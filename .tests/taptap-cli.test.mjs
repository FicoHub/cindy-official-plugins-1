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

// A stand-in for the installed CLI, so the discovery, risk and argument paths
// can be exercised deterministically (CI has no taptap-cli). It answers the
// four calls the worker makes — `__complete`, `<command> --help`, `schema` and
// `aliases` — with a canned tree shaped like the real one: `ai-image` only
// reachable through completion, `+` subcommands carrying their own risk, and a
// container command (`materials`) whose risk lives on its subcommand.
const FIXTURE_TREE = {
  '': [
    ['app', 'app API operations'],
    ['asset-library', 'asset-library API operations'],
    ['dashboard-stats', 'dashboard-stats API operations'],
    ['stats:get', 'Query dashboard stats metrics'],
    ['materials', 'Inspect local game materials'],
    ['task', 'List, inspect, resume, or cancel long-running upload tasks'],
    ['auth', 'Manage TapTap CLI login credentials'],
    ['help', 'Help about any command'],
    ['overview', 'Summarize login, visible developers, and visible games'],
    ['update', 'Update taptap-cli to the latest version'],
    ['upload', 'Upload an image and ingest it into the app asset library'],
    ['upload-apk', 'Upload and create an APK package record'],
    ['version', 'Print the CLI version'],
  ],
  app: [
    ['+bind-spark-version', 'Bind a Spark version'],
    ['+list', 'List games visible under a developer account'],
    ['create-app', 'Create a game draft'],
    ['submit-app-review', 'Submit app edit for review'],
  ],
  'asset-library': [
    ['ai-image', 'Plan and validate model-generated image materials locally'],
    ['search-assets', 'Search the game asset library by target scene'],
  ],
  'asset-library ai-image': [
    ['+plan', 'Build a model image-generation plan'],
    ['+rules', 'Show the generation rules'],
    ['+validate', 'Validate generated files'],
  ],
  materials: [['+inspect', 'Inspect a local directory or archive']],
  task: [
    ['+list', 'List upload tasks'],
    ['+resume', 'Resume an upload task'],
  ],
};

// Only commands the real CLI prints a Risk line for. `materials` and `task` are
// containers and print none — their risk lives on the `+` subcommand.
const FIXTURE_RISK = {
  app: 'read',
  'app +list': 'read',
  'app +bind-spark-version': 'write',
  'app submit-app-review': 'high-risk-write',
  'asset-library ai-image +plan': 'read',
  'asset-library ai-image +rules': 'read',
  'asset-library ai-image +validate': 'read',
  'materials +inspect': 'read',
  'task +list': 'read',
  'task +resume': 'write',
  auth: 'write',
  'auth status': 'read',
  overview: 'read',
  version: 'read',
};

const FIXTURE_SCHEMA = [
  { name: 'app submit-app-review', description: 'Submit review', _meta: { risk: 'high-risk-write' } },
  { name: 'app create-app', description: 'Create', _meta: { risk: 'write' } },
  { name: 'asset-library search-assets', description: 'Search', _meta: { risk: 'read' } },
  { name: 'dashboard-stats get-dashboard-stats', description: 'Stats', _meta: { risk: 'read' } },
];

const FIXTURE_ALIASES = [
  { alias: 'stats:get', canonical: 'dashboard-stats get-dashboard-stats', description: 'Stats' },
];

// Flag completions: the CLI answers `__complete <command> --` with the flags
// that command accepts. A command with no children is recognised by having an
// entry here (or by being a leaf the parent lists) — which is how the worker
// tells "a real command with no subcommands" from "an unknown path".
const FIXTURE_FLAGS = {
  version: [['--format', 'output format: json|pretty'], ['--help', 'help for version']],
  'app create-app': [['--data', 'operation input JSON'], ['--dev-id', 'TapTap developer ID'], ['--dry-run', 'preview']],
  'app +list': [['--dev-id', 'TapTap developer ID'], ['--kw', 'filter by app name or identifier'], ['--page-size', 'apps per page']],
};

