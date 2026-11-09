// Figaro TTS module — MiniMax streaming speech synthesis over WebSocket, played
// straight to the speakers as raw PCM.
//
// Contract (docs/ipc.md §2.2):
//   createTts({config, onLevel, onState, onError})
//     -> { speak(text), flush(), stop(), get speaking }
//
// Design notes
// ------------
// * One WebSocket connection per "session", reused across turns. The first
//   sentence is sent as soon as task_started arrives; the next N sentences are
//   pipelined (`maxInFlight`) so audio for sentence k+1 is already generated
//   while sentence k is still playing — sentence transitions stay gapless.
// * Audio is requested as raw 16-bit LE mono PCM (32 kHz) so chunks can be fed
//   to pw-cat immediately; no decoding / no waiting for a full sentence.
// * All audio of a turn goes into a single long-lived pw-cat process. When the
//   queue drains we wait for the estimated playback tail, then go idle; the
//   player is kept warm for `playerKeepAliveMs` before being closed.
// * Every asynchronous callback carries a generation token; stop() bumps it, so
//   late network chunks / timers from an interrupted turn can never make noise.
// * Failures are reported via onError and never throw into the daemon.

import { cleanText } from './clean.js';
import { splitText } from './split.js';
import { createPlayer } from './player.js';
import { createMiniMaxClient } from './minimax-client.js';

