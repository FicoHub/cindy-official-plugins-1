import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// These tests cover the worker's decision logic — argument rejection, the write
// confirmation gate, and the read-only gate — which all resolve before the CLI
// is ever executed. They therefore pass on a machine with no taptap-cli
// installed, which is what CI is. Anything that actually runs the CLI is
// exercised by hand against a real installation, not here.

const root = path.resolve(import.meta.dirname, '..');
const workerPath = path.join(root, 'taptap-cli', 'node', 'worker.cjs');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'taptap-cli', 'ghost.json'), 'utf8'),
);
const workerSource = fs.readFileSync(workerPath, 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'taptap-cli', 'main.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(root, 'taptap-cli', 'settings.html'), 'utf8') +
  '\n' + fs.readFileSync(path.join(root, 'taptap-cli', 'settings.js'), 'utf8');

// Every file the package ships, so a rule cannot be satisfied in one file while
// another (settings page, manual, locale) still violates it.
function shippedFiles() {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  })(path.join(root, 'taptap-cli'));
  return files.filter((file) => !/\.(png|jpg|jpeg|webp|gif)$/i.test(file));
}

// Spawn one worker per call: the worker answers on stdout and stays alive, so
// the harness collects the single reply and tears the process down.
function callWorker(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const replies = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('worker did not answer in time'));
    }, 20000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          replies.push(JSON.parse(line));
        } catch (_) {
          // Protocol lines are JSON; anything else is a defect, surfaced below.
        }
      }
      if (replies.length >= requests.length) {
        clearTimeout(timer);
        child.kill();
        resolve(replies);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n');
  });
}

const callTool = (name, extra = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'taptap/call_tool',
  params: { name, ...extra },
});

test('the plugin package declares the files it references', () => {
  for (const relative of [manifest.entry, manifest.icon, manifest.settingsHtml]) {
    assert.ok(fs.existsSync(path.join(root, 'taptap-cli', relative)), `missing ${relative}`);
  }
  for (const locale of Object.values(manifest.locales)) {
    assert.ok(fs.existsSync(path.join(root, 'taptap-cli', locale)), `missing ${locale}`);
  }
  for (const item of manifest.manual.items) {
    assert.ok(
      fs.existsSync(path.join(root, 'taptap-cli', item.dir, 'MANUAL.md')),
      `missing ${item.dir}/MANUAL.md`,
    );
  }
});

