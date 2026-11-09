#!/usr/bin/env node
// Bilingual wake-word benchmark: Chinese「费加罗」 + English "figaro".
//
//   node scripts/asr-bilingual-bench.mjs
//
// For every config.asr.sensitivity level it measures, on the bilingual KWS model
// (sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20):
//   - Chinese positives: the 8 committed fixtures
//   - English positives: committed English fixtures + (optionally) TTS clips in
//     /tmp/en-clips and /tmp/en-clips2 generated for the model evaluation
//   - negatives: real human Chinese speech 10 min, 40 Chinese near-miss
//     sentences, 44 Chinese TTS sentences, English negatives/long passages
// Also reports idle CPU/RSS for the module and the wake latency (zh/en).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKws } from '../src/voice/asr/kws.js';
import { createAsr, SENSITIVITY_PRESETS } from '../src/voice/asr/index.js';
import { loadConfig } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIX = path.join(ROOT, 'tests', 'asr', 'fixtures');
const SR = 16000;
const CH = 1600; // 100 ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return out;
}
function readRaw(file) {
  const b = fs.readFileSync(file);
  const n = Math.floor(b.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(i * 2) / 32768;
  return out;
}

const LEAD = new Float32Array(SR * 0.3);
const PAD = new Float32Array(SR * 1.8);

/** Feed a clip with realistic lead-in/padding. Returns hits with word audio position. */
function feedClip(kws, samples, { leadIn = true } = {}) {
  const hits = [];
  const parts = leadIn ? [LEAD, samples, PAD] : [samples, PAD];
  let pos = 0;
  const leadLen = leadIn ? LEAD.length : 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += CH) {
      const chunk = part.subarray(i, Math.min(i + CH, part.length));
      const hit = kws.feed(chunk);
      pos += chunk.length;
      if (hit) hits.push({ ...hit, atSec: Math.max(0, (pos - leadLen) / SR) });
    }
  }
  return hits;
}

const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));
const zhPos = manifest.filter((m) => m.tag === 'wake').map((m) => ({ name: m.name, samples: readWav(path.join(FIX, m.file)) }));
const enPosCommitted = manifest.filter((m) => m.tag === 'wake-en').map((m) => ({ name: m.name, samples: readWav(path.join(FIX, m.file)) }));

const extraEn = [];
const extraEnDirs = [
  ['/tmp/en-clips', (f) => f.startsWith('en-figaro')], // Chinese voices speaking English
  ['/tmp/en-clips2', (f) => f.endsWith('.wav')], // English-native voices
];
for (const [dir, filter] of extraEnDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => filter(x)).sort()) {
    extraEn.push({ name: `${path.basename(dir)}/${f}`, samples: readWav(path.join(dir, f)) });
  }
}
const enNeg = [];
for (const dir of extraEnDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('en-neg')).sort()) {
    enNeg.push({ name: `${path.basename(dir)}/${f}`, samples: readWav(path.join(dir, f)) });
  }
}
const enLong = [];
const longDir = '/tmp/en-long-neg';
if (fs.existsSync(longDir)) {
  for (const f of fs.readdirSync(longDir).filter((x) => x.endsWith('.wav')).sort()) {
    enLong.push({ name: f, samples: readWav(path.join(longDir, f)) });
  }
}

const negCorpora = [];
const nearMissDir = path.join(ROOT, 'models', 'wake-negatives');
if (fs.existsSync(path.join(nearMissDir, 'manifest.json'))) {
  const nm = JSON.parse(fs.readFileSync(path.join(nearMissDir, 'manifest.json'), 'utf8'));
  negCorpora.push({ name: 'zh-near-miss(40句)', files: nm.map((m) => path.join(nearMissDir, m.file)), loader: readWav });
}
const benchAudio = path.join(ROOT, 'models', 'bench-audio');
if (fs.existsSync(path.join(benchAudio, 'manifest.json'))) {
  const bm = JSON.parse(fs.readFileSync(path.join(benchAudio, 'manifest.json'), 'utf8'));
  negCorpora.push({ name: 'zh-tts-44句', files: bm.map((m) => path.join(benchAudio, m.file)), loader: readWav });
}
if (fs.existsSync('/tmp/realhuman-10min.raw')) {
  negCorpora.push({ name: 'zh-真人10min', files: ['/tmp/realhuman-10min.raw'], loader: readRaw });
}
if (enNeg.length) negCorpora.push({ name: 'en-短句', files: enNeg.map((x) => null), loader: null, samples: enNeg });
if (enLong.length) negCorpora.push({ name: 'en-长段落', files: null, loader: null, samples: enLong });

