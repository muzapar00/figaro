#!/usr/bin/env node
// Two-stage wake verification benchmark v2 (task-7) — acceptance + latency.
//
// Measures:
//  1. module-level recall & added latency: Chinese 8 fixtures + English 3
//     fixtures through createAsr(), per clip tries a few lead-in alignments
//     (KWS chunk alignment is pre-existing), compares verification on vs off;
//  2. external English TTS (20 clips): KWS hit at its best alignment, then the
//     exact verification buffer (pre-roll 1.5 s + post 0.3 s) is transcribed by
//     the lazy offline paraformer and matched — counts false rejects (misses);
//  3. near-miss 40 phrases: KWS hits -> verification rejects (0 wakes);
//  4. human Chinese 10 min recording: no wake with verification enabled.
//
//   node scripts/asr-wake-verify-bench2.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAsr } from '../src/voice/asr/index.js';
import { createKws } from '../src/voice/asr/kws.js';
import { createOfflineAsr } from '../src/voice/asr/recognizers.js';
import { matchWakeText, POST_ROLL_MS } from '../src/voice/asr/wake-verify.js';
import { SENSITIVITY_PRESETS } from '../src/voice/asr/index.js';
import { loadConfig } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'asr', 'fixtures');
const SR = 16000;
const CH = 1600;
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
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(body + 2) };
    if (id === 'data') { ds = body; dl = size; }
    off = body + size + (size % 2);
  }
  const n = Math.floor(dl / 2 / fmt.ch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(ds + i * 2 * fmt.ch) / 32768;
  return out;
}
const silence = (ms) => new Float32Array(Math.round((SR * ms) / 1000));
const concat = (...arrs) => {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
};
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)]);
};

function baseAsrConfig(verifyEnabled) {
  const config = loadConfig();
  config.asr = {
    ...config.asr,
    hotkey: '',
    wakeCaptureFallbackMs: 60000,
    wakeCooldownMs: 0,
    verifyWake: { enabled: verifyEnabled },
  };
  return config;
}

/** One clip through the real module; latency measured from clip start (after lead). */
async function runClip(clip, { verifyEnabled, leadMs = 400 } = {}) {
  const lead = silence(leadMs);
  const pcm = concat(lead, clip, silence(3000));
  const config = baseAsrConfig(verifyEnabled);
  const events = [];
  const pumpStart = { t: 0 };
  const asr = createAsr({
    config,
    hotkey: false,
    micGain: false,
    source: ({ onPcm }) => {
      let cancelled = false;
      let timer = null;
      let off = 0;
      return {
        async start() {
          pumpStart.t = Date.now();
          const pump = () => {
            if (cancelled || off >= pcm.length) return;
            const end = Math.min(off + CH, pcm.length);
            onPcm(pcm.subarray(off, end));
            off = end;
            timer = setTimeout(pump, 100);
          };
          pump();
        },
        async stop() { cancelled = true; clearTimeout(timer); },
      };
    },
    onWake: () => events.push({ wallMs: Date.now() - pumpStart.t }),
    onError: () => {},
    onLog: () => {},
  });
  await asr.start();
  const deadline = Date.now() + Math.round((pcm.length / SR) * 1000) + 12000;
  let fedDone = false;
  while (Date.now() < deadline) {
    await sleep(40);
    if (events.length && Date.now() - pumpStart.t > events[0].wallMs + 2500) { fedDone = true; break; }
    if (!events.length && Date.now() - pumpStart.t > (pcm.length / SR) * 1000 + 4000) break;
  }
  void fedDone;
  const stats = asr.verifyStats;
  await asr.stop();
  return { woke: events.length > 0, latencyMs: events[0] ? Math.max(0, events[0].wallMs - leadMs) : null, stats };
}

/** Find a lead-in alignment where the raw KWS hits; returns {leadMs, hitSample}. */
async function findKwsHit(clip) {
  const cfg = loadConfig();
  const kwsDir = path.resolve(ROOT, cfg.asr.kwsModelDir);
  const preset = SENSITIVITY_PRESETS[cfg.asr.sensitivity] ?? SENSITIVITY_PRESETS.high;
  for (const leadMs of [300, 400, 500, 600, 700, 800]) {
    const kws = createKws({
      modelDir: kwsDir,
      wakeWords: cfg.asr.wakeWords ?? [],
      wakeWordsEn: Array.isArray(cfg.asr.wakeWordsEn) ? cfg.asr.wakeWordsEn : ['figaro', 'hey figaro'],
      numThreads: 1,
      keywordsScore: preset.keywordsScore,
      keywordsThreshold: preset.keywordsThreshold,
    });
    const lead = silence(leadMs);
    const pcm = concat(lead, clip, silence(1800));
    let hit = null;
    for (let i = 0; i < pcm.length; i += CH) {
      hit = kws.feed(pcm.subarray(i, Math.min(i + CH, pcm.length)));
      if (hit) { hit.sample = i + CH; break; }
    }
    kws.free?.();
    if (hit) return { leadMs, hit };
  }
  return null;
}

