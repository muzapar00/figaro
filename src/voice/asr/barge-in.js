// Barge-in detector: "the user is deliberately talking over the assistant".
//
// The old implementation fired on any 250 ms of VAD speech while muted, which
// also fires on Figaro's own speaker output leaking into the microphone (the
// user reported the assistant constantly cutting off its own answers). The new
// rule needs BOTH a minimum loudness and a clear margin over the echo level
// measured while the TTS is playing:
//
//   baseline  = median of the microphone RMS during the first 300 ms of playback
//   threshold = max(minRms, baseline * echoFactor)              (normal TTS)
//   threshold = max(minRms * 1.3, baseline * 2.5)               (wake ack: stricter)
//   trigger   = RMS above threshold continuously for >= minMs, then 1 s cooldown
//
// Pure logic (rms windows in, trigger out) so it is unit tested and also reused
// by scripts/asr-bargein-bench.mjs for the acoustic measurement.

// Measured on this machine (scripts/asr-bargein-bench.mjs): real TTS echo
// through the speaker measured RMS median 0.015 / p95 0.041 / max 0.080 over
// 12 s; a deliberate talk-over at mic RMS 0.15 must trigger 5/5 while the echo
// stays at 0. minRms 0.09 + echoFactor 2.5 satisfies both with margin.
export const BARGE_IN_DEFAULTS = Object.freeze({
  enabled: true,
  minRms: 0.09, // absolute floor of normalised RMS (0..1)
  echoFactor: 2.5, // ...and this many times the measured echo baseline
  minMs: 500, // how long the voice has to stay above the threshold
});

/** Stricter thresholds while the wake acknowledgement is playing. */
export const ACK_ECHO_FACTOR = 2.5;
export const ACK_MIN_RMS_FACTOR = 1.3;
export const BASELINE_MS = 300;
/**
 * Real speech has gaps between syllables and words. We accumulate loud-voice
 * time and tolerate quiet gaps up to this long (they do not reset the
 * accumulator); a longer pause starts the measurement over. 200 ms covers
 * normal inter-word gaps without letting music/TTS pauses accumulate.
 */
export const GAP_TOLERANCE_MS = 200;
export const BASELINE_MAX_MS = 1600; // give up waiting for more audio (stalled mic)
export const BARGE_COOLDOWN_MS = 1000;

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Normalise a (possibly partial) bargeIn config object. */
export function normalizeBargeInConfig(patch = {}, base = BARGE_IN_DEFAULTS) {
  const src = patch && typeof patch === 'object' ? patch : {};
  return {
    enabled: src.enabled === undefined ? base.enabled !== false : Boolean(src.enabled),
    minRms: num(src.minRms, base.minRms, 0, 1),
    echoFactor: num(src.echoFactor, base.echoFactor, 0.1, 50),
    minMs: num(src.minMs, base.minMs, 50, 10000),
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {object} [config] asr.bargeIn (missing fields fall back to defaults)
 */
export function createBargeInDetector(config = {}) {
  let cfg = normalizeBargeInConfig(config);
  let active = false;
  let phase = 'tts';
  const baselineSamples = [];
  let baselineMs = 0;
  let baseline = null;
  let aboveMs = 0;
  let gapMs = 0;
  let lastFireAt = 0;
  let fired = 0;

  function threshold() {
    const base = baseline ?? 0;
    if (phase === 'ack') return Math.max(base * ACK_ECHO_FACTOR, cfg.minRms * ACK_MIN_RMS_FACTOR);
    return Math.max(cfg.minRms, base * cfg.echoFactor);
  }

  return {
    /** Arm the detector when the assistant starts speaking (muted). */
    arm({ phase: nextPhase = 'tts', resetCooldown = false } = {}) {
      phase = nextPhase === 'ack' ? 'ack' : 'tts';
      active = cfg.enabled;
      baselineSamples.length = 0;
      baselineMs = 0;
      baseline = null;
      aboveMs = 0;
      gapMs = 0;
      if (resetCooldown) lastFireAt = 0;
      return active;
    },
    /** Assistant stopped speaking / muted ended. */
    disarm() {
      active = false;
      baseline = null;
      aboveMs = 0;
      gapMs = 0;
    },
    get active() {
      return active;
    },
    get phase() {
      return phase;
    },
    get config() {
      return { ...cfg };
    },
    get baseline() {
      return baseline;
    },
    get threshold() {
      return threshold();
    },
    get stats() {
      return {
        config: { ...cfg },
        active,
        phase,
        baseline,
        threshold: threshold(),
        aboveMs,
        fired,
      };
    },
    /** Hot-apply a partial config (keeps the current baseline/phase). */
    setConfig(patch = {}) {
      cfg = normalizeBargeInConfig(patch, cfg);
      if (!cfg.enabled) {
        active = false;
        baseline = null;
        aboveMs = 0;
        gapMs = 0;
      }
      return { ...cfg };
    },
    /**
     * Feed one RMS window.
     * @param {number} rms normalised RMS 0..1
     * @param {number} [windowMs]
     * @param {number} [now] injectable clock for tests
     * @returns {boolean} true exactly when a barge-in should be reported
     */
    process(rms, windowMs = 50, now = Date.now()) {
      if (!active || !cfg.enabled) return false;
      if (baseline === null) {
        baselineSamples.push(rms);
        baselineMs += windowMs;
        if (baselineMs >= BASELINE_MS) baseline = median(baselineSamples);
        else if (baselineMs >= BASELINE_MAX_MS) baseline = median(baselineSamples);
        return false;
      }
      if (rms > threshold()) {
        aboveMs += windowMs;
        gapMs = 0;
      } else {
        gapMs += windowMs;
        if (gapMs > GAP_TOLERANCE_MS) aboveMs = 0;
      }
      if (aboveMs < cfg.minMs) return false;
      aboveMs = 0;
      gapMs = 0;
      if (now - lastFireAt < BARGE_COOLDOWN_MS) return false;
      lastFireAt = now;
      fired += 1;
      return true;
    },
    reset() {
      active = false;
      baselineSamples.length = 0;
      baselineMs = 0;
      baseline = null;
      aboveMs = 0;
      gapMs = 0;
      fired = 0;
      lastFireAt = 0;
    },
  };
}

export default { createBargeInDetector, normalizeBargeInConfig, BARGE_IN_DEFAULTS };
