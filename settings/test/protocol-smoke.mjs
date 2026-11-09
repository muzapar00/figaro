// Protocol smoke test for the self-test daemon + settings GUI contract.
//
// Exercises every message in docs/ipc.md §3 and §3.1 against a running fake
// daemon and checks the replies/event streams. Run it with the fake daemon up:
//
//   node settings/test/fake-daemon.mjs --duration=60000 &
//   FIGARO_SOCKET=/run/user/1000/figaro-settings-test/sock \
//     node settings/test/protocol-smoke.mjs
//
// Exit code 0 = every check passed.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
const socketPath = process.argv.find((a) => a.startsWith('--socket='))?.slice(9)
  || process.env.FIGARO_SOCKET
  || path.join(runtimeDir, 'figaro-settings-test', 'sock');

if (!fs.existsSync(socketPath)) {
  console.error(`[smoke] no socket at ${socketPath} — start settings/test/fake-daemon.mjs first`);
  process.exit(2);
}

const socket = net.createConnection(socketPath);
socket.setEncoding('utf8');
let buffer = '';
const seen = [];
const waiters = new Map();
let nextId = 1;
let connected = false;

function send(msg) {
  socket.write(JSON.stringify(msg) + '\n');
}

// Poll `cond` until true (used for connection state changes).
function waitFor(cond, { timeout = 5000, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${label} (${timeout}ms)`));
      }
    }, 25);
  });
}

// Poll the received-frame list until a matching frame arrives.
function waitForFrame(predicate, { timeout = 5000, label = 'frame' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = seen.find(predicate);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${label} (${timeout}ms)`));
      }
    }, 25);
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function request(type, fields = {}, { timeout = 5000 } = {}) {
  const id = nextId++;
  send({ type, id, ...fields });
  return waitForFrame((m) => m.id === id && m.type !== 'ack', { timeout, label: type });
}

socket.on('connect', () => {
  connected = true;
});
socket.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      seen.push(JSON.parse(line));
    } catch {}
  }
});
socket.on('error', (err) => {
  console.error('[smoke] socket error:', err.message);
  process.exit(1);
});

async function run() {
  await waitFor(() => connected, { label: 'connect', timeout: 3000 });

  // ---- §3 base protocol ---------------------------------------------------
  send({ type: 'ping' });
  await waitForFrame((m) => m.type === 'pong', { label: 'pong' });
  check('§3 ping -> pong', true);

  send({ type: 'subscribe' });
  const state = await waitForFrame((m) => m.type === 'state', { label: 'state replay' });
  check('§3 subscribe -> state replay', ['idle', 'listening', 'thinking', 'speaking'].includes(state.state), `state=${state.state}`);

  // ---- §3.1 config --------------------------------------------------------
  const cfg = await request('config.get');
  check('§3.1 config.get -> config', cfg.type === 'config' && typeof cfg.config === 'object');
  check('§3.1 config.get is desensitized', !cfg.config.deepseek?.apiKey && !cfg.config.minimax?.apiKey);

  const patched = await request('config.set', { patch: { asr: { sensitivity: 'high' } } });
  check('§3.1 config.set -> merged config', patched.type === 'config' && patched.config.asr.sensitivity === 'high', `sensitivity=${patched.config.asr.sensitivity}`);
  await request('config.set', { patch: { asr: { sensitivity: 'low' } } }); // restore

  // ---- §3.1 diagnostics ---------------------------------------------------
  const diag = await request('diagnostics');
  check('§3.1 diagnostics -> diagnostics', diag.type === 'diagnostics' && !!diag.configPath && !!diag.asr && !!diag.tts && !!diag.latency);
  check('§3.1 diagnostics has mic + recent errors', typeof diag.mic?.gainPercent === 'number' && Array.isArray(diag.recentErrors), `errors=${diag.recentErrors.length}`);

  // ---- §3.1 microphone stream --------------------------------------------
  send({ type: 'test.mic.start', id: 900, ms: 700 });
  const mic = await waitForFrame((m) => m.type === 'mic', { label: 'mic frame' });
  check('§3.1 test.mic.start -> mic frames', typeof mic.rms === 'number' && typeof mic.peak === 'number' && typeof mic.level === 'number', `rms=${mic.rms} peak=${mic.peak}`);
  await waitForFrame((m) => m.type === 'mic.end' && m.id === 900, { timeout: 3000, label: 'mic.end' });
  check('§3.1 test.mic.start -> mic.end', true);

  // ---- §3.1 one-shot asr test --------------------------------------------
  const partialSeen = [];
  const partialPromise = new Promise((resolve) => {
    const timer = setInterval(() => {
      const p = seen.filter((m) => m.type === 'partial' && m.id === 901);
      if (p.length) {
        partialSeen.push(...p);
        clearInterval(timer);
        resolve();
      }
    }, 40);
  });
  send({ type: 'test.asr.start', id: 901 });
  await partialPromise;
  const asrResult = await waitForFrame((m) => m.type === 'test.asr.result' && m.id === 901, { timeout: 6000, label: 'test.asr.result' });
  check('§3.1 test.asr.start -> partial then result', partialSeen.length > 0 && typeof asrResult.text === 'string' && typeof asrResult.ms === 'number', `partials=${partialSeen.length} audioMs=${asrResult.audioMs}`);

  // ---- §3.1 wake window ---------------------------------------------------
  const scores = [];
  const scoreTimer = setInterval(() => {
    for (const m of seen) if (m.type === 'wake.score' && m.id === 902 && !scores.includes(m)) scores.push(m);
  }, 50);
  send({ type: 'test.wake.arm', id: 902, ms: 1200, noise: true });
  const wakeEnd = await waitForFrame((m) => m.type === 'test.wake.end' && m.id === 902, { timeout: 5000, label: 'test.wake.end' });
  clearInterval(scoreTimer);
  check('§3.1 test.wake.arm -> wake.score frames', scores.length > 0, `frames=${scores.length}`);
  check('§3.1 test.wake.arm -> test.wake.end stats', typeof wakeEnd.hits === 'number' && typeof wakeEnd.falseAlarms === 'number', `hits=${wakeEnd.hits} falseAlarms=${wakeEnd.falseAlarms}`);

  // ---- §3.1 tts preview ---------------------------------------------------
  const tts = await request('test.tts', { text: '你好，我是费加罗。' }, { timeout: 4000 });
  check('§3.1 test.tts -> result with latency', tts.type === 'test.tts.result' && typeof tts.ms === 'number', `ms=${tts.ms}`);

  // ---- §3.1 service restart (drops the connection, then rebinds) --------
  send({ type: 'service.restart', id: 903 });
  await waitForFrame((m) => m.type === 'ack' && m.id === 903, { label: 'restart ack' });
  check('§3.1 service.restart -> ack', true);

  await waitFor(() => socket.destroyed || !socket.writable, { timeout: 4000, label: 'disconnect' }).catch(() => {});
  check('§3.1 service.restart drops the client', socket.destroyed || !socket.writable);

  // reconnect after the simulated restart
  await new Promise((r) => setTimeout(r, 1600));
  const socket2 = net.createConnection(socketPath);
  socket2.setEncoding('utf8');
  const reconnected = await new Promise((resolve) => {
    socket2.once('connect', () => resolve(true));
    socket2.once('error', () => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  socket2.end();
  check('fake daemon rebinds its socket after restart', reconnected);

  // ---- summary ------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[smoke] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error('[smoke] FAILURES:', failed.map((f) => f.name).join('; '));
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error('[smoke] ERROR:', err.message);
  process.exit(1);
});
