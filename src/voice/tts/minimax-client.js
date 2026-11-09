// MiniMax synchronous TTS WebSocket protocol client ("t2a_v2", one connection
// per task, one task_continue per sentence).
//
// Protocol (from https://platform.minimax.cn/docs/api-reference/speech-t2a-websocket):
//
//   client -> open wss://.../ws/v1/t2a_v2   (Authorization: Bearer <api key>)
//   server -> {"event":"connected_success"}
//   client -> {"event":"task_start", model, voice_setting, audio_setting, ...}
//   server -> {"event":"task_started"}
//   client -> {"event":"task_continue","text":"..."}   (repeatable, pipelined)
//   server -> {"event":"task_continued","data":{"audio":"<hex pcm>"}, "is_final":bool}
//   client -> {"event":"task_finish"}
//   server -> {"event":"task_finished"}  and closes the socket
//
// Error events: task_failed (fatal for that connection) and closed sockets.

import WebSocket from 'ws';

const CONNECT_TIMEOUT_MS = 8000;

/** MiniMax status codes that will not fix themselves by reconnecting. */
const FATAL_STATUS = new Set([
  1004, // auth failed
  2013, // invalid parameters
  1042, // illegal characters > 10%
  2202, // illegal event
  2203, // empty text
  2204, // text too long
  2205, // request over limit
  2054, // voice id not exist
  2038, // voice id not available (?)
]);

export function isFatalStatus(code) {
  return FATAL_STATUS.has(Number(code));
}

function errorFromResp(resp, fallback) {
  const base = resp?.base_resp || resp || {};
  const code = Number(base.status_code ?? 0);
  const msg = base.status_msg || fallback || 'MiniMax TTS error';
  const err = new Error(`MiniMax TTS ${code ? `[${code}] ` : ''}${msg}`);
  err.statusCode = code;
  err.statusMsg = msg;
  err.fatal = isFatalStatus(code);
  return err;
}

/**
 * @param {object} opts
 * @param {string} opts.wsUrl
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.voiceId
 * @param {number} [opts.speed]
 * @param {number} [opts.vol]
 * @param {number} [opts.pitch]
 * @param {number} [opts.sampleRate=32000]
 * @param {string} [opts.languageBoost='Chinese']
 * @param {string} [opts.textNormalizationMode='basic']
 * @param {number} [opts.connectTimeoutMs]
 * @param {number} [opts.requestTimeoutMs]
 * @param {Function} [opts.WebSocketImpl] injectable for tests
 * @param {(buf:Buffer)=>void} opts.onAudio
 * @param {(info:object)=>void} opts.onFinal
 * @param {()=>void} [opts.onTaskFinished]
 * @param {(err:Error)=>void} [opts.onFailed]
 * @param {(info:object)=>void} [opts.onClose]
 */