test('the plugin ships no bundled CLI binary and never downloads one', () => {
  // The manifest must not promise a binary, and no package path may look like
  // a vendored executable: the plugin runs the user's own installation.
  assert.equal(manifest.node.protocol, 'json-rpc-stdio');
  const packageFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else packageFiles.push(path.relative(path.join(root, 'taptap-cli'), full));
    }
  };
  walk(path.join(root, 'taptap-cli'));
  assert.deepEqual(packageFiles.filter((f) => /(^|\/)bin\//.test(f)), [], 'plugin must not bundle binaries');

  // The worker may spawn exactly one thing: the locally resolved CLI path.
  // It must not reach for a shell, an installer, or the network. (Text that
  // tells the *user* to run npx is guidance, not execution, so this asserts on
  // the process and network APIs rather than on the words.)
  assert.doesNotMatch(workerSource, /\brequire\(['"]node:(?:https?|net|tls)['"]\)/, 'worker must not open a network connection');
  assert.doesNotMatch(workerSource, /\b(?:exec|execSync|spawn|spawnSync|fork)\s*\(/, 'worker must not spawn through a shell or fork');
  assert.doesNotMatch(workerSource, /process\.execPath/, 'packaged Cindy disables RunAsNode');
  const execFileCalls = workerSource.match(/execFile\s*\(/g) ?? [];
  assert.equal(execFileCalls.length, 1, 'worker must have exactly one execFile call site');
  assert.match(workerSource, /execFile\(resolved\.cmd, argv,/, 'the only process must be the resolved CLI path');
});

test('unlisted operations are rejected without reaching the CLI', async () => {
  const [reply] = await callWorker([callTool('totally-made-up')]);
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.errorCode, 'UNKNOWN_TOOL');
});

test('a configured path that is not taptap-cli is rejected', async () => {
  // The setting feeds execFile, so it must not become "run any executable".
  const [reply] = await callWorker([callTool('status', { cli_path: '/bin/sh' })]);
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.errorCode, 'CLI_PATH_REJECTED');
});

test('a configured path that does not exist is reported, not ignored', async () => {
  const [reply] = await callWorker([callTool('status', { cli_path: '/nonexistent/taptap-cli' })]);
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.errorCode, 'CLI_PATH_INVALID');
});

test('a wrong path never falls through to the auto-detected CLI', async () => {
  // Silently ignoring a broken setting would hide the mistake; a correct-looking
  // but missing path must fail loudly even when a working CLI is on PATH.
  assert.match(workerSource, /CLI_PATH_INVALID/);
  assert.match(workerSource, /CLI_BASENAME_RE/);
});

test('local paths must stay inside the session workdir', async () => {
  // materials +inspect is read-only but still must not reach outside the
  // workdir: the manual documents relative paths, so an absolute path or a ../
  // escape is rejected before the CLI runs.
  const workdir = '/tmp/taptap-cli-workdir';
  const replies = await callWorker([
    callTool('materials', { workdir, args: { _positional: ['+inspect', '/etc/passwd'] } }),
    callTool('materials', { workdir, args: { _positional: ['+inspect', '../outside'] } }),
  ]);
  for (const reply of replies) {
    assert.equal(reply.result.ok, false);
    assert.equal(reply.result.errorCode, 'PATH_OUTSIDE_WORKDIR');
  }
});

test('asset-library output paths are confined to the workdir', () => {
  // asset-library ai-image +plan --output-dir and +validate's positional
  // output-dir must go through the same workdir check as upload/materials.
  // asset-library is a service, so its risk needs a live catalog (absent in
  // CI); assert the confinement wiring directly instead of via the CLI.
  const pathCommands = workerSource.match(/const PATH_COMMANDS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(pathCommands, 'PATH_COMMANDS must be declared');
  assert.match(pathCommands[1], /'asset-library'/, 'asset-library must be in PATH_COMMANDS');

  const pathFlags = workerSource.match(/const PATH_FLAG_KEYS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(pathFlags, 'PATH_FLAG_KEYS must be declared');
  assert.match(pathFlags[1], /'output_dir'/, 'output_dir must be validated as an output path');
  assert.match(pathFlags[1], /'output-dir'/, 'the hyphen spelling must not bypass the check');
});

test('arbitrary flag keys are rejected instead of becoming CLI flags', async () => {
  // A control flag must be one the CLI actually implements; an unknown key must
  // not turn into an arbitrary --flag (the argument-injection boundary). One
  // request per worker so the async reply order cannot scramble assertions.
  const workdir = '/tmp/taptap-cli-workdir';
  const [reply] = await callWorker([
    callTool('materials', { workdir, args: { _positional: ['+inspect', 'dir'], evil_flag: 'x' } }),
  ]);
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.errorCode, 'INVALID_ARGS');
  assert.match(reply.result.message, /未知 flag --evil-flag/);
});

test('the flag whitelist is the CLI\'s real vocabulary', () => {
  // The closed flag list is harvested from `taptap-cli <op> --help`; these are
  // the flags the worker may mirror as --flag. Removing one would silently break
  // a real operation, so pin the important spellings.
  const block = workerSource.match(/const KNOWN_FLAGS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, 'KNOWN_FLAGS must be declared');
  for (const flag of ['dry-run', 'yes', 'format', 'idempotency-key', 'scene', 'screen-orientation', 'output-dir', 'rule']) {
    assert.match(block[1], new RegExp(`'${flag}'`), `${flag} must stay in the flag whitelist`);
  }
});

test('every relative link in the manuals resolves inside the package', () => {
  // Manuals are read on demand by the agent; a dangling link is a dead end that
  // no other gate catches, and manual dirs may contain Markdown only.
  const manualRoot = path.join(root, 'taptap-cli', 'manual');
  const markdown = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const relative = path.relative(manualRoot, full);
        assert.match(relative, /\.md$/, `manual directories may contain only Markdown: ${relative}`);
        markdown.push(full);
      }
    }
  };
  walk(manualRoot);
  assert.ok(markdown.length > 0, 'no manual files found');

  const broken = [];
  for (const file of markdown) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:|#|<)/.test(target) || target === 'URL' || target === 'page_url') continue;
      const clean = target.split('#')[0];
      if (!clean) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), clean))) {
        broken.push(`${path.relative(manualRoot, file)} -> ${target}`);
      }
    }
  }
  assert.deepEqual(broken, [], 'manuals contain links that do not resolve');
});

