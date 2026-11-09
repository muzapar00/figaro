#!/usr/bin/env node
// Wake sensitivity + false-wake measurement (acceptance for "误唤醒专项").
//
//   node scripts/asr-wake-sensitivity.mjs
//
// For every config.asr.sensitivity level (low / medium / high) it measures:
//   - hit rate on the 8 committed wake fixtures (and -12 dB attenuated clones)
//   - median wake latency (playback start -> onWake, realtime paced, real module)
//   - false wakes on >= 10 minutes of negative audio:
//       * models/wake-negatives  (40 near-miss sentences: 费/非/飞+加/家)
//       * /tmp/realhuman-10min.raw (10 min continuous real human speech)
//       * /tmp/mic-10min*.raw / /tmp/monitor-10min.raw (real microphone and
//         speaker-monitor recordings from a real session — these contain the
//         TTS echo case, reported separately)
//
// Requires the optional corpora to exist; missing ones are skipped and printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKws } from '../src/voice/asr/kws.js';
import { createAsr, sensitivityPreset, SENSITIVITY_PRESETS } from '../src/voice/asr/index.js';
import { loadConfig } from '../src/config.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIX = path.join(ROOT, 'tests', 'asr', 'fixtures');
const WAKE_NEG = path.join(ROOT, 'models', 'wake-negatives');

function readWav(file) {
  const b = fs.readFileSync(file);
  let off = 12;
  let fmt = null;
  let ds = 0;
  let dl = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4) };
    if (id === 'data') { ds = body; dl = size; }
    off = body + size + (size % 2);
  }
  const n = Math.floor(dl / 2 / fmt.ch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(ds + i * 2 * fmt.ch) / 32768;
  return { samples: out, sampleRate: fmt.sr };
}
function readRaw(file) {
  const b = fs.readFileSync(file);
  const n = Math.floor(b.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(i * 2) / 32768;
  return { samples: out, sampleRate: 16000 };
}
const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));
const positives = manifest.filter((m) => m.tag === 'wake').map((m) => {
  const wav = readWav(path.join(FIX, m.file));
  return { name: m.name, samples: wav.samples, durationMs: m.durationMs };
});
const attenuate = (samples, gain) => Float32Array.from(samples, (v) => Math.max(-1, Math.min(1, v * gain)));

function negatives() {
  const list = [];
  if (fs.existsSync(WAKE_NEG)) {
    const man = JSON.parse(fs.readFileSync(path.join(WAKE_NEG, 'manifest.json'), 'utf8'));
    for (const m of man) {
      const wav = readWav(path.join(WAKE_NEG, m.file));
      list.push({ name: `near-miss:${m.id}`, text: m.text, samples: wav.samples });
    }
  }
  for (const file of ['/tmp/realhuman-10min.raw', '/tmp/mic-10min.raw', '/tmp/monitor-10min.raw', '/tmp/mic-10min2.raw']) {
    if (!fs.existsSync(file)) continue;
    const raw = readRaw(file);
    if (raw.samples.length < 16000 * 10) continue;
    list.push({ name: path.basename(file), samples: raw.samples });
  }
  return list;
}

/** Feed Float32 audio into the KWS in 100 ms chunks; returns hits with audio position. */
function kwsFeed(kws, samples, padSec = 1.6) {
  const hits = [];
  let fed = 0;
  const CH = 1600;
  const feed = (arr) => {
    for (let i = 0; i < arr.length; i += CH) {
      const chunk = arr.subarray(i, Math.min(i + CH, arr.length));
      fed += chunk.length;
      const hit = kws.feed(chunk);
      if (hit) hits.push({ keyword: hit.keyword, at: fed / 16000 });
    }
  };
  feed(samples);
  feed(new Float32Array(16000 * padSec));
  return hits;
}

function realtime(kws, samples) {
  return new Promise((resolve) => {
    let offset = 0;
    const hits = [];
    const CH = 1600;
    const pump = () => {
      if (offset >= samples.length) { resolve({ hits, audioMs: (samples.length / 16000) * 1000 }); return; }
      const end = Math.min(offset + CH, samples.length);
      hits.push(...kwsFeedChunk(kws, samples.subarray(offset, end)));
      offset = end;
      setTimeout(pump, 100);
    };
    pump();
  });
}
function kwsFeedChunk(kws, chunk) {
  const hit = kws.feed(chunk);
  return hit ? [hit] : [];
}

const config = loadConfig();
const kwsDir = path.resolve(ROOT, config.asr.kwsModelDir);
const negs = negatives();
const negSeconds = negs.reduce((n, x) => n + x.samples.length / 16000, 0);

