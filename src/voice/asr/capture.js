// Capture state machine: one utterance, from beginCapture() to onFinal().
//
// Audio clock, not wall clock, drives segmentation: silenceStopMs / maxCaptureMs
// are measured in captured audio milliseconds. That makes the behaviour
// deterministic for unit tests (feed a buffer as fast as you like) and correct
// for a live 16 kHz parec stream.
//
// Flow:
//   begin(preRoll)  -> VAD + streaming ASR run over preRoll + live audio
//   push(pcm)       -> updates VAD / partials, may ask for auto end
//   end(reason)     -> offline ASR (or streaming text) -> strip wake word -> final

import { stripWakePrefix } from './pinyin.js';

const SAMPLE_RATE = 16000;
const silenceNow = () => Date.now();

/**
 * @param {object} opts
 * @param {object} opts.config full config (uses config.asr.*)
 * @param {object|null} opts.streaming streaming recogniser (createStreamingAsr) or null
 * @param {object|null} opts.offline   offline recogniser (createOfflineAsr) or null
 * @param {object|null} opts.vad       voice activity detector (createVad) or null
 * @param {string[]} opts.wakeWords
 * @param {(text: string) => void} [opts.onPartial]
 * @param {() => void} [opts.onVadStart]
 * @param {(reason: string) => void} [opts.onAutoEnd] called when the module wants endCapture()
 * @param {(err: Error) => void} [opts.onError]
 */