const config = loadConfig();
const kwsDir = path.resolve(ROOT, config.asr.kwsModelDir);
const wakeWordsEn = Array.isArray(config.asr.wakeWordsEn) ? config.asr.wakeWordsEn : ['figaro', 'hey figaro'];

console.log('== 中英双语唤醒词实测 ==');
console.log(`model dir: ${kwsDir}`);
console.log(`wakeWordsEn: ${JSON.stringify(wakeWordsEn)}`);
console.log(`中文正样本 ${zhPos.length} 条，英文正样本 ${enPosCommitted.length}（提交夹具）+ ${extraEn.length}（外部 TTS 语料）`);
const negSeconds = negCorpora.reduce((n, c) => {
  if (c.samples) return n + c.samples.reduce((a, x) => a + x.samples.length / SR, 0);
  return n + c.files.reduce((a, f) => a + c.loader(f).length / SR, 0);
}, 0);
console.log(`负样本 ${(negSeconds / 60).toFixed(1)} 分钟: ${negCorpora.map((c) => c.name).join(', ')}`);

const results = [];
for (const [level, preset] of Object.entries(SENSITIVITY_PRESETS)) {
  const kws = createKws({
    modelDir: kwsDir,
    wakeWords: config.asr.wakeWords ?? [],
    wakeWordsEn,
    numThreads: 1,
    keywordsScore: preset.keywordsScore,
    keywordsThreshold: preset.keywordsThreshold,
  });
  const zhHits = zhPos.map((p) => feedClip(kws, p.samples));
  const enHits = enPosCommitted.map((p) => feedClip(kws, p.samples));
  const extraHits = extraEn.map((p) => feedClip(kws, p.samples));
  const byCorpus = [];
  let falseTotal = 0;
  for (const corpus of negCorpora) {
    let hits = 0;
    let secs = 0;
    if (corpus.samples) {
      for (const s of corpus.samples) { secs += s.samples.length / SR; if (feedClip(kws, s.samples, { leadIn: false }).length) hits += 1; }
    } else {
      for (const f of corpus.files) { const s = corpus.loader(f); secs += s.length / SR; if (feedClip(kws, s, { leadIn: false }).length) hits += 1; }
    }
    falseTotal += hits;
    byCorpus.push({ name: corpus.name, seconds: Math.round(secs), hits });
  }
  const detPos = zhHits.filter((h) => h.length).map((h) => h[0].atSec);
  detPos.sort((a, b) => a - b);
  const row = {
    level,
    preset,
    keywords: { chinese: kws.keywords.chineseLines.length, english: kws.keywords.englishLines.length },
    model: kws.modelName,
    maxActivePaths: kws.maxActivePaths,
    zh: { hits: zhHits.filter((h) => h.length).length, total: zhHits.length, medianDetectMs: detPos.length ? Math.round(detPos[Math.floor(detPos.length / 2)] * 1000) : null },
    enCommitted: { hits: enHits.filter((h) => h.length).length, total: enHits.length },
    enExtra: { hits: extraHits.filter((h) => h.length).length, total: extraHits.length },
    negatives: { seconds: Math.round(negSeconds), falseTotal, byCorpus },
  };
  results.push(row);
  kws.free?.();
  console.log(`\n[${level}] score=${preset.keywordsScore} threshold=${preset.keywordsThreshold}`);
  console.log(`  中文唤醒: ${row.zh.hits}/${row.zh.total}  中位检测位置 ${row.zh.medianDetectMs}ms`);
  console.log(`  英文唤醒: 提交夹具 ${row.enCommitted.hits}/${row.enCommitted.total}，外部 TTS ${row.enExtra.hits}/${row.enExtra.total}`);
  console.log(`  误唤醒 ${falseTotal} 次 / ${(negSeconds / 60).toFixed(1)}min: ${byCorpus.map((c) => `${c.name}=${c.hits}`).join(', ')}`);
}

