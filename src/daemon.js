// Figaro daemon: the long-running process that owns the state machine, the
// conversation, and (when the modules exist) the microphone and speaker.
//
//   idle → listening → thinking → speaking → idle
//
// IPC contract: docs/ipc.md §3, implemented with src/ipc.js (not modified).
// Voice modules (src/voice/asr, src/voice/tts) are optional: they are imported
// dynamically and a missing or failing module only removes that capability —
// text interaction always keeps working.
import net from 'node:net';
import fs from 'node:fs';
import { createIpcServer } from './ipc.js';
import { loadConfig } from './config.js';
import { createAgent } from './agent/index.js';
import { createWakeAck, DEFAULT_PHRASES } from './agent/wake-ack.js';

export const STATES = Object.freeze(['idle', 'listening', 'thinking', 'speaking']);

const ASR_MODULE = new URL('./voice/asr/index.js', import.meta.url).href;
const TTS_MODULE = new URL('./voice/tts/index.js', import.meta.url).href;
const PARTIAL_MIN_INTERVAL_MS = 40;
const MAX_SPEECH_CHUNK_CHARS = 220;
const VOICE_RETRY_COOLDOWN_MS = 15_000;
// Time ASR waits for the daemon to start capture after a wake before it starts it
// itself (the wake acknowledgement plays first). See voice/asr/index.js.
const WAKE_CAPTURE_FALLBACK_MS = 1_500;
// How long after an ack finishes its echo may still be in a transcript (pre-roll).
const ACK_ECHO_WINDOW_MS = 3_000;

function makeLogger(logger) {
  if (logger) return logger;
  const stamp = () => new Date().toISOString();
  return {
    info: (...args) => console.error(`[${stamp()}] [info]`, ...args),
    warn: (...args) => console.error(`[${stamp()}] [warn]`, ...args),
    error: (...args) => console.error(`[${stamp()}] [error]`, ...args),
  };
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Is another daemon already listening on this socket? createIpcServer unlinks a
 * stale socket file before binding, which would otherwise let a second daemon
 * steal the path from a live one, so probe first.
 */
function isDaemonListening(socketPath, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const done = (listening) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/** Split a stream of deltas into speakable sentences plus the unfinished rest. */
export function drainSentences(buffer, maxChars = MAX_SPEECH_CHUNK_CHARS) {
  const sentences = [];
  let rest = buffer;
  while (true) {
    const index = findSentenceEnd(rest);
    if (index < 0) break;
    const sentence = rest.slice(0, index + 1).trim();
    rest = rest.slice(index + 1);
    if (sentence.length > 0) sentences.push(sentence);
  }
  while (rest.length > maxChars) {
    const comma = rest.lastIndexOf('，', maxChars);
    const cut = comma > 20 ? comma : maxChars;
    const sentence = rest.slice(0, cut).trim();
    rest = rest.slice(cut);
    if (sentence.length > 0) sentences.push(sentence);
  }
  return { sentences, rest };
}

function findSentenceEnd(text) {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '；' || ch === ';' || ch === '\n') {
      return i;
    }
    // Split English full stops only at a word boundary, so "3.14" stays intact.
    if (ch === '.' && (i + 1 >= text.length || /\s/.test(text[i + 1]))) return i;
  }
  return -1;
}

/**
 * @param {object} [options]
 * @param {object} [options.config] loadConfig() result
 * @param {Function} [options.agentFactory] test seam: ({config, onTextDelta, onToolEvent, onError, onState}) => agent
 * @param {boolean} [options.voice] false disables ASR/TTS entirely
 * @param {boolean} [options.disableAsr]
 * @param {boolean} [options.disableTts]
 * @param {Function} [options.asrFactory] test seam replacing the src/voice/asr module factory
 * @param {Function} [options.ttsFactory] test seam replacing the src/voice/tts module factory
 * @param {Function} [options.ackFactory] test seam replacing the wake-ack controller
 * @param {object} [options.logger] console-like {info,warn,error}
 */