const noop = () => {};

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function createTts({ config = {}, onLevel = noop, onState = noop, onError = noop } = {}) {
  const mm = config.minimax || {};
  const tc = config.tts || {};

  const settings = {
    enabled: tc.enabled !== false,
    apiKey: mm.apiKey || process.env.FIGARO_MINIMAX_API_KEY || process.env.MINIMAX_API_KEY || '',
    wsUrl: mm.wsUrl || 'wss://api.minimax.cn/ws/v1/t2a_v2',
    model: mm.model || 'speech-2.6-turbo',
    voiceId: mm.voiceId || 'male-qn-jingying',
    speed: num(mm.speed, 1),
    volume: num(mm.volume, 1),
    pitch: num(mm.pitch, 0),
    sampleRate: num(mm.sampleRate, 32000),
    maxInFlight: Math.max(1, num(tc.maxInFlight, 3)),
    maxSentenceChars: Math.max(40, num(tc.maxBufferChars, 220)),
    minSentencesBeforeStart: Math.max(1, num(tc.minSentencesBeforeStart, 1)),
    playbackTailMs: Math.max(0, num(tc.playbackTailMs, 150)),
    playerKeepAliveMs: Math.max(0, num(tc.playerKeepAliveMs, 2500)),
    playerLatencyMs: Math.max(0, num(tc.playerLatencyMs, 40)),
    playerCommand: tc.playerCommand || null,
    levelSliceMs: Math.max(20, num(tc.levelSliceMs, 64)),
    wsIdleCloseMs: Math.max(200, num(tc.wsIdleCloseMs, 90000)),
    connectTimeoutMs: num(mm.endpointTimeoutMs, 8000),
    requestTimeoutMs: num(tc.requestTimeoutMs, 20000),
    maxReconnects: Math.max(0, num(tc.maxReconnects, 1)),
    // MiniMax t2a_v2 allows 20 requests/min (paid) or 10 (free); one request per
    // sentence. Pace sends to stay under the limit instead of failing mid-reply.
    rpmLimit: Math.max(0, num(tc.rpmLimit, 18)),
  };

  const bytesPerMs = (settings.sampleRate * 2) / 1000;

  // ---------------------------------------------------------------- state ----
  let generation = 0;
  let speakState = false; // contract `speaking`
  let queue = []; // [{id, text, audioBytes, sentAt}]
  let inflight = []; // sentences sent to the server, awaiting is_final
  let unitSeq = 0;
  let client = null;
  let connectPromise = null;
  let pumpRunning = false;
  let pumpQueued = false;
  let pumpScheduled = false;
  let player = null;
  let playEndAt = 0;
  let turnStartAt = 0;
  let turnSentAny = false;
  let forceStart = false;
  let idleTimer = null;
  let keepAliveTimer = null;
  let wsIdleTimer = null;
  let reconnectTimer = null;
  let reconnects = 0;
  let flushWaiters = [];
  let lastClientFailureAt = 0;
  let sendTimes = []; // task_continue timestamps for the RPM guard
  let rateLimitTimer = null;
  let rateLimitedUntil = 0;

  const stats = {
    sentences: 0, // sentences queued over the module lifetime
    chars: 0,
    requests: 0, // task_continue sent
    finals: 0, // is_final received
    bytes: 0, // PCM bytes handed to the player
    errors: 0,
    failures: 0,
    disconnects: 0,
    reconnects: 0,
    rateLimited: 0,
    lastError: null,
    // latency samples (ms)
    lastFirstAudioMs: null, // speak() turn start -> first PCM written to sink
    lastRequestToFirstAudioMs: null, // task_continue sent -> first PCM of that sentence
    lastInterruptMs: null, // stop(): call -> sink killed / socket closed
    lastInterruptPlayerExitMs: null, // SIGKILL -> player process exit
    lastSpeakingMs: null, // last turn: first PCM -> estimated playback end
    lastTurnMs: null,
    turnFirstAudioMs: null,
  };

  // -------------------------------------------------------------- helpers ----
  function safeCall(fn, ...args) {
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch {
      /* a listener throwing must never break the voice path */
    }
  }

  function emitLevel(value) {
    safeCall(onLevel, clamp01(value));
  }

  function setSpeaking(next) {
    if (speakState === next) return;
    speakState = next;
    safeCall(onState, next ? 'speaking' : 'idle');
  }

  function reportError(err, context) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (context && !e.context) e.context = context;
    stats.errors += 1;
    stats.lastError = e.message;
    safeCall(onError, e);
  }

  function clearTimer(timer) {
    if (timer) clearTimeout(timer);
    return null;
  }

  function clearIdleTimer() {
    idleTimer = clearTimer(idleTimer);
  }
  function clearKeepAliveTimer() {
    keepAliveTimer = clearTimer(keepAliveTimer);
  }
  function clearWsIdleTimer() {
    wsIdleTimer = clearTimer(wsIdleTimer);
  }
  function clearReconnectTimer() {
    reconnectTimer = clearTimer(reconnectTimer);
  }
  function clearRateLimitTimer() {
    rateLimitTimer = clearTimer(rateLimitTimer);
  }

  function bytesToMs(bytes) {
    return bytes / bytesPerMs;
  }

  function hasWork() {
    return queue.length > 0 || inflight.length > 0;
  }

  function resolveFlush() {
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const resolve of waiters) {
      try {
        resolve();
      } catch {
        /* ignore */
      }
    }
  }

  // ----------------------------------------------------------- turn logic ----
  function beginTurnIfIdle() {
    clearWsIdleTimer();
    clearKeepAliveTimer();
    clearIdleTimer();
    if (!hasWork() && !speakState) {
      turnStartAt = Date.now();
      stats.turnFirstAudioMs = null;
      turnSentAny = false;
    }
  }

  function maybeScheduleIdle() {
    const myGen = generation;
    if (hasWork()) return;
    const endAt = playEndAt + settings.playbackTailMs;
    const delay = endAt - Date.now();
    if (delay > 0) {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (generation !== myGen) return;
        maybeScheduleIdle();
      }, Math.max(10, delay));
      idleTimer.unref?.();
      return;
    }
    finishTurn();
  }

  function finishTurn() {
    if (speakState) {
      stats.lastSpeakingMs = turnStartAt ? Date.now() - turnStartAt : 0;
      setSpeaking(false);
      emitLevel(0);
    }
    resolveFlush();
    if (turnStartAt) {
      stats.lastTurnMs = Date.now() - turnStartAt;
      turnStartAt = 0;
    }
    schedulePlayerKeepAlive();
    scheduleWsIdleClose();
  }

  function schedulePlayerKeepAlive() {
    if (!player) return;
    clearKeepAliveTimer();
    const myGen = generation;
    keepAliveTimer = setTimeout(() => {
      keepAliveTimer = null;
      if (generation !== myGen) return;
      if (speakState || hasWork()) return;
      const p = player;
      if (!p) return;
      player = null;
      try {
        p.end();
      } catch {
        /* ignore */
      }
    }, settings.playerKeepAliveMs);
    keepAliveTimer.unref?.();
  }

  function scheduleWsIdleClose() {
    clearWsIdleTimer();
    if (!client) return;
    const myGen = generation;
    wsIdleTimer = setTimeout(() => {
      wsIdleTimer = null;
      if (generation !== myGen) return;
      if (speakState || hasWork()) return;
      const c = client;
      client = null;
      if (!c) return;
      try {
        c.close({ finish: true });
      } catch {
        /* ignore */
      }
    }, settings.wsIdleCloseMs);
    wsIdleTimer.unref?.();
  }

  // --------------------------------------------------------------- player ----
  function detachPlayer(p) {
    if (player === p) player = null;
    if (p && p.alive) {
      try {
        p.end();
      } catch {
        /* ignore */
      }
    }
  }

  function ensurePlayer(myGen) {
    if (player && player.alive && player.writable) return player;
    if (player) detachPlayer(player);
    const p = createPlayer({
      sampleRate: settings.sampleRate,
      command: settings.playerCommand,
      latencyMs: settings.playerLatencyMs,
      sliceMs: settings.levelSliceMs,
      onLevel: (level) => {
        if (generation !== myGen) return;
        emitLevel(level);
      },
      onError: (err) => {
        if (generation !== myGen) return;
        reportError(err, 'player');
      },
      onExit: (info) => {
        if (player === p) player = null;
        if (info.killLatencyMs !== null && info.killLatencyMs !== undefined) {
          stats.lastInterruptPlayerExitMs = info.killLatencyMs;
        }
        if (!info.expected && !info.error && !info.killLatencyMs && generation === myGen) {
          if (speakState || hasWork()) {
            reportError(new Error(`audio player exited unexpectedly (code ${info.code ?? '?'})`), 'player');
          }
        }
      },
    });
    player = p;
    return p;
  }

  // --------------------------------------------------------------- client ----
  function handleAudio(buf, myGen) {
    if (generation !== myGen) return;
    reconnects = 0; // audio is flowing again => the retry budget is restored
    const unit = inflight[0];
    if (unit) unit.audioBytes += buf.length;
    const now = Date.now();
    let p;
    try {
      p = ensurePlayer(myGen);
    } catch (err) {
      reportError(err, 'player');
      return;
    }
    if (!p.write(buf)) {
      detachPlayer(p);
      return;
    }
    playEndAt = Math.max(now, playEndAt) + bytesToMs(buf.length);
    stats.bytes += buf.length;
    if (unit && unit.firstAudioAt === 0) {
      unit.firstAudioAt = now;
      stats.lastRequestToFirstAudioMs = unit.sentAt ? now - unit.sentAt : null;
    }
    if (!speakState) {
      setSpeaking(true);
      if (turnStartAt) {
        stats.turnFirstAudioMs = now - turnStartAt;
        stats.lastFirstAudioMs = stats.turnFirstAudioMs;
      }
    }
  }

  function handleFinal(info, myGen) {
    if (generation !== myGen) return;
    const unit = inflight.shift();
    if (unit) unit.finalizedAt = Date.now();
    stats.finals += 1;
    const status = info && info.status;
    const code = Number(status && status.status_code);
    if (code && unit && unit.audioBytes === 0) {
      const err = new Error(`MiniMax TTS rejected sentence [${code}] ${status.status_msg || ''}`);
      err.statusCode = code;
      err.fatal = code === 1004 || code === 2013 || code === 2054;
      reportError(err, 'synthesis');
    }
    if (queue.length || inflight.length) pumpSoon();
    else maybeScheduleIdle();
  }

  function handleClientFailed(err, myGen) {
    if (generation !== myGen) return;
    lastClientFailureAt = Date.now();
    const code = Number(err && err.statusCode);
    if (code === 1002 || code === 1039) {
      // RPM/TPM limit: back off before reconnecting, do not burn the retry budget
      rateLimitedUntil = Date.now() + 10000;
      stats.rateLimited += 1;
    }
    reportError(err, 'minimax');
  }

  function handleClientClose(info, myGen) {
    if (generation !== myGen) return; // intentional stop()/idle close
    if (client && client.state === 'closed') client = null;
    client = null;
    if (info.expected) return;
    if (!info.wasReady) return; // handshake failures are handled by ensureClient()
    if (Date.now() - lastClientFailureAt < 50) {
      // task_failed already reported; only decide whether to retry
    }
    handleUnexpectedDisconnect(info, myGen);
  }

  function handleUnexpectedDisconnect(info, myGen) {
    stats.disconnects += 1;
    const partial = inflight.filter((u) => u.audioBytes > 0);
    const unspoken = inflight.filter((u) => u.audioBytes === 0);
    inflight = [];
    if (partial.length > 0) {
      reportError(
        new Error(`MiniMax TTS connection lost mid-sentence (${partial.length} sentence(s) cut off)`),
        'minimax',
      );
    }
    if (unspoken.length > 0) queue = [...unspoken, ...queue];
    if (info.fatal || reconnects >= settings.maxReconnects) {
      failFast(
        info.fatal
          ? new Error('MiniMax TTS rejected the request (fatal, not retrying)')
          : new Error('MiniMax TTS connection dropped repeatedly; giving up'),
      );
      return;
    }
    reconnects += 1;
    stats.reconnects += 1;
    clearReconnectTimer();
    const retryDelay = Math.max(150, rateLimitedUntil - Date.now());
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (generation !== myGen) return;
      if (queue.length) pumpSoon();
      else maybeScheduleIdle();
    }, retryDelay);
    reconnectTimer.unref?.();
    maybeScheduleIdle();
  }

  function failFast(err) {
    queue = [];
    inflight = [];
    stats.failures += 1;
    const c = client;
    client = null;
    if (c) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    clearReconnectTimer();
    clearWsIdleTimer();
    clearRateLimitTimer();
    if (err) reportError(err, 'tts');
    maybeScheduleIdle();
  }

  function handleTransportFailure(err, myGen) {
    if (generation !== myGen) return;
    if (client === null && reconnectTimer) return; // close handler already scheduled a retry
    if (err && err.fatal) {
      failFast(err);
      return;
    }
    if (err && err.message === 'tts request cancelled') return;
    failFast(err || new Error('MiniMax TTS transport failure'));
  }

  function ensureClient(myGen) {
    if (client && client.ready) return Promise.resolve(client);
    if (connectPromise) return connectPromise;
    if (!settings.apiKey) {
      const err = new Error('MiniMax API key is missing (config.minimax.apiKey)');
      err.fatal = true;
      return Promise.reject(err);
    }
    connectPromise = (async () => {
      const c = createMiniMaxClient({
        wsUrl: settings.wsUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        voiceId: settings.voiceId,
        speed: settings.speed,
        vol: settings.volume,
        pitch: settings.pitch,
        sampleRate: settings.sampleRate,
        connectTimeoutMs: settings.connectTimeoutMs,
        requestTimeoutMs: settings.requestTimeoutMs,
        onAudio: (buf) => handleAudio(buf, myGen),
        onFinal: (info) => handleFinal(info, myGen),
        onFailed: (err) => handleClientFailed(err, myGen),
        onClose: (info) => handleClientClose(info, myGen),
      });
      client = c;
      try {
        await c.connect();
      } catch (err) {
        if (client === c) client = null;
        try {
          c.close();
        } catch {
          /* ignore */
        }
        throw err;
      }
      if (generation !== myGen) {
        try {
          c.close();
        } catch {
          /* ignore */
        }
        throw new Error('tts request cancelled');
      }
      return c;
    })().finally(() => {
      connectPromise = null;
    });
    return connectPromise;
  }

  // ---------------------------------------------------------- rpm limiter ----
  function rateLimitWaitMs() {
    if (!settings.rpmLimit) return 0;
    const now = Date.now();
    const cutoff = now - 60000;
    while (sendTimes.length > 0 && sendTimes[0] <= cutoff) sendTimes.shift();
    const cooldown = rateLimitedUntil - now;
    if (cooldown > 0) return cooldown;
    if (sendTimes.length >= settings.rpmLimit) return sendTimes[0] + 60000 - now + 50;
    return 0;
  }

  function scheduleRateLimitRetry(waitMs, myGen) {
    clearRateLimitTimer();
    rateLimitTimer = setTimeout(() => {
      rateLimitTimer = null;
      if (generation !== myGen) return;
      pumpSoon();
    }, Math.max(20, waitMs + 20));
    rateLimitTimer.unref?.();
  }

  // ----------------------------------------------------------------- pump ----
  function pumpSoon() {
    if (pumpRunning) {
      pumpQueued = true;
      return;
    }
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      void pump();
    });
  }

  async function pump() {
    if (pumpRunning) {
      pumpQueued = true;
      return;
    }
    pumpRunning = true;
    const myGen = generation;
    try {
      while (generation === myGen) {
        if (!queue.length) break;
        if (inflight.length >= settings.maxInFlight) break;
        if (!turnSentAny && !forceStart && queue.length < settings.minSentencesBeforeStart) break;
        const c = await ensureClient(myGen);
        if (generation !== myGen) return;
        let blockedByRateLimit = false;
        while (queue.length > 0 && inflight.length < settings.maxInFlight) {
          if (!turnSentAny && !forceStart && queue.length < settings.minSentencesBeforeStart) break;
          const wait = rateLimitWaitMs();
          if (wait > 0) {
            stats.rateLimited += 1;
            scheduleRateLimitRetry(wait, myGen);
            blockedByRateLimit = true;
            break;
          }
          const unit = queue.shift();
          try {
            c.send(unit.text);
          } catch (err) {
            queue.unshift(unit);
            throw err;
          }
          sendTimes.push(Date.now());
          unit.sentAt = Date.now();
          inflight.push(unit);
          turnSentAny = true;
          forceStart = false;
          stats.requests += 1;
        }
        if (blockedByRateLimit) break;
      }
    } catch (err) {
      if (generation === myGen) handleTransportFailure(err, myGen);
    } finally {
      pumpRunning = false;
      if (pumpQueued) {
        pumpQueued = false;
        pumpSoon();
      } else {
        maybeScheduleIdle();
      }
    }
  }

  // ------------------------------------------------------------- public API --
  function speak(text) {
    if (!settings.enabled) return Promise.resolve();
    try {
      const cleaned = cleanText(text, { maxChars: 4000 });
      if (!cleaned) return Promise.resolve();
      const sentences = splitText(cleaned, { maxLen: settings.maxSentenceChars });
      if (!sentences.length) return Promise.resolve();
      beginTurnIfIdle();
      for (const sentence of sentences) {
        unitSeq += 1;
        queue.push({ id: unitSeq, text: sentence, audioBytes: 0, sentAt: 0, firstAudioAt: 0 });
        stats.sentences += 1;
      }
      stats.chars += cleaned.length;
      pumpSoon();
    } catch (err) {
      reportError(err, 'speak');
    }
    // speak() only enqueues; use flush() to wait for playback.
    return Promise.resolve();
  }

  function flush() {
    if (!hasWork() && Date.now() >= playEndAt + settings.playbackTailMs) return Promise.resolve();
    return new Promise((resolve) => {
      flushWaiters.push(resolve);
      if (queue.length > 0 && !turnSentAny) {
        forceStart = true;
        pumpSoon();
      }
      maybeScheduleIdle();
    });
  }

  function stop() {
    const t0 = performance.now();
    generation += 1;
    queue = [];
    inflight = [];
    clearIdleTimer();
    clearKeepAliveTimer();
    clearWsIdleTimer();
    clearReconnectTimer();
    clearRateLimitTimer();
    const p = player;
    player = null;
    if (p) {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }
    const c = client;
    client = null;
    if (c) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    setSpeaking(false);
    emitLevel(0);
    resolveFlush();
    playEndAt = 0;
    turnStartAt = 0;
    turnSentAny = false;
    forceStart = false;
    reconnects = 0;
    stats.lastInterruptMs = Math.round((performance.now() - t0) * 10) / 10;
  }

  /** Extra helper (not in the contract): release everything, e.g. daemon exit. */
  function close() {
    stop();
  }

  return {
    speak,
    flush,
    stop,
    close,
    get speaking() {
      return speakState;
    },
    get state() {
      return speakState ? 'speaking' : 'idle';
    },
    /** Diagnostics for the daemon / smoke tests / dashboards. */
    get stats() {
      return {
        ...stats,
        queued: queue.length,
        inflight: inflight.length,
        playerAlive: Boolean(player && player.alive),
        connected: Boolean(client && client.ready),
        model: settings.model,
        voiceId: settings.voiceId,
      };
    },
  };
}

export default createTts;
