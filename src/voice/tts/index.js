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
// * Output never relies on the system default sink: `config.tts.sink` is resolved
//   once at startup (full name or unique substring) and passed to pw-cat as
//   `--target=...`; a missing sink warns once and falls back to the default.
// * playPcm() injects already-synthesized PCM (wake ack) into the same player;
//   synthesize() produces cached PCM without playing it.

import { cleanText } from './clean.js';
import { splitText } from './split.js';
import { createPlayer } from './player.js';
import { createMiniMaxClient } from './minimax-client.js';
import { probeAudioSinks, resolveSinkConfig } from './sink.js';
import { normalizePcm, pcmDurationMs } from './pcm.js';

const noop = () => {};
const SILENT_LOGGER = { info: noop, warn: noop, error: noop };

/** `[tts] ...` lines go to stderr (systemd/journal) unless a logger is injected. */
function makeLogger(logger) {
  if (logger === null) return SILENT_LOGGER;
  if (logger === undefined) {
    const write = (...args) => {
      try {
        console.error('[tts]', ...args);
      } catch {
        /* ignore */
      }
    };
    return { info: write, warn: write, error: write };
  }
  const pick = (key) => (typeof logger[key] === 'function' ? logger[key].bind(logger) : noop);
  return { info: pick('info'), warn: pick('warn'), error: pick('error') };
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function createTts({
  config = {},
  onLevel = noop,
  onState = noop,
  onError = noop,
  logger,
  // test seam: () => ({ available: [{name}], defaultSink, ok })
  sinkProbe,
} = {}) {
  const mm = config.minimax || {};
  const tc = config.tts || {};
  const log = makeLogger(logger);

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
    // Output device: PipeWire/PulseAudio sink name ('' => system default).
    // Never rely on the *system* default sink: on this machine the default can
    // be a muted analog jack while the audible speakers are the HDMI sink.
    sink: typeof tc.sink === 'string' ? tc.sink.trim() : '',
  };

  // Resolve the configured sink once, at module start, and say where we play.
  const sinkResolution = (() => {
    let probe;
    try {
      probe = typeof sinkProbe === 'function' ? sinkProbe() : sinkProbe || probeAudioSinks();
    } catch (err) {
      probe = { ok: false, available: [], defaultSink: '', error: err };
    }
    return resolveSinkConfig(settings.sink, probe);
  })();
  settings.sink = sinkResolution.target;
  if (sinkResolution.status === 'fallback-missing') {
    log.warn(
      `sink "${sinkResolution.configured}" not found (available: ${
        (sinkResolution.candidates || []).join(', ') || 'none'
      }); falling back to default sink (${sinkResolution.name})`,
    );
  } else if (sinkResolution.status === 'ambiguous') {
    log.warn(
      `sink "${sinkResolution.configured}" matches several sinks (${(
        sinkResolution.candidates || []
      ).join(', ')}); falling back to default sink (${sinkResolution.name})`,
    );
  } else if (sinkResolution.status === 'unverified') {
    log.warn(`cannot query audio sinks (pactl unavailable); using configured sink "${sinkResolution.configured}"`);
  }
  if (sinkResolution.target) {
    log.info(
      sinkResolution.status === 'resolved'
        ? `playing to ${sinkResolution.name} (resolved from "${sinkResolution.configured}")`
        : `playing to ${sinkResolution.name}`,
    );
  } else {
    log.info(`playing to default sink (${sinkResolution.name})`);
  }

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
  let pcmWaiters = []; // playPcm() promises waiting for their playback to end
  let sinkFallbackUsed = false; // warn-once guard for runtime sink failure

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
    // playPcm()/synthesize() path (wake acknowledgement cache)
    pcmPlays: 0,
    pcmBytes: 0,
    lastPcmWriteMs: null, // playPcm() call -> first PCM handed to the player
    synthRequests: 0,
    lastSynthMs: null,
    lastSynthTtfbMs: null,
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

  function resolvePcmWaiters(reason) {
    const waiters = pcmWaiters;
    pcmWaiters = [];
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      try {
        waiter.resolve({ bytes: waiter.bytes, durationMs: waiter.durationMs, completed: reason === 'played' });
      } catch {
        /* ignore */
      }
    }
  }

  function finishTurn() {
    resolvePcmWaiters('played');
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
      sink: settings.sink,
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
        const diedUnexpectedly = !info.expected && !info.error && !info.killLatencyMs;
        if (diedUnexpectedly && settings.sink && !sinkFallbackUsed && generation === myGen) {
          // pw-cat does not fail on a missing --target (measured), but a sink can
          // still disappear at runtime (unplugged monitor, card suspend...).
          // Never leave the assistant voiceless: fall back to the default sink once.
          sinkFallbackUsed = true;
          const failedSink = settings.sink;
          settings.sink = '';
          log.warn(
            `playback to sink "${failedSink}" failed (exit ${info.code ?? '?'}); falling back to default sink`,
          );
          return;
        }
        if (diedUnexpectedly && generation === myGen && (speakState || hasWork())) {
          reportError(new Error(`audio player exited unexpectedly (code ${info.code ?? '?'})`), 'player');
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

  // ------------------------------------------------- play cached / raw PCM ----
  /**
   * Play already-synthesized PCM (e.g. a pre-cached wake acknowledgement).
   *
   * Runs through the *same* player instance as TTS audio, on the same sink, with
   * the same onLevel/onState semantics, and is stopped by the same stop().
   * The PCM is written immediately into the playback stream (it is not mixed,
   * not queued as a separate utterance). Use it while the assistant is idle:
   * if callers inject while TTS audio is still being written, it plays after the
   * audio already queued to the sink.
   *
   * @param {Buffer|Uint8Array|Int16Array|Float32Array|Float64Array|number[]} data
   *   s16le Buffer (interleaved), or float samples in [-1, 1].
   * @param {{rate?: number, channels?: number}} [opts]
   * @returns {Promise<{bytes:number, durationMs:number, completed:boolean}>}
   *   resolves when this PCM has finished playing (or immediately if nothing to play).
   */
  function playPcm(data, opts = {}) {
    if (!settings.enabled) return Promise.resolve({ bytes: 0, durationMs: 0, completed: false });
    const startedAt = Date.now();
    let pcm;
    try {
      pcm = normalizePcm(data, {
        rate: num(opts.rate, settings.sampleRate),
        channels: num(opts.channels, 1),
        targetRate: settings.sampleRate,
      });
    } catch (err) {
      reportError(err, 'playPcm');
      return Promise.resolve({ bytes: 0, durationMs: 0, completed: false });
    }
    if (!pcm || pcm.length === 0) return Promise.resolve({ bytes: 0, durationMs: 0, completed: false });

    const myGen = generation;
    beginTurnIfIdle();
    let p;
    try {
      p = ensurePlayer(myGen);
    } catch (err) {
      reportError(err, 'player');
      return Promise.resolve({ bytes: 0, durationMs: 0, completed: false });
    }
    if (!p || !p.write(pcm)) {
      if (p) detachPlayer(p);
      reportError(new Error('audio player unavailable for playPcm'), 'player');
      return Promise.resolve({ bytes: 0, durationMs: 0, completed: false });
    }
    const now = Date.now();
    playEndAt = Math.max(now, playEndAt) + bytesToMs(pcm.length);
    const durationMs = Math.round((pcm.length / bytesPerMs) * 10) / 10;
    const endAt = playEndAt;
    stats.pcmPlays += 1;
    stats.pcmBytes += pcm.length;
    stats.bytes += pcm.length;
    stats.lastPcmWriteMs = now - startedAt;
    clearWsIdleTimer();
    if (!speakState) setSpeaking(true);
    maybeScheduleIdle();

    return new Promise((resolve) => {
      const waiter = {
        bytes: pcm.length,
        durationMs,
        endAt,
        resolve,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        waiter.timer = null;
        const idx = pcmWaiters.indexOf(waiter);
        if (idx >= 0) pcmWaiters.splice(idx, 1);
        resolve({ bytes: pcm.length, durationMs, completed: true });
      }, Math.max(0, endAt + settings.playbackTailMs - Date.now()));
      waiter.timer.unref?.();
      pcmWaiters.push(waiter);
    });
  }

  /**
   * Synthesize text to PCM *without playing it* — for pre-caching wake
   * acknowledgements ("我在"/"在的"/"请指示"). Same voice/model/song settings as
   * speak(), one task_continue per sentence, own short-lived WebSocket.
   *
   * @param {string} text
   * @param {{model?: string, voiceId?: string}} [opts]
   * @returns {Promise<{pcm: Buffer, sampleRate: number, durationMs: number, sentences: number, ms: number, ttfbMs: number|null}>}
   */
  async function synthesize(text, opts = {}) {
    const empty = { pcm: Buffer.alloc(0), sampleRate: settings.sampleRate, durationMs: 0, sentences: 0, ms: 0, ttfbMs: null };
    if (!settings.enabled) return empty;
    const cleaned = cleanText(text, { maxChars: 4000 });
    if (!cleaned) return empty;
    const sentences = splitText(cleaned, { maxLen: settings.maxSentenceChars });
    if (!sentences.length) return empty;
    if (!settings.apiKey) {
      const err = new Error('MiniMax API key is missing (config.minimax.apiKey)');
      err.fatal = true;
      throw err;
    }

    const startedAt = Date.now();
    const chunks = [];
    let firstAt = null;
    let failed = null;
    let finals = 0;
    let settle = null;
    const finished = new Promise((resolve) => {
      settle = resolve;
    });
    const client = createMiniMaxClient({
      wsUrl: settings.wsUrl,
      apiKey: settings.apiKey,
      model: opts.model || settings.model,
      voiceId: opts.voiceId || settings.voiceId,
      speed: settings.speed,
      vol: settings.volume,
      pitch: settings.pitch,
      sampleRate: settings.sampleRate,
      connectTimeoutMs: settings.connectTimeoutMs,
      requestTimeoutMs: settings.requestTimeoutMs,
      onAudio: (buf) => {
        if (firstAt === null) firstAt = Date.now();
        chunks.push(buf);
      },
      onFinal: () => {
        finals += 1;
        if (finals >= sentences.length) settle();
      },
      onFailed: (err) => {
        if (!failed) failed = err;
        settle();
      },
      onClose: () => {
        if (!failed && finals < sentences.length) failed = new Error('synthesis connection closed early');
        settle();
      },
    });

    const timeoutTimer = setTimeout(() => {
      if (!failed) failed = new Error('synthesize timeout');
      settle();
    }, Math.max(5000, settings.requestTimeoutMs * 2));
    timeoutTimer.unref?.();
    try {
      await client.connect();
      for (const sentence of sentences) {
        const wait = rateLimitWaitMs();
        if (wait > 0) {
          stats.rateLimited += 1;
          await sleep(wait);
        }
        client.send(sentence);
        sendTimes.push(Date.now());
        stats.synthRequests += 1;
      }
      await finished;
      if (failed) throw failed;
      const pcm = Buffer.concat(chunks);
      stats.lastSynthMs = Date.now() - startedAt;
      stats.lastSynthTtfbMs = firstAt === null ? null : firstAt - startedAt;
      return {
        pcm,
        sampleRate: settings.sampleRate,
        durationMs: Math.round(pcmDurationMs(pcm, settings.sampleRate)),
        sentences: sentences.length,
        ms: Date.now() - startedAt,
        ttfbMs: firstAt === null ? null : firstAt - startedAt,
      };
    } finally {
      clearTimeout(timeoutTimer);
      try {
        client.close();
      } catch {
        /* ignore */
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
    resolvePcmWaiters('stopped');
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
    playPcm,
    synthesize,
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
        audioSink: settings.sink,
        audioSinkName: sinkResolution.name,
        sinkStatus: sinkResolution.status,
      };
    },
  };
}

export default createTts;
