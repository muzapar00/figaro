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
import { loadConfig, CONFIG_PATH } from './config.js';
import { createAgent } from './agent/index.js';
import { createWakeAck, DEFAULT_PHRASES } from './agent/wake-ack.js';
import { createSettingsService, SETTINGS_MESSAGE_TYPES } from './agent/settings.js';

export const STATES = Object.freeze(['idle', 'waking', 'listening', 'finalizing', 'thinking', 'speaking', 'waiting']);

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
// Siri-style defaults for the wake/cancel state machine (docs/voice-interaction.md).
const DEFAULT_WAKE_GIVE_UP_MS = 5_000;
const DEFAULT_CANCEL_PHRASES = Object.freeze(['取消', '算了', '别说了', '停下', '停止', '不用了', '退出']);
// Extra characters tolerated after a cancel phrase ("取消吧" / "算了。") without
// turning a normal command into a cancel.
const CANCEL_TRAILING_CHARS = new Set(['吧', '啊', '呀', '哦', '呢', '了', '嘛', '呗', '！', '。', '，', '、', '？', '?', '!', '.', '~']);
// Exit code used for `service.restart`: non-zero so systemd's Restart=on-failure
// brings the daemon back after a GUI-triggered restart.
const RESTART_EXIT_CODE = 75;
// Paths of the settings API that can change without recreating the ASR module.
const ASR_HOT_PATHS = Object.freeze([
  'asr.sensitivity',
  'asr.wakeCooldownMs',
  'asr.inputGainPercent',
  'asr.bargeIn.enabled',
  'asr.bargeIn.minRms',
  'asr.bargeIn.echoFactor',
  'asr.bargeIn.minMs',
]);
// Interaction settings are pure daemon state, so they re-read instantly.
const UI_PATHS = Object.freeze(['ui.scale', 'ui.shape', 'ui.motion', 'ui.windowButtonSize']);
const INTERACTION_PATHS = Object.freeze([
  'interaction.followUpWindowMs',
  'interaction.followUpMinRms',
  'interaction.followUpMinMs',
  'interaction.dismissPhrases',
  'interaction.cancelPhrases',
]);
// TTS settings fixed at module creation: changing them recreates the module.
const TTS_RECREATE_PATHS = Object.freeze(['tts.model', 'tts.voiceId', 'tts.speed', 'tts.sink']);
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
})();

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
 * @param {string} [options.configPath] config.json path used by config.set (default CONFIG_PATH)
 * @param {Function} [options.reloadConfigFn] test seam: () => loadConfig()-shaped object
 * @param {Function} [options.restartFn] test seam replacing the service.restart exit
 * @param {Function} [options.listSinks] test seam: async () => [{name, description, isDefault}]
 * @param {object} [options.logger] console-like {info,warn,error}
 */
