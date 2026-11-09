// PCM conversion tests for the playPcm() path.

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePcm, pcmDurationMs, resampleS16Mono } from '../../src/voice/tts/pcm.js';

function sineS16(samples, amplitude = 16384) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((i / 32) * Math.PI * 2)), i * 2);
  }
  return buf;
}

test('mono s16 at the target rate is passed through unchanged', () => {
  const pcm = sineS16(1600);
  const out = normalizePcm(pcm, { rate: 32000, channels: 1, targetRate: 32000 });
  assert.ok(out.equals(pcm));
});

test('stereo s16 is downmixed to mono', () => {
  const frames = 4;
  const stereo = Buffer.alloc(frames * 4);
  stereo.writeInt16LE(1000, 0); // L
  stereo.writeInt16LE(3000, 2); // R
  stereo.writeInt16LE(-2000, 4);
  stereo.writeInt16LE(2000, 6);
  stereo.writeInt16LE(0, 8);
  stereo.writeInt16LE(0, 10);
  stereo.writeInt16LE(8000, 12);
  stereo.writeInt16LE(4000, 14);
  const out = normalizePcm(stereo, { rate: 32000, channels: 2, targetRate: 32000 });
  assert.equal(out.length, frames * 2);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => out.readInt16LE(i * 2)),
    [2000, 0, 0, 6000],
  );
});

test('Float32Array samples are converted to s16 (0.5 amplitude ~ 16384)', () => {
  const n = 512;
  const floats = new Float32Array(n);
  for (let i = 0; i < n; i++) floats[i] = i % 2 === 0 ? 0.5 : -0.5;
  const out = normalizePcm(floats, { rate: 32000, channels: 1, targetRate: 32000 });
  assert.equal(out.length, n * 2);
  assert.equal(out.readInt16LE(0), 16384); // round(0.5 * 32767)
  assert.equal(out.readInt16LE(2), -16383); // Math.round rounds -0.5 up
});

test('Float32 out-of-range values are clamped', () => {
  const out = normalizePcm(new Float32Array([2, -2, 0]), { targetRate: 32000 });
  assert.equal(out.readInt16LE(0), 32767);
  assert.equal(out.readInt16LE(2), -32768);
  assert.equal(out.readInt16LE(4), 0);
});

test('Int16Array is accepted', () => {
  const out = normalizePcm(new Int16Array([100, -100, 0]), { targetRate: 32000 });
  assert.equal(out.length, 6);
  assert.equal(out.readInt16LE(0), 100);
  assert.equal(out.readInt16LE(2), -100);
});

test('16 kHz PCM is resampled to 32 kHz (2x duration in samples)', () => {
  const src = sineS16(1600); // 100ms @16k
  const out = normalizePcm(src, { rate: 16000, channels: 1, targetRate: 32000 });
  assert.equal(out.length, 1600 * 2 * 2);
  // resampled signal must still be a sine-ish waveform with sane amplitude
  let max = 0;
  for (let i = 0; i < out.length; i += 2) max = Math.max(max, Math.abs(out.readInt16LE(i)));
  assert.ok(max > 10000 && max <= 16384, `max=${max}`);
});

test('resampleS16Mono keeps a constant signal constant', () => {
  const src = Buffer.alloc(100 * 2, 0);
  for (let i = 0; i < 100; i++) src.writeInt16LE(1234, i * 2);
  const out = resampleS16Mono(src, 8000, 32000);
  assert.equal(out.length, 400 * 2);
  for (let i = 0; i < 400; i++) assert.equal(out.readInt16LE(i * 2), 1234);
});

test('empty input yields empty output', () => {
  assert.equal(normalizePcm(Buffer.alloc(0), {}).length, 0);
  assert.equal(normalizePcm(new Float32Array(0), {}).length, 0);
});

test('unsupported input types throw TypeError', () => {
  assert.throws(() => normalizePcm('hello'), TypeError);
  assert.throws(() => normalizePcm(42), TypeError);
  assert.throws(() => normalizePcm(null), TypeError);
});

test('pcmDurationMs computes mono s16 duration', () => {
  const pcm = Buffer.alloc(32000 * 2); // 1s @32k
  assert.equal(pcmDurationMs(pcm, 32000), 1000);
  assert.equal(pcmDurationMs(pcm.subarray(0, 64), 32000), 1);
});
