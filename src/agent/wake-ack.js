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

// Short, natural spoken acknowledgements. Deliberately without punctuation:
// the TTS reads marks as pauses and "有何贵干？" gains an unnatural question
// intonation, so the bare words sound better.
export const DEFAULT_PHRASES = Object.freeze([
  '我在',
  '在的',
  '你好',
  '嘿',
  '有何贵干',
  '来了',
  '听着呢',
  '请讲',
  '久等了',
  '你说',
]);
export const DEFAULT_TIMEOUT_MS = 800;
export const DEFAULT_SYNTH_CONCURRENCY = 3;
export const MAX_SYNTH_CONCURRENCY = 5;
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
  // Avoid playing the same phrase twice in a row (the user heard "在的" twice and
  // thought only one phrase existed).
  const avoidRepeat = ackCfg.avoidRepeat !== false;
  // MiniMax rate-limits at 20 RPM. A daemon restart right after another burst
  // (for example a package upgrade plus a reboot) can hit 1002 and previously
  // left the wake ack permanently unavailable until the next restart. Rate
  // limited phrases are retried with backoff, and if the whole batch is limited
  // a background pass tries again later.
  const retryDelaysMs = (Array.isArray(ackCfg.rateLimitRetryMs) ? ackCfg.rateLimitRetryMs : [4000, 12000])
    .map((value) => Math.max(0, Number(value) || 0))
    .filter((value, index, all) => Number.isFinite(value) && all.indexOf(value) === index);
  const reviveDelayMs = Number.isFinite(Number(ackCfg.reviveDelayMs)) && Number(ackCfg.reviveDelayMs) >= 0
    ? Number(ackCfg.reviveDelayMs)
    : 30000;
  const maxRevives = 2;
  const synthConcurrency = Math.min(
    MAX_SYNTH_CONCURRENCY,
    Math.max(1, Number.isFinite(Number(ackCfg.synthConcurrency))
      ? Math.round(Number(ackCfg.synthConcurrency))
      : DEFAULT_SYNTH_CONCURRENCY),
  );
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
    avoidRepeat,
    synthConcurrency,
    revives: 0,
    reviveScheduledAt: null,
    phraseMs: {}, // phrase -> synthesis wall time (ms), for latency diagnostics
    disabledReason: enabled ? null : 'tts disabled',
  };
  let preparePromise = null;
  let reviveTimer = null;
  let reviveCount = 0;
  let closed = false;
  let active = null; // {phrase, startedAt, settled, resolveDone, timer}
  let lastPickedPhrase = null;

  function fail(reason) {
    stats.ready = false;
    stats.disabledReason = String(reason);
    stats.errors.push(stats.disabledReason);
    log.warn(`wake-ack unavailable: ${stats.disabledReason}`);
  }

  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const isRateLimit = (err) => /1002|rate limit|rpm/i.test(String(err?.message || err));

  /** Synthesize one phrase, retrying when MiniMax answers with a rate limit. */
  async function synthesizeWithRetry(tts, phrase) {
    let lastError = null;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      if (closed) throw new Error('closed');
      try {
        return await tts.synthesize(phrase);
      } catch (err) {
        lastError = err;
        if (!isRateLimit(err) || attempt === retryDelaysMs.length) break;
        const delay = retryDelaysMs[attempt];
        log.info(`wake-ack: phrase "${phrase}" hit the MiniMax rate limit; retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
    throw lastError ?? new Error(`synthesis failed for "${phrase}"`);
  }

  /** If a whole pass was rate limited, try again later instead of staying off. */
  function scheduleRevive() {
    if (closed || reviveTimer || reviveCount >= maxRevives || reviveDelayMs <= 0) return;
    reviveCount += 1;
    stats.revives = reviveCount;
    stats.reviveScheduledAt = Date.now();
    log.info(`wake-ack: retrying pre-synthesis in ${reviveDelayMs}ms (attempt ${reviveCount}/${maxRevives})`);
    reviveTimer = setTimeout(() => {
      reviveTimer = null;
      if (closed) return;
      void prepare();
    }, reviveDelayMs);
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
      let rateLimited = 0;
      // Finite concurrency: 10 short phrases at 3 at a time turns a ~2s serial
      // warm-up into ~2.5s for ten phrases (a single phrase costs ~0.6-0.7s of
      // MiniMax round-trip). Failures are per phrase: one bad phrase must not
      // disable the whole ack.
      let nextIndex = 0;
      const worker = async () => {
        while (!closed) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= phrases.length) return;
          const phrase = phrases[index];
          const phraseStartedAt = performance.now();
          try {
            const result = await synthesizeWithRetry(tts, phrase);
            const pcm = result?.pcm;
            if (!Buffer.isBuffer(pcm) || pcm.length < MIN_PCM_BYTES) {
              throw new Error(`synthesis returned no usable PCM for "${phrase}"`);
            }
            cache.set(phrase, { pcm, durationMs: result.durationMs ?? (pcm.length / (sampleRate * 2)) * 1000 });
            stats.bytes += pcm.length;
            stats.phraseMs[phrase] = Math.round(performance.now() - phraseStartedAt);
          } catch (err) {
            failures += 1;
            if (isRateLimit(err)) rateLimited += 1;
            stats.errors.push(String(err?.message || err));
            log.warn(`wake-ack: phrase "${phrase}" failed: ${err?.message || err}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(synthConcurrency, phrases.length) }, () => worker()));
      const ttsStats = tts.stats ?? {};
      stats.phrases = cache.size;
      stats.synthMs = Math.round(performance.now() - startedAt);
      stats.model = ttsStats.model ?? config.minimax?.model ?? null;
      stats.voiceId = ttsStats.voiceId ?? config.minimax?.voiceId ?? null;
      stats.sampleRate = ttsStats.sampleRate ?? sampleRate;
      stats.ready = cache.size > 0;
      if (stats.ready) {
        stats.disabledReason = null;
      } else {
        stats.disabledReason = rateLimited > 0 ? 'rate limited' : failures > 0 ? 'synthesis failed' : 'no phrases cached';
        // Recover on its own instead of staying silent until the next restart.
        if (rateLimited > 0) scheduleRevive();
      }
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
    // Never play the same phrase twice in a row when we have alternatives.
    const candidates = avoidRepeat && keys.length > 1 && lastPickedPhrase !== null
      ? keys.filter((key) => key !== lastPickedPhrase)
      : keys;
    const pool = candidates.length > 0 ? candidates : keys;
    const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
    const phrase = pool[index];
    lastPickedPhrase = phrase;
    return phrase;
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
      if (reviveTimer) {
        clearTimeout(reviveTimer);
        reviveTimer = null;
      }
      stopActive('close');
    },
    get ready() {
      return stats.ready && !closed;
    },
    get playing() {
      return active !== null;
    },
    get stats() {
      return {
        ...stats,
        errors: [...stats.errors],
        cachedPhrases: [...cache.keys()],
        phraseMs: { ...stats.phraseMs },
        lastPickedPhrase,
      };
    },
  };
}

export default createWakeAck;