const FIXTURE_CLI = `#!/usr/bin/env node
const args = process.argv.slice(2);
const tree = ${JSON.stringify(FIXTURE_TREE)};
const risk = ${JSON.stringify(FIXTURE_RISK)};
const schema = ${JSON.stringify(FIXTURE_SCHEMA)};
const aliases = ${JSON.stringify(FIXTURE_ALIASES)};
const flagMap = ${JSON.stringify(FIXTURE_FLAGS)};
const write = (s) => process.stdout.write(s);
if (args[0] === '__complete') {
  const partial = args[args.length - 1];
  const path = args.slice(1, -1).join(' ');
  const entries = partial === '--' ? (flagMap[path] || []) : (tree[path] || []);
  write(entries.map((c) => c[0] + '\\t' + c[1]).join('\\n') + '\\n:0\\nCompletion ended with directive: ShellCompDirectiveNoFileComp\\n');
  process.exit(0);
}
if (args.length && args[args.length - 1] === '--help') {
  const key = args.slice(0, -1).join(' ');
  const level = risk[key];
  write('Usage:\\n  taptap-cli ' + key + ' [flags]\\n' + (level ? '\\nRisk: ' + level + '\\n' : ''));
  process.exit(0);
}
if (args[0] === 'schema') { write(JSON.stringify({ ok: true, data: schema })); process.exit(0); }
if (args[0] === 'aliases') { write(JSON.stringify({ ok: true, data: { aliases } })); process.exit(0); }
write(JSON.stringify({ ok: true, data: { echo: args, workdir: process.cwd() } }));
`;

function makeFakeCli() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'taptap-fixture-'));
  const bin = path.join(dir, 'taptap-cli');
  fs.writeFileSync(bin, FIXTURE_CLI, { mode: 0o755 });
  return bin;
}

const fakeCli = makeFakeCli();
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

// Spawn one worker for a batch of calls. The worker answers asynchronously —
// two calls in flight finish in whichever order the CLI does — so each request
// gets its own id and the replies come back matched to it, not in arrival order.
function callWorker(requests) {
  const pending = requests.map((request, index) => ({ ...request, id: index + 1 }));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const byId = new Map();
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
          const reply = JSON.parse(line);
          if (reply && reply.result !== undefined) byId.set(reply.id, reply);
        } catch (_) {
          // Protocol lines are JSON; anything else is a defect, surfaced below.
        }
      }
      if (byId.size >= pending.length) {
        clearTimeout(timer);
        child.kill();
        resolve(pending.map((request) => byId.get(request.id)));
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    for (const request of pending) child.stdin.write(JSON.stringify(request) + '\n');
  });
}

const callTool = (name, extra = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'taptap/call_tool',
  params: { name, ...extra },
});

const listTools = (category, extra = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'taptap/list_tools',
  params: { ...(category ? { category } : {}), ...extra },
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

test('local file arguments are confined by the CLI, rooted at the session workdir', async () => {
  // The CLI rejects absolute paths and `..` escapes for every local input
  // (positional uploads, --output, --output-dir, --data @file) and resolves
  // symlinks — stronger than a check here, and it can never drift from the
  // flags it ships. What the worker owes that check is the directory to resolve
  // against; without a session workdir there is no root, so the call is refused.
  assert.match(workerSource, /cwd: options\.cwd && fs\.existsSync\(options\.cwd\) \? options\.cwd : undefined/);
  const [reply] = await callWorker([
    callTool('materials', { cli_path: fakeCli, args: { _positional: ['+inspect', 'dir'] } }),
  ]);
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.errorCode, 'WORKDIR_REQUIRED');
});

test('a subcommand marker is not mistaken for a local file', async () => {
  // `task +list` takes no file argument; only a real operand (or --output /
  // --data @file) needs the workdir.
  const [reply] = await callWorker([
    callTool('task', { cli_path: fakeCli, args: { _positional: ['+list'] } }),
  ]);
  assert.equal(reply.result.ok, true);
  assert.deepEqual(reply.result.data.envelope.data.echo, ['task', '+list']);
});

