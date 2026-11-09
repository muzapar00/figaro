// Manual tool: objective prosody stats for candidate TTS WAVs.
//
//   node tests/tts/analyze-prosody.mjs [dir=tests/tts/out]
//
// F0 median / P10-P90 range (semitones), voiced ratio and RMS dynamics are a
// rough objective proxy for prosody. They are NOT a naturalness verdict — use
// the WAVs and your ears for that.
import fs from 'node:fs';
import path from 'node:path';

function readWavPcm(file) {
  const b = fs.readFileSync(file);
  // find 'data' chunk
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') return { pcm: b.subarray(off + 8, off + 8 + size), sampleRate: b.readUInt32LE(24) };
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in ' + file);
}

function f0Stats(pcm, sr) {
  const frameLen = Math.round(sr * 0.04); // 40ms
  const hop = Math.round(sr * 0.02);
  const minLag = Math.floor(sr / 400);
  const maxLag = Math.floor(sr / 65);
  const f0s = [];
  let rmsAll = [];
  for (let start = 0; (start + frameLen + maxLag) * 2 < pcm.length; start += hop) {
    let sum = 0;
    const n = frameLen + maxLag;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = pcm.readInt16LE((start + i) * 2) / 32768;
    for (let i = 0; i < frameLen; i++) sum += x[i] * x[i];
    const rms = Math.sqrt(sum / frameLen);
    rmsAll.push(rms);
    if (rms < 0.01) continue;
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0, e1 = 0, e2 = 0;
      for (let i = 0; i < frameLen; i++) {
        corr += x[i] * x[i + lag];
        e1 += x[i] * x[i];
        e2 += x[i + lag] * x[i + lag];
      }
      const norm = corr / Math.sqrt(e1 * e2 + 1e-9);
      if (norm > best) { best = norm; bestLag = lag; }
    }
    if (best > 0.55 && bestLag > 0) f0s.push(sr / bestLag);
  }
  // robust stats
  f0s.sort((a, b) => a - b);
  const q = (p) => f0s[Math.floor((f0s.length - 1) * p)];
  const med = q(0.5), lo = q(0.1), hi = q(0.9);
  const st = (f) => 12 * Math.log2(f / 55); // semitones above 55Hz
  const rmsMean = rmsAll.reduce((a, b) => a + b, 0) / rmsAll.length;
  const rmsStd = Math.sqrt(rmsAll.reduce((a, b) => a + (b - rmsMean) ** 2, 0) / rmsAll.length);
  return {
    voicedRatio: +(f0s.length / rmsAll.length).toFixed(2),
    f0Median: +med.toFixed(1),
    f0P10: +lo.toFixed(1),
    f0P90: +hi.toFixed(1),
    f0RangeSemitones: +(st(hi) - st(lo)).toFixed(2),
    rmsMean: +rmsMean.toFixed(3),
    rmsRelStd: +(rmsStd / (rmsMean || 1)).toFixed(2),
  };
}

const dir = process.argv[2] || 'tests/tts/out';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
const rows = [];
for (const f of files) {
  const { pcm, sampleRate } = readWavPcm(path.join(dir, f));
  const dur = pcm.length / 2 / sampleRate;
  const s = f0Stats(pcm, sampleRate);
  rows.push({ file: f, audioSec: +dur.toFixed(2), ...s });
}
console.log('file | audio(s) | voiced% | F0 median(Hz) | F0 range(st) | RMS mean | RMS rel.std');
for (const r of rows) {
  console.log(`${r.file} | ${r.audioSec} | ${(r.voicedRatio*100).toFixed(0)}% | ${r.f0Median} | ${r.f0RangeSemitones} | ${r.rmsMean} | ${r.rmsRelStd}`);
}
fs.writeFileSync(path.join(dir, 'prosody.json'), JSON.stringify(rows, null, 2));
