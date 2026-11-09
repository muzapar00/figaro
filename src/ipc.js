// Figaro IPC: newline-delimited JSON over a unix socket.
// Contract lives in docs/ipc.md. Owned by the Lead: do not change the wire
// format without asking; additive fields are fine.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const MAX_LINE = 4 * 1024 * 1024; // guard against runaway frames

export function ensureSocketDir(socketPath) {
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Create the daemon-side IPC server.
 * @param {object} opts
 * @param {string} opts.socketPath
 * @param {(msg: object, client: ClientHandle) => void} opts.onMessage
 * @param {(client: ClientHandle) => void} [opts.onConnect]
 * @param {(client: ClientHandle) => void} [opts.onDisconnect}
 */
export function createIpcServer({ socketPath, onMessage, onConnect, onDisconnect }) {
  ensureSocketDir(socketPath);
  try {
    fs.unlinkSync(socketPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const clients = new Set();
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    const handle = {
      socket,
      send(msg) {
        if (socket.destroyed) return false;
        try {
          socket.write(JSON.stringify(msg) + '\n');
          return true;
        } catch {
          return false;
        }
      },
      close() {
        socket.end();
      },
      get subscribed() {
        return handle._subscribed;
      },
      set subscribed(v) {
        handle._subscribed = v;
      },
    };
    handle._subscribed = false;
    clients.add(handle);
    onConnect?.(handle);

    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        handle.send({ type: 'error', message: 'frame too large' });
        socket.destroy();
        return;
      }
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          handle.send({ type: 'error', message: 'invalid json' });
          continue;
        }
        try {
          onMessage?.(msg, handle);
        } catch (err) {
          handle.send({ type: 'error', message: String(err?.message || err) });
        }
      }
    });

    socket.on('close', () => {
      clients.delete(handle);
      onDisconnect?.(handle);
    });
    socket.on('error', () => {
      clients.delete(handle);
    });
  });

  server.listen(socketPath);

  return {
    server,
    clients,
    /** Broadcast to every subscribed client. */
    broadcast(msg) {
      let n = 0;
      for (const c of clients) {
        if (c.subscribed) n += c.send(msg) ? 1 : 0;
      }
      return n;
    },
    /** Broadcast regardless of subscription (used for state before subscribe). */
    broadcastAll(msg) {
      let n = 0;
      for (const c of clients) n += c.send(msg) ? 1 : 0;
      return n;
    },
    close() {
      for (const c of clients) c.close();
      clients.clear();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Client side: connects to the daemon, auto-reconnecting with backoff.
 * Usage:
 *   const c = createIpcClient({socketPath, onMessage});
 *   await c.connect();
 *   c.send({type:'ask', text:'hi'});
 */
export function createIpcClient({ socketPath, onMessage, onConnect, onDisconnect, reconnect = false }) {
  let socket = null;
  let buffer = '';
  let closedByUser = false;
  let backoff = 250;

  const client = {
    connected: false,
    async connect() {
      closedByUser = false;
      await new Promise((resolve, reject) => {
        const s = net.createConnection(socketPath);
        s.setEncoding('utf8');
        s.once('connect', () => {
          socket = s;
          client.connected = true;
          backoff = 250;
          onConnect?.();
          resolve();
        });
        s.once('error', (err) => {
          if (!client.connected) reject(err);
        });
        s.on('data', (chunk) => {
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
            onMessage?.(msg);
          }
        });
        s.on('close', () => {
          client.connected = false;
          socket = null;
          onDisconnect?.();
          if (!reconnect || closedByUser) return;
          setTimeout(() => {
            client.connect().catch(() => {});
          }, backoff);
          backoff = Math.min(backoff * 2, 5000);
        });
      });
    },
    send(msg) {
      if (!socket || socket.destroyed) return false;
      try {
        socket.write(JSON.stringify(msg) + '\n');
        return true;
      } catch {
        return false;
      }
    },
    close() {
      closedByUser = true;
      socket?.end();
      socket = null;
      client.connected = false;
    },
  };
  return client;
}