test('control flags are forwarded, and the CLI owns the vocabulary', async () => {
  // The CLI rejects flags an operation does not declare, so the worker must not
  // keep a second copy of that list: copies drift and start rejecting flags the
  // CLI added (kw, offline, payload-digest were all killed by such a copy).
  const [reply] = await callWorker([
    callTool('version', { cli_path: fakeCli, args: { kw: 'x', offline: true, page_size: 5 } }),
  ]);
  assert.equal(reply.result.ok, true);
  assert.deepEqual(reply.result.data.envelope.data.echo, ['version', '--kw', 'x', '--offline', '--page-size', '5']);
});

test('the listing is read from the CLI, so nothing is missing from a table', async () => {
  // A command that is not in the OpenAPI schema (`ai-image` is only reachable
  // through completion) must still be discoverable, or the agent cannot reach
  // the operations underneath it at all.
  const [top, library, third, prefix, leaf] = await callWorker([
    listTools('', { cli_path: fakeCli }),
    listTools('asset-library', { cli_path: fakeCli }),
    listTools('asset-library ai-image', { cli_path: fakeCli }),
    listTools('up', { cli_path: fakeCli }),
    listTools('version', { cli_path: fakeCli }),
  ]);

  const topNames = top.result.data.categories.map((entry) => entry.category);
  assert.ok(topNames.includes('app'), 'top level lists the services');
  assert.ok(!topNames.includes('dashboard-stats'), 'the data-query service stays out of the listing');
  assert.ok(!topNames.includes('stats:get'), 'the data-query alias stays out of the listing');
  assert.ok(!topNames.includes('update'), 'updating the user’s CLI is not a plugin operation');

  const libraryNames = library.result.data.operations.map((op) => op.name);
  assert.ok(libraryNames.includes('asset-library search-assets'), 'schema operations keep their inputSchema');
  assert.ok(libraryNames.includes('asset-library ai-image'), 'completion children are merged in');

  const thirdNames = third.result.data.operations.map((op) => op.name);
  assert.deepEqual(thirdNames, [
    'asset-library ai-image +plan',
    'asset-library ai-image +rules',
    'asset-library ai-image +validate',
  ]);

  const prefixNames = prefix.result.data.operations.map((op) => op.name);
  assert.ok(prefixNames.includes('upload'), 'a prefix search finds the commands under it');
  assert.ok(prefixNames.includes('upload-apk'), '…all of them, not just the first match');
  assert.ok(!prefixNames.includes('update'), 'the exclusion still applies to a prefix search');

  // A command with no subcommands must not be handed back as its own child;
  // what it does have is the flags it accepts.
  assert.deepEqual(leaf.result.data.operations, [], 'a leaf is not its own child');
  assert.ok(
    leaf.result.data.flags.some((f) => f.flag === '--format'),
    'a leaf reports the flags it accepts',
  );
});

test('risk comes from the CLI, so second-level commands are not gated as writes', async () => {
  // `app +list` is a read the schema does not describe. Treating unknown
  // commands as writes (fail closed) is safe but wrong for reads, and a
  // hand-written table drifts; the CLI's own `Risk:` line is the authority.
  const [read, resume, bind, submit, unknown] = await callWorker([
    callTool('app +list', { cli_path: fakeCli, args: {} }),
    callTool('task', { cli_path: fakeCli, args: { _positional: ['+resume'] } }),
    callTool('app +bind-spark-version', { cli_path: fakeCli, args: {} }),
    callTool('app submit-app-review', { cli_path: fakeCli, args: {} }),
    callTool('app made-up-command', { cli_path: fakeCli, args: {} }),
  ]);
  assert.equal(read.result.ok, true, 'a read subcommand runs without a confirmation round');
  assert.equal(resume.result.errorCode, 'CONFIRM_REQUIRED', 'task +resume is a write');
  assert.equal(bind.result.errorCode, 'CONFIRM_REQUIRED', 'binding a Spark version is a write');
  assert.equal(submit.result.errorCode, 'CONFIRM_REQUIRED', 'review submission is high-risk-write');
  assert.equal(unknown.result.errorCode, 'UNKNOWN_TOOL', 'a command the CLI does not have is rejected');
});