// ---- module level: idle CPU/RSS + wake latency (zh/en) ----------------------
function cpuTicks() {
  const s = fs.readFileSync('/proc/self/stat', 'utf8');
  const rp = s.lastIndexOf(')');
  const rest = s.slice(rp + 2).split(' ');
  return Number(rest[11]) + Number(rest[12]);
}
const rssMb = () => Math.round(process.memoryUsage().rss / 1e6);

const moduleResult = { startupMs: null, idleCpuPct: null, idleRssMb: null, latency: {} };
{
  const cfg = { ...config, asr: { ...config.asr, hotkey: '', wakeCaptureFallbackMs: 0, micGain: undefined } };
  const asr = createAsr({
    config: cfg,
    hotkey: false,
    micGain: false,
    onError: () => {},
    onLog: () => {},
  });
  const t0 = Date.now();
  await asr.start();
  moduleResult.startupMs = Date.now() - t0;
  await sleep(2500);
  const c0 = cpuTicks();
  const r0 = rssMb();
  await sleep(20000);
  moduleResult.idleCpuPct = Number((((cpuTicks() - c0) / 100 / 20) * 100).toFixed(2));
  moduleResult.idleRssMb = { start: r0, end: rssMb() };
  moduleResult.modelInfo = { model: asr.modelInfo.model, hasEnglish: asr.modelInfo.hasEnglish, englishKeywords: asr.modelInfo.englishKeywords, keywords: asr.modelInfo.keywords.length, maxActivePaths: asr.modelInfo.maxActivePaths };
  await asr.stop();
}

// wake latency through the real module: zh then en fixtures, realtime paced
async function moduleWakeLatency(clipList) {
  const parts = [];
  let cursor = 0;
  const starts = [];
  const gap = new Float32Array(SR * 1.6);
  for (const clip of clipList) {
    parts.push(clip.samples);
    starts.push((cursor / SR) * 1000);
    cursor += clip.samples.length;
    parts.push(gap);
    cursor += gap.length;
  }
  const pcm = new Float32Array(cursor);
  let off = 0;
  for (const p of parts) { pcm.set(p, off); off += p.length; }
  const events = [];
  let srcStart = 0;
  const asr = createAsr({
    config: { ...config, asr: { ...config.asr, hotkey: '', wakeCaptureFallbackMs: 60000, wakeCooldownMs: 0 } },
    hotkey: false,
    micGain: false,
    source: ({ onPcm }) => {
      let cancelled = false;
      let timer = null;
      let offset = 0;
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
    onWake: () => events.push(Date.now() - srcStart),
    onError: () => {},
    onLog: () => {},
  });
  await asr.start();
  const deadline = Date.now() + 30000;
  while (events.length < clipList.length && Date.now() < deadline) await sleep(20);
  await asr.stop();
  const lat = events.map((at, i) => Math.round(at - starts[i])).sort((a, b) => a - b);
  return { wakes: events.length, total: clipList.length, min: lat[0] ?? null, median: lat[Math.floor(lat.length / 2)] ?? null, max: lat.at(-1) ?? null };
}
moduleResult.latency = {
  zh: await moduleWakeLatency(zhPos.slice(0, 4)),
  en: await moduleWakeLatency(enPosCommitted),
};

console.log('\n== 模块资源与唤醒延迟 ==');
console.log(`启动 ${moduleResult.startupMs}ms；空闲 CPU ${moduleResult.idleCpuPct}%；RSS ${JSON.stringify(moduleResult.idleRssMb)}MB`);
console.log(`模型: ${JSON.stringify(moduleResult.modelInfo)}`);
console.log(`唤醒延迟（含 100ms 播放节奏）zh=${JSON.stringify(moduleResult.latency.zh)} en=${JSON.stringify(moduleResult.latency.en)}`);

console.log('\n__BILINGUAL_JSON__');
console.log(JSON.stringify({ results, moduleResult, negSeconds }, null, 2));