export function createMiniMaxClient(opts = {}) {
  const {
    wsUrl,
    apiKey,
    model,
    voiceId,
    speed = 1,
    vol = 1,
    pitch = 0,
    sampleRate = 32000,
    languageBoost = 'Chinese',
    textNormalizationMode = 'basic',
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    requestTimeoutMs = 15000,
    WebSocketImpl = WebSocket,
    onAudio,
    onFinal,
    onTaskFinished,
    onFailed,
    onClose,
  } = opts;

  let ws = null;
  let state = 'idle'; // idle | connecting | ready | closed
  let expectedClose = false;
  let fatal = false;
  let lastMessageAt = 0;
  let sent = 0;
  let finalized = 0;
  let watchdog = null;
  let connectDeferred = null;
  let closeInfo = null;

  function now() {
    return Date.now();
  }

  function clearWatchdog() {
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
  }

  function startWatchdog() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      if (state !== 'ready') return;
      if (sent - finalized <= 0) return;
      if (now() - lastMessageAt > requestTimeoutMs) {
        const err = new Error(`MiniMax TTS request timed out after ${requestTimeoutMs}ms`);
        err.timeout = true;
        try {
          onFailed?.(err);
        } catch {
          /* ignore */
        }
        // Server is considered dead; tear the socket down (fires onClose).
        try {
          ws?.terminate();
        } catch {
          /* ignore */
        }
      }
    }, 500);
    watchdog.unref?.();
  }

  function settleConnect(err) {
    if (!connectDeferred) return;
    const d = connectDeferred;
    connectDeferred = null;
    if (err) d.reject(err);
    else d.resolve();
  }

  function handleMessage(raw) {
    lastMessageAt = now();
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }
    const event = msg && msg.event;

    if (event === 'connected_success') {
      return;
    }

    if (event === 'task_started') {
      const code = Number(msg.base_resp?.status_code ?? 0);
      if (code !== 0) {
        fatal = true;
        settleConnect(errorFromResp(msg, 'task_start failed'));
        return;
      }
      state = 'ready';
      lastMessageAt = now();
      settleConnect(null);
      startWatchdog();
      return;
    }

    if (event === 'task_continued') {
      if (state !== 'ready') return;
      const hex = msg.data?.audio;
      if (typeof hex === 'string' && hex.length >= 2) {
        const buf = Buffer.from(hex, 'hex');
        if (buf.length > 0) {
          try {
            onAudio?.(buf);
          } catch {
            /* listener error must not kill the stream */
          }
        }
      }
      if (msg.is_final) {
        finalized += 1;
        try {
          onFinal?.({ status: msg.base_resp, extraInfo: msg.extra_info || null });
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (event === 'task_finished') {
      expectedClose = true;
      try {
        onTaskFinished?.();
      } catch {
        /* ignore */
      }
      // Server closes the socket itself; make sure it does not linger.
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      return;
    }

    if (event === 'task_failed') {
      const err = errorFromResp(msg, 'task failed');
      fatal = err.fatal;
      try {
        onFailed?.(err);
      } catch {
        /* ignore */
      }
      return;
    }
  }

  function handleClose(code, reason) {
    const wasReady = state === 'ready';
    state = 'closed';
    clearWatchdog();
    const bufReason = reason ? reason.toString() : '';
    settleConnect(
      new Error(`MiniMax TTS socket closed during handshake (code ${code}${bufReason ? `: ${bufReason}` : ''})`),
    );
    closeInfo = {
      code,
      reason: bufReason,
      expected: expectedClose,
      fatal,
      wasReady,
    };
    try {
      onClose?.(closeInfo);
    } catch {
      /* ignore */
    }
  }

  return {
    /** Connect + task_start handshake. Resolves when task_started arrives. */
    connect() {
      if (state === 'ready') return Promise.resolve();
      if (state === 'connecting' && connectDeferred) return connectDeferred.promise;
      state = 'connecting';
      expectedClose = false;
      fatal = false;
      connectDeferred = {};
      connectDeferred.promise = new Promise((resolve, reject) => {
        connectDeferred.resolve = resolve;
        connectDeferred.reject = reject;
      });
      const connectTimer = setTimeout(() => {
        const err = new Error(`MiniMax TTS connect timeout (${connectTimeoutMs}ms)`);
        err.timeout = true;
        settleConnect(err);
        try {
          ws?.terminate();
        } catch {
          /* ignore */
        }
      }, connectTimeoutMs);
      connectTimer.unref?.();
      const clearConnectTimer = () => clearTimeout(connectTimer);
      const origResolve = connectDeferred.resolve;
      const origReject = connectDeferred.reject;
      connectDeferred.resolve = (v) => {
        clearConnectTimer();
        origResolve(v);
      };
      connectDeferred.reject = (e) => {
        clearConnectTimer();
        if (state === 'idle' || state === 'connecting') state = 'closed';
        origReject(e);
      };
      try {
        ws = new WebSocketImpl(wsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
      } catch (err) {
        settleConnect(err);
        state = 'closed';
        return connectDeferred.promise;
      }
      ws.on('open', () => {
        const startMsg = {
          event: 'task_start',
          model,
          language_boost: languageBoost,
          text_normalization_mode: textNormalizationMode,
          voice_setting: {
            voice_id: voiceId,
            speed,
            vol,
            pitch,
          },
          audio_setting: {
            sample_rate: sampleRate,
            format: 'pcm',
            channel: 1,
          },
        };
        try {
          ws.send(JSON.stringify(startMsg));
        } catch (err) {
          settleConnect(err);
        }
      });
      ws.on('message', handleMessage);
      ws.on('error', (err) => {
        if (state !== 'ready') {
          settleConnect(err);
        }
      });
      ws.on('close', (code, reason) => handleClose(code, reason));
      return connectDeferred.promise;
    },

    /** Send one sentence. Throws when the client is not ready. */
    send(text) {
      if (state !== 'ready' || !ws) throw new Error('MiniMax TTS client is not ready');
      ws.send(JSON.stringify({ event: 'task_continue', text }));
      sent += 1;
      lastMessageAt = now();
      startWatchdog();
    },

    /** Ask the server to finish the task; it closes the socket afterwards. */
    finish() {
      if (state !== 'ready' || !ws) return false;
      expectedClose = true;
      try {
        ws.send(JSON.stringify({ event: 'task_finish' }));
        return true;
      } catch {
        return false;
      }
    },

    /** Close the socket. `finish:true` sends task_finish first (graceful). */
    close({ finish = false } = {}) {
      if (state === 'closed' || !ws) {
        state = 'closed';
        return;
      }
      if (finish && state === 'ready') {
        expectedClose = true;
        try {
          ws.send(JSON.stringify({ event: 'task_finish' }));
        } catch {
          /* ignore */
        }
      } else {
        expectedClose = true;
      }
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      state = 'closed';
      clearWatchdog();
    },

    get ready() {
      return state === 'ready';
    },
    get state() {
      return state;
    },
    get sentCount() {
      return sent;
    },
    get finalizedCount() {
      return finalized;
    },
    get outstanding() {
      return sent - finalized;
    },
    get lastMessageAt() {
      return lastMessageAt;
    },
    get closeInfo() {
      return closeInfo;
    },
  };
}

export default createMiniMaxClient;