test('reading documentation is never gated as a write', async () => {
  // `help` only prints a command's documentation, so its own --help carries no
  // Risk line; failing closed on that would drag a help dump through the
  // confirmation gate. Its positionals are command names, not file paths.
  const [reply] = await callWorker([
    callTool('help', { cli_path: fakeCli, args: { _positional: ['app', '+list'] } }),
  ]);
  assert.equal(reply.result.ok, true);
  assert.deepEqual(reply.result.data.envelope.data.echo, ['help', 'app', '+list']);
});

test('every manual link is addressable through ghost_manual', () => {
  // Manuals are read on demand by the agent, and its only reader is
  // ghost_manual: it needs a full path from the manual root and rejects `..`.
  // A markdown-relative target therefore resolves fine on disk and is still a
  // dead end for the agent — which is what the previous filesystem-based check
  // here failed to notice.
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
      // `URL` and `page_url` are the prohibited-format examples in the
      // page-handover rules, not links.
      if (/^(https?:|mailto:|#|<)/.test(target) || target === 'URL' || target === 'page_url') continue;
      const clean = target.split('#')[0];
      if (!clean) continue;
      const where = `${path.relative(manualRoot, file)} -> ${target}`;
      if (clean.split('/').includes('..')) {
        broken.push(`${where} (ghost_manual rejects ..)`);
        continue;
      }
      if (!clean.startsWith('taptap-suite/')) {
        broken.push(`${where} (must be a path from the manual root)`);
        continue;
      }
      const resolved = path.join(manualRoot, clean);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        broken.push(`${where} (no such manual file)`);
      }
    }
  }
  assert.deepEqual(broken, [], 'manuals contain links the agent cannot follow');
});

test('the data-query domain is excluded from every surface', async () => {
  // Data querying is deliberately out of scope for this plugin. It must stay
  // gone from the catalog, the manuals, and the manifest — the catalog is read
  // live from the CLI, so the worker filter is what actually enforces it.
  assert.match(workerSource, /EXCLUDED_SERVICES = new Set\(\['dashboard-stats'\]\)/);
  assert.match(workerSource, /if \(EXCLUDED_SERVICES\.has\(service\)\) continue;/);
  assert.match(workerSource, /excluded\.push/, 'the alias route into the service must be filtered too');
  assert.match(workerSource, /function isExcluded/, 'every listing path must consult the exclusion');
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

test('the manuals never tell the agent to call a command the plugin refuses', () => {
  // A `call_tool` name in the manual is an instruction to the agent; naming a
  // command the worker rejects (data querying, CLI self-update) or redirects
  // (raw `auth login`, which would hand the device code to the model) sends it
  // into a guaranteed failure. Bash examples are addressed to the user and are
  // deliberately not checked here.
  const refused = [
    { name: 'dashboard-stats', why: 'data querying is out of scope' },
    { name: 'stats:get', why: 'data querying is out of scope' },
    { name: 'update', why: 'updating the CLI is the user\'s own action' },
    { name: 'auth login', why: 'the worker redirects it to auth login-start' },
  ];
  const manualRoot = path.join(root, 'taptap-cli', 'manual');
  const markdown = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else markdown.push(full);
    }
  })(manualRoot);

  const found = [];
  for (const file of markdown) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/call_tool\(name:\s*["']([^"']+)["']/g)) {
      const called = match[1].trim();
      for (const rule of refused) {
        if (called === rule.name || called.startsWith(rule.name + ' ')) {
          found.push(`${path.relative(manualRoot, file)}: ${called} (${rule.why})`);
        }
      }
    }
  }
  assert.deepEqual(found, [], 'the manuals instruct the agent to call a refused command');
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
  assert.match(workerSource, /\.map\(trimOutputSchema\)/, 'drill-down trims outputSchema');
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
  // Regression guard: a command whose risk cannot be established silently
  // passes the gate, so the lookup must fail closed. The two heads the worker
  // orchestrates are the only ones with no CLI metadata to read.
  assert.match(workerSource, /if \(!risk\) risk = 'write';/, 'an unresolved risk must fail closed');
  for (const op of ['auth login-start', 'auth login-wait']) {
    assert.match(workerSource, new RegExp(`\\['${op}', 'write'\\]`), `${op} must be declared a write`);
  }
  assert.match(workerSource, /riskPathTokens\(tokens, args\)/,
    'the risk lookup must see the `+` subcommand a call actually names');
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