test('the data-query domain is excluded from every surface', async () => {
  // Data querying is deliberately out of scope for this plugin. It must stay
  // gone from the catalog, the manuals, and the manifest — the catalog is read
  // live from the CLI, so the worker filter is what actually enforces it.
  assert.match(workerSource, /EXCLUDED_SERVICES = new Set\(\['dashboard-stats'\]\)/);
  assert.match(workerSource, /if \(EXCLUDED_SERVICES\.has\(service\)\) continue;/);
  assert.doesNotMatch(workerSource, /stats:get/, 'the stats:get shortcut must not be listed');
  assert.doesNotMatch(workerSource, /'dashboard-stats':/, 'the service must not have a description entry');

  const manualNames = manifest.manual.items.map((item) => item.name).sort();
  assert.ok(!manualNames.includes('data-stats'), 'the data-stats manual must be gone');
  const manualDirs = fs.readdirSync(path.join(root, 'taptap-cli', 'manual')).sort();
  assert.deepEqual(manualNames, manualDirs, 'manual items must match the manual directories');

  assert.doesNotMatch(
    manifest.description,
    /数据表现|dashboard|analytics/i,
    'the plugin description must not advertise data querying',
  );

  // A denied operation must be rejected outright, not merely hidden from the list.
  const [reply] = await callWorker([callTool('dashboard-stats get-dashboard-stats')]);
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.errorCode, 'UNKNOWN_TOOL');
});

