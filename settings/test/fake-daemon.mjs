// Fake Figaro daemon for developing and demoing the macOS-style settings GUI
// without a microphone, a TTS key or the real agent.
//
// It speaks the *full* docs/ipc.md contract: §3 base messages plus every §3.1
// settings/self-test message (config get/set, mic / asr / wake / tts tests,
// service.restart, diagnostics). It never touches production paths:
//   - default socket: $XDG_RUNTIME_DIR/figaro-settings-test/sock
//   - default config: $XDG_RUNTIME_DIR/figaro-settings-test/config.json
// and it refuses to start if either path resolves to the production location
// ($XDG_RUNTIME_DIR/figaro/sock, ~/.config/figaro/config.json).
//
// Usage:
//   node settings/test/fake-daemon.mjs               # normal
//   node settings/test/fake-daemon.mjs --verbose     # log every message
//   node settings/test/fake-daemon.mjs --socket=/tmp/x/sock --config=/tmp/x/config.json
//   node settings/test/fake-daemon.mjs --duration=600000   # auto-exit after 10 min
//   FIGARO_SOCKET=... node settings/test/fake-daemon.mjs   # GUI will use the same env
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Arguments / paths (and the production-path guard)
// ---------------------------------------------------------------------------
function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
const home = process.env.HOME || '/home/mzpr00';
const verbose = process.argv.includes('--verbose');
const durationMs = Number(argValue('duration') || 0);

const defaultSocket = path.join(runtimeDir, 'figaro-settings-test', 'sock');
const defaultConfig = path.join(runtimeDir, 'figaro-settings-test', 'config.json');
const socketPath = path.resolve(argValue('socket') || process.env.FIGARO_SOCKET || defaultSocket);
const configPath = path.resolve(
  argValue('config') || process.env.FIGARO_SETTINGS_FAKE_CONFIG || defaultConfig,
);

const PROD_SOCKETS = new Set([
  path.resolve(path.join(runtimeDir, 'figaro', 'sock')),
  '/run/user/1000/figaro/sock',
  '/tmp/figaro/sock',
]);
const PROD_CONFIGS = new Set([
  path.resolve(path.join(home, '.config', 'figaro', 'config.json')),
  `/home/${process.env.USER || 'mzpr00'}/.config/figaro/config.json`,
]);

if (PROD_SOCKETS.has(socketPath)) {
  console.error(`[fake] REFUSING to listen on the production socket ${socketPath}`);
  process.exit(2);
}
if (PROD_CONFIGS.has(configPath)) {
  console.error(`[fake] REFUSING to write the production config ${configPath}`);
  process.exit(2);
}

fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
try {
  fs.unlinkSync(socketPath);
} catch {}

