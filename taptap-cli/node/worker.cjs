'use strict';

// TapTap CLI Cindy plugin worker.
//
// Protocol: JSON-RPC 2.0, one object per line on stdio. stdout is protocol-only;
// logs go to stderr. Methods:
//   taptap/list_tools  { category? }                        -> catalog / per-category detail + RULES
//   taptap/call_tool   { name, args?, callId? }             -> run the taptap-cli the user installed
//   ping                                                     -> liveness
//
// Every request may carry:
//   cli_path — the taptap-cli path saved in the plugin settings (optional
//              override). Only a file named taptap-cli is accepted, so the
//              setting cannot be turned into "run any local executable".
//   workdir  — the session workdir, used as the CLI's cwd so relative file
//              arguments (upload <file>, --output) resolve where the user expects
//
// The worker runs the user's own taptap-cli, so auth, risk gates and the --json
// envelopes of the CLI itself stay the single source of truth. The plugin never
// reads or stores credentials: they live in the CLI's own credential store.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(PLUGIN_ROOT, 'bin');
const MAX_RESULT_BYTES = 900 * 1024; // single-line stdout protocol cap is 1MB
const DEFAULT_TIMEOUT_MS = 300 * 1000;
const MAX_TIMEOUT_MS = 870 * 1000;
const HEARTBEAT_MS = 25 * 1000;

// ---------------------------------------------------------------------------
// protocol helpers

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function log(message) {
  process.stderr.write('[taptap-cli-plugin] ' + message + '\n');
}

// ---------------------------------------------------------------------------
// CLI resolution
//
// The plugin does not bundle the CLI: the official npm package is ~95MB across
// seven platform binaries, far past the plugin package size cap. It runs the
// taptap-cli the user installed themselves, resolved in this order:
//   1. a path saved in the plugin settings (`cli_path`)
//   2. a binary bundled under bin/, when a local build shipped one
//   3. `taptap-cli` on the worker's PATH
//   4. common install locations (~/.local/bin, /usr/local/bin, Homebrew, npm prefix)
//
// Nothing here downloads or installs anything; a missing CLI is a setup
// failure the user resolves, not something the plugin works around.

const EXE_NAME = process.platform === 'win32' ? 'taptap-cli.exe' : 'taptap-cli';

function expandHome(value) {
  if (typeof value !== 'string' || !value) return '';
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch (_) {
    return false;
  }
}

