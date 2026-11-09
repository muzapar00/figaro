// Voice activity detection for the capture phase.
//
// Preferred: sherpa-onnx Silero VAD (models/vad/silero_vad.onnx, shipped by
// scripts/fetch-models.sh). Fallback: an adaptive-energy VAD so the module still
// works (with slightly worse music/noise rejection) when the VAD model is absent.
//
// Both expose the same tiny interface:
//   { windowSize, minSilenceDurationMs, process(samples): boolean, reset() }
// `process` consumes exactly `windowSize` samples and returns whether speech is
// currently detected (Silero keeps a hangover of ~minSilenceDuration).

import fs from 'node:fs';
import { loadSherpa } from './sherpa.js';

const WINDOW = 512; // Silero VAD v5 window = 512 samples @ 16 kHz = 32 ms

/**
 * Create the best available VAD.
 *
 * @param {object} opts
 * @param {string} [opts.modelPath] path to silero_vad.onnx
 * @param {number} [opts.threshold]
 * @param {number} [opts.minSilenceDurationMs]
 * @param {number} [opts.minSpeechDurationMs]
 * @param {number} [opts.numThreads]
 * @returns {{kind: 'silero'|'energy', windowSize: number, minSilenceDurationMs: number,
 *            process(samples: Float32Array): boolean, reset(): void, free(): void}}
 */
export function createVad(opts = {}) {
  const {
    modelPath,
    threshold = 0.5,
    minSilenceDurationMs = 250,
    minSpeechDurationMs = 200,
    numThreads = 1,
  } = opts;

  if (modelPath && fs.existsSync(modelPath)) {
    try {
      {
        const sherpa = loadSherpa();
        const vad = new sherpa.Vad({
          sileroVad: {
            model: modelPath,
            threshold,
            minSilenceDuration: minSilenceDurationMs / 1000,
            minSpeechDuration: minSpeechDurationMs / 1000,
            windowSize: WINDOW,
            maxSpeechDuration: 15,
          },
          sampleRate: 16000,
          numThreads,
          provider: 'cpu',
          debug: 0,
        }, 30);
        return {
          kind: 'silero',
          windowSize: WINDOW,
          minSilenceDurationMs,
          process(samples) {
            vad.acceptWaveform(samples.subarray(0, WINDOW));
            // Drop finished segments so the internal buffer does not grow during
            // a long capture; we only need the per-window speech flag.
            while (!vad.isEmpty()) vad.pop();
            return vad.isDetected();
          },
          reset() {
            vad.reset();
            vad.clear();
          },
          free() {
            // sherpa-onnx VAD holds native memory until GC; nothing else to do.
          },
        };
      }
    } catch {
      // fall through to the energy VAD
    }
  }
  return createEnergyVad({ minSilenceDurationMs });
}

/**
 * Adaptive-energy VAD: tracks a noise floor with an exponential moving minimum
 * and flags speech when the frame RMS clearly exceeds it. No model, no native
 * code, fully deterministic — good enough for a desktop microphone in a quiet
 * room, and used by the unit tests.
 */
export function createEnergyVad(opts = {}) {
  const { minSilenceDurationMs = 250, absoluteFloor = 0.006, ratio = 3.5 } = opts;
  const windowSize = WINDOW;
  let noiseFloor = 0.003;
  let lastSpeechAt = -Infinity;
  let clockMs = 0;

  return {
    kind: 'energy',
    windowSize,
    minSilenceDurationMs,
    process(samples) {
      let sum = 0;
      const n = Math.min(windowSize, samples.length);
      for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / n);
      clockMs += (n / 16000) * 1000;
      const speech = rms > Math.max(absoluteFloor, noiseFloor * ratio);
      if (speech) {
        lastSpeechAt = clockMs;
      } else {
        // Adapt the floor towards quiet frames only, so loud music does not
        // instantly redefine "silence".
        noiseFloor = Math.min(0.02, Math.max(0.0005, noiseFloor * 0.98 + rms * 0.02));
      }
      return clockMs - lastSpeechAt <= minSilenceDurationMs && lastSpeechAt !== -Infinity;
    },
    reset() {
      noiseFloor = 0.003;
      lastSpeechAt = -Infinity;
      clockMs = 0;
    },
    free() {},
  };
}

export default { createVad, createEnergyVad };
