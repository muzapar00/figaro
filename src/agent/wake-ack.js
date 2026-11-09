// Wake acknowledgement ("我在"): a short, pre-synthesized phrase played the
// instant a wake-up is detected, so the user immediately knows Figaro is awake.
//
// Why pre-synthesize: the TTS module's first word takes ~170ms when its MiniMax
// WebSocket is already connected but ~430ms cold (measured 345-506ms, median
// 428ms over 5 runs) — and the module drops its socket after 90s idle, so most
// wake-ups hit the cold path. Pre-synthesizing at daemon startup and playing the
// cached PCM through the TTS module's own `playPcm()` gets audio out in well
// under 300ms.
//
// Voice consistency: synthesis goes through the TTS module's public
// `synthesize()` entry point, i.e. the same MiniMax client, model, voiceId,
// speed, volume, pitch and sample rate as normal replies, and playback goes
// through the same player/sink via `playPcm()` (so barge-in `stop()` semantics
// apply too). No second synthesis path, no second player.
//
// This is best effort: a missing key, blocked network or a TTS module without
// the PCM APIs just disables the ack; the daemon keeps working and capture
// starts immediately instead.
import { performance } from 'node:perf_hooks';

export const DEFAULT_PHRASES = ['我在', '在的', '请指示'];
export const DEFAULT_TIMEOUT_MS = 800;
const DEFAULT_SAMPLE_RATE = 32000;
const MAX_PHRASE_CHARS = 24;
const MIN_PCM_BYTES = 320; // shorter than ~5ms of 32k s16 mono => bad synthesis

/**
 * @param {object} options
 * @param {object} [options.config] loadConfig() result
 * @param {object} [options.logger] console-like {info,warn,error}
 * @param {() => object|null} [options.getTts] returns the live TTS module instance
 * @param {() => number} [options.random] test seam
 */