test('nothing shipped points at the internal taptap/cli repository', () => {
  // The GitHub repository is internal; only the npm package is public. Any
  // link to the repository is therefore a dead end for the people who install
  // this plugin, including the manuals the agent reads and may relay onward.
  const offenders = [];
  for (const file of shippedFiles()) {
    if (/github\.com\/taptap\/cli\b/.test(fs.readFileSync(file, 'utf8'))) {
      offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, [], 'the internal repository must not be linked from shipped files');
});

test('the install guidance lists commands that actually work', () => {
  // `npx @taptap/cli install` runs a wizard whose internal `npm install -g` is
  // capped at 120s. The package is ~37MB, so a first run can exceed that and
  // exit before installing anything — observed on a real machine. These three
  // commands each do one thing and carry no such cap.
  for (const [label, source] of [['worker', workerSource], ['settings page', settingsSource]]) {
    assert.match(source, /npm install -g @taptap\/cli/, `${label} must install the package`);
    assert.match(source, /update --skills-layout suite/, `${label} must install the skills`);
    assert.match(source, /taptap-cli auth login/, `${label} must authorize`);
    assert.doesNotMatch(source, /npx @taptap\/cli install/,
      `${label} must not route users through the timed-out wizard`);
  }
});

test('the manuals keep the agent on the plugin path, not the CLI skill path', () => {
  // Installing the CLI also installs same-named Agent Skills that teach running
  // `taptap-cli` directly. Those are auto-surfaced, so a manual that points at
  // them would send the agent down a path that bypasses this plugin's write
  // gate, read-only handling, failure tri-state, and excluded data queries.
  const rules = fs.readFileSync(
    path.join(root, 'taptap-cli', 'manual', 'taptap-suite', 'MANUAL.md'), 'utf8');

  assert.match(rules, /一律以本插件的手册为准/, 'the plugin manuals must be declared authoritative');
  assert.match(rules, /不要照着它用 Bash 直接跑 taptap-cli/, 'the CLI-skill shortcut must be refused');
  assert.match(rules, /不要改用 Shell、npx 或其它方式绕过本插件/, 'the bypass rule must stay stated');

  // The earlier wording actively invited reading the CLI skill.
  assert.doesNotMatch(rules, /也可按 CLI 自带的同名 Skill 阅读/, 'must not invite the CLI-skill path');

  // The CLI ships its skills in two layouts; naming only one leaves the agent
  // unable to recognise what it is looking at under the other.
  assert.match(rules, /separate 布局/, 'the separate layout must be described');
  assert.match(rules, /suite 布局/, 'the suite layout must be described');
  assert.match(rules, /references\/taptap-xxx/, 'the suite reference path must be named');
});

test('the install guidance recommends the suite layout', () => {
  // Suite layout installs one taptap-suite entry instead of ten taptap-*
  // skills, which is the smallest overlap with this plugin's manuals.
  for (const [label, source] of [['worker', workerSource], ['settings page', settingsSource]]) {
    assert.match(source, /update --skills-layout suite/, `${label} must recommend the suite layout`);
  }
});

test('discovery text never advertises the data-query domain', () => {
  // whenToUse is what the agent uses to decide whether this plugin answers a
  // question. It kept advertising download/rating/order data after that domain
  // was removed, so the agent routed data questions here and found nothing.
  const ADVERTISES = /查下载|下载\/浏览|下载、PV|download\/impression|query metrics|数据表现|データ照会|데이터 조회/;

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'taptap-cli', 'ghost.json'), 'utf8'));
  assert.ok(!ADVERTISES.test(manifest.whenToUse), 'manifest whenToUse must not advertise data querying');

  for (const locale of ['zh-CN', 'en', 'ja', 'ko']) {
    const resource = JSON.parse(
      fs.readFileSync(path.join(root, 'taptap-cli', 'locales', `${locale}.json`), 'utf8'));
    assert.ok(!ADVERTISES.test(resource.whenToUse), `${locale} whenToUse must not advertise data querying`);
  }
});

test('the tool declaration documents every control argument the worker accepts', () => {
  // The worker's TIMEOUT message tells the agent to use args._timeout_seconds,
  // but the declaration never mentioned it — the agent could only learn it by
  // failing first. Any control the worker reads has to be declared.
  const controls = [...new Set((workerSource.match(/args\.(_[a-z_]+)/g) || [])
    .map((hit) => hit.slice('args.'.length)))];
  assert.ok(controls.length > 0, 'no control arguments found in the worker');

  // `controls` already carry their leading underscore.
  const callToolDecl = JSON.stringify(manifest.tools.find((tool) => tool.name === 'call_tool'));
  for (const control of controls) {
    assert.ok(callToolDecl.includes(control + '(') || callToolDecl.includes('`' + control + '`'),
      `call_tool must document the ${control} control argument`);
  }
});

test('CLI discovery covers version-manager install layouts', () => {
  // npm installs a global package into the active Node version's prefix. Under
  // a version manager that directory is not on PATH, and the npm prefix is not
  // visible to this worker through the environment either, so a CLI can be
  // installed successfully and still not be found by name. A real install hit
  // exactly that: installed to ~/.proto/tools/node/<version>/bin, invisible.
  for (const manager of ['.proto', '.nvm', '.fnm', '.asdf', '.nodenv', 'mise', '.volta']) {
    assert.ok(workerSource.includes(manager), `discovery must cover ${manager}`);
  }
  assert.match(workerSource, /function versionManagerBinDirs/);
  assert.match(workerSource, /return dirs\.concat\(versionManagerBinDirs\(\)\);/);
});