const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));
const zhPos = manifest.filter((m) => m.tag === 'wake').map((m) => ({ name: m.name, samples: readWav(path.join(FIX, m.file)) }));
const enPos = manifest.filter((m) => m.tag === 'wake-en').map((m) => ({ name: m.name, samples: readWav(path.join(FIX, m.file)) }));
const enExternal = [];
for (const [dir, filter] of [['/tmp/en-clips', (f) => f.startsWith('en-figaro')], ['/tmp/en-clips2', (f) => f.endsWith('.wav')]]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter(filter).sort()) enExternal.push({ name: `ext/${f}`, samples: readWav(path.join(dir, f)) });
}

console.log('== 两段式唤醒校验实测 v2 ==');
console.log(`中文夹具 ${zhPos.length} / 英文夹具 ${enPos.length} / 英文外部 TTS ${enExternal.length}`);

// ---- 1. module recall + added latency (zh + en fixtures) -------------------
async function recallAndLatency(clips, label) {
  const rows = [];
  for (const clip of clips) {
    const hit = await findKwsHit(clip.samples);
    const leadMs = hit?.leadMs ?? 400;
    const off = await runClip(clip.samples, { verifyEnabled: false, leadMs });
    const on = await runClip(clip.samples, { verifyEnabled: true, leadMs });
    rows.push({ name: clip.name, leadMs, off, on });
    console.log(`  ${clip.name}: KWS=${off.woke ? 'wake' : 'miss'} 校验后=${on.woke ? 'wake' : 'miss'}${on.stats.lastVerify ? `  text="${on.stats.lastVerify.text}" reason=${on.stats.lastVerify.reason} verifyMs=${on.stats.lastVerify.ms}` : ''}`);
  }
  const offLat = rows.filter((r) => r.off.woke && r.off.latencyMs !== null).map((r) => r.off.latencyMs);
  const onLat = rows.filter((r) => r.on.woke && r.on.latencyMs !== null).map((r) => r.on.latencyMs);
  const missed = rows.filter((r) => r.off.woke && !r.on.woke).map((r) => r.name);
  console.log(`${label}: 唤醒 ${rows.filter((r) => r.on.woke).length}/${rows.length}；校验导致漏唤 ${missed.length} ${missed.length ? JSON.stringify(missed) : ''}`);
  console.log(`${label} 延迟(从片段开头): 校验关 median=${median(offLat)}ms，校验开 median=${median(onLat)}ms，增加=${median(onLat) - median(offLat)}ms`);
  return { rows, missed, latency: { offMedian: median(offLat), onMedian: median(onLat), addedMedian: median(onLat) - median(offLat) } };
}
console.log('\n--- 中文 8 条（模块逐条） ---');
const zhRes = await recallAndLatency(zhPos, '中文');
console.log('\n--- 英文夹具 3 条（模块逐条） ---');
const enRes = await recallAndLatency(enPos, '英文夹具');

// ---- 2. external English TTS: verification false-reject rate ---------------
const cfgNow = loadConfig();
const offline = createOfflineAsr({ dir: path.resolve(ROOT, cfgNow.asr.offlineModelDir ?? 'models/asr-offline'), numThreads: 1 });
const extRows = [];
for (const clip of enExternal) {
  const hit = await findKwsHit(clip.samples);
  if (!hit) { extRows.push({ name: clip.name, kws: false, accepted: null }); continue; }
  const preSamples = Math.round(1.5 * SR);
  const postSamples = Math.round((POST_ROLL_MS / 1000) * SR);
  const pcm = concat(silence(hit.leadMs), clip.samples, silence(1000));
  const start = Math.max(0, hit.hit.sample - preSamples);
  const end = Math.min(pcm.length, hit.hit.sample + postSamples);
  const buffer = pcm.subarray(start, end);
  const t0 = Date.now();
  const text = await offline.transcribe(buffer);
  const ms = Date.now() - t0;
  const match = matchWakeText(text, { lang: hit.hit.lang ?? 'en' });
  extRows.push({ name: clip.name, kws: true, accepted: match.ok, reason: match.reason, text, ms, lang: hit.hit.lang ?? 'en' });
}
const extMiss = extRows.filter((r) => r.kws && !r.accepted).map((r) => r.name);
const extTooShort = extRows.filter((r) => !r.kws).map((r) => r.name);
console.log(`\n--- 英文外部 TTS ${enExternal.length} 条：校验接受率 ---`);
console.log(`KWS 命中 ${extRows.filter((r) => r.kws).length}/${enExternal.length}，校验接受 ${extRows.filter((r) => r.accepted).length}/${extRows.filter((r) => r.kws).length}，校验误拒 ${extMiss.length} ${extMiss.length ? JSON.stringify(extMiss) : ''}`);
console.log(`校验转写耗时 median=${median(extRows.filter((r) => r.ms).map((r) => r.ms))}ms`);
for (const r of extRows.filter((x) => x.accepted === false)) console.log(`  rejected: ${r.name} text="${r.text}"`);