export function createDaemon(options = {}) {
  const config = options.config ?? loadConfig();
  const log = makeLogger(options.logger);
  const voiceEnabled = options.voice !== false;
  const asrEnabled = voiceEnabled && options.disableAsr !== true && config.asr?.enabled !== false;
  const ttsEnabled = voiceEnabled && options.disableTts !== true && config.tts?.enabled !== false;
  const agentFactory = options.agentFactory ?? createAgent;
  const ackFactory = options.ackFactory ?? createWakeAck;
  const wakeCaptureFallbackMs = Number.isFinite(Number(config.asr?.wakeCaptureFallbackMs))
    ? Math.max(0, Number(config.asr.wakeCaptureFallbackMs))
    : WAKE_CAPTURE_FALLBACK_MS;

  const socketPath = config.ui?.socket;
  if (!socketPath) throw new Error('config.ui.socket is required');

  const voice = { asr: null, tts: null };
  let ipc = null;
  let agent = null;
  let state = 'idle';
  let startedAt = 0;
  let stopping = false;
  let lastError = null;
  let current = null; // active turn {controller, requestId, full, speak, speechBuffer, lastPartialAt, partialTimer}
  let runChain = Promise.resolve();
  let turnSeq = 0;
  let voiceInitPromise = null;
  let voiceLastAttempt = 0;
  let ttsSpeaking = false;
  let lastAsrPartial = '';
  let ack = null; // wake-ack controller (pre-synthesized "我在")
  let ackActive = null; // current ack playback handle
  let ackPrepared = false;
  let pendingAckFinal = ''; // transcript captured while the ack was playing
  let lastAckEndedAt = 0;
  let captureRetryCount = 0;
  let suppressFinalOnce = false;

  const emit = (message) => {
    try {
      return ipc?.broadcast(message) ?? 0;
    } catch (err) {
      log.warn('broadcast failed:', err?.message || err);
      return 0;
    }
  };

  function setState(next, { force = false } = {}) {
    if (!STATES.includes(next)) throw new Error(`invalid state ${next}`);
    if (state === next && !force) return;
    state = next;
    if (next !== 'listening') lastAsrPartial = '';
    emit({ type: 'state', state: next });
  }

  function reportError(message, err) {
    lastError = String(message);
    if (err) log.warn(message, err?.message || err);
    emit({ type: 'error', message: String(message) });
  }

  function health() {
    return {
      state,
      pid: process.pid,
      socket: socketPath,
      uptimeMs: startedAt > 0 ? Date.now() - startedAt : 0,
      model: config.deepseek?.model ?? null,
      voice: { asr: Boolean(voice.asr), tts: Boolean(voice.tts) },
      asrCapturing: Boolean(voice.asr?.capturing),
      history: agent?.history?.length ?? 0,
      ack: ackHealth(),
      lastError,
    };
  }

  function ackHealth() {
    if (!ack) {
      return { enabled: false, ready: false, reason: ttsEnabled ? 'not initialised yet' : 'tts disabled' };
    }
    const stats = ack.stats;
    return {
      enabled: Boolean(ack.enabled),
      ready: Boolean(ack.ready),
      timeoutMs: ack.timeoutMs,
      phrases: ack.phrases,
      model: stats.model ?? null,
      voiceId: stats.voiceId ?? null,
      sampleRate: stats.sampleRate ?? null,
      lastPhrase: stats.lastPhrase ?? null,
      lastPlayDurationMs: stats.lastPlayDurationMs ?? null,
      failures: stats.failures ?? 0,
      reason: stats.disabledReason ?? null,
    };
  }

  // ---------------------------------------------------------------- agent callbacks

  function handleTextDelta(delta) {
    const turn = current;
    if (!turn || typeof delta !== 'string' || delta.length === 0) return;
    turn.full += delta;
    const now = Date.now();
    if (now - turn.lastPartialAt >= PARTIAL_MIN_INTERVAL_MS) {
      turn.lastPartialAt = now;
      emit({ type: 'partial', text: turn.full });
    } else if (turn.partialTimer === null) {
      turn.partialTimer = setTimeout(() => {
        turn.partialTimer = null;
        if (current === turn) emit({ type: 'partial', text: turn.full });
      }, PARTIAL_MIN_INTERVAL_MS);
      turn.partialTimer.unref?.();
    }
    if (turn.speak) feedSpeech(delta, turn);
  }

  function handleToolEvent(event) {
    if (!event || typeof event.name !== 'string') return;
    const message = {
      type: 'tool',
      name: event.name,
      status: event.status === 'end' ? 'end' : 'start',
    };
    if (event.summary !== undefined) message.summary = event.summary;
    if (event.durationMs !== undefined) message.durationMs = event.durationMs;
    if (event.ok !== undefined) message.ok = event.ok;
    if (current) {
      if (message.status === 'start') {
        current.activeTool = { name: message.name, summary: message.summary };
      } else if (current.activeTool?.name === message.name) {
        current.activeTool = null;
      }
    }
    emit(message);
    if (event.status === 'end' && config.agent?.verboseTools === true) {
      log.info(`tool ${event.name} ${event.ok === false ? 'failed' : 'finished'} in ${event.durationMs ?? '?'}ms`);
    }
  }

  function handleAgentError(err) {
    reportError(`模型请求失败：${err?.message || err}`, err);
  }

  // ---------------------------------------------------------------- speech out

  function feedSpeech(delta, turn) {
    if (!voice.tts) {
      turn.speechBuffer = '';
      return;
    }
    turn.speechBuffer += delta;
    const { sentences, rest } = drainSentences(turn.speechBuffer);
    turn.speechBuffer = rest;
    for (const sentence of sentences) speakSentence(sentence, turn);
  }

  function speakSentence(text, turn) {
    if (!voice.tts) return;
    const clean = String(text ?? '').trim();
    if (clean.length === 0) return;
    if (current !== turn) return;
    if (state !== 'speaking') setState('speaking');
    try {
      const pending = voice.tts.speak(clean);
      if (pending && typeof pending.catch === 'function') {
        pending.catch((err) => handleVoiceError('tts', err));
      }
    } catch (err) {
      handleVoiceError('tts', err);
    }
  }

  function flushSpeech(turn) {
    if (!voice.tts) return;
    const rest = String(turn.speechBuffer ?? '').trim();
    turn.speechBuffer = '';
    if (rest.length > 0) speakSentence(rest, turn);
  }

  function handleVoiceError(area, err) {
    const message = `${area === 'tts' ? '语音合成' : '语音识别'}出错：${err?.message || err}`;
    lastError = message;
    log.warn(message);
    emit({ type: 'error', message });
    if (area === 'tts') ttsSpeaking = false;
  }

  // ---------------------------------------------------------------- ASR callbacks

  function handleAsrWake() {
    if (!voice.asr) return;
    beginWakeFlow('asr');
  }

  function handleAsrLevel(value) {
    emit({ type: 'level', value: clamp01(value) });
  }

  function handleAsrPartial(text) {
    lastAsrPartial = String(text ?? '');
    // While the ack is audible the mic may pick it up; do not paint that echo
    // into the UI as if the user had said it.
    if (ackActive) return;
    emit({ type: 'partial', text: lastAsrPartial });
  }

  function handleAsrFinal(rawText) {
    if (suppressFinalOnce) {
      suppressFinalOnce = false;
      if (!ackActive) setState('idle');
      return;
    }
    let transcript = String(rawText ?? '').trim();
    const stripped = stripAckEcho(transcript);
    if (stripped !== transcript) {
      log.info(`wake-ack: stripped echo from transcript (${transcript.length} -> ${stripped.length} chars)`);
      transcript = stripped;
    }
    if (transcript.length === 0) {
      // Nothing was captured, or only the ack echo. Right after a wake, give the
      // user one more listening window instead of going deaf immediately.
      if (ackActive) return;
      const inWakeWindow = lastAckEndedAt > 0 && Date.now() - lastAckEndedAt < 4_000;
      if (inWakeWindow && captureRetryCount < 1 && voice.asr) {
        captureRetryCount += 1;
        log.info('wake: empty transcript after ack, listening again');
        beginListeningCapture();
        return;
      }
      captureRetryCount = 0;
      if (current === null) setState('idle');
      return;
    }
    if (ackActive) {
      pendingAckFinal = transcript;
      log.info(`wake: captured ${transcript.length} chars during ack, will process it after ack`);
      return;
    }
    captureRetryCount = 0;
    lastAckEndedAt = 0;
    enqueueTurn(() => processAsk({ text: transcript, speak: true }, null));
  }

  /** Remove a leading ack phrase ("我在…") that leaked in through pre-roll/echo. */
  function stripAckEcho(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    if (!ack || !ack.enabled) return text;
    const withinWindow = lastAckEndedAt > 0 && Date.now() - lastAckEndedAt <= ACK_ECHO_WINDOW_MS;
    if (!withinWindow) return text;
    const normalize = (value) => value.replace(/[\s，。！？、,.!?~～…—\-]/g, '');
    const normalized = normalize(text);
    const candidates = [...(ack.phrases ?? DEFAULT_PHRASES)].sort((a, b) => b.length - a.length);
    for (const phrase of candidates) {
      const target = normalize(phrase);
      if (target.length === 0 || !normalized.startsWith(target)) continue;
      let seen = 0;
      let index = 0;
      while (index < text.length && seen < target.length) {
        if (normalize(text[index]).length > 0) seen += 1;
        index += 1;
      }
      return text.slice(index).replace(/^[\s，。！？、,.!?~～…—\-]+/, '').trim();
    }
    return text;
  }

  function handleAsrVadStart() {
    if (state === 'idle' || state === 'speaking') setState('listening');
  }

  function handleAsrError(err) {
    handleVoiceError('asr', err);
    if (state === 'listening') setState('idle');
  }

  // ---------------------------------------------------------------- wake flow

  /**
   * Wake sequence: interrupt everything, play the cached "我在" acknowledgement,
   * then start capture. If the ack is unavailable or fails, capture starts
   * immediately (a missed ack must never leave Figaro deaf).
   */
  function beginWakeFlow(origin) {
    if (!voice.asr) return;
    log.info(`wake (${origin})`);
    cancelCurrent('wake interrupted it');
    stopCaptureForBargeIn();
    pendingAckFinal = '';
    captureRetryCount = 0;

    const playback = ack && ack.enabled && ack.ready && voice.tts ? ack.play() : null;
    if (!playback) {
      log.info('wake: no ack available, starting capture immediately');
      beginListeningCapture();
      return;
    }
    ackActive = playback;
    setState('speaking'); // the ack is audible now
    let startedSeen = false;
    const startTimer = setTimeout(() => {
      if (ackActive !== playback || startedSeen) return;
      log.warn(`wake-ack: no audio within ${ack.timeoutMs}ms; falling back to capture`);
      abortAck('timeout');
      beginListeningCapture();
    }, Math.max(50, ack.timeoutMs));
    startTimer.unref?.();
    playback.started.then(() => {
      startedSeen = true;
      clearTimeout(startTimer);
    }).catch(() => {});
    playback.done.then((info) => {
      clearTimeout(startTimer);
      if (ackActive !== playback) return;
      ackActive = null;
      lastAckEndedAt = Date.now();
      if (info?.ok) log.info(`wake-ack: played "${info.phrase}" (${info.durationMs ?? '?'}ms)`);
      else log.warn(`wake-ack: playback incomplete (${info?.error || 'stopped'})`);
      finishWakeFlow();
    }).catch((err) => {
      clearTimeout(startTimer);
      log.warn('wake-ack: playback promise failed:', err?.message || err);
      if (ackActive === playback) {
        ackActive = null;
        lastAckEndedAt = Date.now();
        finishWakeFlow();
      }
    });
  }

  function finishWakeFlow() {
    if (stopping) return;
    const pending = pendingAckFinal;
    pendingAckFinal = '';
    setState('listening');
    if (pending.length > 0) {
      log.info(`wake: processing transcript captured during ack (${pending.length} chars)`);
      enqueueTurn(() => processAsk({ text: pending, speak: true }, null));
      return;
    }
    beginCaptureNow();
  }

  function beginCaptureNow() {
    if (!voice.asr) return;
    try {
      if (!voice.asr.capturing) voice.asr.beginCapture();
    } catch (err) {
      handleVoiceError('asr', err);
    }
  }

  function beginListeningCapture() {
    pendingAckFinal = '';
    setState('listening');
    beginCaptureNow();
  }

  function abortAck(reason) {
    const playback = ackActive;
    ackActive = null;
    if (playback) {
      try {
        playback.stop();
      } catch {
        /* ignore */
      }
    }
    if (voice.tts) {
      try {
        voice.tts.stop();
      } catch {
        /* ignore */
      }
    }
    void reason;
  }

  /** Stop capture that was running before an interrupt; ignore its stale final. */
  function stopCaptureForBargeIn() {
    if (!voice.asr?.capturing) return;
    suppressFinalOnce = true;
    try {
      voice.asr.endCapture();
    } catch (err) {
      log.warn('asr.endCapture() failed:', err?.message || err);
    }
  }

  // ---------------------------------------------------------------- turns

  function cancelCurrent(reason) {
    const turn = current;
    current = null;
    if (turn?.controller) {
      try {
        turn.controller.abort();
      } catch {
        /* ignore */
      }
    }
    if (turn?.partialTimer) {
      clearTimeout(turn.partialTimer);
      turn.partialTimer = null;
    }
    if (ackActive) {
      const playback = ackActive;
      ackActive = null;
      try {
        playback.stop();
      } catch {
        /* ignore */
      }
    }
    pendingAckFinal = '';
    if (voice.tts) {
      try {
        voice.tts.stop();
      } catch (err) {
        log.warn('tts.stop() failed:', err?.message || err);
      }
    }
    ttsSpeaking = false;
    if (state === 'thinking' || state === 'speaking' || state === 'listening') setState('idle');
    if (turn) log.info(`turn cancelled (${reason})`);
  }

  function enqueueTurn(job) {
    const run = () => job();
    runChain = runChain.then(run, run);
    return runChain;
  }

  async function processAsk(message, client) {
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    if (text.length === 0) {
      if (client) client.send({ type: 'error', message: 'ask.text must be a non-empty string' });
      return;
    }
    const speak = message.speak !== false; // docs/ipc.md: default true
    const requestId = typeof message.requestId === 'string' && message.requestId.length > 0
      ? message.requestId
      : `req-${++turnSeq}`;
    if (client) client.send({ type: 'ack', requestId });

    stopCaptureForBargeIn();
    cancelCurrent('new ask superseded it');
    const turn = {
      controller: new AbortController(),
      requestId,
      full: '',
      speak,
      speechBuffer: '',
      lastPartialAt: 0,
      partialTimer: null,
    };
    current = turn;
    setState('thinking');
    log.info(`ask ${requestId}: ${text.length} chars (speak=${speak})`);

    let result;
    try {
      result = await agent.run({ text, signal: turn.controller.signal });
    } catch (err) {
      if (current === turn) {
        reportError(`处理失败：${err?.message || err}`, err);
        current = null;
        setState('idle');
      }
      return;
    }
    if (current !== turn) return; // cancelled or superseded while running
    if (turn.partialTimer) {
      clearTimeout(turn.partialTimer);
      turn.partialTimer = null;
    }

    if (result?.aborted) {
      current = null;
      setState('idle');
      return;
    }

    const replyText = typeof result?.text === 'string' ? result.text : '';
    flushSpeech(turn);
    current = null;
    if (result?.error && replyText.length === 0) {
      // onError already reported by the agent; do not leave a client waiting forever.
    }
    const reply = { type: 'reply', text: replyText, requestId };
    if (result?.usage) reply.usage = result.usage;
    if (Number.isInteger(result?.toolRounds)) reply.toolRounds = result.toolRounds;
    emit(reply);
    log.info(`reply ${requestId}: ${replyText.length} chars`);

    if (speak && voice.tts) {
      setState('speaking');
      try {
        await voice.tts.flush();
      } catch (err) {
        handleVoiceError('tts', err);
      }
      if (state === 'speaking') setState('idle');
    } else {
      setState('idle');
    }
  }

  async function processSay(message, client) {
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    if (text.length === 0) {
      if (client) client.send({ type: 'error', message: 'say.text must be a non-empty string' });
      return;
    }
    const requestId = typeof message.requestId === 'string' && message.requestId.length > 0
      ? message.requestId
      : `say-${++turnSeq}`;
    cancelCurrent('say superseded it');
    if (!voice.tts) {
      reportError('没有语音合成模块，暂时不能朗读。');
      emit({ type: 'reply', text, requestId, spoken: false });
      return;
    }
    const turn = { requestId, full: text, speak: true, speechBuffer: '', lastPartialAt: 0, partialTimer: null };
    current = turn;
    setState('speaking');
    try {
      await voice.tts.speak(text);
      await voice.tts.flush();
    } catch (err) {
      handleVoiceError('tts', err);
    }
    if (current === turn) {
      current = null;
      if (state === 'speaking') setState('idle');
    }
    emit({ type: 'reply', text, requestId, spoken: true });
  }

  // ---------------------------------------------------------------- voice module loading

  async function loadVoiceFactory(kind, specifier, factoryName) {
    try {
      const mod = await import(specifier);
      const factory = mod?.[factoryName] ?? mod?.default?.[factoryName];
      if (typeof factory !== 'function') {
        throw new Error(`${factoryName}() is not exported`);
      }
      return factory;
    } catch (err) {
      log.warn(`[${kind}] module unavailable (${err?.code || err?.name || 'error'}: ${err?.message || err}); running without it`);
      return null;
    }
  }

  async function initVoice() {
    if (!voiceEnabled) {
      log.info('voice disabled (--no-voice)');
      return;
    }
    if (asrEnabled && !voice.asr) {
      const factory = options.asrFactory ?? await loadVoiceFactory('asr', ASR_MODULE, 'createAsr');
      if (factory) {
        try {
          const asrConfig = {
            ...config,
            asr: { ...(config.asr ?? {}), wakeCaptureFallbackMs },
          };
          voice.asr = factory({
            config: asrConfig,
            onWake: handleAsrWake,
            onLevel: handleAsrLevel,
            onPartial: handleAsrPartial,
            onFinal: handleAsrFinal,
            onVadStart: handleAsrVadStart,
            onError: handleAsrError,
          });
          const started = voice.asr?.start?.();
          if (started && typeof started.then === 'function') {
            started.catch((err) => {
              handleVoiceError('asr', err);
              voice.asr = null;
            });
          }
          log.info('asr module loaded');
        } catch (err) {
          log.warn(`[asr] createAsr() failed: ${err?.message || err}; running without it`);
          voice.asr = null;
        }
      }
    }
    if (ttsEnabled && !voice.tts) {
      const factory = options.ttsFactory ?? await loadVoiceFactory('tts', TTS_MODULE, 'createTts');
      if (factory) {
        try {
          voice.tts = factory({
            config,
            onLevel: (value) => emit({ type: 'level', value: clamp01(value) }),
            onState: (next) => {
              ttsSpeaking = next === 'speaking';
              if (next === 'idle' && current === null && state === 'speaking' && !ackActive) setState('idle');
            },
            onError: (err) => handleVoiceError('tts', err),
          });
          log.info('tts module loaded');
        } catch (err) {
          log.warn(`[tts] createTts() failed: ${err?.message || err}; running without it`);
          voice.tts = null;
        }
      }
    }
    void prepareAck();
  }

  /** Pre-synthesize the wake acknowledgements once the TTS module is available. */
  async function prepareAck() {
    if (!ack || !ack.enabled || ackPrepared) return;
    ackPrepared = true;
    const ready = await ack.prepare();
    if (!ready) {
      log.warn(`wake-ack unavailable: ${ack.stats.disabledReason ?? 'unknown'}; wake will start capture immediately`);
      return;
    }
    const stats = ack.stats;
    log.info(
      `wake-ack ready: ${stats.phrases} phrase(s) ${JSON.stringify(ack.phrases)}, voiceId=${stats.voiceId}, ` +
        `model=${stats.model}, sampleRate=${stats.sampleRate}, synth=${stats.synthMs}ms, timeout=${ack.timeoutMs}ms ` +
        `(same synthesize()/playPcm() path and voice as normal replies)`,
    );
  }

  /** Load voice modules without ever blocking the text path. */
  function ensureVoice() {
    const now = Date.now();
    if (voiceInitPromise) return voiceInitPromise;
    if ((voice.asr || !asrEnabled) && (voice.tts || !ttsEnabled)) return Promise.resolve();
    if (now - voiceLastAttempt < VOICE_RETRY_COOLDOWN_MS) return Promise.resolve();
    voiceLastAttempt = now;
    voiceInitPromise = initVoice()
      .catch((err) => log.warn('voice init failed:', err?.message || err))
      .finally(() => {
        voiceInitPromise = null;
      });
    return voiceInitPromise;
  }

  // ---------------------------------------------------------------- IPC messages

  function handleMessage(message, client) {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      client.send({ type: 'error', message: 'message must be an object with a string type' });
      return;
    }
    switch (message.type) {
      case 'subscribe':
        client.subscribed = true;
        // A late subscriber (UI overlay) must be able to render a turn that is
        // already in progress: replay the current state, partial text and tool.
        client.send({ type: 'state', state });
        if (state === 'listening' && lastAsrPartial.length > 0) {
          client.send({ type: 'partial', text: lastAsrPartial });
        } else if (current) {
          if (current.full.length > 0) client.send({ type: 'partial', text: current.full });
          if (current.activeTool) {
            client.send({ type: 'tool', name: current.activeTool.name, status: 'start', summary: current.activeTool.summary });
          }
        }
        break;
      case 'ping':
        client.send({ type: 'pong', ...health() });
        break;
      case 'ask':
        enqueueTurn(() => processAsk(message, client)).catch((err) => {
          log.error('ask handler crashed:', err?.message || err);
          client.send({ type: 'error', message: `内部错误：${err?.message || err}` });
        });
        break;
      case 'say':
        enqueueTurn(() => processSay(message, client)).catch((err) => {
          log.error('say handler crashed:', err?.message || err);
          client.send({ type: 'error', message: `内部错误：${err?.message || err}` });
        });
        break;
      case 'cancel':
        cancelCurrent('cancel message');
        stopCaptureForBargeIn();
        pendingAckFinal = '';
        break;
      case 'wake':
        if (voice.asr) {
          beginWakeFlow('ui-wake');
        } else {
          reportError('没有麦克风模块（或模块不可用），直接用文字问我吧。');
          ensureVoice();
        }
        break;
      case 'listen_begin':
        if (voice.asr) {
          beginWakeFlow('ui-listen');
        } else {
          reportError('没有麦克风模块（或模块不可用），直接用文字问我吧。');
          ensureVoice();
        }
        break;
      case 'listen_end':
        if (voice.asr) {
          try {
            voice.asr.endCapture();
          } catch (err) {
            handleVoiceError('asr', err);
          }
        } else {
          reportError('没有麦克风模块（或模块不可用）。');
        }
        break;
      default:
        client.send({ type: 'error', message: `unknown message type: ${message.type}` });
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async function start() {
    if (ipc) throw new Error('daemon already started');
    if (await isDaemonListening(socketPath)) {
      throw new Error(`another figaro daemon is already listening on ${socketPath}`);
    }
    startedAt = Date.now();
    agent = agentFactory({
      config,
      onTextDelta: handleTextDelta,
      onToolEvent: handleToolEvent,
      onError: handleAgentError,
      onState: () => {},
    });
    ipc = createIpcServer({
      socketPath,
      onMessage: (message, client) => {
        try {
          handleMessage(message, client);
        } catch (err) {
          log.error('message handler crashed:', err?.message || err);
          try {
            client.send({ type: 'error', message: `内部错误：${err?.message || err}` });
          } catch {
            /* ignore */
          }
        }
      },
      onConnect: (client) => {
        // Every client learns the current state immediately; subscribe() then
        // unlocks the event stream exactly as docs/ipc.md §3 specifies.
        client.send({ type: 'state', state });
        log.info(`client connected (${ipc?.clients.size ?? '?'} total)`);
      },
      onDisconnect: () => {},
    });
    await new Promise((resolve, reject) => {
      const onListening = () => {
        ipc.server.off('error', onError);
        resolve();
      };
      const onError = (err) => {
        ipc.server.off('listening', onListening);
        reject(err);
      };
      ipc.server.once('listening', onListening);
      ipc.server.once('error', onError);
    });
    log.info(`daemon listening on ${socketPath} (pid ${process.pid}, model ${config.deepseek?.model ?? '?'})`);
    if (ttsEnabled) {
      ack = ackFactory({ config, logger: log, getTts: () => voice.tts });
      log.info(
        `wake-ack: ${ack.enabled ? 'enabled' : 'disabled'} (phrases=${JSON.stringify(ack.phrases)}, timeout=${ack.timeoutMs}ms)`,
      );
    }
    // Voice modules load in the background: the text path must never wait on them.
    void ensureVoice();
    return { socketPath };
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    cancelCurrent('shutdown');
    try {
      await voice.asr?.stop?.();
    } catch (err) {
      log.warn('asr.stop() failed:', err?.message || err);
    }
    try {
      voice.tts?.stop?.();
    } catch (err) {
      log.warn('tts.stop() failed:', err?.message || err);
    }
    try {
      ack?.close?.();
    } catch {
      /* ignore */
    }
    ack = null;
    ackActive = null;
    voice.asr = null;
    voice.tts = null;
    const closed = ipc?.close();
    ipc = null;
    try {
      await closed;
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* already gone */
    }
    log.info('daemon stopped');
  }

  return {
    start,
    stop,
    get state() {
      return state;
    },
    get socketPath() {
      return socketPath;
    },
    get health() {
      return health();
    },
    get agent() {
      return agent;
    },
    get voice() {
      return voice;
    },
    /** Test hook: run a turn directly without the socket. */
    ask: (text, speak = false) => enqueueTurn(() => processAsk({ text, speak }, null)),
  };
}

export default createDaemon;