// ---------------------------------------------------------------------------
// Fake config: same shape as src/config.js DEFAULTS, minus the API keys.
// The GUI is allowed to patch only the §3.1 tunables, but config.set merges
// deeply like the real daemon does, so anything is fair game here.
// ---------------------------------------------------------------------------
const DEFAULTS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', maxToolRounds: 24 },
  minimax: {
    baseUrl: 'https://api.minimax.cn',
    model: 'speech-2.6-turbo',
    voiceId: 'male-qn-jingying',
    speed: 1.0,
  },
  asr: {
    // null = repo bundled bilingual KWS model; a path overrides it.
    modelDir: null,
    wakeWords: ['费加罗', '菲加罗', '飞加罗', 'figaro', '费加'],
    wakeWordsEn: ['figaro', 'hey figaro'],
    device: 'default',
    hotkey: 'F9',
    sensitivity: 'low',
    wakeCooldownMs: 2500,
    inputGainPercent: 45,
    silenceStopMs: 900,
    bargeIn: { enabled: true, minRms: 0.09, echoFactor: 2.5, minMs: 500 },
  },
  interaction: {
    cancelPhrases: ['取消', '算了', '别说了', '停下', '停止', '不用了', '退出'],
    dismissPhrases: ['退下', '退下吧', '先退下', '你可以退下了', '可以退下了', '休息吧', '没事了', '结束吧', '关了'],
    followUpWindowMs: 7000,
    followUpMinRms: 0.012,
    followUpMinMs: 180,
  },
  sfx: {
    enabled: true,
    volume: 0.35,
  },
  ui: {
    scale: 1.0,
    shape: 'orb',
    motion: 'auto',
    windowButtonSize: 16,
  },
  tts: {
    enabled: true,
    sink: 'alsa_output.pci-0000_00_1f.3.analog-stereo',
    ack: { enabled: true, phrases: ['我在', '在的', '请指示'], timeoutMs: 800 },
  },
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}
// Mirrors src/daemon.js: TTS snapshots are rebuilt, three ASR fields hot-swap,
// everything else (barge-in, interaction, wake words, asr.enabled) needs a
// daemon restart today. Keep this in sync with the real daemon so the GUI demo
// shows the same 已生效/需重启 states.
const HOT_PATHS = [
  'asr.sensitivity',
  'asr.wakeCooldownMs',
  'asr.inputGainPercent',
  // the real daemon hot-switches barge-in through asr.applyRuntimeConfig
  'asr.bargeIn.enabled',
  'asr.bargeIn.minRms',
  'asr.bargeIn.echoFactor',
  'asr.bargeIn.minMs',
  // interaction settings are pure daemon state and re-read instantly
  'interaction.followUpWindowMs',
  'interaction.followUpMinRms',
  'interaction.followUpMinMs',
  'interaction.dismissPhrases',
  'interaction.cancelPhrases',
  // ui.* are hot-applied: the daemon re-emits a {type:"ui"} frame
  'sfx.enabled',
  'sfx.volume',
  'ui.scale',
  'ui.shape',
  'ui.motion',
  'ui.windowButtonSize',
  'tts.sink',
  'tts.model',
  'tts.voiceId',
  'tts.speed',
];

function flattenPaths(patch, prefix = '') {
  const out = [];
  if (!isPlainObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && Object.keys(value).length > 0) out.push(...flattenPaths(value, path));
    else out.push(path);
  }
  return out;
}

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}
let config = deepMerge(DEFAULTS, readConfigFile());
function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
// Never print secrets (apiKey) into logs.
function redactPatch(value) {
  if (Array.isArray(value)) return value.map(redactPatch);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /apiKey$/i.test(k) ? '***' : redactPatch(v);
    }
    return out;
  }
  return value;
}

function uiSnapshot() {
  const ui = config.ui || {};
  const size = Number(ui.windowButtonSize);
  return {
    type: 'ui',
    scale: Number.isFinite(Number(ui.scale)) ? Math.min(2, Math.max(0.5, Number(ui.scale))) : 1.0,
    shape: ['orb', 'ball', 'line'].includes(ui.shape) ? ui.shape : 'orb',
    motion: ui.motion === 'off' ? 'off' : 'auto',
    windowButtonSize: Number.isFinite(size) && size >= 12 && size <= 24 ? size : 16,
  };
}

// The real daemon maps the docs/ipc.md §3.1 aliases tts.voiceId/model/speed
// onto minimax.* before exposing the effective config (src/daemon.js
// applyTtsAliases). Mirror that so the GUI reads the same thing here.
function applyTtsAliases(target) {
  const tts = target && target.tts;
  if (!tts || typeof tts !== 'object') return target;
  const minimax = { ...(target.minimax || {}) };
  if (typeof tts.voiceId === 'string' && tts.voiceId.trim().length > 0) minimax.voiceId = tts.voiceId.trim();
  if (typeof tts.model === 'string' && tts.model.trim().length > 0) minimax.model = tts.model.trim();
  if (Number.isFinite(Number(tts.speed)) && Number(tts.speed) > 0) minimax.speed = Number(tts.speed);
  target.minimax = minimax;
  return target;
}

// config.get must never leak secrets (docs/ipc.md §3.1).
function publicConfig() {
  const c = JSON.parse(JSON.stringify(config));
  applyTtsAliases(c);
  // Same as src/agent/settings.js sanitizeConfig: secrets become "***"; the
  // GUI can only tell that a key is stored, never read it back.
  // Mask only stored keys; an unset key stays "" so the GUI can show 未设置.
  c.deepseek = c.deepseek || {};
  c.deepseek.apiKey = config.deepseek && typeof config.deepseek.apiKey === 'string' && config.deepseek.apiKey.length > 0
    ? '***' : '';
  c.minimax = c.minimax || {};
  c.minimax.apiKey = config.minimax && typeof config.minimax.apiKey === 'string' && config.minimax.apiKey.length > 0
    ? '***' : '';
  return c;
}
saveConfig();