// ---- 1) KWS-level measurements per sensitivity level ----
const kwsResults = {};
for (const level of Object.keys(SENSITIVITY_PRESETS)) {
  const p = sensitivityPreset(level);
  const kws = createKws({ modelDir: kwsDir, wakeWords: config.asr.wakeWords, numThreads: 1, keywordsScore: p.keywordsScore, keywordsThreshold: p.keywordsThreshold });
  let hit = 0;
  let quiet25 = 0;
  const detPositions = [];
  for (const clip of positives) {
    const h = kwsFeed(kws, clip.samples);
    if (h.length) { hit += 1; detPositions.push(h[0].at); }
  }
  for (const clip of positives) {
    const h = kwsFeed(kws, attenuate(clip.samples, 0.25));
    if (h.length) quiet25 += 1;
  }
  let falseHits = 0;
  const falseDetail = [];
  const byCorpus = {};
  for (const neg of negs) {
    const kind = neg.name.startsWith('near-miss:') ? 'near-miss'
      : neg.name.startsWith('realhuman') ? 'real-human-10min'
        : 'mic/monitor-recording(TTS echo)';
    const h = kwsFeed(kws, neg.samples, 0.3);
    if (h.length) {
      falseHits += h.length;
      byCorpus[kind] = (byCorpus[kind] ?? 0) + h.length;
      falseDetail.push(`${neg.name}:${h.map((x) => `${x.keyword}@${x.at.toFixed(0)}s`).join(',')}`);
    }
  }
  kws.free?.();
  detPositions.sort((a, b) => a - b);
  kwsResults[level] = {
    params: p,
    hit,
    total: positives.length,
    quiet25,
    falseHits,
    falseByCorpus: byCorpus,
    falseDetail,
    medianDetectionPosMs: detPositions.length ? Math.round(detPositions[Math.floor(detPositions.length / 2)] * 1000) : null,
    negativeSeconds: Math.round(negSeconds),
  };
}

// ---- 2) module-level wake latency per sensitivity level (realtime) ----
const moduleResults = {};
for (const level of Object.keys(SENSITIVITY_PRESETS)) {
  const pcmParts = [];
  const starts = [];
  let cursorSamples = 0;
  const gap = new Float32Array(16000 * 1.6); // 1.6 s silence between clips (no capture: fallback high)
  for (const clip of positives) {
    pcmParts.push(clip.samples);
    starts.push((cursorSamples / 16000) * 1000);
    cursorSamples += clip.samples.length;
    pcmParts.push(gap);
    cursorSamples += gap.length;
  }
  const total = pcmParts.reduce((n, a) => n + a.length, 0);
  const pcm = new Float32Array(total);
  let off = 0;
  for (const part of pcmParts) { pcm.set(part, off); off += part.length; }
  const events = [];
  const cfg = { ...config, asr: { ...config.asr, hotkey: '', wakeCaptureFallbackMs: 60000, wakeCooldownMs: 0, sensitivity: level } };
  let srcStart = 0;
  const asr = createAsr({
    config: cfg,
    hotkey: false,
    micGain: false,
    source: ({ onPcm }) => {
      let cancelled = false;
      let timer = null;
      let offset = 0;
      const CH = 1600;
      return {
        async start() {
          srcStart = Date.now();
          const pump = () => {
            if (cancelled || offset >= pcm.length) return;
            const end = Math.min(offset + CH, pcm.length);
            onPcm(pcm.subarray(offset, end));
            offset = end;
            if (offset < pcm.length) timer = setTimeout(pump, 100);
          };
          pump();
        },
        async stop() { cancelled = true; clearTimeout(timer); },
      };
    },
    onWake: () => events.push({ at: Date.now() - srcStart }),
    onError: () => {},
    onLog: () => {},
  });
  await asr.start();
  const deadline = Date.now() + 60000;
  while (events.length < positives.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await asr.stop();
  const latencies = events.map((e, i) => (i < starts.length ? Math.round(e.at - starts[i]) : null)).filter((x) => x !== null);
  latencies.sort((a, b) => a - b);
  moduleResults[level] = {
    wakes: events.length,
    latencyMs: latencies.length ? { min: latencies[0], median: latencies[Math.floor(latencies.length / 2)], max: latencies.at(-1) } : null,
  };
}

// ---- report ----
console.log(`\n负样本总时长: ${(negSeconds / 60).toFixed(1)} 分钟`);
console.log(`  ${negs.map((n) => `${n.name}=${(n.samples.length / 16000).toFixed(0)}s`).join(', ')}`);
console.log('\n=== 唤醒灵敏度实测 ===');
console.log(['level'.padEnd(6), 'score', 'thr', '命中', '0.25x', '检测位置', '真人10min', '近音40句', '录音回声', '合计'].join(' | '));
for (const [level, r] of Object.entries(kwsResults)) {
  console.log([
    level.padEnd(6),
    String(r.params.keywordsScore).padEnd(5),
    String(r.params.keywordsThreshold).padEnd(4),
    `${r.hit}/${r.total}`.padEnd(4),
    `${r.quiet25}/${r.total}`.padEnd(4),
    `${r.medianDetectionPosMs}ms`.padEnd(7),
    String(r.falseByCorpus['real-human-10min'] ?? 0).padEnd(8),
    String(r.falseByCorpus['near-miss'] ?? 0).padEnd(8),
    String(r.falseByCorpus['mic/monitor-recording(TTS echo)'] ?? 0).padEnd(8),
    String(r.falseHits).padEnd(4),
  ].join(' | '));
}
console.log('\n=== 唤醒延迟（真机播放节奏，模块 onWake）===');
for (const [level, r] of Object.entries(moduleResults)) {
  console.log(`  ${level.padEnd(8)} wakes=${r.wakes}/8 latency(min/median/max)=${JSON.stringify(r.latencyMs)}`);
}
const output = {
  generatedAt: new Date().toISOString(),
  negativeSeconds: negSeconds,
  negatives: negs.map((n) => ({ name: n.name, seconds: Math.round(n.samples.length / 16000) })),
  kws: kwsResults,
  module: moduleResults,
};
const outFile = path.join('/tmp', 'asr-wake-sensitivity.json');
fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
console.log(`\njson: ${outFile}`);
console.log('\n__SENS_JSON__');
console.log(JSON.stringify(output, null, 2));