export function createCapture(opts) {
  const {
    config,
    streaming = null,
    offline = null, // recogniser object, null, or a () => recogniser lazy getter
    vad = null,
    wakeWords = [],
    onPartial = () => {},
    onVadStart = () => {},
    onAutoEnd = () => {},
    onError = () => {},
  } = opts;
  const offlineRef = typeof offline === 'function' ? offline : () => offline;
  const asrCfg = config?.asr ?? {};
  const silenceStopMs = asrCfg.silenceStopMs ?? 900;
  const maxCaptureMs = asrCfg.maxCaptureMs ?? 15000;
  const minCaptureMs = asrCfg.minCaptureMs ?? 350;
  // Silero VAD has a hangover of minSilenceDuration; compensate so the total
  // "speech ended -> endCapture" latency stays around silenceStopMs.
  const vadHangoverMs = vad?.minSilenceDurationMs ?? 0;
  const effectiveSilenceMs = Math.max(120, silenceStopMs - vadHangoverMs);
  // When the user woke us but says nothing, give them a bit more than silenceStopMs
  // before cancelling (waking and then drawing breath is normal).
  const initialWaitMs = Math.max(silenceStopMs, 1500);

  let active = false;
  let reason = null;
  let chunks = [];
  let preRollSamples = 0;
  let audioPosMs = 0; // audio clock including pre-roll
  let postMs = 0; // audio clock after beginCapture()
  let lastSpeechAt = -1;
  let speechSeen = false;
  let vadStartEmitted = false;
  let vadRemainder = new Float32Array(0);
  let streamText = '';
  let lastPartial = '';
  let lastPartialAt = -10_000;
  let startedAt = 0;

  /** @param {Float32Array} samples @ 16kHz */
  function runVad(samples) {
    if (!vad) return;
    const windowSize = vad.windowSize ?? 512;
    let buf;
    if (vadRemainder.length) {
      buf = new Float32Array(vadRemainder.length + samples.length);
      buf.set(vadRemainder, 0);
      buf.set(samples, vadRemainder.length);
    } else {
      buf = samples;
    }
    let off = 0;
    while (off + windowSize <= buf.length) {
      const win = buf.subarray(off, off + windowSize);
      const startMs = audioPosMs + (off / SAMPLE_RATE) * 1000;
      let detected = false;
      try {
        detected = vad.process(win);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
      if (detected) {
        lastSpeechAt = startMs + (windowSize / SAMPLE_RATE) * 1000;
        speechSeen = true;
        if (!vadStartEmitted && startMs >= preRollSamples / SAMPLE_RATE * 1000 - 1) {
          vadStartEmitted = true;
          try { onVadStart(); } catch (err) { onError(err instanceof Error ? err : new Error(String(err))); }
        }
      }
      off += windowSize;
    }
    vadRemainder = buf.slice(off);
  }

  function feedStreaming(samples) {
    if (!streaming) return;
    try {
      const text = streaming.feed(samples);
      streamText = text ?? '';
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function maybeEmitPartial(force = false) {
    if (!streaming) return;
    const text = stripWakePrefix(streamText, wakeWords).trim();
    if (!text || text === lastPartial) return;
    if (!force && postMs - lastPartialAt < 90) return;
    lastPartial = text;
    lastPartialAt = postMs;
    try { onPartial(text); } catch (err) { onError(err instanceof Error ? err : new Error(String(err))); }
  }

  function totalSamples() {
    return chunks.reduce((n, c) => n + c.length, 0);
  }

  const capture = {
    get active() {
      return active;
    },
    get elapsedMs() {
      return postMs;
    },
    get partialText() {
      return stripWakePrefix(streamText, wakeWords).trim();
    },
    get stats() {
      return { active, reason, postMs, audioPosMs, lastSpeechAt, speechSeen, vadKind: vad?.kind ?? 'none' };
    },

    /**
     * @param {Float32Array} [preRoll] audio recorded before beginCapture() (wake word)
     */
    begin(preRoll) {
      active = true;
      reason = null;
      chunks = [];
      preRollSamples = preRoll && preRoll.length ? preRoll.length : 0;
      audioPosMs = 0;
      postMs = 0;
      lastSpeechAt = -1;
      speechSeen = false;
      vadStartEmitted = false;
      vadRemainder = new Float32Array(0);
      streamText = '';
      lastPartial = '';
      lastPartialAt = -10_000;
      startedAt = silenceNow();
      if (vad) { try { vad.reset(); } catch { /* ignore */ } }
      if (streaming) { try { streaming.reset(); } catch { /* ignore */ } }
      if (preRoll && preRoll.length) {
        chunks.push(preRoll);
        audioPosMs = (preRoll.length / SAMPLE_RATE) * 1000;
        runVad(preRoll);
        feedStreaming(preRoll);
        maybeEmitPartial(true);
      }
    },

    /**
     * Feed newly captured audio. May invoke onAutoEnd() when a stop condition is
     * reached; callers should then call end().
     * @param {Float32Array} samples
     * @returns {{autoEnd: boolean, reason: string|null}}
     */
    push(samples) {
      if (!active || !samples || samples.length === 0) return { autoEnd: false, reason: null };
      chunks.push(samples);
      const ms = (samples.length / SAMPLE_RATE) * 1000;
      runVad(samples);
      feedStreaming(samples);
      maybeEmitPartial();
      audioPosMs += ms;
      postMs += ms;

      let nextReason = null;
      if (lastSpeechAt >= 0 && audioPosMs - lastSpeechAt >= effectiveSilenceMs) {
        nextReason = 'silence';
      } else if (lastSpeechAt < 0 && postMs >= initialWaitMs) {
        nextReason = 'no-speech';
      }
      if (!nextReason && postMs >= maxCaptureMs) nextReason = 'max-duration';
      if (nextReason) {
        active = false;
        reason = nextReason;
        try { onAutoEnd(nextReason); } catch (err) { onError(err instanceof Error ? err : new Error(String(err))); }
        return { autoEnd: true, reason: nextReason };
      }
      return { autoEnd: false, reason: null };
    },

    /**
     * Finish the utterance and produce the final transcript.
     * @returns {Promise<{text: string, reason: string, stats: object}>}
     */
    async end(why = 'manual') {
      if (!active && reason === null) {
        return { text: '', reason: 'not-capturing', stats: capture.stats };
      }
      active = false;
      if (!reason) reason = why;
      const pcm = new Float32Array(totalSamples());
      let off = 0;
      for (const c of chunks) { pcm.set(c, off); off += c.length; }
      chunks = [];
      if (streaming) maybeEmitPartial(true);

      let text = '';
      const offlineAsr = postMs < minCaptureMs ? null : offlineRef();
      if (postMs < minCaptureMs) {
        text = ''; // too short (e.g. a quick F5 tap): discard
      } else if (offlineAsr) {
        try {
          text = await offlineAsr.transcribe(pcm);
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)));
          text = streamText;
        }
      } else if (streaming) {
        text = streamText;
      }
      const cleaned = stripWakePrefix(text, wakeWords).trim();
      const stats = { ...capture.stats, totalMs: (pcm.length / SAMPLE_RATE) * 1000, wallMs: silenceNow() - startedAt };
      return { text: cleaned, reason, stats };
    },

    reset() {
      active = false;
      reason = null;
      chunks = [];
      audioPosMs = 0;
      postMs = 0;
      lastSpeechAt = -1;
      speechSeen = false;
      vadStartEmitted = false;
      vadRemainder = new Float32Array(0);
      streamText = '';
      lastPartial = '';
    },
  };
  return capture;
}

export default { createCapture };
