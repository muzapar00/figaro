// PCM helpers for the "play already synthesized audio" path (wake acknowledgements).
//
// The playback pipeline is fixed at 16-bit little-endian mono at the configured
// sample rate (32000 Hz by default). Cached/pre-synthesized ack audio may come
// in other shapes (Float32Array from WebAudio-ish code, 16 kHz mono, stereo...),
// so it is converted once, up front, and then injected into the same player
// stream as the TTS audio.

const S16_MAX = 32767;

function clamp16(v) {
  if (v > S16_MAX) return S16_MAX;
  if (v < -32768) return -32768;
  return Math.round(v);
}

function isTypedFloatArray(data) {
  return data instanceof Float32Array || data instanceof Float64Array;
}

function isTypedInt16Array(data) {
  return data instanceof Int16Array;
}

function bytesToS16Mono(buf, channels) {
  const ch = Math.max(1, Math.floor(channels) || 1);
  const frameBytes = ch * 2;
  const frames = Math.floor(buf.length / frameBytes);
  const out = Buffer.alloc(frames * 2);
  if (ch === 1) {
    buf.copy(out, 0, 0, frames * 2);
    return out;
  }
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < ch; c++) sum += buf.readInt16LE(i * frameBytes + c * 2);
    out.writeInt16LE(clamp16(sum / ch), i * 2);
  }
  return out;
}

function floatsToS16Mono(samples, channels) {
  const ch = Math.max(1, Math.floor(channels) || 1);
  const frames = Math.floor(samples.length / ch);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < ch; c++) sum += Number(samples[i * ch + c]) || 0;
    const v = sum / ch;
    out.writeInt16LE(clamp16(v * S16_MAX), i * 2);
  }
  return out;
}

/**
 * Resample mono s16le PCM (linear interpolation). Adequate for short UI sounds
 * and speech acknowledges; not intended for high-fidelity music.
 * @param {Buffer} pcm mono s16le
 * @param {number} fromRate
 * @param {number} toRate
 */
export function resampleS16Mono(pcm, fromRate, toRate) {
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new Error('invalid sample rate for PCM conversion');
  }
  if (Math.round(fromRate) === Math.round(toRate)) return pcm;
  const inSamples = Math.floor(pcm.length / 2);
  if (inSamples === 0) return pcm;
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcPos = (i * fromRate) / toRate;
    const i0 = Math.min(inSamples - 1, Math.floor(srcPos));
    const i1 = Math.min(inSamples - 1, i0 + 1);
    const frac = srcPos - i0;
    const a = pcm.readInt16LE(i0 * 2);
    const b = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(clamp16(a * (1 - frac) + b * frac), i * 2);
  }
  return out;
}

/**
 * Normalise arbitrary caller audio into the player's format: mono s16le at
 * `targetRate`.
 *
 * Accepted inputs:
 *  - Buffer / Uint8Array  : raw interleaved s16le PCM (assumed `channels`)
 *  - Int16Array           : interleaved s16 samples
 *  - Float32Array / Float64Array / number[] : samples in [-1, 1], interleaved
 *
 * @param {Buffer|Uint8Array|Int16Array|Float32Array|Float64Array|number[]} data
 * @param {{rate?: number, channels?: number, targetRate?: number}} [opts]
 * @returns {Buffer} mono s16le @ targetRate
 */
export function normalizePcm(data, opts = {}) {
  const channels = Math.max(1, Math.floor(opts.channels) || 1);
  const rate = Number.isFinite(opts.rate) && opts.rate > 0 ? opts.rate : 32000;
  const targetRate = Number.isFinite(opts.targetRate) && opts.targetRate > 0 ? opts.targetRate : 32000;

  let mono;
  if (Buffer.isBuffer(data)) {
    mono = bytesToS16Mono(data, channels);
  } else if (data instanceof Uint8Array) {
    mono = bytesToS16Mono(Buffer.from(data.buffer, data.byteOffset, data.byteLength), channels);
  } else if (isTypedInt16Array(data)) {
    mono = bytesToS16Mono(Buffer.from(data.buffer, data.byteOffset, data.byteLength), channels);
  } else if (isTypedFloatArray(data) || Array.isArray(data)) {
    mono = floatsToS16Mono(data, channels);
  } else {
    throw new TypeError('playPcm(data): expected Buffer, Int16Array, Float32Array or number[]');
  }

  if (mono.length === 0) return mono;
  return resampleS16Mono(mono, rate, targetRate);
}

/** Duration of mono s16le PCM in milliseconds. */
export function pcmDurationMs(pcm, sampleRate = 32000) {
  return (pcm.length / 2 / sampleRate) * 1000;
}

export { clamp16 };
export default normalizePcm;