test('args map to the CLI input model: scope flags + everything else a flag', () => {
  // The CLI exposes only --dev-id/--app-id as scope flags; every business
  // field goes into one --data JSON, and every other key is a control flag
  // mirrored verbatim (`dry_run` -> `--dry-run`). The plugin must not re-invent
  // which flags exist, so there is no hand-maintained flag whitelist.
  assert.match(workerSource, /developer_id: 'dev-id'/, 'developer_id must map to --dev-id');
  assert.match(workerSource, /app_id: 'app-id'/, 'app_id must map to --app-id');
  assert.match(workerSource, /Any other key is a control flag/,
    'non-scope, non-data keys must pass through as flags');
  assert.ok(workerSource.includes("key.replace(/_/g, '-')"), 'flags mirror the key name verbatim');
});

test('the catalogue keeps inputSchema but drops outputSchema', () => {
  // The category drill-down must keep everything the agent needs to pick an
  // operation and fill its args — inputSchema, affordance, risk, description —
  // but drop outputSchema, which is only needed after execution and is the
  // largest part of the schema (22%). The old summarizeField dropped inputSchema
  // detail; the full passthrough bloated every drill-down to 70 KB. This lands
  // in between: inputSchema intact, outputSchema fetched on demand via `schema`.
  assert.doesNotMatch(workerSource, /function summarizeField/, 'the field summarizer must be gone');
  assert.doesNotMatch(workerSource, /function summarizeOperation/, 'the operation summarizer must be gone');
  assert.match(workerSource, /function trimOutputSchema/, 'outputSchema must be trimmed');
  assert.match(workerSource, /const \{ outputSchema, \.\.\.rest \} = op/, 'outputSchema must be dropped');
  assert.match(workerSource, /operations: ops\.map\(trimOutputSchema\)/, 'drill-down trims outputSchema');
});

test('the rules carry a concrete call example', () => {
  // Rules describe the mapping; a concrete example is what makes it click. The
  // agent must see one complete call_tool invocation end to end.
  assert.match(workerSource, /调用示例/, 'the rules must include a worked example');
  assert.match(workerSource, /enum=可选值/, 'the example must explain enum');
  assert.match(workerSource, /dry_run:true/, 'the example must show the write preview');
});

test('control flags are not hard-coded', () => {
  // The old CONTROL_FLAGS set froze the flag list and drifted from the CLI
  // (json/offline were once folded into --data). Now every non-scope, non-data
  // key is mirrored as a flag, so there is no whitelist to maintain.
  assert.doesNotMatch(workerSource, /const CONTROL_FLAGS/, 'the flag whitelist must be gone');
  assert.match(workerSource, /Any other key is a control flag/, 'unknown keys pass through as flags');
});

test('shortcut names with a colon resolve as live aliases', () => {
  // game:create / audit:submit / assets:search carry a colon. The token check
  // disallowed `:`, so every colon shortcut read as UNKNOWN_TOOL — including
  // stats:get, which was mistaken for the data-query exclusion. The aliases are
  // now read live from `taptap-cli aliases` rather than a static table.
  assert.match(workerSource, /TOKEN_RE = \/\^\[a-z0-9\+\]\[a-z0-9\+\._:\-\]\*\$/i,
    'the token regex must allow the shortcut colon');
  assert.match(workerSource, /function getAliases/, 'aliases are read live from the CLI');
});

test('a write operation is refused until the user confirms', async () => {
  const [reply] = await callWorker([callTool('auth logout')]);
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.errorCode, 'CONFIRM_REQUIRED');
  assert.match(reply.result.message, /auth logout/);
});