function findOnPath(name) {
  // `name` already carries the platform extension (EXE_NAME is taptap-cli.exe
  // on win32), so do not append another one — that would probe taptap-cli.exe.EXE.
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function bundledBinaryPath() {
  const platformMap = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
  const archMap = { x64: 'amd64', arm64: 'arm64' };
  const platform = platformMap[process.platform];
  const arch = archMap[process.arch];
  if (!platform || !arch) return null;
  return path.join(BIN_DIR, 'taptap-cli-' + platform + '-' + arch + (process.platform === 'win32' ? '.exe' : ''));
}

// A global npm install lands in the active Node version's prefix. Under a
// version manager that prefix is not on PATH — only the manager's shim
// directory is — so the CLI can be installed successfully and still not be
// found by name. The npm prefix is not exposed to this worker through the
// environment (npm_config_prefix/PREFIX are unset here), so enumerate the
// per-version bin directories the common managers use.
function versionManagerBinDirs() {
  const home = os.homedir();
  const bases = [
    [path.join(home, '.proto', 'tools', 'node'), 'bin'],
    [path.join(home, '.nvm', 'versions', 'node'), 'bin'],
    [path.join(home, '.fnm', 'node-versions'), path.join('installation', 'bin')],
    [path.join(home, '.asdf', 'installs', 'nodejs'), 'bin'],
    [path.join(home, '.nodenv', 'versions'), 'bin'],
    [path.join(home, '.local', 'share', 'mise', 'installs', 'node'), 'bin'],
  ];
  const dirs = [];
  for (const [base, suffix] of bases) {
    let entries;
    try {
      entries = fs.readdirSync(base);
    } catch (_) {
      continue; // manager not installed
    }
    for (const entry of entries) dirs.push(path.join(base, entry, suffix));
  }
  // Managers that keep a single flat bin directory.
  dirs.push(path.join(home, '.volta', 'bin'));
  return dirs;
}

function commonInstallDirs() {
  const dirs = [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  const prefix = process.env.npm_config_prefix || process.env.PREFIX;
  if (prefix) dirs.push(process.platform === 'win32' ? prefix : path.join(prefix, 'bin'));
  dirs.push(path.join(os.homedir(), '.npm-global', 'bin'));
  return dirs.concat(versionManagerBinDirs());
}

// A configured path is a user-writable string that ends up in execFile, so
// constrain it to the CLI's own name instead of accepting any executable.
const CLI_BASENAME_RE = /^taptap-cli(?:\.(?:exe|cmd|bat))?$/i;

function resolutionError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function resolveCli(override) {
  const explicit = expandHome(override);
  if (explicit) {
    if (!CLI_BASENAME_RE.test(path.basename(explicit))) {
      return {
        cmd: null,
        source: null,
        error: resolutionError('CLI_PATH_REJECTED',
          '插件设置里的路径指向的不是 taptap-cli 本身(当前文件名:' + path.basename(explicit) +
          ')。为避免执行任意可执行文件,该字段只接受以 taptap-cli 命名的程序,例如 ' +
          '/opt/homebrew/bin/taptap-cli。请在插件设置页更正或清空该字段后重试。'),
      };
    }
    if (isExecutableFile(explicit)) return { cmd: explicit, source: 'settings' };
    return {
      cmd: null,
      source: null,
      error: resolutionError('CLI_PATH_INVALID',
        '插件设置里配置的 taptap-cli 路径不可执行:' + explicit +
        ';请在插件设置页更正或清空该字段后重试。'),
    };
  }

  const bundled = bundledBinaryPath();
  if (bundled && isExecutableFile(bundled)) return { cmd: bundled, source: 'bundled' };

  const onPath = findOnPath(EXE_NAME);
  if (onPath) return { cmd: onPath, source: 'path' };

  for (const dir of commonInstallDirs()) {
    const candidate = path.join(dir, EXE_NAME);
    if (isExecutableFile(candidate)) return { cmd: candidate, source: 'common-path' };
  }

  const err = new Error(
    '本机没有找到 taptap-cli。请先在终端安装并登录官方 CLI,然后重试:\n' +
    '  npm install -g @taptap/cli               # 安装(包约 37MB)\n' +
    '  taptap-cli update --skills-layout suite  # 安装 AI Skills,并合并为单个 taptap-suite\n' +
    '  taptap-cli auth login                    # 授权\n' +
    '插件会自动搜索 PATH 以及 nvm / proto / volta 等版本管理器下的全局目录,装完即可用,通常不需要手动配置 PATH。\n' +
    '若你还要单独使用那些 skill,把 --skills-layout 换成 separate 即可。\n' +
    '若已安装但仍找不到,可在插件设置页填写 taptap-cli 的绝对路径。' +
    (process.platform === 'win32'
      ? '\n(Windows 上插件只会直接执行 taptap-cli.exe;仅存在 .cmd 包装脚本时无法调用。)'
      : '')
  );
  err.code = 'CLI_NOT_INSTALLED';
  return { cmd: null, source: null, error: err };
}

function childEnv(source) {
  const env = Object.assign({}, process.env);
  // Only a bundled binary needs to be pointed at the package's own skills.
  // An installed CLI resolves its skills from its own install location.
  if (source === 'bundled') env.TAPTAP_CLI_BUNDLED_SKILLS_ROOT = PLUGIN_ROOT;
  return env;
}

function clip(text, maxBytes) {
  const limit = maxBytes || MAX_RESULT_BYTES;
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  return Buffer.from(text, 'utf8').slice(0, limit).toString('utf8');
}

function parseEnvelope(stdout) {
  const text = (stdout || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

// Run the CLI binary with a keep-alive heartbeat. `callId` (when present) is
// echoed in progress notifications so main.js can keep the host tool-call
// window alive for long tasks (uploads, login polling).
function runBinary(argv, opts) {
  const options = opts || {};
  const timeoutMs = Math.min(Math.max(options.timeoutMs || DEFAULT_TIMEOUT_MS, 10 * 1000), MAX_TIMEOUT_MS);
  const resolved = resolveCli(options.cliPath);
  if (!resolved.cmd) {
    return Promise.resolve({
      code: -1,
      err: resolved.error,
      killed: false,
      maxBufferExceeded: false,
      stdout: '',
      stderr: '',
      durationMs: 0,
      cliUnavailable: true,
      cliErrorCode: (resolved.error && resolved.error.code) || 'CLI_NOT_INSTALLED',
      message: (resolved.error && resolved.error.message) || 'taptap-cli 不可用。',
    });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(resolved.cmd, argv, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      cwd: options.cwd && fs.existsSync(options.cwd) ? options.cwd : undefined,
      env: childEnv(resolved.source),
    }, (err, stdout, stderr) => {
      clearInterval(timer);
      const code = err
        ? (typeof err.code === 'number' ? err.code : -1)
        : 0;
      resolve({
        code,
        err,
        killed: Boolean(err && err.killed),
        maxBufferExceeded: Boolean(err && err.code === 'ENOBUFS'),
        stdout: stdout || '',
        stderr: stderr || '',
        durationMs: Date.now() - started,
      });
    });
    const timer = setInterval(() => {
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (options.callId) {
        notify('progress', { callId: options.callId, message: (options.label || '命令执行中') + ',已运行 ' + elapsed + ' 秒' });
      }
      log((options.label || argv.join(' ')) + ' still running (' + elapsed + 's)');
    }, HEARTBEAT_MS);
  });
}

// ---------------------------------------------------------------------------
// command catalog (from the CLI's own OpenAPI snapshot)

// Cached per resolved CLI, so switching the configured path re-reads the catalog.
const catalogCache = new Map();

function getCatalog(runOpts) {
  const options = runOpts || {};
  const key = options.cliPath || '';
  if (!catalogCache.has(key)) {
    const promise = (async () => {
      const res = await runBinary(['schema'], {
        timeoutMs: 120 * 1000,
        label: '读取命令目录',
        cliPath: options.cliPath,
      });
      if (res.cliUnavailable) {
        const err = new Error(res.message);
        err.code = res.cliErrorCode;
        throw err;
      }
      if (res.code !== 0) {
        throw new Error('读取 CLI 命令目录失败(exit ' + res.code + '):' + clip(res.stderr, 500));
      }
      const env = parseEnvelope(res.stdout);
      if (!env || env.ok !== true || !Array.isArray(env.data)) {
        throw new Error('CLI 命令目录格式异常');
      }
      const services = new Map();
      for (const item of env.data) {
        const name = item && typeof item.name === 'string' ? item.name : null;
        if (!name || name.indexOf(' ') < 0) continue;
        const service = name.split(' ')[0];
        if (EXCLUDED_SERVICES.has(service)) continue;
        if (!services.has(service)) services.set(service, []);
        services.get(service).push(item);
      }
      return services;
    })().catch((err) => {
      catalogCache.delete(key);
      throw err;
    });
    catalogCache.set(key, promise);
  }
  return catalogCache.get(key);
}

const aliasesCache = new Map();

// The CLI's friendly shortcut allowlist (`taptap-cli aliases`). Each alias maps
// to a canonical service operation; reading it live keeps list_tools/call_tool
// in sync with the CLI instead of a hand-maintained shortcut table. The data
// query service is filtered the same way as the catalog.
function getAliases(runOpts) {
  const options = runOpts || {};
  const key = options.cliPath || '';
  if (!aliasesCache.has(key)) {
    const promise = (async () => {
      const res = await runBinary(['aliases'], {
        timeoutMs: 120 * 1000,
        label: '读取快捷命令',
        cliPath: options.cliPath,
      });
      if (res.cliUnavailable) {
        const err = new Error(res.message);
        err.code = res.cliErrorCode;
        throw err;
      }
      if (res.code !== 0) {
        throw new Error('读取 CLI 快捷命令失败(exit ' + res.code + '):' + clip(res.stderr, 500));
      }
      const env = parseEnvelope(res.stdout);
      if (!env || env.ok !== true || !env.data || !Array.isArray(env.data.aliases)) {
        throw new Error('CLI 快捷命令格式异常');
      }
      return env.data.aliases.filter((a) => {
        const canonical = a && typeof a.canonical === 'string' ? a.canonical : '';
        return !EXCLUDED_SERVICES.has(canonical.split(' ')[0]);
      });
    })().catch((err) => {
      aliasesCache.delete(key);
      throw err;
    });
    aliasesCache.set(key, promise);
  }
  return aliasesCache.get(key);
}

// ---------------------------------------------------------------------------
// static surface: shortcuts, service tools, rules

// Data-query operations are deliberately not offered by this plugin. Two layers
// enforce that: the catalog filter drops the service before it is ever listed,
// and leaving it out of SERVICE_DESCRIPTIONS plus dropping its shortcut from
// SHORTCUTS keeps it out of ALLOWED_HEADS, so call_tool rejects it outright
// rather than relying on the listing to hide it.
const EXCLUDED_SERVICES = new Set(['dashboard-stats']);

const SERVICE_DESCRIPTIONS = {
  app: '游戏资料、包体槽位、版本生命周期、审核与发布',
  'asset-library': '图片/视频素材库检索、收录与上传',
  developer: '开发者账号与厂商列表',
  'package-management': '包体库、线上/待处理包、自测入口与小游戏能力',
  qualification: '上架资质分析、非敏感材料草稿、资质增量审核',
  'test-plan': 'CBT/OBT 测试计划、招募、资格批次与激活码',
};

// Non-alias top-level shortcuts (upload / materials / task / test-qr-code ...).
// The colon aliases (game:create, audit:submit, ...) are read live from
// `taptap-cli aliases` via getAliases instead of being hand-listed here.
const SHORTCUTS = [
  { name: 'test-qr-code', risk: 'write', description: '生成自测二维码 PNG(--output 指定文件路径)' },
  { name: 'upload', risk: 'write', description: '上传一张图片并收录进素材库(需 idempotency_key)' },
  { name: 'upload-video', risk: 'write', description: '上传视频(scene 决定回填目标字段)' },
  { name: 'upload-apk', risk: 'write', description: '上传 APK 并创建包体记录' },
  { name: 'upload-pc-package', risk: 'write', description: '上传 Windows 包(不带槽位绑定)' },
  { name: 'upload-h5-package', risk: 'write', description: '上传 H5 zip 并创建 H5 版本' },
  { name: 'materials', risk: 'read', description: '只读盘点本地目录/压缩包中的可上传物料(+inspect)' },
  { name: 'task', risk: 'read', description: '查看/恢复长任务上传(+list / +get / +resume)' },
];

const SERVICE_TOOLS = [
  { name: 'overview', risk: 'read', description: '一次查看登录态、可见厂商、游戏样例和下一步建议' },
  { name: 'doctor', risk: 'read', description: '检查 CLI 配置、凭证与连通性' },
  { name: 'status', risk: 'read', description: '检查 Capability API 可达性' },
  { name: 'config', risk: 'read', description: '查看本地 CLI 配置与运行策略' },
  { name: 'profile', risk: 'read', description: '查看/切换服务器 profile' },
  { name: 'event', risk: 'read', description: '消费与管理实时事件' },
  { name: 'version', risk: 'read', description: '查看 CLI 版本' },
  { name: 'aliases', risk: 'read', description: '列出友好快捷命令允许清单' },
  { name: 'schema', risk: 'read', description: '查看某个操作的输入输出 schema(如 schema app save-changes)' },
];

const ALLOWED_HEADS = new Map();
for (const [service, description] of Object.entries(SERVICE_DESCRIPTIONS)) {
  ALLOWED_HEADS.set(service, { kind: 'service', maxTokens: 2, description });
}
for (const shortcut of SHORTCUTS) {
  ALLOWED_HEADS.set(shortcut.name, { kind: 'shortcut', maxTokens: 1, description: shortcut.description });
}
for (const tool of SERVICE_TOOLS) {
  ALLOWED_HEADS.set(tool.name, { kind: 'tool', maxTokens: tool.name === 'schema' ? 3 : 1, description: tool.description });
}
ALLOWED_HEADS.set('auth', { kind: 'tool', maxTokens: 2, description: '登录凭证管理(login/logout/qrcode/status)' });

// Shortcut names carry a colon (game:create, audit:submit); service tokens
// are space-separated. Allow the colon so shortcuts resolve, while the
// ALLOWED_HEADS whitelist still rejects anything unknown.
const TOKEN_RE = /^[a-z0-9+][a-z0-9+._:-]*$/i;

const GLOBAL_RULES = [
  '写门禁:risk 为 write / high-risk-write 的操作,必须先向用户说明参数与影响并取得明确同意;先用 dry_run:true 预览,再用完全相同的参数加 yes:true 执行。未确认就带 yes 的调用会被拒绝。--yes 不代表用户同意协议;遇到服务端 required_consents 只展示 agreement.name 与 agreement.url。',
  '参数:scope 字段(developer_id / app_id)直接传,worker 映射成 --dev-id / --app-id;其余业务字段必须放进 args.data(JSON 对象);除 scope 和 data 外的键都是控制 flag(如 dry_run / yes / idempotency_key / format),透传成 --dry-run / --yes 等;快捷命令的位置参数(如文件路径)放 args._positional 数组;args._help:true 可查看某命令的 --help。list_tools 下钻不含 outputSchema,需要某操作的输出结构时用 call_tool(name:"schema", args:{_positional:[service, method]}) 查完整输入输出。',
  '调用示例:先 list_tools(category) 看该域操作与参数(enum=可选值、pattern=格式、required=true=必填),再 call_tool。例——创建冒险游戏:call_tool(name:"app create-app", args:{developer_id:"1001", data:{title:"我的游戏", category:"adventure", package_type:"apk", developer_role:"developer"}, dry_run:true});用户确认后同参数加 yes:true。务必按 inputSchema 的 enum 取值、按 pattern 校验格式,不要猜值。',
  '输出:成功返回的 data 是 CLI 的 JSON envelope(顶层 ok / data / error)。业务失败以 ok:false 返回,message 含 error.type / error.message / error.hint。不要手动传 json / format flag,输出已默认结构化(默认文本的命令如 auth status 由插件自动补 --json)。',
  '失败三态:失败结果带 `execution_state` 字段,只有两个取值。`not_executed` 表示操作没有生效,可按 message 修正参数后重试;`unknown` 表示写操作可能已经在服务端生效,必须先核对实际状态(上传类用 task +list 查看已有任务)再决定是否重试,禁止直接重跑。',
  '身份:缺 developer_id / app_id 时先用 overview 或 developer 类目查询候选,多候选让用户选,不要猜 ID。',
  '手册:完整业务流程与领域规范用 ghost_manual({ghost_id:"taptap-cli", path:...}) 读取,入口见 taptap-suite。',
];

const AUTH_RULES = [
  '未登录时:先 call_tool(name:"auth login-start"),把返回的 verification_url 按两行原样提供给用户(第一行仅写"请完成授权:",第二行仅写 URL);不要用 Markdown 链接语法,也不要重复展示 URL。',
  '紧接着立即 call_tool(name:"auth login-wait", args:{login_handle:...}) 持续轮询,不要等待用户回复;不要只用 device_code 重建命令,不要输出/记录/上报 access token;登录成功后向用户只回复"登录成功"。',
  'auth status 只在用户询问当前身份、登录失败或错误要求重登时运行,不作为每个任务的固定前置。',
];

// ---------------------------------------------------------------------------
// list_tools

function runOptions(params) {
  return {
    cliPath: params && params.cli_path,
    cwd: params && params.workdir,
  };
}

function catalogFailure(err) {
  return {
    ok: false,
    errorCode: (err && err.code) || 'CATALOG_UNAVAILABLE',
    message: (err && err.message) || String(err),
  };
}

// The category drill-down keeps everything the agent needs to pick an operation
// and fill its args — inputSchema, affordance (use_when / avoid_when / examples),
// risk, and description — but drops outputSchema, which is only needed after
// execution and is the single largest part of the catalogue (22% of the full
// schema). An agent that wants the output shape queries it per-operation with
// call_tool(name:"schema", args:{_positional:[service, method]}).
function trimOutputSchema(op) {
  if (!op || typeof op !== 'object') return op;
  const { outputSchema, ...rest } = op;
  return rest;
}

async function listTools(params) {
  const runOpts = runOptions(params);
  const category = params && typeof params.category === 'string' ? params.category.trim() : '';
  if (!category) {
    let services;
    let aliases;
    try {
      services = await getCatalog(runOpts);
      aliases = await getAliases(runOpts);
    } catch (err) {
      return catalogFailure(err);
    }
    const categories = [
      { category: 'overview', count: 1, description: '登录态与游戏总览(只读,推荐起点)' },
      { category: 'auth', count: 5, description: '登录授权、登录态与凭证管理' },
    ];
    for (const [service, ops] of services) {
      categories.push({ category: service, count: ops.length, description: SERVICE_DESCRIPTIONS[service] || service + ' API operations' });
    }
    categories.push({ category: 'shortcuts', count: aliases.length + SHORTCUTS.length, description: '端到端快捷命令:创建游戏、提审、上传图片/视频/APK/Windows/H5、素材盘点' });
    categories.push({ category: 'service-tools', count: SERVICE_TOOLS.length, description: '诊断、profile、schema 查询等服务工具' });
    return {
      ok: true,
      data: {
        categories,
        rules: GLOBAL_RULES,
        hint: '传 category 查看该类目下的操作明细与类目规则;第一次做业务前建议先读手册 execution-rules。',
      },
    };
  }

  const rules = GLOBAL_RULES.slice();
  if (category === 'auth') rules.unshift(...AUTH_RULES);

  if (category === 'overview') {
    return { ok: true, data: { category, rules, operations: SERVICE_TOOLS.slice(0, 1) } };
  }
  if (category === 'auth') {
    return { ok: true, data: { category, rules, operations: AUTH_OPERATIONS } };
  }
  if (category === 'shortcuts') {
    let aliases;
    try {
      aliases = await getAliases(runOpts);
    } catch (err) {
      return catalogFailure(err);
    }
    return { ok: true, data: { category, rules, operations: [...aliases, ...SHORTCUTS] } };
  }
  if (category === 'service-tools') {
    return { ok: true, data: { category, rules, operations: SERVICE_TOOLS } };
  }

  let services;
  try {
    services = await getCatalog(runOpts);
  } catch (err) {
    return catalogFailure(err);
  }
  const ops = services.get(category);
  if (!ops) {
    return {
      ok: false,
      errorCode: 'UNKNOWN_CATEGORY',
      message: '未知类目 ' + category + ';可用类目见 list_tools() 概览',
    };
  }
  return { ok: true, data: { category, rules, operations: ops.map(trimOutputSchema) } };
}

const AUTH_OPERATIONS = [
  { name: 'auth login-start', risk: 'write', description: '发起链接授权,返回用户需打开的 verification_url 和 login_handle(不返回设备码)。' },
  { name: 'auth login-wait', risk: 'write', description: '用 login_handle 持续轮询直到授权完成或设备码过期;login-start 后立即调用。' },
  { name: 'auth status', risk: 'read', description: '查看登录态、账号、profile 与服务器状态。' },
  { name: 'auth logout', risk: 'write', description: '清除本机保存的登录凭证。' },
  { name: 'auth qrcode', risk: 'read', description: '生成授权二维码。' },
];

// ---------------------------------------------------------------------------
// login orchestration

// The CLI's device-code flow is stateless: `auth login --no-wait` returns a
// device code, and `auth login --device-code` resumes polling with it. The code
// must survive the gap between login-start and login-wait without being
// persisted to a file (forbidden by the repository) or returned to the agent
// (where a base64 blob could be decoded). It is held in-process under an opaque
// random handle; if the worker idles out between the two calls the handle is
// lost and the agent must re-run login-start.
const loginHandles = new Map();

function newLoginHandle(deviceCode, expiresAt, interval) {
  const id = 'login_' + crypto.randomBytes(16).toString('hex');
  loginHandles.set(id, {
    device_code: deviceCode,
    expires_at_unix: expiresAt || undefined,
    interval_seconds: interval,
    created_at_unix: Math.floor(Date.now() / 1000),
  });
  // Drop stale handles so the map cannot grow without bound.
  const nowUnix = Math.floor(Date.now() / 1000);
  for (const [key, value] of loginHandles) {
    if (!value || !value.created_at_unix || nowUnix - value.created_at_unix > 3600) loginHandles.delete(key);
  }
  return id;
}

function getLoginHandle(id) {
  if (typeof id !== 'string' || !id) return null;
  return loginHandles.get(id) || null;
}

function deleteLoginHandle(id) {
  if (typeof id === 'string') loginHandles.delete(id);
}

async function authLoginStart(params) {
  const runOpts = runOptions(params);
  const res = await runBinary(['auth', 'login', '--no-wait', '--json'], {
    timeoutMs: 60 * 1000,
    label: '发起授权',
    cliPath: runOpts.cliPath,
    cwd: runOpts.cwd,
  });
  if (res.cliUnavailable) {
    return { ok: false, errorCode: res.cliErrorCode || 'CLI_NOT_INSTALLED', message: res.message };
  }
  const env = parseEnvelope(res.stdout);
  const data = env && env.ok === true && env.data ? env.data : null;
  if (!data || !data.verification_url || !data.device_code) {
    return {
      ok: false,
      errorCode: 'LOGIN_START_FAILED',
      message: '发起授权失败:' + briefFailure(res, env),
    };
  }
  const interval = Number(data.interval) > 0 ? Number(data.interval) : 5;
  return {
    ok: true,
    data: {
      verification_url: data.verification_url,
      expires_at_unix: data.expires_at || undefined,
      interval_seconds: interval,
      login_handle: newLoginHandle(data.device_code, data.expires_at, interval),
      display_contract: '把 verification_url 按两行原样展示给用户(第一行仅"请完成授权:",第二行仅 URL),然后立即用 login_handle 调用 auth login-wait,不要等待用户回复。',
    },
  };
}

async function authLoginWait(params) {
  const handle = getLoginHandle(params && params.login_handle);
  if (!handle) {
    return {
      ok: false,
      errorCode: 'LOGIN_HANDLE_INVALID',
      message: 'login_handle 无效、已过期或 worker 已重启;请重新调用 auth login-start 换取新的授权链接。',
    };
  }
  const argv = ['auth', 'login', '--json', '--device-code', handle.device_code];
  if (handle.expires_at_unix) argv.push('--expires-at-unix', String(handle.expires_at_unix));
  argv.push('--interval-seconds', String(handle.interval_seconds || 5));
  const runOpts = runOptions(params);
  const res = await runBinary(argv, {
    timeoutMs: MAX_TIMEOUT_MS,
    callId: params && params.callId,
    label: '等待用户完成授权',
    cliPath: runOpts.cliPath,
    cwd: runOpts.cwd,
  });
  // A timeout leaves the device code usable, so keep the handle and let the
  // agent resume polling. Any completed run (success or a hard CLI failure)
  // consumes it.
  if (!res.killed) deleteLoginHandle(params && params.login_handle);
  if (res.cliUnavailable) {
    return { ok: false, errorCode: res.cliErrorCode || 'CLI_NOT_INSTALLED', message: res.message };
  }
  if (res.killed) {
    return {
      ok: false,
      errorCode: 'LOGIN_PENDING',
      message: '授权仍在等待中(本次轮询已到时限,用户尚未完成)。可用同一个 login_handle 再次调用 auth login-wait 继续等待。',
    };
  }
  const env = parseEnvelope(res.stdout);
  if (env && env.ok === true) {
    return { ok: true, data: { status: 'authorized' } };
  }
  return {
    ok: false,
    errorCode: 'LOGIN_WAIT_FAILED',
    message: '授权未完成:' + briefFailure(res, env) + ';可重新调用 auth login-start 换新链接。',
  };
}

function briefFailure(res, env) {
  const parts = [];
  const err = env && env.error ? env.error : null;
  if (err && err.type) parts.push(err.type + (err.subtype ? '/' + err.subtype : ''));
  if (err && err.message) parts.push(err.message);
  if (err && err.hint) parts.push(err.hint);
  if (!parts.length && res && res.stderr) parts.push(clip(res.stderr.trim(), 300));
  if (!parts.length) parts.push('exit=' + (res ? res.code : '?'));
  return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// call_tool

const SHORTCUT_RISKS = new Map(SHORTCUTS.map((s) => [s.name, s.risk]));

// Heads of kind "tool" are not in the service catalog, so their risk has to be
// declared here. The lookup below fails closed: an unlisted tool head is
// treated as a write rather than silently passing the confirmation gate.
const TOOL_HEAD_RISKS = new Map([
  ['overview', 'read'],
  ['doctor', 'read'],
  ['status', 'read'],
  ['config', 'read'],
  ['profile', 'read'],
  ['event', 'read'],
  ['version', 'read'],
  ['aliases', 'read'],
  ['schema', 'read'],
  ['auth login-start', 'write'],
  ['auth login-wait', 'write'],
  ['auth logout', 'write'],
  ['auth status', 'read'],
  ['auth qrcode', 'read'],
]);

// The CLI's input model (cmd/openapi/openapi.go): a service operation exposes
// only `--dev-id` and `--app-id` as scope flags (with those short names), and
// every business field goes inside one `--data` JSON. The two scope names are
// the CLI's fixed convention (matching the schema's developer_id / app_id),
// not something the plugin invents. Every other key the agent passes is a
// control flag, mirrored to the CLI verbatim (`dry_run` -> `--dry-run`), so the
// plugin never has to maintain a list of which flags exist.
const SCOPE_FLAG = {
  developer_id: 'dev-id',
  dev_id: 'dev-id',
  app_id: 'app-id',
};

function buildArgv(tokens, args) {
  const argv = tokens.slice();
  if (Array.isArray(args._positional)) argv.push(...args._positional.map(String));
  if (args._help === true) argv.push('--help');

  const dataObj = {};
  let hasData = false;
  let rawData = null;

  for (const [key, value] of Object.entries(args)) {
    if (key === 'callId' || key.charAt(0) === '_') continue;
    if (value === undefined || value === null) continue;

    if (SCOPE_FLAG[key]) {
      argv.push('--' + SCOPE_FLAG[key], String(value));
      continue;
    }
    if (key === 'data') {
      if (typeof value === 'string') { rawData = value; hasData = true; }
      else if (typeof value === 'object') { Object.assign(dataObj, value); hasData = true; }
      continue;
    }
    // Any other key is a control flag, mirrored verbatim to the CLI. Object
    // values are JSON-encoded (e.g. raw API `--params`).
    const flag = '--' + key.replace(/_/g, '-');
    if (value === true) argv.push(flag);
    else if (value !== false) argv.push(flag, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  if (hasData) {
    if (rawData !== null) argv.push('--data', rawData);
    else if (Object.keys(dataObj).length > 0) argv.push('--data', JSON.stringify(dataObj));
  }

  if (Array.isArray(args._extra_args)) argv.push(...args._extra_args.map(String));
  return argv;
}

async function callTool(params) {
  const runOpts = runOptions(params);
  const name = params && typeof params.name === 'string' ? params.name.trim() : '';
  const args = params && typeof params.args === 'object' && params.args !== null ? params.args : {};
  if (!name) {
    return { ok: false, errorCode: 'INVALID_ARGS', message: '缺少 name;操作名来自 list_tools,如 "app get-app-module"。' };
  }
  const tokens = name.split(/\s+/);
  if (!tokens.every((t) => TOKEN_RE.test(t))) {
    return {
      ok: false,
      errorCode: 'UNKNOWN_TOOL',
      message: '未知操作 "' + name + '";先用 list_tools() 看类目概览,或传 category 下钻查看可用操作。',
    };
  }
  const headInfo = ALLOWED_HEADS.get(tokens[0]);
  let alias = null;
  if (!headInfo) {
    // Not a static head; it may be a colon alias read live from the CLI.
    let aliases;
    try {
      aliases = await getAliases(runOpts);
    } catch (err) {
      return catalogFailure(err);
    }
    alias = aliases.find((a) => a.alias === tokens[0]) || null;
    if (!alias || tokens.length !== 1) {
      return {
        ok: false,
        errorCode: 'UNKNOWN_TOOL',
        message: '未知操作 "' + name + '";先用 list_tools() 看类目概览,或传 category 下钻查看可用操作。',
      };
    }
  } else if (tokens.length > headInfo.maxTokens) {
    return {
      ok: false,
      errorCode: 'UNKNOWN_TOOL',
      message: '未知操作 "' + name + '";先用 list_tools() 看类目概览,或传 category 下钻查看可用操作。',
    };
  }

  // Login is orchestrated in the worker so the device code never reaches the
  // model. It is a write, so a read-only session must not start one.
  if (name === 'auth login-start' || name === 'auth login-wait') {
    if (params.read_only === true) {
      return {
        ok: false,
        errorCode: 'SESSION_READ_ONLY',
        execution_state: 'not_executed',
        message: '当前会话处于只读/计划模式,不能执行 ' + name + '。请退出只读模式后再试。',
      };
    }
    const merged = Object.assign({}, params.args, {
      callId: params.callId,
      cli_path: params.cli_path,
      workdir: params.workdir,
    });
    return name === 'auth login-start' ? authLoginStart(merged) : authLoginWait(merged);
  }

  // auth status defaults to human-readable text; its documented agent contract
  // is structured JSON, so append --json unless explicitly suppressed.
  if (name === 'auth status' && args.json === undefined) args.json = true;

  // risk gate: catalogued ops and aliases by their own metadata, top-level
  // shortcuts and tools by static maps.
  let risk = null;
  if (alias) {
    try {
      const services = await getCatalog(runOpts);
      const canonicalTokens = alias.canonical.split(' ');
      const op = services.get(canonicalTokens[0]);
      const found = op && op.find((item) => item.name === alias.canonical);
      // fail closed: an alias whose canonical op is missing or lacks risk
      // metadata must not run unguarded.
      risk = (found && found._meta && found._meta.risk) || 'write';
    } catch (err) {
      return catalogFailure(err);
    }
  } else if (headInfo.kind === 'service') {
    try {
      const services = await getCatalog(runOpts);
      const op = services.get(tokens[0]);
      const found = op && op.find((item) => item.name === name);
      // fail closed: a service op that vanished from the catalog or lacks risk
      // metadata must not run unguarded.
      risk = (found && found._meta && found._meta.risk) || 'write';
    } catch (err) {
      return catalogFailure(err);
    }
  } else if (headInfo.kind === 'shortcut') {
    risk = SHORTCUT_RISKS.get(tokens[0]) || 'read';
    // `task +resume` resumes an upload (external side effect), unlike the
    // read-only +list / +get, so it must be gated as a write. The resume marker
    // can arrive through either positional args or the verbatim _extra_args.
    if (tokens[0] === 'task') {
      const hasResume = (Array.isArray(args._positional) && args._positional.includes('+resume')) ||
        (Array.isArray(args._extra_args) && args._extra_args.includes('+resume'));
      if (hasResume) risk = 'write';
    }
  } else if (headInfo.kind === 'tool') {
    risk = TOOL_HEAD_RISKS.get(name) || 'write';
  }
  if (risk && risk !== 'read' && params.read_only === true) {
    return {
      ok: false,
      errorCode: 'SESSION_READ_ONLY',
      execution_state: 'not_executed',
      message: '当前会话处于只读/计划模式,不能执行 ' + name + '(' + risk + ')。请退出只读模式后再试。',
    };
  }
  if (risk && risk !== 'read' && args.yes !== true && args.dry_run !== true) {
    return {
      ok: false,
      errorCode: 'CONFIRM_REQUIRED',
      execution_state: 'not_executed',
      message: '操作 ' + name + ' 的风险级别是 ' + risk + ',需要先取得用户明确同意:先用 dry_run:true 预览,用户确认后再用相同参数加 yes:true 执行。',
    };
  }

  const argv = buildArgv(tokens, args);
  const timeoutMs = args._timeout_seconds ? Number(args._timeout_seconds) * 1000 : DEFAULT_TIMEOUT_MS;
  const res = await runBinary(argv, {
    timeoutMs,
    callId: params && params.callId,
    label: name,
    cliPath: runOpts.cliPath,
    cwd: runOpts.cwd,
  });

  const env = parseEnvelope(res.stdout);
  // Every failure path states whether the operation reached the server, because
  // several external operations here (uploads, review submission, publishing)
  // cannot be undone. Not-run is safe to retry; unknown must be checked first.
  const isWrite = Boolean(risk && risk !== 'read');
  const unknownForWrite = isWrite ? 'unknown' : 'not_executed';

  if (res.cliUnavailable) {
    return {
      ok: false,
      errorCode: res.cliErrorCode || 'CLI_NOT_INSTALLED',
      execution_state: 'not_executed',
      message: res.message,
    };
  }
  if (res.maxBufferExceeded) {
    return {
      ok: false,
      errorCode: 'RESULT_TOO_LARGE',
      execution_state: unknownForWrite,
      message: '命令输出超过单次返回上限' + (isWrite
        ? ',且本次是写操作,是否已在服务端生效不确定:请先用只读方式核对实际状态,确认未生效再重试,不要直接重跑。'
        : ';请收窄查询(如减小 page_size、指定更短时间范围或更精确的过滤条件)后重试。'),
    };
  }
  if (res.killed) {
    return {
      ok: false,
      errorCode: 'TIMEOUT',
      execution_state: unknownForWrite,
      message: '命令在 ' + Math.round(timeoutMs / 1000) + ' 秒后超时。' + (isWrite
        ? '该写操作可能已经在服务端生效,结果不确定:请先用只读方式核对实际状态(上传类可用 task +list 查看已有任务),确认未生效再重试,不要直接重跑;也可用 args._timeout_seconds(最大 870)放宽超时后重试。'
        : '只读操作没有副作用,可用 args._timeout_seconds(最大 870)放宽超时后重试。'),
      data: env || undefined,
    };
  }
  if (res.code === 10) {
    return {
      ok: false,
      errorCode: 'CONFIRM_REQUIRED',
      execution_state: 'not_executed',
      message: 'CLI 确认门禁(exit 10):该写操作需要用户明确同意后,以相同参数加 yes:true 重试;--yes 不代表用户同意协议。',
      data: env || undefined,
    };
  }
  if (res.code !== 0) {
    // A structured CLI error means the CLI itself decided the outcome. A bare
    // non-zero exit with no envelope (crash, signal, killed helper) does not,
    // so a write must be treated as possibly-executed rather than failed.
    const state = env && env.ok === false && env.error ? 'not_executed' : unknownForWrite;
    return {
      ok: false,
      errorCode: 'CLI_FAILED',
      exit_code: res.code,
      execution_state: state,
      message: briefFailure(res, env) + (state === 'unknown'
        ? ';命令异常退出且没有返回结构化结果,该写操作是否已在服务端生效不确定:请先核对实际状态再决定是否重试,不要直接重跑。'
        : ''),
      data: env || { raw: clip(res.stdout, 20 * 1024) },
    };
  }
  return {
    ok: true,
    data: {
      name,
      duration_ms: res.durationMs,
      envelope: env || { raw: clip(res.stdout) },
      stderr: res.stderr ? clip(res.stderr.trim(), 4000) : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// main loop

function handle(req, fn) {
  Promise.resolve()
    .then(() => fn(req.params || {}))
    .then((result) => reply(req.id, result))
    .catch((err) => {
      log('error: ' + ((err && err.stack) || err));
      reply(req.id, {
        ok: false,
        errorCode: 'INTERNAL',
        message: 'worker 内部错误:' + ((err && err.message) || String(err)),
      });
    });
}

readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let req;
  try {
    req = JSON.parse(text);
  } catch (_) {
    log('ignoring non-JSON line');
    return;
  }
  if (!req || typeof req.method !== 'string') return;
  if (req.method === 'taptap/list_tools') return handle(req, listTools);
  if (req.method === 'taptap/call_tool') return handle(req, callTool);
  if (req.method === 'ping') return reply(req.id, { ok: true, pong: true });
  reply(req.id, { ok: false, errorCode: 'METHOD_NOT_FOUND', message: '未知方法 ' + req.method });
});

log('worker ready, plugin root: ' + PLUGIN_ROOT);
