// Fake Figaro daemon for developing the overlay without a microphone, TTS, or
// the real agent. Speaks the same NDJSON protocol as the real daemon
// (docs/ipc.md §3) and drives a scripted state cycle.
//
// Usage: node qml/test/fake-daemon.mjs [socketPath]
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const socketFlag = process.argv.slice(2).find((a) => a.startsWith('--socket='));
const socketArg = socketFlag ? socketFlag.slice('--socket='.length) : null;
const socketPath =
  socketArg || path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'figaro-ui-test', 'sock');

fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
try {
  fs.unlinkSync(socketPath);
} catch {}

const clients = new Set();
const server = net.createServer((socket) => {
  clients.add(socket);
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === 'ping') socket.write(JSON.stringify({ type: 'pong' }) + '\n');
      if (msg.type === 'subscribe') {
        socket.write(JSON.stringify({ type: 'state', state: current }) + '\n');
        if (currentPartial) socket.write(JSON.stringify({ type: 'partial', text: currentPartial }) + '\n');
        if (currentTool) socket.write(JSON.stringify({ type: 'tool', name: 'bash', status: 'start', summary: currentTool }) + '\n');
      }
      if (msg.type === 'cancel') console.log('[fake] got cancel');
      if (msg.type === 'quit') shutdown();
      if (msg.type === 'ask') console.log('[fake] got ask:', msg.text ?? '(no text)');
    }
  });
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
  socket.write(JSON.stringify({ type: 'state', state: current }) + '\n');
});
server.listen(socketPath);
console.log('[fake] listening on', socketPath);

let current = 'idle';
let currentPartial = '';
let currentTool = '';
function broadcast(msg) {
  if (msg.type === 'partial') currentPartial = msg.text || '';
  if (msg.type === 'tool') currentTool = msg.status === 'start' ? (msg.summary || msg.name || '') : '';
  if (msg.type === 'state' && msg.state === 'idle') { currentPartial = ''; currentTool = ''; }
  const line = JSON.stringify(msg) + '\n';
  for (const c of clients) {
    try {
      c.write(line);
    } catch {}
  }
}
function setState(state) {
  current = state;
  console.log('[fake] state ->', state);
  broadcast({ type: 'state', state });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Level generator: a plausible syllable envelope.
let levelTimer = null;
function streamLevels(seconds, gain = 1) {
  stopLevels();
  const start = Date.now();
  levelTimer = setInterval(() => {
    if (Date.now() - start > seconds * 1000) return stopLevels();
    const t = (Date.now() - start) / 1000;
    const syll = Math.abs(Math.sin(t * 7.3)) * (0.55 + 0.45 * Math.sin(t * 1.7));
    const v = Math.min(1, syll * gain);
    broadcast({ type: 'level', value: v });
  }, 50);
}
function stopLevels() {
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = null;
}

const cycle = process.argv.includes('--cycle');
const holdState = (() => {
  const i = process.argv.indexOf('--state');
  return i >= 0 ? process.argv[i + 1] : null;
})();

async function runLoop() {
  while (true) {
    setState('listening');
    broadcast({ type: 'partial', text: '费加罗，帮我看看今天有哪些安排，然后把下午三点的会挪到四点，顺便提醒我带充电器' });
    streamLevels(2.6, 1.0);
    await sleep(2600);
    stopLevels();
    setState('thinking');
    await sleep(600);
    broadcast({ type: 'tool', name: 'bash', status: 'start', summary: '正在运行 bash…' });
    await sleep(1200);
    broadcast({ type: 'tool', name: 'bash', status: 'end' });
    broadcast({ type: 'partial', text: '好，我已经把下午三点的会挪到四点，并且加了一条四点二十分出门前带充电器的提醒。今天还有两件事：十点半的项目同步，和晚上七点跟设计组的评审。' });
    await sleep(900);
    setState('speaking');
    streamLevels(3.2, 0.8);
    await sleep(3200);
    stopLevels();
    broadcast({ type: 'reply', text: '好，已经把音量调高了一档。' });
    setState('idle');
    await sleep(2400);
  }
}

if (holdState) {
  setState(holdState);
  if (holdState === 'listening') { broadcast({ type: 'partial', text: '费加罗，帮我看看今天有哪些安排，然后把下午三点的会挪到四点，顺便提醒我带充电器' }); streamLevels(600, 1.0); }
  else if (holdState === 'speaking') { broadcast({ type: 'partial', text: '好，我已经把下午三点的会挪到四点，并且加了一条四点二十分出门前带充电器的提醒。今天还有两件事：十点半的项目同步，和晚上七点跟设计组的评审。' }); streamLevels(600, 0.85); }
  else if (holdState === 'thinking') { broadcast({ type: 'tool', name: 'bash', status: 'start', summary: '正在运行 bash…' }); }
} else if (cycle) {
  runLoop();
} else {
  console.log('[fake] idle; press Ctrl-C to quit. Pass --cycle to run the demo loop.');
}

function shutdown() {
  stopLevels();
  server.close();
  // Only remove the path if this process still owns it: an older instance
  // unlinking a newer instance's socket silently disconnects every client.
  try {
    if (fs.statSync(socketPath).ino === fs.statSync(`/proc/self/fd/0`).ino) {
      // never true; placeholder
    }
  } catch {}
  fs.rmSync(socketPath, { force: true });
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