test('every operation with a write risk declares one', () => {
  // Regression guard: a head whose risk is missing silently passes the gate.
  // The lookup must fail closed, so an unlisted tool head is treated as a write.
  assert.match(workerSource, /TOOL_HEAD_RISKS\.get\(name\) \|\| 'write'/);
  for (const op of ['auth login-start', 'auth login-wait', 'auth logout']) {
    assert.match(workerSource, new RegExp(`\\['${op}', 'write'\\]`), `${op} must be declared a write`);
  }
  for (const op of ['auth status', 'auth qrcode', 'overview', 'doctor', 'version']) {
    assert.match(workerSource, new RegExp(`\\['${op}', 'read'\\]`), `${op} must be declared a read`);
  }
});

test('a read-only session refuses writes even with yes:true', async () => {
  const [reply] = await callWorker([callTool('auth logout', { yes: true, read_only: true })]);
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.errorCode, 'SESSION_READ_ONLY');
});

test('rejections report that nothing was executed', async () => {
  // The agent must be able to tell "refused, safe to retry" from
  // "maybe already applied, check first".
  const [gate, readOnly] = await callWorker([
    callTool('auth logout'),
    callTool('upload-apk', { yes: true, read_only: true }),
  ]);
  assert.equal(gate.result.execution_state, 'not_executed');
  assert.equal(readOnly.result.execution_state, 'not_executed');
});

test('a write that fails ambiguously is reported as unknown, never as failed', () => {
  // Timeouts, oversized output, and a crash without a structured envelope can
  // all leave a write already applied on the server. Those paths must say so
  // and must not invite a blind retry.
  assert.match(workerSource, /const unknownForWrite = isWrite \? 'unknown' : 'not_executed';/);
  for (const code of ['TIMEOUT', 'RESULT_TOO_LARGE', 'CLI_FAILED']) {
    const block = workerSource.slice(workerSource.indexOf(`errorCode: '${code}'`));
    assert.match(block.slice(0, 400), /execution_state: (?:unknownForWrite|state)/,
      `${code} must declare an execution state`);
  }
  assert.match(workerSource, /不要直接重跑/, 'an unknown outcome must tell the agent to verify before retrying');

  // A structured CLI error is usually the CLI deciding the outcome (not
  // executed), but an ambiguous subtype (e.g. ambiguous_outcome) means the CLI
  // does not know whether a write was applied, so it must stay unknown.
  assert.match(workerSource, /const ambiguous = Boolean\(err\)/);
  assert.match(workerSource, /\(err && !ambiguous\) \? 'not_executed' : unknownForWrite/);

  // The worker computing the state is not enough: the brain must carry it into
  // the tool result, or the agent only ever sees prose. Other CLI-backed
  // plugins in this repository surface the same field name.
  assert.match(mainSource, /if \(executionState\) payload\.execution_state = executionState;/);
  assert.match(mainSource, /result && result\.execution_state/);
});

test('a read-only session refuses to start a login', async () => {
  const [reply] = await callWorker([callTool('auth login-start', { read_only: true })]);
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.errorCode, 'SESSION_READ_ONLY');
});

test('unknown methods are reported instead of crashing the worker', async () => {
  const [reply] = await callWorker([{ jsonrpc: '2.0', id: 1, method: 'taptap/nope', params: {} }]);
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.errorCode, 'METHOD_NOT_FOUND');
});

test('the brain forwards the session workdir and the configured CLI path', () => {
  // Both are what make relative file arguments and a non-PATH install work.
  assert.match(mainSource, /session_context/);
  assert.match(mainSource, /cli_path/);
  assert.match(mainSource, /workdir_is_local/);
  assert.match(mainSource, /workdir_is_read_only/);
  assert.doesNotMatch(mainSource, /navigator\.language/);
});