export function createDaemon(options = {}) {
  const config = options.config ?? loadConfig();
  applyTtsAliases(config);
  const log = makeLogger(options.logger);
  const voiceEnabled = options.voice !== false;
  // Read once at construction: toggling config.asr.enabled through config.set is
  // reported as restartRequired (the ASR module has no enable/disable hot hook).
  const asrEnabled = voiceEnabled && options.disableAsr !== true && config.asr?.enabled !== false;
  const ttsEnabled = voiceEnabled && options.disableTts !== true && config.tts?.enabled !== false;
  const agentFactory = options.agentFactory ?? createAgent;
  const ackFactory = options.ackFactory ?? createWakeAck;
  const configPath = options.configPath ?? CONFIG_PATH;
  const reloadConfigFn = options.reloadConfigFn ?? loadConfig;
  const wakeCaptureFallbackMs = Number.isFinite(Number(config.asr?.wakeCaptureFallbackMs))
    ? Math.max(0, Number(config.asr.wakeCaptureFallbackMs))
    : WAKE_CAPTURE_FALLBACK_MS;
  const wakeGiveUpMs = Number.isFinite(Number(config.asr?.wakeGiveUpMs)) && Number(config.asr.wakeGiveUpMs) > 0
    ? Number(config.asr.wakeGiveUpMs)
    : DEFAULT_WAKE_GIVE_UP_MS;
  // After a spoken reply the assistant stays on screen for this long, waiting
  // for a follow-up. Only a voice clearly above the microphone's noise floor
  // re-opens the conversation; quiet speech and background noise are ignored.
  // "退下/休息/结束" means: stand down. Unlike the cancel phrases this must not
  // cut a reply that is already being spoken; the assistant finishes talking and
  // then leaves.
  let dismissPhrases = (Array.isArray(config.interaction?.dismissPhrases)
    ? config.interaction.dismissPhrases
    : ['退下', '退下吧', '先退下', '你可以退下了', '可以退下了', '休息吧', '没事了', '结束吧', '关了']
  ).map((value) => String(value ?? '').replace(/[\s，。！？、,.!?~～…—\-]/g, '').toLowerCase())
    .filter((value) => value.length > 0);
  let followUpMinRms = Math.max(0.004, Number(config.interaction?.followUpMinRms ?? 0.012) || 0.012);
  let followUpMinMs = Math.max(80, Number(config.interaction?.followUpMinMs ?? 180) || 180);
  let followUpWindowMs = Number.isFinite(Number(config.interaction?.followUpWindowMs)) && Number(config.interaction.followUpWindowMs) > 0
    ? Number(config.interaction.followUpWindowMs)
    : 0;
  let cancelPhrases = (Array.isArray(config.interaction?.cancelPhrases) && config.interaction.cancelPhrases.length > 0
    ? config.interaction.cancelPhrases
    : DEFAULT_CANCEL_PHRASES
  ).map((phrase) => String(phrase ?? '').trim()).filter((phrase) => phrase.length > 0);

  const socketPath = config.ui?.socket;
  if (!socketPath) throw new Error('config.ui.socket is required');

  const voice = { asr: null, tts: null };
  let ipc = null;
  let agent = null;
  let state = 'idle';
  let dismissRequested = false;
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
  // Capture can begin while the acknowledgement is still playing (Siri does the
  // same): waiting for "我在" to finish before opening the microphone added
  // ~700ms to every wake. Ack echo is stripped from the transcript.
  let ackCaptureStarted = false;
  let lastAckEndedAt = 0;
  let captureRetryCount = 0;
  let suppressFinalOnce = false;
  let settings = null; // docs/ipc.md §3.1 settings & self-test service
  let lastMicRms = 0;
  let lastMicPeak = 0;
  let lastCancelAt = 0; // suppresses echo re-listen after an explicit cancel
  let wakeMuted = false; // wake-word listening paused while TTS/ack audio plays
  let wakeMuteSupported = null; // null = not probed yet
  let giveUpTimer = null; // listening -> silent idle when the user says nothing
  let giveUpAt = 0; // absolute deadline for the current listening window
  let followUpTimer = null; // optional "keep listening after a reply" window
  let followUpActive = false;
  let followUpLoudMs = 0;
  let followUpLastAt = 0;
  let followUpPeak = 0;
  let followUpPeakAt = 0;
  // Rolling noise floor. Measured on this machine: a quiet room sits around
  // 0.002-0.005, normal speech has a median of ~0.036 and quiet syllables reach
  // ~0.012. The gate is the larger of the configured floor and 3x this ambient
  // estimate, so a noisy room raises it automatically instead of misfiring.
  let ambientEma = 0.003;
  let waitingTimer = null;
  // True while a wake is taking over the state machine: suppresses the transient
  // idle state that TTS.stop() would otherwise emit between speaking and waking.
  let wakeFlowPending = false;
  const recentErrors = []; // ring buffer for diagnostics.recentErrors

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

  function pushRecentError(message) {
    recentErrors.push({ at: new Date().toISOString(), message: String(message) });
    if (recentErrors.length > 20) recentErrors.splice(0, recentErrors.length - 20);
  }

  function reportError(message, err) {
    lastError = String(message);
    pushRecentError(message);
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
      wakeMuted: Boolean(wakeMuted),
      // Effective settings summary (docs/ipc.md §3.1); lets a GUI confirm that a
      // config.set actually landed without a separate config.get.
      config: {
        asr: {
          sensitivity: config.asr?.sensitivity ?? null,
          wakeCooldownMs: config.asr?.wakeCooldownMs ?? null,
          inputGainPercent: config.asr?.inputGainPercent ?? null,
          hotkey: config.asr?.hotkey ?? '',
          silenceStopMs: config.asr?.silenceStopMs ?? null,
        },
        tts: {
          model: config.minimax?.model ?? null,
          voiceId: config.minimax?.voiceId ?? null,
          sink: config.tts?.sink ?? '',
          ackEnabled: config.tts?.ack?.enabled !== false,
        },
      },
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
    pushRecentError(message);
    log.warn(message);
    emit({ type: 'error', message });
    if (area === 'tts') {
      ttsSpeaking = false;
      // A broken TTS stream must not leave the wake-word spotter muted forever.
      setWakeMuted(false);
    }
  }

  // ------------------------------------------------------- echo suppression

  /**
   * Pause the ASR wake-word spotter while Figaro itself is speaking, so the
   * speaker→microphone feedback cannot wake us (that was the root cause of the
   * "被自己 TTS 反复唤醒" reports). Capture/levels/self-tests keep working.
   * Falls back to pauseListening()/resumeListening() and silently does nothing
   * when the ASR module has no such hook.
   */
  function setWakeMuted(mute) {
    const asr = voice.asr;
    if (!asr) return;
    const desired = Boolean(mute);
    if (wakeMuted === desired) return;
    let applied = false;
    try {
      if (typeof asr.setMuted === 'function') {
        asr.setMuted(desired);
        applied = true;
      } else if (desired && typeof asr.pauseListening === 'function') {
        asr.pauseListening();
        applied = true;
      } else if (!desired && typeof asr.resumeListening === 'function') {
        asr.resumeListening();
        applied = true;
      }
    } catch (err) {
      log.warn(`wake mute(${desired}) failed: ${err?.message || err}`);
    }
    if (applied) {
      wakeMuted = desired;
      log.info(`wake-word listening ${desired ? 'paused (TTS playing)' : 'resumed'}`);
      return;
    }
    if (wakeMuteSupported !== false) {
      wakeMuteSupported = false;
      log.info('ASR module has no wake mute hook (setMuted/pauseListening); skipping echo suppression');
    }
  }

  // ------------------------------------------------ interaction state helpers

  function clearGiveUpTimer() {
    if (giveUpTimer) {
      clearTimeout(giveUpTimer);
      giveUpTimer = null;
    }
  }

  function clearFollowUpTimer() {
    if (followUpTimer) {
      clearTimeout(followUpTimer);
      followUpTimer = null;
    }
  }

  /** User made a sound: no give-up while they are talking, but keep the deadline. */
  function noteUserSpeech() {
    if (giveUpTimer) {
      clearTimeout(giveUpTimer);
      giveUpTimer = null;
    }
  }

  function clearWaitingTimer() {
    if (waitingTimer) {
      clearTimeout(waitingTimer);
      waitingTimer = null;
    }
  }

  /** Waiting window: if no loud voice arrives, leave quietly. */
  function armWaitingTimer() {
    clearWaitingTimer();
    waitingTimer = setTimeout(() => {
      waitingTimer = null;
      if (state !== 'waiting') return;
      log.info(`waiting: no follow-up within ${followUpWindowMs}ms -> idle`);
      settleTurn('follow-up-timeout');
    }, followUpWindowMs);
    waitingTimer.unref?.();
  }

  function armGiveUpTimer(ms, reason = 'wake') {
    clearGiveUpTimer();
    const budget = Math.max(50, Number(ms) || DEFAULT_WAKE_GIVE_UP_MS);
    giveUpAt = Date.now() + budget;
    giveUpTimer = setTimeout(() => {
      giveUpTimer = null;
      if (state !== 'listening' || current !== null) return;
      log.info(`listening: no speech within ${budget}ms (${reason}) -> idle silently`);
      settleTurn('give-up');
    }, budget);
    giveUpTimer.unref?.();
  }

  /** Does a transcript mean "stand down"? (退下/休息/结束...) */
  function isDismissPhrase(text) {
    const normalized = String(text ?? '').replace(/[\s，。！？、,.!?~～…—\-]/g, '').toLowerCase();
    if (normalized.length === 0 || normalized.length > 12) return false;
    return dismissPhrases.some((phrase) => normalized.includes(phrase));
  }

  /**
   * Stand down. If the assistant is currently speaking, the reply is allowed to
   * finish first - the user asked for that explicitly - and the dismissal then
   * happens instead of the follow-up window.
   */
  function requestDismiss(reason = 'dismissed') {
    // A dismissal is a *request*, not an immediate action: whenever a turn owns
    // the screen (its reply being generated or spoken, including the goodbye the
    // model writes after calling the dismiss tool) the turn runner settles when
    // the audio has finished. That is what makes "退下" wait for the last
    // sentence instead of cutting it off.
    dismissRequested = true;
    log.info(`dismiss requested (${reason})`);
    const turnInFlight = current !== null;
    const busy = turnInFlight
      || state === 'speaking'
      || state === 'waking'
      || state === 'listening'
      || state === 'finalizing'
      || state === 'thinking'
      || ttsSpeaking;
    if (busy) {
      log.info('dismiss deferred until the turn and its audio finish');
      return;
    }
    dismissRequested = false;
    stopCaptureForBargeIn();
    settleTurn('dismissed');
  }

  /** Does a transcript mean "stop"? (取消/算了/别说了/...) */
  function isCancelPhrase(text) {
    const normalize = (value) => String(value ?? '').replace(/[\s，。！？、,.!?~～…—\-]/g, '').toLowerCase();
    const normalized = normalize(text);
    if (normalized.length === 0) return false;
    for (const phrase of cancelPhrases) {
      const target = normalize(phrase);
      if (target.length === 0) continue;
      if (normalized === target) return true;
      if (normalized.startsWith(target)) {
        const rest = normalized.slice(target.length);
        if ([...rest].every((ch) => CANCEL_TRAILING_CHARS.has(ch))) return true;
      }
    }
    return false;
  }

  /**
   * Unified end-of-turn cleanup (docs/voice-interaction.md §"硬要求"):
   * silence everything, clear interaction timers, restore the wake word, go idle.
   * Every exit path (cancel/error/timeout/give-up/normal) ends here.
   */
  function settleTurn(reason) {
    wakeFlowPending = false;
    dismissRequested = false;
    ackCaptureStarted = false;
    clearGiveUpTimer();
    clearFollowUpTimer();
    clearWaitingTimer();
    followUpActive = false;
    giveUpAt = 0;
    if (ackActive) {
      const playback = ackActive;
      ackActive = null;
      try {
        playback.stop();
      } catch {
        /* ignore */
      }
    }
    setWakeMuted(false);
    if (voice.tts && ttsSpeaking) {
      try {
        voice.tts.stop();
      } catch {
        /* ignore */
      }
    }
    ttsSpeaking = false;
    if (state !== 'idle') setState('idle');
    if (reason) log.info(`turn settled (${reason}) -> idle`);
  }

  /** Cancel everything now: abort the LLM, stop audio/capture/ack, go idle. */
  function cancelTurn(reason) {
    cancelCurrent(reason);
    stopCaptureForBargeIn();
    pendingAckFinal = '';
    settleTurn(reason);
  }

  /**
   * Optional continuous conversation (interaction.followUpWindowMs > 0):
   * after a spoken reply, listen for one more command without a wake word.
   */
  function startFollowUpWindow() {
    if (followUpWindowMs <= 0 || !voice.asr) {
      settleTurn('reply-done');
      return;
    }
    // The reply is over: retract the text so the pill collapses back into a
    // ball, then stay on screen without recording. Recording only starts once a
    // real voice crosses the loudness gate, which keeps quiet speech and room
    // noise from being transcribed as a command.
    lastAsrPartial = '';
    emit({ type: 'partial', text: '' });
    followUpActive = true;
    followUpLoudMs = 0;
    followUpLastAt = Date.now();
    followUpPeak = 0;
    followUpPeakAt = Date.now();
    setState('waiting');
    armWaitingTimer();
    log.info(`waiting ${followUpWindowMs}ms for a follow-up (loudness gate rms>=${followUpMinRms}, ${followUpMinMs}ms)`);
  }

  /** A loud enough voice during `waiting` continues the conversation directly. */
  function continueFromFollowUp(level) {
    if (!followUpActive) return;
    followUpActive = false;
    clearGiveUpTimer();
    log.info(`follow-up accepted (rms ${level.toFixed(3)}) -> listening`);
    setState('listening');
    beginCaptureNow();
    armGiveUpTimer(wakeGiveUpMs, 'follow-up');
  }

  // ---------------------------------------------------------------- ASR callbacks

  function handleAsrWake() {
    if (!voice.asr) return;
    beginWakeFlow('asr');
  }

  function handleAsrLevel(value) {
    lastMicRms = clamp01(value);
    emit({ type: 'level', value: lastMicRms });
    if (!followUpActive || state !== 'waiting') return;
    const now = Date.now();
    const dt = now - followUpLastAt;
    followUpLastAt = now;
    // Diagnostics: the peak during the window is what tells us whether the gate
    // matches this microphone. One line per second, only while waiting.
    followUpPeak = Math.max(followUpPeak, lastMicRms);
    if (now - followUpPeakAt > 1000) {
      log.info(`waiting: peak rms ${followUpPeak.toFixed(4)} (gate ${Math.max(followUpMinRms, ambientEma * 3).toFixed(4)}, floor ${ambientEma.toFixed(4)}, need ${followUpMinMs}ms)`);
      followUpPeak = lastMicRms;
      followUpPeakAt = now;
    }
    if (lastMicRms < followUpMinRms) ambientEma = ambientEma * 0.98 + lastMicRms * 0.02;
    const gate = Math.max(followUpMinRms, ambientEma * 3);
    if (lastMicRms >= gate) followUpLoudMs += Math.min(dt, 200);
    else followUpLoudMs = Math.max(0, followUpLoudMs - dt * 2);
    if (followUpLoudMs >= followUpMinMs) continueFromFollowUp(lastMicRms);
  }

  function handleAsrPartial(text) {
    lastAsrPartial = String(text ?? '');
    // Settings self-tests stream their own partials; never mix them into a turn.
    if (settings?.isAnyTestActive()) return;
    // While the ack is audible the mic may pick it up; do not paint that echo
    // into the UI as if the user had said it.
    if (ackActive) return;
    if (state === 'listening') noteUserSpeech();
    emit({ type: 'partial', text: lastAsrPartial });
  }

  function handleAsrFinal(rawText, meta) {
    if (settings?.isAnyTestActive()) {
      log.info('wake: ignoring ASR final while a settings test is running');
      return;
    }
    if (suppressFinalOnce) {
      suppressFinalOnce = false;
      // Only settle if we are still in a pre-LLM state; a stale final arriving
      // after a new turn started must not kill that new turn.
      if (!ackActive && (state === 'listening' || state === 'waking' || state === 'finalizing')) {
        settleTurn('stale-final');
      }
      return;
    }
    let transcript = String(rawText ?? '').trim();
    const stripped = stripAckEcho(transcript);
    if (stripped !== transcript) {
      log.info(`wake-ack: stripped echo from transcript (${transcript.length} -> ${stripped.length} chars)`);
      transcript = stripped;
    }
    if (transcript.length === 0) {
      if (ackActive) return;
      // An explicit cancel must not be undone by the empty final of the capture
      // it just interrupted.
      if (lastCancelAt > 0 && Date.now() - lastCancelAt < 3_000) {
        lastCancelAt = 0;
        captureRetryCount = 0;
        settleTurn('cancelled');
        return;
      }
      // Still inside the give-up budget: keep listening silently (the ASR module
      // may have ended a 1.5s no-speech capture early; Siri waits longer).
      if (giveUpAt > Date.now() && voice.asr) {
        log.info('listening: empty transcript, still waiting for speech');
        setState('listening');
        beginCaptureNow();
        return;
      }
      // Silence: leave without a sound and without an error.
      log.info(`listening: gave up (${meta?.reason || 'no-speech'})`);
      if (state === 'listening' || state === 'waking' || state === 'finalizing') settleTurn('no-speech');
      return;
    }
    // "取消/算了/别说了/..." -> never reach the model (any active phase).
    if (isCancelPhrase(transcript)) {
      log.info(`cancel phrase heard: "${transcript}" -> idle (no LLM call)`);
      cancelTurn('cancel-phrase');
      return;
    }
    if (isDismissPhrase(transcript)) {
      const busy = current !== null || state === 'speaking' || state === 'thinking';
      if (busy) {
        log.info(`dismiss phrase heard: "${transcript}" -> stand down after this turn`);
        requestDismiss('dismiss-phrase');
        return;
      }
      // Nothing is being said: let the assistant answer the dismissal with one
      // short farewell, speak it completely, and only then leave.
      log.info(`dismiss phrase heard: "${transcript}" -> short farewell, then stand down`);
      enqueueTurn(() => processAsk(
        { text: transcript, speak: true, fromVoice: true, dismissAfterReply: true },
        null,
      ));
      return;
    }
    if (ackActive) {
      pendingAckFinal = transcript;
      log.info(`wake: captured ${transcript.length} chars during ack, will process it after ack`);
      return;
    }
    captureRetryCount = 0;
    lastAckEndedAt = 0;
    clearGiveUpTimer();
    followUpActive = false;
    enqueueTurn(() => processAsk({ text: transcript, speak: true, fromVoice: true }, null));
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
    noteUserSpeech();
    if (state === 'waking') {
      log.info('user started speaking during ack -> listening now');
      finishWakeFlow('speech');
      return;
    }
    if (state === 'listening') return;
    if (state === 'idle' || state === 'speaking') setState('listening');
  }

  /** ASR module reports the user talked while Figaro is speaking (barge-in). */
  function handleAsrUserSpeech() {
    if (settings?.isAnyTestActive()) return;
    // Loudness-gated barge-in is a user preference: when it is off, nothing but
    // an explicit cancel may cut a reply short. The ASR module applies its own
    // threshold on top of this.
    if (config.asr?.bargeIn?.enabled === false) return;
    if (state === 'waking') {
      log.info('user spoke during ack -> stop ack, listening');
      finishWakeFlow('speech');
      return;
    }
    if (state === 'speaking') {
      log.info('barge-in: user spoke while Figaro was talking');
      beginWakeFlow('barge-in');
      return;
    }
    if (state === 'listening') noteUserSpeech();
  }

  /** ASR module reports the capture finished (VAD end) and finalizing is running. */
  function handleAsrFinalizing() {
    if (state === 'listening' || state === 'waking') setState('finalizing');
  }

  /** ASR module reports the wake window expired with no speech. */
  function handleAsrGiveUp(info) {
    if (state !== 'listening') return;
    log.info(`asr give-up${info?.reason ? ` (${info.reason})` : ''} -> idle silently`);
    settleTurn('give-up');
  }

  /** Short hotkey press = cancel (long press is the wake path). */
  function handleAsrTap(info) {
    if (settings?.isAnyTestActive()) return;
    const held = Number.isFinite(Number(info?.heldMs)) ? ` (${Math.round(Number(info.heldMs))}ms)` : '';
    log.info(`hotkey tap${held} -> cancel`);
    if (state === 'idle') {
      log.info('hotkey tap while idle: nothing to cancel');
      return;
    }
    cancelTurn('hotkey-tap');
  }

  function handleAsrError(err) {
    handleVoiceError('asr', err);
    if (state !== 'idle' && state !== 'speaking' && state !== 'thinking') settleTurn('asr-error');
  }

  // ---------------------------------------------------------------- wake flow

  /**
   * Wake sequence (docs/voice-interaction.md): interrupt anything that is
   * running, play the cached "我在" acknowledgement (state=waking), then start
   * listening with a give-up deadline. A second wake while waking is ignored
   * (debounce); if the user speaks during the ack, the ack stops immediately and
   * listening starts.
   */
  function beginWakeFlow(origin) {
    if (!voice.asr) return;
    if (settings?.isAnyTestActive()) {
      const counted = settings.noteRealWake();
      log.info(`wake (${origin}) ignored during a settings test${counted ? ' (counted as false alarm)' : ''}`);
      return;
    }
    if (state === 'waking' || ackActive) {
      log.info(`wake (${origin}) ignored: wake acknowledgement already playing (debounce)`);
      return;
    }
    log.info(`wake (${origin})`);
    // Abort the old turn (LLM request) and stop any audio that is playing. The
    // subsequent waking/listening transition owns the state, so no idle flash
    // (not even from TTS.stop()'s onState('idle') callback).
    wakeFlowPending = true;
    try {
      cancelCurrent('wake interrupted it', { settleState: false });
    } finally {
      // Keep the flag until waking/listening is on screen; the ack path sets
      // `waking` synchronously below, the no-ack path starts capture synchronously.
      setTimeout(() => { wakeFlowPending = false; }, 0).unref?.();
    }
    // The internal cancel above is not a user cancel: this wake starts a fresh
    // listening window that is allowed to re-listen on an echo-only final.
    lastCancelAt = 0;
    stopCaptureForBargeIn();
    pendingAckFinal = '';
    captureRetryCount = 0;
    followUpActive = false;
    clearFollowUpTimer();
    clearGiveUpTimer();

    const playback = ack && ack.enabled && ack.ready && voice.tts ? ack.play() : null;
    if (!playback) {
      log.info('wake: no ack available, starting capture immediately');
      beginListeningCapture({ reason: 'wake-no-ack' });
      return;
    }
    ackActive = playback;
    setState('waking'); // the ack is audible now
    let startedSeen = false;
    const startTimer = setTimeout(() => {
      if (ackActive !== playback || startedSeen) return;
      log.warn(`wake-ack: no audio within ${ack.timeoutMs}ms; falling back to capture`);
      abortAck('timeout');
      beginListeningCapture({ reason: 'ack-timeout' });
    }, Math.max(50, ack.timeoutMs));
    startTimer.unref?.();
    playback.started.then(() => {
      startedSeen = true;
      clearTimeout(startTimer);
      if (ackActive !== playback || ackCaptureStarted) return;
      // The acknowledgement is audible now, so the user can already be talking:
      // open the microphone in parallel and let the echo stripper deal with the
      // tail of the ack.
      ackCaptureStarted = true;
      log.info('wake: ack started, opening the microphone in parallel');
      beginListeningCapture({ reason: 'ack-started', keepPendingAckFinal: true });
    }).catch(() => {});
    playback.done.then((info) => {
      clearTimeout(startTimer);
      if (ackActive !== playback) return;
      ackActive = null;
      lastAckEndedAt = Date.now();
      if (info?.ok) log.info(`wake-ack: played "${info.phrase}" (${info.durationMs ?? '?'}ms)`);
      else log.warn(`wake-ack: playback incomplete (${info?.error || 'stopped'})`);
      finishWakeFlow('ack-done');
    }).catch((err) => {
      clearTimeout(startTimer);
      log.warn('wake-ack: playback promise failed:', err?.message || err);
      if (ackActive === playback) {
        ackActive = null;
        lastAckEndedAt = Date.now();
        finishWakeFlow('ack-failed');
      }
    });
  }

  /** Ack finished (or the user barged in): start the listening window. */
  function finishWakeFlow(reason = 'ack-done') {
    if (stopping) return;
    // A user speaking during the ack stops it immediately.
    if (ackActive) {
      const playback = ackActive;
      ackActive = null;
      try {
        playback.stop();
      } catch {
        /* ignore */
      }
      lastAckEndedAt = Date.now();
    }
    const pending = pendingAckFinal;
    pendingAckFinal = '';
    const captureAlreadyRunning = ackCaptureStarted;
    ackCaptureStarted = false;
    if (pending.length > 0) {
      log.info(`wake: processing transcript captured during ack (${pending.length} chars)`);
      clearGiveUpTimer();
      enqueueTurn(() => processAsk({ text: pending, speak: true, fromVoice: true }, null));
      return;
    }
    if (captureAlreadyRunning) {
      // The microphone has been open since the ack began; do not restart it or
      // the user's first words would be dropped.
      clearGiveUpTimer();
      armGiveUpTimer(wakeGiveUpMs, reason);
      if (state !== 'listening') setState('listening');
      return;
    }
    beginListeningCapture({ reason });
  }

  function beginCaptureNow() {
    if (!voice.asr) return;
    try {
      if (!voice.asr.capturing) voice.asr.beginCapture();
    } catch (err) {
      handleVoiceError('asr', err);
    }
  }

  function beginListeningCapture({ giveUpMs = wakeGiveUpMs, reason = 'wake', keepPendingAckFinal = false } = {}) {
    if (!keepPendingAckFinal) pendingAckFinal = '';
    setState('listening');
    beginCaptureNow();
    armGiveUpTimer(giveUpMs, reason);
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
    lastAckEndedAt = Date.now();
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

  function cancelCurrent(reason, { settleState = true } = {}) {
    const turn = current;
    current = null;
    lastCancelAt = Date.now();
    clearGiveUpTimer();
    clearFollowUpTimer();
    followUpActive = false;
    if (turn) {
      turn.cancelled = true;
      if (turn.controller) {
        try {
          turn.controller.abort();
        } catch {
          /* ignore */
        }
      }
      if (turn.partialTimer) {
        clearTimeout(turn.partialTimer);
        turn.partialTimer = null;
      }
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
    setWakeMuted(false);
    // A wake immediately continues into `waking`; skip the idle flash so the UI
    // sees one continuous transition (Siri-style).
    if (settleState && state !== 'idle') setState('idle');
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
      fromVoice: message.fromVoice === true,
      dismissAfterReply: message.dismissAfterReply === true,
      cancelled: false,
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
        settleTurn('error');
      }
      return;
    }
    if (current !== turn) return; // cancelled or superseded while running
    if (turn.partialTimer) {
      clearTimeout(turn.partialTimer);
      turn.partialTimer = null;
    }

    if (result?.aborted || turn.cancelled) {
      if (current === turn) current = null;
      settleTurn('aborted');
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

    if (turn.cancelled) {
      settleTurn('cancelled');
      return;
    }
    if (speak && voice.tts) {
      setState('speaking');
      try {
        await voice.tts.flush();
      } catch (err) {
        handleVoiceError('tts', err);
      }
      // If a wake/cancel already took over during playback, it owns the state
      // machine now; do not stomp its state from this (finished) turn.
      if (turn.cancelled || state !== 'speaking') return;
      if (turn.dismissAfterReply || dismissRequested) {
        dismissRequested = false;
        settleTurn('dismissed-after-reply');
        return;
      }
      if (followUpWindowMs > 0 && turn.fromVoice) startFollowUpWindow();
      else settleTurn('reply-done');
    } else if (turn.dismissAfterReply || dismissRequested) {
      dismissRequested = false;
      settleTurn('dismissed-after-reply');
    } else if (followUpWindowMs > 0 && turn.fromVoice) {
      startFollowUpWindow();
    } else {
      settleTurn('reply-done');
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
    const turn = { requestId, full: text, speak: true, fromVoice: false, cancelled: false, speechBuffer: '', lastPartialAt: 0, partialTimer: null };
    current = turn;
    setState('speaking');
    try {
      await voice.tts.speak(text);
      await voice.tts.flush();
    } catch (err) {
      handleVoiceError('tts', err);
    }
    const cancelled = current !== turn;
    if (!cancelled) current = null;
    emit({ type: 'reply', text, requestId, spoken: true });
    // A wake/cancel that took over during the say() owns the state now.
    if (cancelled || state !== 'speaking') return;
    settleTurn('say-done');
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
            // Siri-style interaction hooks (docs/voice-interaction.md). The ASR
            // module calls whichever ones it implements; unknown options are
            // ignored by older module versions.
            onTap: handleAsrTap,
            onUserSpeech: handleAsrUserSpeech,
            onGiveUp: handleAsrGiveUp,
            onFinalizing: handleAsrFinalizing,
          });
          wakeMuted = false;
          wakeMuteSupported = null;
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
      if (factory) createTtsInstance(factory);
    }
    void prepareAck();
  }

  /** Create the TTS module from a loaded factory (shared by initVoice and hot reload). */
  function createTtsInstance(factory) {
    try {
      voice.tts = factory({
        config,
        onLevel: (value) => emit({ type: 'level', value: clamp01(value) }),
        onState: (next) => {
          ttsSpeaking = next === 'speaking';
          // Echo suppression: never listen for the wake word while audio plays.
          setWakeMuted(next === 'speaking');
          // Do NOT move the state machine to idle here. Playback ending is not
          // the end of the turn: the turn runner still has to decide between the
          // waiting window and settling, and this callback used to pre-empt it
          // (state was already idle by the time flush() resolved, which silently
          // disabled the follow-up window).
        },
        onError: (err) => handleVoiceError('tts', err),
      });
      log.info('tts module loaded');
      return true;
    } catch (err) {
      log.warn(`[tts] createTts() failed: ${err?.message || err}; running without it`);
      voice.tts = null;
      return false;
    }
  }

  /** Build the wake-ack controller for the current config. */
  function createAckController() {
    if (!ttsEnabled) return null;
    try {
      const controller = ackFactory({ config, logger: log, getTts: () => voice.tts });
      log.info(
        `wake-ack: ${controller.enabled ? 'enabled' : 'disabled'} (phrases=${JSON.stringify(controller.phrases)}, timeout=${controller.timeoutMs}ms)`,
      );
      return controller;
    } catch (err) {
      log.warn('wake-ack: controller creation failed:', err?.message || err);
      return null;
    }
  }

  /** Recreate the TTS module after a config.set (voice/sink/model change). */
  async function recreateTts() {
    if (!ttsEnabled) return false;
    setWakeMuted(false);
    const old = voice.tts;
    voice.tts = null;
    try {
      old?.stop?.();
    } catch {
      /* ignore */
    }
    try {
      old?.close?.();
    } catch {
      /* ignore */
    }
    const factory = options.ttsFactory ?? await loadVoiceFactory('tts', TTS_MODULE, 'createTts');
    if (!factory) return false;
    const ok = createTtsInstance(factory);
    if (ok) {
      // The ack cache was synthesized with the old voice/sink: rebuild it too.
      await recreateAck();
      log.info('tts hot-reloaded after config.set');
    }
    return ok;
  }

  /** Rebuild the wake-ack cache (voice/phrase config changed). */
  async function recreateAck() {
    const old = ack;
    ack = null;
    ackActive = null;
    ackPrepared = false;
    try {
      old?.close?.();
    } catch {
      /* ignore */
    }
    ack = createAckController();
    if (ack?.enabled) {
      void prepareAck();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- settings hot-apply

  /**
   * docs/ipc.md §3.1 exposes the voice as `tts.model/voiceId/speed`, while the
   * voice modules read `minimax.model/voiceId/speed`. Mirror the GUI-facing keys
   * onto the module-facing ones so both a fresh daemon start and a config.set
   * hot reload see a single value.
   */
  function applyTtsAliases(target) {
    const tts = target?.tts;
    if (!tts || typeof tts !== 'object') return target;
    const minimax = { ...(target.minimax ?? {}) };
    if (typeof tts.voiceId === 'string' && tts.voiceId.trim().length > 0) minimax.voiceId = tts.voiceId.trim();
    if (typeof tts.model === 'string' && tts.model.trim().length > 0) minimax.model = tts.model.trim();
    if (Number.isFinite(Number(tts.speed)) && Number(tts.speed) > 0) minimax.speed = Number(tts.speed);
    target.minimax = minimax;
    return target;
  }

  /** Re-read config.json through the config loader and swap it into the daemon. */
  async function reloadConfigFromFile() {
    const fresh = await reloadConfigFn();
    for (const key of Object.keys(fresh)) config[key] = fresh[key];
    applyTtsAliases(config);
    return config;
  }

  /** Snapshot of the overlay preferences, sent to UI subscribers. */
  function uiSnapshot() {
    const ui = config.ui ?? {};
    const scale = Number(ui.scale);
    const buttonSize = Number(ui.windowButtonSize);
    return {
      type: 'ui',
      scale: Number.isFinite(scale) && scale > 0 ? Math.min(2.0, Math.max(0.5, scale)) : 1.0,
      shape: ['orb', 'ball', 'line'].includes(ui.shape) ? ui.shape : 'orb',
      motion: ui.motion === 'off' ? 'off' : 'auto',
      windowButtonSize: Number.isFinite(buttonSize) && buttonSize >= 12 && buttonSize <= 24 ? buttonSize : 16,
    };
  }

  /** Re-read the interaction settings after config.set wrote them. */
  function reloadInteractionSettings() {
    const interaction = config.interaction ?? {};
    const windowMs = Number(interaction.followUpWindowMs);
    const minRms = Number(interaction.followUpMinRms);
    const minMs = Number(interaction.followUpMinMs);
    if (Number.isFinite(windowMs) && windowMs > 0) followUpWindowMs = windowMs;
    else followUpWindowMs = 0;
    if (Number.isFinite(minRms) && minRms > 0) followUpMinRms = Math.max(0.004, minRms);
    if (Number.isFinite(minMs) && minMs > 0) followUpMinMs = Math.max(80, minMs);
    if (Array.isArray(interaction.dismissPhrases)) {
      const normalized = interaction.dismissPhrases
        .map((value) => String(value ?? '').replace(/[\s，。！？、,.!?~～…—\-]/g, '').toLowerCase())
        .filter((value) => value.length > 0);
      if (normalized.length > 0) dismissPhrases = normalized;
    }
    if (Array.isArray(interaction.cancelPhrases) && interaction.cancelPhrases.length > 0) {
      cancelPhrases = interaction.cancelPhrases.map(String);
    }
    log.info(`interaction settings reloaded (followUp ${followUpWindowMs}ms, gate ${followUpMinRms}/${followUpMinMs}ms, ${dismissPhrases.length} dismiss phrases)`);
  }

  /** Try to apply runtime-changeable ASR settings; anything else needs a restart. */
  function applyAsrRuntime(changedPaths) {
    const asr = voice.asr;
    const applied = [];
    const restartRequired = [];
    const errors = [];
    const runtime = {
      sensitivity: config.asr?.sensitivity,
      wakeCooldownMs: config.asr?.wakeCooldownMs,
      inputGainPercent: config.asr?.inputGainPercent,
      bargeIn: config.asr?.bargeIn,
    };
    if (!asr) {
      restartRequired.push(...changedPaths);
      return { applied, restartRequired, errors: ['ASR 模块不可用，设置将在重启后生效'] };
    }
    if (typeof asr.applyRuntimeConfig === 'function') {
      try {
        const result = asr.applyRuntimeConfig(runtime) ?? {};
        const asrRestart = Array.isArray(result.restartRequired) ? result.restartRequired.map(String) : [];
        for (const path of changedPaths) {
          const key = path.split('.').pop();
          if (asrRestart.some((item) => item === path || item === key || item.endsWith(`.${key}`))) {
            restartRequired.push(path);
          } else {
            applied.push(path);
          }
        }
        if (Array.isArray(result.errors)) errors.push(...result.errors.map(String));
      } catch (err) {
        errors.push(`ASR 热更新失败：${err?.message || err}`);
        restartRequired.push(...changedPaths);
      }
      return { applied, restartRequired, errors };
    }
    const setters = {
      'asr.sensitivity': 'setSensitivity',
      'asr.wakeCooldownMs': 'setWakeCooldownMs',
      'asr.inputGainPercent': 'setInputGainPercent',
    };
    for (const path of changedPaths) {
      const method = setters[path];
      const key = path.split('.').pop();
      if (method && typeof asr[method] === 'function') {
        try {
          asr[method](runtime[key]);
          applied.push(path);
        } catch (err) {
          errors.push(`${path} 热更新失败：${err?.message || err}`);
          restartRequired.push(path);
        }
      } else {
        restartRequired.push(path);
      }
    }
    return { applied, restartRequired, errors };
  }

  /**
   * Apply a validated config patch without restarting where possible.
   * @returns {Promise<{applied: string[], restartRequired: string[], errors: string[]}>}
   */
  async function applyConfigPatch(patch, changedPaths) {
    const applied = [];
    const restartRequired = [];
    const errors = [];
    void patch;

    const asrHot = changedPaths.filter((path) => ASR_HOT_PATHS.includes(path));
    const asrRestart = changedPaths.filter((path) => path.startsWith('asr.') && !ASR_HOT_PATHS.includes(path));
    if (asrRestart.length > 0) restartRequired.push(...asrRestart);
    if (asrHot.length > 0) {
      const result = applyAsrRuntime(asrHot);
      applied.push(...result.applied);
      restartRequired.push(...result.restartRequired);
      errors.push(...result.errors);
    }

    const uiChanged = changedPaths.filter((path) => UI_PATHS.includes(path));
    if (uiChanged.length > 0) {
      // The overlay has no config file access: push the new prefs to it.
      emit(uiSnapshot());
      applied.push(...uiChanged);
      log.info(`ui settings reloaded (${JSON.stringify(uiSnapshot())})`);
    }

    const keyPaths = changedPaths.filter((path) => path === 'deepseek.apiKey');
    if (keyPaths.length > 0) applied.push(...keyPaths); // the agent reads config per request
    const minimaxKey = changedPaths.filter((path) => path === 'minimax.apiKey');
    if (minimaxKey.length > 0) {
      const ok = await recreateTts();
      if (ok) applied.push(...minimaxKey);
      else {
        errors.push('MiniMax API key 已写入，但重建 TTS 失败，设置将在重启后生效');
        restartRequired.push(...minimaxKey);
      }
    }
    const asrModel = changedPaths.filter((path) => path.startsWith('asr.modelDir'));
    if (asrModel.length > 0) restartRequired.push(...asrModel);

    const interactionChanged = changedPaths.filter((path) => INTERACTION_PATHS.includes(path));
    if (interactionChanged.length > 0) {
      try {
        reloadInteractionSettings();
        applied.push(...interactionChanged);
      } catch (err) {
        errors.push(`交互设置热应用失败：${err?.message || err}`);
        restartRequired.push(...interactionChanged);
      }
    }

    const ttsRecreate = changedPaths.filter((path) => TTS_RECREATE_PATHS.includes(path));
    let ttsRecreated = false;
    if (ttsRecreate.length > 0) {
      const ok = await recreateTts();
      ttsRecreated = ok;
      if (ok) applied.push(...ttsRecreate);
      else {
        errors.push('TTS 重新加载失败，设置将在重启后生效');
        restartRequired.push(...ttsRecreate);
      }
    }

    const ackPaths = changedPaths.filter((path) => path.startsWith('tts.ack'));
    if (ackPaths.length > 0) {
      if (ttsRecreated) {
        // recreateTts() already rebuilt the cache with the new voice/phrases.
        applied.push(...ackPaths);
      } else {
        const ok = await recreateAck();
        if (ok || !ttsEnabled) applied.push(...ackPaths);
        else {
          errors.push('唤醒应答缓存重建失败，设置将在重启后生效');
          restartRequired.push(...ackPaths);
        }
      }
    }

    return {
      applied: [...new Set(applied)],
      restartRequired: [...new Set(restartRequired)],
      errors,
    };
  }

  /** Restart the daemon: exit non-zero so systemd's Restart=on-failure pulls us back. */
  function requestRestart() {
    if (typeof options.restartFn === 'function') {
      setTimeout(() => options.restartFn(), 200).unref?.();
      return;
    }
    log.info(`service.restart: exiting with code ${RESTART_EXIT_CODE} (systemd Restart=on-failure)`);
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 250).unref?.();
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
    // docs/ipc.md §3.1: settings & self-test messages are handled by a separate
    // service so they cannot interfere with the conversation state machine.
    if (settings && SETTINGS_MESSAGE_TYPES.includes(message.type)) {
      Promise.resolve(settings.handle(message, client)).catch((err) => {
        log.error(`settings handler crashed (${message.type}):`, err?.message || err);
        try {
          client.send({ type: 'error', code: 'SETTINGS_FAILED', message: `内部错误：${err?.message || err}` });
        } catch {
          /* ignore */
        }
      });
      return;
    }
    switch (message.type) {
      case 'subscribe':
        client.subscribed = true;
        // A late subscriber (UI overlay) must be able to render a turn that is
        // already in progress: replay the current state, partial text and tool.
        client.send({ type: 'state', state });
        client.send(uiSnapshot());
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
        cancelTurn('cancel message');
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
          if (state === 'listening') setState('finalizing');
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
      // Lets the model stand down on paraphrases the deterministic phrase list
      // does not cover ("你可以去休息了").
      control: { dismiss: () => requestDismiss('tool') },
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
    ack = createAckController();
    settings = createSettingsService({
      config,
      logger: log,
      configPath,
      listSinks: options.listSinks,
      context: {
        getVoice: () => voice,
        getAck: () => ack,
        getEffectiveConfig: () => config,
        getUptimeMs: () => (startedAt > 0 ? Date.now() - startedAt : 0),
        getVersion: () => PKG_VERSION,
        getRecentErrors: () => recentErrors,
        getMicInfo: () => ({
          rms: clamp01(voice.asr?.micInfo?.rms ?? lastMicRms),
          peak: clamp01(voice.asr?.micInfo?.peak ?? lastMicPeak),
        }),
        getState: () => state,
        broadcast: (message) => emit(message),
        reply: (client, message) => client?.send?.(message),
        reloadConfig: reloadConfigFromFile,
        applyConfigPatch,
        describeRestart: () => (process.env.INVOCATION_ID ? 'systemd' : 'manual'),
        requestRestart,
        cancelSpeech: () => {
          cancelCurrent('settings tts test');
          if (voice.tts) {
            try {
              voice.tts.stop();
            } catch {
              /* ignore */
            }
          }
        },
      },
    });
    log.info(`settings service ready (config: ${configPath})`);
    // Voice modules load in the background: the text path must never wait on them.
    void ensureVoice();
    return { socketPath };
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    clearGiveUpTimer();
    clearFollowUpTimer();
    followUpActive = false;
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
    setWakeMuted(false);
    try {
      settings?.close?.();
    } catch {
      /* ignore */
    }
    settings = null;
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
    get settings() {
      return settings;
    },
    /** Test hook: run a turn directly without the socket. */
    ask: (text, speak = false) => enqueueTurn(() => processAsk({ text, speak }, null)),
  };
}

export default createDaemon;