const startedAt = Date.now();
const version = '0.1.0-fake';
// Fixed timestamps: diagnostics is polled periodically and the GUI de-dupes
// entries by (time, message), so a moving timestamp would duplicate them.
const fakeErrorTimes = [startedAt + 1_000, startedAt + 8_000];

// ---------------------------------------------------------------------------
// Server / clients / broadcast
// ---------------------------------------------------------------------------
const clients = new Set();
let server = null;
let currentState = 'idle';
let currentPartial = '';
let currentTool = '';
let wakeTestStats = { hits: 0, misses: 0, falseAlarms: 0, noise: false, startedAt: 0, maxScore: 0 };

function log(...args) {
  console.log('[fake]', ...args);
}

function bindServer() {
  server = net.createServer((socket) => {
    clients.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          send(socket, { type: 'error', message: 'invalid json' });
          continue;
        }
        try {
          handle(socket, msg);
        } catch (err) {
          send(socket, { type: 'error', message: String(err && err.message ? err.message : err) });
        }
      }
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
  server.listen(socketPath);
  server.on('error', (err) => log('server error:', err.message));
}

function send(socket, msg) {
  if (!socket || socket.destroyed) return false;
  try {
    socket.write(JSON.stringify(msg) + '\n');
    return true;
  } catch {
    return false;
  }
}

function broadcast(msg) {
  const line = JSON.stringify(msg) + '\n';
  for (const c of clients) {
    try {
      c.write(line);
    } catch {}
  }
}

function setState(state) {
  currentState = state;
  broadcast({ type: 'state', state });
}

// ---------------------------------------------------------------------------
// Timer bookkeeping: every self-test owns at most one interval per client.
// ---------------------------------------------------------------------------
const timers = new Map(); // key -> { interval, timeout, meta }
function clearTest(key) {
  const t = timers.get(key);
  if (!t) return null;
  if (t.interval) clearInterval(t.interval);
  if (t.timeout) clearTimeout(t.timeout);
  timers.delete(key);
  return t;
}
function clearAllTests() {
  for (const key of [...timers.keys()]) clearTest(key);
}

// ---------------------------------------------------------------------------
// Slightly realistic signal generators
// ---------------------------------------------------------------------------
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// KWS-like score simulator: a low, jittery floor with occasional short
// "word candidate" bursts that spike past the detection threshold. In noise
// mode bursts are more frequent (background music / nearby conversation), which
// is exactly what the false-wake test is supposed to expose.
function newWakeSim({ noise = false } = {}) {
  let value = rand(0.03, 0.14);
  let burstLeft = 0;
  let burstHit = false;
  return {
    tick() {
      let hit = null;
      const threshold = noise ? 0.78 : 0.8;
      if (burstLeft > 0) {
        burstLeft -= 1;
        // Short high-score burst: a candidate word rolling through the KWS.
        value = clamp(rand(0.6, 0.98), 0.01, 0.99);
        if (!burstHit && value > threshold) {
          burstHit = true;
          hit = { score: Math.round(value * 1000) / 1000 };
        }
      } else {
        value += rand(-0.035, 0.035) + (0.08 - value) * 0.06;
        value = clamp(value, 0.01, 0.42);
        const chance = noise ? 0.045 : 0.028;
        if (Math.random() < chance) {
          burstLeft = Math.round(rand(5, 10));
          burstHit = false;
        }
      }
      return { score: Math.round(value * 1000) / 1000, hit };
    },
  };
}

