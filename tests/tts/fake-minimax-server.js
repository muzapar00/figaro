// A local, network-free fake of the MiniMax t2a_v2 WebSocket server.
//
// Used by tests/tts/*.test.js to exercise the real protocol client end to end
// (real `ws` client against a real local WS server) without touching the
// internet or spending API quota.
//
// Protocol shape mirrors https://platform.minimax.cn/docs/api-reference/speech-t2a-websocket

import http from 'node:http';
import { WebSocketServer } from 'ws';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(cond, { timeoutMs = 3000, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
}

/** Deterministic fake PCM for request #index: `totalBytes` bytes of a quiet tone. */
function fakePcm(text, index, totalBytes) {
  const buf = Buffer.alloc(totalBytes);
  for (let i = 0; i + 1 < totalBytes; i += 2) {
    // small but non-silent tone so RMS/level paths see real data
    const sample = Math.round(3000 * Math.sin((i / 2) * 0.06 + index));
    buf.writeInt16LE(sample, i);
  }
  return buf;
}

/**
 * Start the fake server.
 *
 * @param {object} [opts]
 * @param {number} [opts.chunkBytes=2048] bytes per task_continued frame
 * @param {number} [opts.chunks=2] frames per task_continue (last one is_final)
 * @param {number} [opts.chunkDelayMs=2] delay between frames (simulates streaming)
 * @param {number} [opts.startDelayMs=0] delay before task_started
 * @param {number} [opts.taskStartedCode=0] non-zero => task_started w/ error code
 * @param {boolean} [opts.dropFirstContinue=false] terminate socket on first task_continue
 * @param {(text:string)=>({code:number,msg:string}|null)} [opts.failTextMatcher]
 * @param {(ctx:object)=>Promise<void>} [opts.onContinue] full control over one task_continue
 * @returns {Promise<{url:string, port:number, messages:object[], requests:object[], connections:number,
 *   connectionCount():number, lastCloseAt:number, authHeaders:string[],
 *   waitForConnections(n:number):Promise<void>, close():Promise<void>, emitTaskFailed(ws,code,msg):void}>}
 */
export async function startFakeMiniMaxServer(opts = {}) {
  const {
    chunkBytes = 2048,
    chunks = 2,
    chunkDelayMs = 2,
    startDelayMs = 0,
    taskStartedCode = 0,
    dropFirstContinue = false,
    failTextMatcher = null,
    onContinue = null,
  } = opts;

  const clock = {
    messages: [], // every parsed client message, in order
    requests: [], // task_continue payloads
    connections: 0,
    authHeaders: [],
    lastCloseAt: 0,
  };
  let droppedOnce = false;
  let continueIndex = 0;
  const sockets = new Set();

  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });

  function send(ws, obj) {
    if (ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  async function streamChunks(ws, text, reqIndex) {
    const pcm = fakePcm(text, reqIndex, chunkBytes * chunks);
    for (let i = 0; i < chunks; i++) {
      if (chunkDelayMs > 0) await sleep(chunkDelayMs);
      if (ws.readyState !== ws.OPEN) return;
      const slice = pcm.subarray(i * chunkBytes, (i + 1) * chunkBytes);
      send(ws, {
        event: 'task_continued',
        data: { audio: slice.toString('hex') },
        is_final: i === chunks - 1,
        extra_info: { audio_format: 'pcm', audio_sample_rate: 32000, audio_channel: 1 },
      });
    }
  }

  wss.on('connection', (ws, req) => {
    clock.connections += 1;
    clock.authHeaders.push(req.headers.authorization || '');
    sockets.add(ws);
    ws.on('close', () => {
      sockets.delete(ws);
      clock.lastCloseAt = Date.now();
    });
    ws.on('error', () => {});
    send(ws, {
      event: 'connected_success',
      session_id: 'fake-session',
      trace_id: 'fake-trace',
      base_resp: { status_code: 0, status_msg: 'success' },
    });
    // MiniMax processes task_continue frames one after another; emulate that
    // by serialising our handler (otherwise concurrent fake streams interleave).
    let chain = Promise.resolve();
    ws.on('message', (raw) => {
      chain = chain.then(() => handleClientMessage(ws, raw)).catch(() => {});
    });
    async function handleClientMessage(ws, raw) {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      clock.messages.push(msg);
      if (msg.event === 'task_start') {
        if (startDelayMs > 0) await sleep(startDelayMs);
        send(ws, {
          event: 'task_started',
          session_id: 'fake-session',
          base_resp:
            taskStartedCode === 0
              ? { status_code: 0, status_msg: 'success' }
              : { status_code: taskStartedCode, status_msg: 'fake start failure' },
        });
        return;
      }
      if (msg.event === 'task_continue') {
        clock.requests.push(msg);
        const reqIndex = continueIndex++;
        if (dropFirstContinue && !droppedOnce) {
          droppedOnce = true;
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
          return;
        }
        if (failTextMatcher) {
          const failure = failTextMatcher(msg.text);
          if (failure) {
            send(ws, {
              event: 'task_failed',
              base_resp: { status_code: failure.code || 1004, status_msg: failure.msg || 'fake failure' },
            });
            setTimeout(() => {
              try {
                ws.close(1000);
              } catch {
                /* ignore */
              }
            }, 5);
            return;
          }
        }
        if (onContinue) {
          await onContinue({
            ws,
            text: msg.text,
            requestIndex: reqIndex,
            send,
            sendChunk: (buf, isFinal) =>
              send(ws, {
                event: 'task_continued',
                data: { audio: buf.toString('hex') },
                is_final: Boolean(isFinal),
                extra_info: { audio_format: 'pcm', audio_sample_rate: 32000, audio_channel: 1 },
              }),
            sleep,
          });
          return;
        }
        await streamChunks(ws, msg.text, reqIndex);
        return;
      }
      if (msg.event === 'task_finish') {
        send(ws, { event: 'task_finished', base_resp: { status_code: 0, status_msg: 'success' } });
        setTimeout(() => {
          try {
            ws.close(1000);
          } catch {
            /* ignore */
          }
        }, 5);
      }
    }
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const url = `ws://127.0.0.1:${port}`;

  return {
    url,
    port,
    clock,
    get messages() {
      return clock.messages;
    },
    get requests() {
      return clock.requests;
    },
    get connections() {
      return clock.connections;
    },
    get authHeaders() {
      return clock.authHeaders;
    },
    get lastCloseAt() {
      return clock.lastCloseAt;
    },
    async waitForConnections(n, timeoutMs = 3000) {
      await waitFor(() => clock.connections >= n, { timeoutMs, label: `${n} ws connections` });
    },
    close() {
      for (const ws of sockets) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
      return new Promise((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
        // force-close if the ws server keeps an idle client
        setTimeout(resolve, 500).unref?.();
      });
    },
  };
}

export { fakePcm };
export default startFakeMiniMaxServer;