// ---- 3. near-miss 40 -------------------------------------------------------
const nearDir = path.join(ROOT, 'models', 'wake-negatives');
const nearManifest = JSON.parse(fs.readFileSync(path.join(nearDir, 'manifest.json'), 'utf8'));
let nearKwsHits = 0;
let nearVerifiedWakes = 0;
const nearRows = [];
const preset = SENSITIVITY_PRESETS[cfgNow.asr.sensitivity] ?? SENSITIVITY_PRESETS.high;
for (const m of nearManifest) {
  const clip = readWav(path.join(nearDir, m.file));
  const hit = await findKwsHit(clip);
  if (!hit) { nearRows.push({ id: m.id, kws: false }); continue; }
  nearKwsHits += 1;
  const off = await runClip(clip, { verifyEnabled: false, leadMs: hit.leadMs });
  const on = await runClip(clip, { verifyEnabled: true, leadMs: hit.leadMs });
  if (on.woke) nearVerifiedWakes += 1;
  const last = on.stats.lastVerify;
  nearRows.push({ id: m.id, kwsHit: true, kwsWake: off.woke, verifiedWake: on.woke, verify: last });
  console.log(`  ${m.id} "${m.text}": KWS=${off.woke ? 'wake' : 'no-wake'} 校验后=${on.woke ? 'wake' : 'no-wake'}${last ? `  text="${last.text}" reason=${last.reason}` : ''}`);
}
const nearKwsWakes = nearRows.filter((r) => r.kwsWake).length;
console.log(`\n--- 近音对抗 40 句 ---`);
console.log(`KWS 原始误唤醒=${nearKwsWakes}/40；校验后误唤醒=${nearVerifiedWakes}/40`);

// ---- 4. human 10 min ------------------------------------------------------
let human = { wakes: 0, note: 'missing' };
if (fs.existsSync('/tmp/realhuman-10min.raw')) {
  const b = fs.readFileSync('/tmp/realhuman-10min.raw');
  const raw = new Float32Array(Math.floor(b.length / 2));
  for (let i = 0; i < raw.length; i++) raw[i] = b.readInt16LE(i * 2) / 32768;
  const config = baseAsrConfig(true);
  const events = [];
  let fedSamples = 0;
  const asr = createAsr({
    config,
    hotkey: false,
    micGain: false,
    source: ({ onPcm }) => {
      let cancelled = false;
      let timer = null;
      let off = 0;
      return {
        async start() {
          const pump = () => {
            if (cancelled || off >= raw.length) return;
            const end = Math.min(off + CH, raw.length);
            onPcm(raw.subarray(off, end));
            off = end;
            fedSamples = off;
            timer = setTimeout(pump, 0);
          };
          pump();
        },
        async stop() { cancelled = true; clearTimeout(timer); },
      };
    },
    onWake: () => events.push('wake'),
    onError: () => {},
    onLog: () => {},
  });
  await asr.start();
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    await sleep(100);
    if (fedSamples >= raw.length && Date.now() - t0 > 1000) break;
    if (events.length && fedSamples >= raw.length) break;
  }
  await sleep(2500);
  human = { wakes: events.length, note: '' };
  await asr.stop();
  console.log(`\n--- 真人中文语音 10min（校验开启）--- 误唤醒=${human.wakes}`);
}

console.log('\n__VERIFY2_JSON__');
console.log(JSON.stringify({
  zh: { recall: `${zhRes.rows.filter((r) => r.on.woke).length}/8`, missed: zhRes.missed, latency: zhRes.latency },
  enCommitted: { recall: `${enRes.rows.filter((r) => r.on.woke).length}/3`, missed: enRes.missed, latency: enRes.latency },
  enExternal: {
    total: enExternal.length,
    kwsHit: extRows.filter((r) => r.kws).length,
    accepted: extRows.filter((r) => r.accepted).length,
    falseRejects: extMiss,
    transcribeMedianMs: median(extRows.filter((r) => r.ms).map((r) => r.ms)),
    samples: extRows.map((r) => ({ name: r.name, kws: r.kws, accepted: r.accepted, reason: r.reason, text: r.text })),
  },
  nearMiss: { kwsWakes: nearKwsWakes, verifiedWakes: nearVerifiedWakes, total: nearManifest.length },
  human,
}, null, 2));
