// `figaro doctor` CLI tests. Everything runs against a fake world (temp HOME,
// temp config dir, stub commands on PATH, a fake daemon on a temp socket), so
// no test depends on this machine's real services, mixer or GPU.
//
// Scenarios (task acceptance): all-green, missing models, missing keys, service
// not running, configured sink missing — plus masked secrets and --fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'figaro');
const SECRET_DEEPSEEK = 'sk-DOCTORSECRET1234567890abcdef';
const SECRET_MINIMAX = 'sk-api-DOCTORSECRET0987654321zyxw';

const execFileAsync = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: err });
    });
  });

const DEFAULT_AMIXER = `Simple mixer control 'Capture',0
  Capabilities: cvolume cswitch
  Capture channels: Front Left - Front Right
  Limits: Capture 0 - 63
  Front Left: Capture 45 [71%] [16.50dB] [on]
  Front Right: Capture 45 [71%] [16.50dB] [on]
`;

function sortedPairs(entries) {
  return Object.fromEntries(Object.entries(entries));
}

/** Build a complete "healthy installation" fixture under a temp dir. */
async function createWorld(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figaro-doctor-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const world = {
    root,
    home: path.join(root, 'home'),
    configDir: path.join(root, 'config'),
    repo: path.join(root, 'repo'),
    stub: path.join(root, 'stub'),
    runtime: path.join(root, 'runtime'),
    state: path.join(root, 'state'),
    pcm: path.join(root, 'mic.pcm'),
    socket: path.join(root, 'runtime', 'figaro', 'sock'),
  };
  for (const dir of [world.home, world.configDir, world.repo, world.stub, world.runtime, world.state]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  world.models = {
    kws: path.join(world.repo, 'models', 'kws'),
    offline: path.join(world.repo, 'models', 'asr-offline'),
    stream: path.join(world.repo, 'models', 'asr-stream'),
    vad: path.join(world.repo, 'models', 'vad'),
  };
  for (const dir of Object.values(world.models)) await fs.mkdir(dir, { recursive: true });
  world.write = async (file, content, mode = 0o644) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { mode });
  };

  // --- models -------------------------------------------------------------
  await world.write(path.join(world.models.kws, 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx'), 'x');
  await world.write(path.join(world.models.kws, 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx'), 'x');
  await world.write(path.join(world.models.kws, 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx'), 'x');
  await world.write(path.join(world.models.kws, 'tokens.txt'), 'x');
  await world.write(path.join(world.models.kws, 'en.phone'), 'x');
  await world.write(path.join(world.models.offline, 'model.int8.onnx'), 'x');
  await world.write(path.join(world.models.offline, 'tokens.txt'), 'x');
  await world.write(path.join(world.models.stream, 'encoder-epoch-99.int8.onnx'), 'x');
  await world.write(path.join(world.models.stream, 'decoder-epoch-99.int8.onnx'), 'x');
  await world.write(path.join(world.models.stream, 'joiner-epoch-99.int8.onnx'), 'x');
  await world.write(path.join(world.models.stream, 'tokens.txt'), 'x');
  await world.write(path.join(world.models.vad, 'silero_vad.onnx'), 'x');

  // --- config -------------------------------------------------------------
  world.config = {
    deepseek: { apiKey: SECRET_DEEPSEEK, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
    minimax: {
      apiKey: SECRET_MINIMAX,
      wsUrl: 'wss://api.minimax.cn/ws/v1/t2a_v2',
      model: 'speech-2.6-turbo',
      voiceId: 'male-qn-jingying',
    },
    asr: {
      hotkey: 'F9',
      wakeWords: ['费加罗', 'figaro'],
      kwsModelDir: world.models.kws,
      offlineModelDir: world.models.offline,
      streamingModelDir: world.models.stream,
      inputGainPercent: null,
    },
    tts: { sink: 'sink-a' },
    interaction: {},
    ui: { socket: world.socket },
  };
  world.writeConfig = async () => {
    await world.write(path.join(world.configDir, 'config.json'), `${JSON.stringify(world.config, null, 2)}\n`, 0o600);
  };
  await world.writeConfig();

  // --- desktop fixtures ---------------------------------------------------
  world.unitPath = path.join(world.home, '.config', 'systemd', 'user', 'figaro-ui.service');
  await world.write(
    world.unitPath,
    `[Service]
Environment=QS_DISABLE_FILE_WATCHER=1
Environment=QML2_IMPORT_PATH=%h/.config/quickshell/kos
ExecStart=%h/.local/bin/qs --no-duplicate -c figaro
`,
  );
  await world.write(
    path.join(world.home, '.config', 'kglobalshortcutsrc'),
    `[figaro]
_k_friendly_name=Figaro
figaro-talk=F9,F9,费加罗：按住说话 / 唤醒
`,
  );
  await world.write(path.join(world.home, '.config', 'quickshell', 'kos', 'Kos', 'SurfaceShape', 'qmldir'), 'module Kos.SurfaceShape\n');
  await world.write(path.join(world.home, '.local', 'bin', 'qs'), '#!/bin/sh\nexit 0\n', 0o755);

  // --- stub commands ------------------------------------------------------
  const stub = async (name, body) => world.write(path.join(world.stub, name), `#!/usr/bin/env bash\n${body}\n`, 0o755);
  await stub('systemctl', `set -u
state="\${STUB_STATE:-${world.state}}"
mkdir -p "$state"
case "$*" in
  *"is-active figaro-ui"*) if [[ -f "$state/ui-active" ]]; then echo active; else echo "\${STUB_UI_STATUS:-active}"; fi; exit 0 ;;
  *"is-active figaro"*) if [[ -f "$state/figaro-active" ]]; then echo active; else echo "\${STUB_FIGARO_STATUS:-active}"; fi; exit 0 ;;
  *"--value figaro-ui"*) if [[ -f "$state/ui-active" ]]; then echo 23456; else echo "\${STUB_UI_PID:-23456}"; fi; exit 0 ;;
  *"--value figaro"*) if [[ -f "$state/figaro-active" ]]; then echo 12345; else echo "\${STUB_FIGARO_PID:-12345}"; fi; exit 0 ;;
  *"restart figaro-ui"*) touch "$state/ui-active"; exit 0 ;;
  *"restart figaro"*) touch "$state/figaro-active"; exit 0 ;;
  *) exit 0 ;;
esac`);
  await stub('pgrep', `case "$*" in
  *"bin/figaro daemon"*) echo "12345 /usr/bin/node /tmp/repo/bin/figaro daemon"; exit 0 ;;
  *"qs .*-c figaro"*) echo "23456 /usr/local/bin/qs --no-duplicate -c figaro"; exit 0 ;;
esac
exit 1`);
  await stub('pactl', `case "$1" in
  list) printf '56\\tsink-a\\tPipeWire\\ts32le 2ch 48000Hz\\tSUSPENDED\\n'; printf '78\\tsink-b\\tPipeWire\\ts32le 2ch 48000Hz\\tRUNNING\\n'; exit 0 ;;
  get-default-sink) echo "sink-a"; exit 0 ;;
  get-default-source) echo "source-a"; exit 0 ;;
  get-sink-mute) echo "Mute: \${STUB_SINK_MUTE:-no}"; exit 0 ;;
  get-sink-volume) echo "Volume: front-left: 65536 / 100% / 0.00 dB"; exit 0 ;;
  set-sink-mute) echo "$*" >> "\${STUB_LOG:-/dev/null}"; exit 0 ;;
esac
exit 1`);
  await stub('amixer', `cat "\${STUB_AMIXER_FILE:-}" 2>/dev/null || cat <<'EOF'
${DEFAULT_AMIXER}EOF`);
  await stub('parec', `cat "\${STUB_PCM:-${world.pcm}}"`);
  await stub('ps', `echo "\${STUB_CPU:-12.0}"`);
  await stub('nvidia-smi', `echo "\${STUB_GPU:-1713, 16303}"`);
  await stub('df', `cat <<'EOF'
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/nvme0n1p3 776651928 471494400 265632308 64% /
EOF`);
  for (const tool of ['pw-cat', 'ffmpeg', 'spectacle']) {
    await world.write(path.join(world.stub, tool), '#!/bin/sh\nexit 0\n', 0o755);
  }
  // 1 second of silence at 16 kHz mono s16le (parec fixture)
  await world.write(world.pcm, Buffer.alloc(16000 * 2, 0), 0o644);
  // low capture gain fixture (raw 18/63) for the warning scenario
  world.amixerLow = path.join(world.root, 'amixer-low.txt');
  await world.write(world.amixerLow, `Simple mixer control 'Capture',0
  Limits: Capture 0 - 63
  Front Left: Capture 18 [28%] [4.00dB] [on]
  Front Right: Capture 18 [28%] [4.00dB] [on]
`);

  // --- fake daemon --------------------------------------------------------
  world.startFakeDaemon = async () => {
    await fs.mkdir(path.dirname(world.socket), { recursive: true, mode: 0o700 });
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.type === 'subscribe') socket.write(`${JSON.stringify({ type: 'state', state: 'idle' })}\n`);
          if (message.type === 'ping') socket.write(`${JSON.stringify({ type: 'pong', state: 'idle' })}\n`);
        }
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(world.socket, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return server;
  };

  world.env = (extra = {}) => sortedPairs({
    ...process.env,
    // never let the developer's own environment leak keys/secrets into a fixture
    FIGARO_DEEPSEEK_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    FIGARO_MINIMAX_API_KEY: '',
    MINIMAX_API_KEY: '',
    HOME: world.home,
    FIGARO_CONFIG_DIR: world.configDir,
    FIGARO_SOCKET: world.socket,
    FIGARO_DOCTOR_REPO_ROOT: world.repo,
    XDG_CONFIG_HOME: path.join(world.home, '.config'),
    XDG_RUNTIME_DIR: world.runtime,
    PATH: `${world.stub}:${process.env.PATH ?? ''}`,
    ...extra,
  });

  world.run = (args = [], extraEnv = {}) => execFileAsync(process.execPath, [BIN, 'doctor', ...args], {
    env: world.env(extraEnv),
    timeout: 90_000,
  });
  return world;
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

// ---------------------------------------------------------------- scenarios

test('doctor all-green world: exit 0, every group present, no ✗', async (t) => {
  const world = await createWorld(t);
  await world.startFakeDaemon();
  const { code, stdout, stderr } = await world.run();
  assert.equal(code, 0, `expected exit 0, stderr: ${stderr}`);
  assert.match(stdout, /费加罗体检/);
  assert.match(stdout, /✓/);
  assert.match(stdout, /✗ 0/);
  for (const title of ['服务', 'IPC 通信', '配置与密钥', '本地模型', '麦克风', '音频出口', 'TTS / LLM 连通性', '热键', '桌面能力', '资源占用']) {
    assert.ok(stdout.includes(title), `missing group ${title}`);
  }
  // secrets are masked, never printed in full
  assert.ok(!stdout.includes(SECRET_DEEPSEEK), 'DeepSeek key must never be printed');
  assert.ok(!stdout.includes(SECRET_MINIMAX), 'MiniMax key must never be printed');
  assert.match(stdout, /sk-…/);

  const report = parseJson((await world.run(['--json'])).stdout);
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.groups.length, 10);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.warn, 0);
  assert.ok(report.summary.ok >= 20);
  assert.ok(report.groups.every((group) => group.checks.length > 0));
  assert.equal(report.suggestions.length, 0);
  assert.ok(!JSON.stringify(report).includes(SECRET_DEEPSEEK));
});

test('doctor flags missing models and suggests fetch-models.sh', async (t) => {
  const world = await createWorld(t);
  await world.startFakeDaemon();
  await fs.rm(path.join(world.models.kws, 'en.phone'));
  await fs.rm(path.join(world.models.kws, 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx'));
  await fs.rm(path.join(world.models.offline, 'model.int8.onnx'));
  const { code, stdout } = await world.run();
  assert.notEqual(code, 0, 'missing models must fail the exit code');
  assert.match(stdout, /✗ 唤醒词模型不完整/);
  assert.match(stdout, /✗ 离线识别模型缺失/);
  assert.match(stdout, /fetch-models\.sh/);
  const report = parseJson((await world.run(['--json'])).stdout);
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
  const failing = report.groups.flatMap((group) => group.checks).filter((check) => check.status === 'fail');
  assert.ok(failing.some((check) => check.id === 'models.kws'));
  assert.ok(failing.some((check) => check.id === 'models.offline'));
  assert.ok(report.suggestions.some((suggestion) => suggestion.command.includes('fetch-models.sh')));
});

test('doctor flags missing keys without leaking anything', async (t) => {
  const world = await createWorld(t);
  await world.startFakeDaemon();
  delete world.config.deepseek.apiKey;
  delete world.config.minimax.apiKey;
  await world.writeConfig();
  const { code, stdout } = await world.run();
  assert.notEqual(code, 0);
  assert.match(stdout, /✗ LLM key（deepseek）: 未配置/);
  assert.match(stdout, /✗ MiniMax key: 未配置/);
  const report = parseJson((await world.run(['--json'])).stdout);
  const failing = report.groups.flatMap((group) => group.checks).filter((check) => check.status === 'fail');
  assert.ok(failing.some((check) => check.id === 'config.llm-key'));
  assert.ok(failing.some((check) => check.id === 'config.minimax-key'));
});

test('doctor flags a stopped daemon and a stale overlay, and --fix restarts them', async (t) => {
  const world = await createWorld(t);
  await world.startFakeDaemon();
  const failing = await world.run([], { STUB_FIGARO_STATUS: 'inactive', STUB_FIGARO_PID: '0', STUB_UI_STATUS: 'inactive', STUB_UI_PID: '0' });
  assert.notEqual(failing.code, 0);
  assert.match(failing.stdout, /✗ 守护进程 figaro: inactive/);
  assert.match(failing.stdout, /! 桌面 overlay figaro-ui: inactive/);
  assert.match(failing.stdout, /systemctl --user restart figaro/);

  // --fix applies the safe actions; the stub flips to active after restart.
  const fixed = await world.run(['--json', '--fix'], { STUB_FIGARO_STATUS: 'inactive', STUB_FIGARO_PID: '0', STUB_UI_STATUS: 'inactive', STUB_UI_PID: '0' });
  const report = parseJson(fixed.stdout);
  assert.ok(report.fixesApplied.some((fix) => fix.kind === 'restart-daemon' && fix.ok), 'daemon restart recorded');
  assert.ok(report.fixesApplied.some((fix) => fix.kind === 'restart-ui' && fix.ok), 'overlay restart recorded');
  assert.equal(fixed.code, 0, 'after fixes the daemon/overlay are active again');
  assert.equal(report.summary.fail, 0);
});

test('doctor flags a configured sink that does not exist', async (t) => {
  const world = await createWorld(t);
  await world.startFakeDaemon();
  world.config.tts.sink = 'does-not-exist';
  await world.writeConfig();
  const { code, stdout } = await world.run();
  assert.notEqual(code, 0);
  assert.match(stdout, /✗ tts\.sink="does-not-exist" 不存在/);
  assert.match(stdout, /figaro settings/);
  const report = parseJson((await world.run(['--json'])).stdout);
  const failing = report.groups.flatMap((group) => group.checks).filter((check) => check.status === 'fail');
  assert.ok(failing.some((check) => check.id === 'audio.sink'));
});

test('doctor flags muted output and low mic gain with copy-paste fixes', async (t) => {
  const world = await createWorld(t);
  await world.startFakeDaemon();
  const { code, stdout } = await world.run([], {
    STUB_SINK_MUTE: 'yes',
    STUB_AMIXER_FILE: world.amixerLow,
  });
  assert.equal(code, 0, 'warnings alone do not fail the exit code');
  assert.match(stdout, /! 输出设备被静音/);
  assert.match(stdout, /pactl set-sink-mute sink-a 0/);
  assert.match(stdout, /! 采集增益偏低/);
  assert.match(stdout, /amixer -c 0 sset Capture 45/);
});

test('doctor jsons keep the exit code contract (✗ -> 1, warnings -> 0)', async (t) => {
  const world = await createWorld(t);
  await world.startFakeDaemon();
  const warnReport = parseJson((await world.run(['--json'], { STUB_SINK_MUTE: 'yes' })).stdout);
  assert.equal(warnReport.ok, true);
  assert.equal(warnReport.exitCode, 0);
  assert.ok(warnReport.summary.warn >= 1);

  const failReport = parseJson((await world.run(['--json'], { STUB_FIGARO_STATUS: 'inactive', STUB_FIGARO_PID: '0' })).stdout);
  assert.equal(failReport.ok, false);
  assert.equal(failReport.exitCode, 1);
  assert.ok(Array.isArray(failReport.suggestions));
  assert.ok(failReport.suggestions.some((suggestion) => suggestion.command.includes('restart figaro')));
});