export function createWakeAck(options = {}) {
  const config = options.config ?? {};
  const log = options.logger ?? { info() {}, warn() {}, error() {} };
  const getTts = options.getTts ?? (() => null);
  const random = options.random ?? Math.random;
  const ttsCfg = config.tts ?? {};
  const ackCfg = ttsCfg.ack ?? {};

  const enabled = ackCfg.enabled !== false && ttsCfg.enabled !== false;
  const phrases = (Array.isArray(ackCfg.phrases) ? ackCfg.phrases : DEFAULT_PHRASES)
    .map((phrase) => String(phrase ?? '').trim())
    .filter((phrase) => phrase.length > 0 && phrase.length <= MAX_PHRASE_CHARS);
  const timeoutMs = Number.isFinite(Number(ackCfg.timeoutMs)) && Number(ackCfg.timeoutMs) > 0
    ? Number(ackCfg.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const sampleRate = Number.isFinite(Number(config.minimax?.sampleRate))
    ? Number(config.minimax.sampleRate)
    : DEFAULT_SAMPLE_RATE;

  const cache = new Map(); // phrase -> { pcm: Buffer, durationMs }
  const stats = {
    enabled,
    ready: false,
    phrases: 0,
    bytes: 0,
    synthMs: null,
    model: null,
    voiceId: null,
    sampleRate,
    errors: [],
    plays: 0,
    failures: 0,
    lastPhrase: null,
    lastFirstWriteMs: null,
    lastPlayDurationMs: null,
    disabledReason: enabled ? null : 'tts disabled',
  };
  let preparePromise = null;
  let closed = false;
  let active = null; // {phrase, startedAt, settled, resolveDone, timer}

  function fail(reason) {
    stats.ready = false;
    stats.disabledReason = String(reason);
    stats.errors.push(stats.disabledReason);
    log.warn(`wake-ack unavailable: ${stats.disabledReason}`);
  }

  /** Pre-synthesize every configured phrase. Safe to call multiple times. */
  async function prepare() {
    if (!enabled) return false;
    if (preparePromise) return preparePromise;
    preparePromise = (async () => {
      const tts = getTts();
      if (!tts) {
        fail('tts module not loaded');
        return false;
      }
      if (typeof tts.synthesize !== 'function' || typeof tts.playPcm !== 'function') {
        fail('tts module has no synthesize()/playPcm()');
        return false;
      }
      if (phrases.length === 0) {
        fail('no valid tts.ack.phrases configured');
        return false;
      }
      const startedAt = performance.now();
      let failures = 0;
      for (const phrase of phrases) {
        try {
          const result = await tts.synthesize(phrase);
          const pcm = result?.pcm;
          if (!Buffer.isBuffer(pcm) || pcm.length < MIN_PCM_BYTES) {
            throw new Error(`synthesis returned no usable PCM for "${phrase}"`);
          }
          cache.set(phrase, { pcm, durationMs: result.durationMs ?? (pcm.length / (sampleRate * 2)) * 1000 });
          stats.bytes += pcm.length;
        } catch (err) {
          failures += 1;
          stats.errors.push(String(err?.message || err));
          log.warn(`wake-ack: phrase "${phrase}" failed: ${err?.message || err}`);
        }
      }
      const ttsStats = tts.stats ?? {};
      stats.phrases = cache.size;
      stats.synthMs = Math.round(performance.now() - startedAt);
      stats.model = ttsStats.model ?? config.minimax?.model ?? null;
      stats.voiceId = ttsStats.voiceId ?? config.minimax?.voiceId ?? null;
      stats.sampleRate = ttsStats.sampleRate ?? sampleRate;
      stats.ready = cache.size > 0;
      if (!stats.ready) stats.disabledReason = failures > 0 ? 'synthesis failed' : 'no phrases cached';
      return stats.ready;
    })()
      .catch((err) => {
        fail(err?.message || err);
        return false;
      })
      .finally(() => {
        preparePromise = null;
      });
    return preparePromise;
  }

  function pickPhrase() {
    const keys = [...cache.keys()];
    if (keys.length === 0) return null;
    return keys[Math.min(keys.length - 1, Math.floor(random() * keys.length))];
  }

  function finishActive(info, stateOverride) {
    const state = stateOverride ?? active;
    if (!state || state.settled) return;
    state.settled = true;
    if (state.timer) clearTimeout(state.timer);
    if (active === state) active = null;
    stats.lastPhrase = state.phrase;
    stats.lastPlayDurationMs = Math.round(performance.now() - state.startedAt);
    stats.plays += 1;
    state.resolveDone({
      phrase: state.phrase,
      ok: Boolean(info?.ok),
      durationMs: info?.durationMs ?? state.entry.durationMs,
      stopped: Boolean(state.stopped),
      ...(info?.error ? { error: info.error } : {}),
    });
  }

  /**
   * Play a random cached phrase through the TTS module's own player.
   * @returns {{phrase:string, started:Promise<number>, done:Promise<object>, stop:()=>void}|null}
   */
  function play() {
    if (closed || !stats.ready) return null;
    const tts = getTts();
    if (!tts || typeof tts.playPcm !== 'function') {
      stats.failures += 1;
      fail('tts.playPcm() unavailable at play time');
      return null;
    }
    const phrase = pickPhrase();
    if (phrase === null) return null;
    const entry = cache.get(phrase);
    if (!entry) return null;

    if (active) stopActive('replaced');
    const startedAt = performance.now();
    let resolveStarted;
    let resolveDone;
    const started = new Promise((resolve) => {
      resolveStarted = resolve;
    });
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const state = {
      phrase,
      entry,
      startedAt,
      settled: false,
      stopped: false,
      timer: null,
      resolveDone,
    };
    active = state;

    let playback;
    try {
      playback = tts.playPcm(entry.pcm, { rate: sampleRate, channels: 1 });
    } catch (err) {
      stats.failures += 1;
      stats.errors.push(String(err?.message || err));
      state.settled = true;
      if (active === state) active = null;
      resolveStarted(-1);
      resolveDone({ phrase, ok: false, durationMs: 0, error: String(err?.message || err) });
      return { phrase, started, done, stop: () => {} };
    }

    // playPcm() hands the PCM to the player synchronously; first write latency is
    // the local call cost (the audible onset is player latency, measured externally).
    const firstWriteMs = Math.round(performance.now() - startedAt);
    stats.lastFirstWriteMs = firstWriteMs;
    resolveStarted(firstWriteMs);

    Promise.resolve(playback)
      .then((info) => {
        finishActive({
          ok: info?.completed !== false && (info?.bytes ?? entry.pcm.length) > 0,
          durationMs: info?.durationMs ?? entry.durationMs,
        });
      })
      .catch((err) => {
        stats.failures += 1;
        stats.errors.push(String(err?.message || err));
        finishActive({ ok: false, error: String(err?.message || err) });
      });

    // Safety net: never leave the daemon waiting on a stuck player.
    state.timer = setTimeout(() => {
      state.timer = null;
      try {
        tts.stop();
      } catch {
        /* ignore */
      }
      finishActive({ ok: false, error: 'playback timeout' });
    }, Math.max(1000, entry.durationMs + 1500));
    state.timer.unref?.();

    return { phrase, started, done, stop: () => stopActive('stop') };
  }

  function stopActive(reason) {
    const state = active;
    if (!state) return false;
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    try {
      getTts()?.stop?.();
    } catch {
      /* ignore */
    }
    finishActive({ ok: false, stopped: true }, state);
    if (active === state) active = null;
    void reason;
    return true;
  }

  return {
    enabled,
    timeoutMs,
    phrases,
    prepare,
    play,
    stop: () => stopActive('stop'),
    close() {
      closed = true;
      stopActive('close');
    },
    get ready() {
      return stats.ready && !closed;
    },
    get playing() {
      return active !== null;
    },
    get stats() {
      return { ...stats, errors: [...stats.errors], cachedPhrases: [...cache.keys()] };
    },
  };
}

export default createWakeAck;
