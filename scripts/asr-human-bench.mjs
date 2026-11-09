#!/usr/bin/env node
// Real-human-speech CER comparison (ground truth from the sherpa-onnx docs).
//
//   node scripts/asr-human-bench.mjs [--dir=/path/to/test_wavs]
//
// The 16 wav files shipped with sherpa-onnx-paraformer-zh-int8-2025-10-07 are
// real human recordings (including Sichuan / Tianjin / Henan accented Mandarin)
// with ground truth published in the sherpa docs. They are a much better proxy
// for "how accurate is Figaro for a real person with an accent" than TTS audio.
//
// This script is only a measurement tool (audio is not in the repo); it prints:
//   model x overall CER, median decode latency, per-file detail.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOfflineAsr } from '../src/voice/asr/recognizers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const dirArg = args.find((a) => a.startsWith('--dir='));
const WAV_DIR = dirArg
  ? dirArg.slice('--dir='.length)
  : path.join('/tmp/figaro-models-dl/sherpa-onnx-paraformer-zh-int8-2025-10-07/test_wavs');

// Ground truth from
// https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/paraformer-models.html
const TRUTH = {
  '1.wav': '来，哥哥再给你唱首歌。好儿，哎呦，把伴奏给我放起来，放就放嘛，还要躲人家钩子。',
  '2.wav': '对不起，只有二娃才能让我真正体会作为女人的快乐。',
  '3.wav': '我想去逛街，欢迎进入直播间，晚上好，那我的名字是怎么说的呢？',
  '4.wav': '梦见的就是你，不行啊，有四川话根本唱不起来，根本唱不起来呀！',
  '5.wav': '就临走那天挑了个飘了一下嗨呀，弟弟灵魂儿就飞上九霄云，就飘着一下魂都飞了，对不对？',
  '6.wav': '是不是给人感觉后头是青花亮色的然后说话是很平和的眼神是不慌乱的不散的。',
  '7.wav': '他坐在椅子上，挺直起腰杆，脸上展现出灿烂的笑容。',
  '8.wav': '唤起路由无限的感慨，使他，更加痛恨官场的欺诈污浊。',
  '9.wav': '看面貌约五十左右却自称活了两百多岁，在清顺治时出家当过和尚，还有杜蝶为证。',
  '10.wav': '其言曰，士大夫以其见闻之广反各有所偏，自有负担杀者有负良骑者。',
  '11.wav': '据说有网友坐飞机的时候呢，广播全程播报。',
  '12.wav': '将溃疡两周以上都应该及时就医，据了解啊小云平时呢都喜欢吃比较烫的饭菜，也喜欢吃麻辣烫火锅之类的高温食物。',
  '13.wav': '绝佳好位置好像我被看到了，就问你敢不敢进来吧你，一套带走猪脚亮。',
  '14.wav': '两岸猿声啼不住，有家难回车里住。',
  '15.wav': '杨大人一律就退还会再要求，以关注货币，来补助这个差额，天宝年间杨胜坚转任。',
  '16.wav': '做钱的速度还快，这真的是，一个经济爆发式增长的时代。',
};

function readWavSamples(file) {
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

const PUNCT = /[\s，。！？、,.!?;；:：…~～"'“”‘’()（）【】《》<>—\-]/g;
const norm = (s) => String(s ?? '').replace(PUNCT, '').toLowerCase();
function levenshtein(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function dirSize(dir) {
  let total = 0;
  try { for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size; } catch { /* ignore */ }
  return total;
}

if (!fs.existsSync(WAV_DIR)) {
  console.error(`real-human wav dir missing: ${WAV_DIR}\n先下载/解压 sherpa-onnx-paraformer-zh-int8-2025-10-07.tar.bz2`);
  process.exit(2);
}
process.env.FIGARO_SENSEVOICE_ITN = process.env.FIGARO_SENSEVOICE_ITN ?? '0';

const candidates = [
  { name: 'paraformer-zh-int8-2023-09-14 (现役)', dir: path.join(ROOT, 'models', 'asr-offline') },
  { name: 'SenseVoice-small-int8', dir: path.join(ROOT, 'models', 'asr-offline-sensevoice') },
  { name: 'paraformer-zh-int8-2025-10-07 (川渝微调)', dir: path.join('/tmp/figaro-models-dl', 'sherpa-onnx-paraformer-zh-int8-2025-10-07') },
].filter((c) => fs.existsSync(c.dir));

const files = Object.keys(TRUTH).filter((f) => fs.existsSync(path.join(WAV_DIR, f)));
console.log(`real-human set: ${files.length} 句 (${WAV_DIR})`);
console.log('ground truth 来自 sherpa-onnx 官方文档；含川渝/天津/河南口音');
console.log(files.map((f) => `  ${f}: ${TRUTH[f]}`).join('\n'));

const results = [];
for (const cand of candidates) {
  const size = dirSize(cand.dir);
  const t0 = Date.now();
  const rec = createOfflineAsr({ dir: cand.dir, numThreads: 1 });
  if (!rec) { console.log(`\n${cand.name}: 不可用`); continue; }
  const loadMs = Date.now() - t0;
  console.log(`\n=== ${cand.name} kind=${rec.kind} ${(size / 1e6).toFixed(0)}MB load=${loadMs}ms ===`);
  const rows = [];
  for (const file of files) {
    const { samples } = readWavSamples(path.join(WAV_DIR, file));
    const t = Date.now();
    const hyp = await rec.transcribe(samples);
    const ms = Date.now() - t;
    const ref = TRUTH[file];
    const cer = levenshtein(norm(hyp), norm(ref)) / Math.max(1, norm(ref).length);
    rows.push({ file, ref, hyp, cer, ms });
  }
  const meanCer = rows.reduce((n, r) => n + r.cer, 0) / rows.length;
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`  CER=${(meanCer * 100).toFixed(2)}%  中位延迟=${lat[Math.floor(lat.length / 2)]}ms`);
  for (const r of rows) console.log(`  ${r.file.padEnd(6)} CER ${(r.cer * 100).toFixed(0).padStart(3)}%  hyp="${r.hyp}"`);
  results.push({ name: cand.name, kind: rec.kind, sizeMb: (size / 1e6).toFixed(0), loadMs, meanCer, medianMs: lat[Math.floor(lat.length / 2)], rows });
  if (rec.free) rec.free();
}

console.log('\n=== 真实人声对比表 ===');
console.log(['model'.padEnd(38), 'CER'.padEnd(8), '中位延迟'].join(' | '));
for (const r of results) console.log([r.name.padEnd(38), `${(r.meanCer * 100).toFixed(2)}%`.padEnd(8), `${r.medianMs}ms`].join(' | '));
console.log('\n__HUMAN_JSON__');
console.log(JSON.stringify(results.map(({ rows, ...rest }) => rest), null, 2));