function newMicSim(gainPercent) {
  const gain = clamp(Number(gainPercent) / 40 || 1, 0.15, 3);
  let phase = rand(0, 6.28);
  return {
    tick() {
      phase += rand(0.25, 0.6);
      // Calibrated to the measured real-world range: room floor ~0.002-0.01,
      // normal speech median ~0.036, loud syllable ~0.09.
      const speech = Math.abs(Math.sin(phase * 1.7)) * (0.35 + 0.4 * Math.abs(Math.sin(phase * 0.31)));
      const noise = rand(0.002, 0.008);
      const rms = clamp((speech * 0.10 + noise) * gain);
      const peak = clamp(rms * rand(1.6, 2.4) + rand(0.004, 0.02) * gain);
      return {
        rms: Math.round(rms * 1000) / 1000,
        peak: Math.round(peak * 1000) / 1000,
        level: Math.round(clamp(rms * 1.6) * 1000) / 1000,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Message handlers: base protocol (§3)
// ---------------------------------------------------------------------------
function handle(socket, msg) {
  if (verbose) log('<<', JSON.stringify(msg).slice(0, 220));

  switch (msg.type) {
    // ---- §3 base protocol -------------------------------------------------
    case 'subscribe': {
      socket.write(
        JSON.stringify({ type: 'state', state: currentState }) + '\n',
      );
      if (currentPartial) send(socket, { type: 'partial', text: currentPartial });
      if (currentTool) send(socket, { type: 'tool', name: 'bash', status: 'start', summary: currentTool });
      log('client subscribed');
      return;
    }
    case 'ping':
      return send(socket, { type: 'pong' });
    case 'ask':
      log('ask:', msg.text);
      currentPartial = '好的，我来看看。';
      setState('thinking');
      broadcast({ type: 'partial', text: currentPartial });
      setTimeout(() => {
        broadcast({ type: 'tool', name: 'bash', status: 'start', summary: '正在运行 bash…' });
        setTimeout(() => {
          broadcast({ type: 'tool', name: 'bash', status: 'end' });
          broadcast({ type: 'reply', text: '好了，已经处理完了。' });
          currentPartial = '';
          setState('idle');
        }, 900);
      }, 500);
      return;
    case 'cancel':
      currentPartial = '';
      setState('idle');
      return;
    case 'wake':
      setState('listening');
      currentPartial = '费加罗';
      broadcast({ type: 'partial', text: currentPartial });
      return;
    case 'listen_begin':
      setState('listening');
      return;
    case 'listen_end':
      setState('thinking');
      return;

    // ---- §3.1 config ------------------------------------------------------
    case 'config.get':
      return send(socket, { type: 'config', id: msg.id, config: publicConfig() });

    case 'config.set': {
      const changed = flattenPaths(msg.patch || {});
      config = deepMerge(config, msg.patch || {});
      saveConfig();
      const applied = changed.filter((path) => HOT_PATHS.includes(path));
      // apiKey/modelDir/other non-hot paths need a daemon restart.
      const restartRequired = changed.filter((path) => !HOT_PATHS.includes(path));
      const uiChanged = changed.filter((path) => path.startsWith('ui.'));
      log('config.set:', JSON.stringify(redactPatch(msg.patch)), 'applied=', applied.join(','), 'restart=', restartRequired.join(','));
      const reply = {
        type: 'config',
        id: msg.id,
        ok: true,
        applied,
        restartRequired,
        config: publicConfig(),
      };
      // Send the reply by hand so the ui frame only reaches this client after it.
      send(socket, reply);
      if (uiChanged.length > 0) broadcast(uiSnapshot());
      return true;
    }

    // ---- §3.1 microphone test --------------------------------------------
    case 'test.mic.start': {
      clearTest('mic');
      const ms = Number(msg.ms || 4000);
      const gainPercent = config.asr.inputGainPercent;
      const sim = newMicSim(gainPercent);
      const started = Date.now();
      const interval = setInterval(() => {
        const s = sim.tick();
        send(socket, { type: 'mic', id: msg.id, ...s, t: Date.now() - started });
      }, 50);
      const timeout = setTimeout(() => {
        clearTest('mic');
        send(socket, { type: 'mic.end', id: msg.id, reason: 'timeout' });
      }, ms);
      timers.set('mic', { interval, timeout });
      return;
    }
    case 'test.mic.stop':
      clearTest('mic');
      return send(socket, { type: 'mic.end', id: msg.id, reason: 'stopped' });

    // ---- §3.1 one-shot recording -> transcription test --------------------
    case 'test.asr.start': {
      clearTest('asr');
      // Deliberately one homophone off so the GUI's char-level accuracy has something to show.
      const finalText = '费加罗，帮我打开设置面板，把灵敏度调到低挡。';
      const streamingText = '费加罗帮我打开设置面板把灵敏度调到低档';
      const partials = ['费', '费加', '费加罗', '费加罗帮', '费加罗帮我', '费加罗帮我打开', '费加罗帮我打开设置', '费加罗帮我打开设置面板', '费加罗帮我打开设置面板把灵敏度', '费加罗帮我打开设置面板把灵敏度调到低档'];
      let i = 0;
      const started = Date.now();
      const interval = setInterval(() => {
        if (i < partials.length) {
          send(socket, { type: 'partial', id: msg.id, text: partials[i] });
          i += 1;
        }
      }, 260);
      const timeout = setTimeout(() => {
        clearTest('asr');
        const audioMs = Date.now() - started;
        send(socket, { type: 'partial', id: msg.id, text: streamingText });
        send(socket, {
          type: 'test.asr.result',
          id: msg.id,
          text: finalText,
          streamingText,
          ms: 860 + Math.round(rand(0, 260)),
          audioMs,
        });
      }, 2600);
      timers.set('asr', { interval, timeout });
      return;
    }
    case 'test.asr.stop': {
      clearTest('asr');
      return send(socket, {
        type: 'test.asr.result',
        id: msg.id,
        text: '费加罗，帮我打开设置面板。',
        streamingText: '费加罗帮我打开设置面板',
        ms: 430,
        audioMs: 700,
      });
    }

    // ---- §3.1 wake-word / false-positive test ---------------------------
    case 'test.wake.arm': {
      clearTest('wake');
      const ms = Number(msg.ms || 15000);
      const noise = Boolean(msg.noise);
      const sim = newWakeSim({ noise });
      const started = Date.now();
      wakeTestStats = { hits: 0, misses: 0, falseAlarms: 0, noise, startedAt: started, maxScore: 0 };
      send(socket, { type: 'ack', id: msg.id, test: 'wake', ms });
      let hits = 0;
      let misses = 0;
      let falseAlarms = 0;
      let lastHitAt = 0;
      const interval = setInterval(() => {
        const { score, hit } = sim.tick();
        wakeTestStats.maxScore = Math.max(wakeTestStats.maxScore, score);
        send(socket, { type: 'wake.score', id: msg.id, score, keyword: '费加罗' });
        if (hit && Date.now() - lastHitAt > 1200) {
          lastHitAt = Date.now();
          const latency = 110 + Math.round(rand(0, 240));
          const hitMsg = {
            type: 'wake.hit',
            id: msg.id,
            score: hit.score,
            latencyMs: latency,
            keyword: '费加罗',
            falseAlarm: noise,
            t: Date.now() - started,
          };
          broadcast(hitMsg);
          if (noise) falseAlarms += 1;
          else hits += 1;
          wakeTestStats.hits = hits;
          wakeTestStats.misses = misses;
          wakeTestStats.falseAlarms = falseAlarms;
        }
      }, 100);
      // Demo determinism: non-noise self-tests get one real hit early, so the
      // guided wizard can be walked end-to-end without random misses.
      const forcedHit = noise ? null : setTimeout(() => {
        if (!timers.has('wake')) return;
        const score = 0.9 + rand(0, 0.05);
        send(socket, { type: 'wake.score', id: msg.id, score, keyword: '费加罗' });
        broadcast({
          type: 'wake.hit',
          id: msg.id,
          score,
          latencyMs: 180 + Math.round(rand(0, 120)),
          keyword: '费加罗',
          falseAlarm: false,
          t: Date.now() - started,
        });
        hits += 1;
        wakeTestStats.hits = hits;
        wakeTestStats.maxScore = Math.max(wakeTestStats.maxScore, score);
      }, 1200 + rand(0, 600));
      if (timers.has('wake') && timers.get('wake')) timers.get('wake').forcedHit = forcedHit;
      const timeout = setTimeout(() => {
        if (forcedHit) clearTimeout(forcedHit);
        clearTest('wake');
        if (!noise && hits === 0) misses = 1;
        send(socket, {
          type: 'test.wake.end',
          id: msg.id,
          hits,
          misses,
          falseAlarms,
          maxScore: Math.round(wakeTestStats.maxScore * 100) / 100,
          durationMs: Date.now() - started,
          noise,
        });
      }, ms);
      timers.set('wake', { interval, timeout });
      return;
    }
    case 'test.wake.disarm':
      clearTest('wake');
      return send(socket, {
        type: 'test.wake.end',
        id: msg.id,
        hits: wakeTestStats.hits,
        misses: wakeTestStats.misses,
        falseAlarms: wakeTestStats.falseAlarms,
        maxScore: Math.round(wakeTestStats.maxScore * 100) / 100,
        durationMs: Date.now() - wakeTestStats.startedAt,
        noise: wakeTestStats.noise,
        reason: 'stopped',
      });

    // ---- §3.1 TTS preview -------------------------------------------------
    case 'test.tts': {
      const ms = 90 + Math.round(rand(0, 260));
      setTimeout(() => {
        send(socket, { type: 'test.tts.result', id: msg.id, ms, ok: true });
      }, 220 + ms);
      return;
    }

    // ---- §3.1 development-only: play a "wake" burst ----------------------
    // Extensions used by the fake only; the GUI never requires them.
    case 'fake.emitHit': {
      broadcast({
        type: 'wake.hit',
        score: 0.91,
        latencyMs: 180,
        keyword: '费加罗',
        falseAlarm: Boolean(msg.falseAlarm),
      });
      return;
    }
    case 'fake.reset': {
      config = deepMerge(DEFAULTS, {});
      saveConfig();
      return send(socket, { type: 'config', id: msg.id, config: publicConfig() });
    }

    // ---- §3.1 diagnostics / service restart ------------------------------
    case 'diagnostics':
      return send(socket, { ...diagnostics(), id: msg.id });

    case 'service.restart':
      return handleRestart(socket, msg);

    default:
      // Unknown message: log it; the real daemon would ignore it too.
      log('IGNORED unknown message type:', msg.type);
      return;
  }
}

// ---------------------------------------------------------------------------
// §3.1 service.restart: ack, drop clients, rebind the socket
// ---------------------------------------------------------------------------
async function handleRestart(socket, msg) {
  send(socket, { type: 'ack', id: msg.id, action: 'restart' });
  log('service.restart requested; simulating a daemon restart');
  clearAllTests();
  setTimeout(() => {
    for (const c of clients) {
      try {
        c.end();
      } catch {}
    }
    clients.clear();
    server.close();
    server = null;
    setTimeout(() => {
      bindServer();
      log('daemon "restarted"; listening again on', socketPath);
    }, 1200);
  }, 250);
}

// ---------------------------------------------------------------------------
// §3.1 diagnostics
// ---------------------------------------------------------------------------
function diagnostics() {
  const mic = newMicSim(config.asr.inputGainPercent).tick();
  const effective = applyTtsAliases(JSON.parse(JSON.stringify(config)));
  return {
    type: 'diagnostics',
    configPath,
    logPath: 'journalctl --user -u figaro',
    socketPath,
    version: `${version} (self-test daemon)`,
    pid: process.pid,
    state: currentState,
    uptimeMs: Date.now() - startedAt,
    asr: {
      available: true,
      state: 'idle',
      capturing: false,
      modelDir: config.asr.modelDir ?? null,
      sensitivity: config.asr.sensitivity,
      wakeCooldownMs: config.asr.wakeCooldownMs,
      inputGainPercent: config.asr.inputGainPercent,
      hotkey: config.asr.hotkey,
      hotkeyState: { state: 'active', bound: true, started: true, session: 'fake-session' },
      muted: false,
      wakeWordsEn: config.asr.wakeWordsEn,
      bargeIn: {
        enabled: config.asr.bargeIn.enabled !== false,
        minRms: Number(config.asr.bargeIn.minRms),
        echoFactor: Number(config.asr.bargeIn.echoFactor),
        minMs: Number(config.asr.bargeIn.minMs),
      },
      modelInfo: {
        threads: { kws: 2, streaming: 2, offline: 4 },
        sensitivity: config.asr.sensitivity,
        kwsParams: { keywordsScore: 1.6, keywordsThreshold: 0.3 },
        wakeCooldownMs: config.asr.wakeCooldownMs,
        inputGainPercent: config.asr.inputGainPercent,
        lastFinalMs: 860,
        offlineLoaded: true,
        offlineLoadError: null,
        kwsDir: 'models/kws',
        streamingDir: 'models/asr-stream',
        offlineDir: 'models/asr-offline',
        vadModel: 'models/vad',
        kws: 'kws',
        keywords: config.asr.wakeWords,
        streaming: true,
        offline: 'paraformer',
        vad: 'silero',
      },
      lastFinalMs: 860,
    },
    tts: {
      available: true,
      model: effective.minimax.model,
      voiceId: effective.minimax.voiceId,
      sink: effective.tts.sink,
      sinkStatus: 'ok',
      speaking: false,
      connected: true,
      // Candidate sinks for the GUI picker, same shape as the real daemon
      // ({name, description, isDefault, isCurrent}, see src/agent/settings.js).
      sinks: [
        { name: 'alsa_output.pci-0000_00_1f.3.analog-stereo', description: '内置模拟立体声', isDefault: true, isCurrent: config.tts.sink === 'alsa_output.pci-0000_00_1f.3.analog-stereo' },
        { name: 'alsa_output.pci-0000_01_00.1.hdmi-stereo', description: 'HDMI / 显示器', isDefault: false, isCurrent: config.tts.sink === 'alsa_output.pci-0000_01_00.1.hdmi-stereo' },
        { name: 'bluez_output.00_11_22_33_44_55.1', description: '蓝牙耳机', isDefault: false, isCurrent: config.tts.sink === 'bluez_output.00_11_22_33_44_55.1' },
        { name: '', description: '系统默认输出', isDefault: false, isCurrent: !config.tts.sink },
      ],
    },
    ack: {
      enabled: config.tts.ack.enabled,
      ready: true,
      timeoutMs: config.tts.ack.timeoutMs,
      phrases: config.tts.ack.phrases,
      model: config.minimax.model,
      voiceId: config.minimax.voiceId,
      lastPhrase: '我在',
      lastPlayDurationMs: 212,
      failures: 0,
      reason: null,
    },
    mic: {
      gainPercent: config.asr.inputGainPercent,
      rms: mic.rms,
      peak: mic.peak,
      fixed: config.asr.inputGainPercent !== null,
    },
    latency: {
      wakeToAckMs: 232,
      ttsFirstByteMs: 381,
      ttsFirstAudioMs: 381,
      ttsRequestToFirstAudioMs: 402,
      ackLastPlayDurationMs: 212,
      ackLastFirstWriteMs: 168,
      asrLastFinalMs: 860,
      asrFinalMs: 860,
      asrPartialMs: 148,
    },
    recentErrors: [
      { at: new Date(fakeErrorTimes[0]).toISOString(), message: 'TTS 连接超时一次，已自动重试（fake）' },
      { at: new Date(fakeErrorTimes[1]).toISOString(), message: 'KWS 模型热加载完成（fake）' },
    ],
    ui: uiSnapshot(),
    sfx: {
      enabled: config.sfx.enabled !== false,
      volume: Number(config.sfx.volume),
    },
    interaction: {
      followUpWindowMs: Number(config.interaction.followUpWindowMs) || 0,
      followUpMinRms: Number(config.interaction.followUpMinRms),
      followUpMinMs: Number(config.interaction.followUpMinMs),
      dismissPhrases: config.interaction.dismissPhrases,
      cancelPhrases: config.interaction.cancelPhrases,
    },
    tests: { mic: false, asr: false, wake: false },
  };
}

// ---------------------------------------------------------------------------
// Boot / shutdown
// ---------------------------------------------------------------------------
function shutdown(reason) {
  clearAllTests();
  for (const c of clients) {
    try {
      c.end();
    } catch {}
  }
  if (server) server.close();
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {}
  log('shutting down (' + reason + ')');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
if (durationMs > 0) setTimeout(() => shutdown('duration reached'), durationMs);

bindServer();
log('FAKE Figaro daemon (docs/ipc.md §3 + §3.1)');
log('socket :', socketPath);
log('config :', configPath, '(fake; the production config is never touched)');
log('ready; Ctrl-C to quit. Point the GUI at it with:');
log(`  FIGARO_SOCKET=${socketPath}`);
