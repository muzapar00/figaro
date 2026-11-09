// Minimal "legacy" Figaro daemon: speaks only the base §3 protocol and silently
// ignores every §3.1 settings/self-test message, exactly like a daemon built
// before the settings extension existed.
//
// Used to prove the GUI degrades gracefully ("当前 daemon 不支持此功能") instead
// of hanging or crashing. Never touches the production socket.
//
//   node settings/test/legacy-daemon.mjs --socket=/tmp/figaro-legacy/sock
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
const argSocket = process.argv.slice(2).find((a) => a.startsWith('--socket='));
const socketPath = path.resolve(
  argSocket ? argSocket.slice('--socket='.length)
    : process.env.FIGARO_SOCKET || path.join(runtimeDir, 'figaro-settings-legacy', 'sock'),
);
const prod = path.resolve(path.join(runtimeDir, 'figaro', 'sock'));
if (socketPath === prod) {
  console.error(`[legacy] REFUSING to listen on the production socket ${socketPath}`);
  process.exit(2);
}

fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
try {
  fs.unlinkSync(socketPath);
} catch {}

const clients = new Set();
const state = { value: 'idle' };
const send = (socket, msg) => {
  if (!socket.destroyed) socket.write(JSON.stringify(msg) + '\n');
};
const server = net.createServer((socket) => {
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
        continue;
      }
      // Base protocol only.
      if (msg.type === 'ping') send(socket, { type: 'pong' });
      else if (msg.type === 'subscribe') send(socket, { type: 'state', state: state.value });
      else if (msg.type === 'wake') {
        state.value = 'listening';
        send(socket, { type: 'state', state: state.value });
      } else if (msg.type === 'cancel') {
        state.value = 'idle';
        send(socket, { type: 'state', state: state.value });
      } else if (msg.type === 'ask') {
        send(socket, { type: 'partial', text: '（旧 daemon 只支持纯文本问句）' });
        send(socket, { type: 'reply', text: '旧 daemon：已收到。' });
      } else {
        // §3.1 and anything else: ignore, exactly like the old daemon.
        console.log('[legacy] ignored message type:', msg.type);
      }
    }
  });
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});
server.listen(socketPath);
console.log('[legacy] listening on', socketPath, '(base §3 protocol only)');

function shutdown() {
  for (const c of clients) c.end();
  server.close();
  fs.rmSync(socketPath, { force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
