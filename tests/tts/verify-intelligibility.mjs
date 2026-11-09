// Manual tool: ASR round-trip on the preview WAVs in tests/tts/out/.
//
//   node tests/tts/verify-intelligibility.mjs
//
// Uses the local paraformer model from models/asr-offline (fetched by
// figaro-ears). TTS output -> ASR -> compare to the intended text: this proves
// intelligibility / no dropped words (it says nothing about voice aesthetics).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../', import.meta.url));
const sherpa = require('/home/mzpr00/Projects/figaro/node_modules/sherpa-onnx-node/sherpa-onnx.js');

const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    paraformer: { model: new URL('../../models/asr-offline/model.int8.onnx', import.meta.url).pathname },
    tokens: new URL('../../models/asr-offline/tokens.txt', import.meta.url).pathname,
    numThreads: 4, provider: 'cpu', debug: 0,
  },
});

function readWav(file) {
  const b = fs.readFileSync(file); let off = 12; let sampleRate = 32000, channels = 1;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4); const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { channels = b.readUInt16LE(off + 10); sampleRate = b.readUInt32LE(off + 12); }
    if (id === 'data') return { pcm: b.subarray(off + 8, off + 8 + size), sampleRate, channels };
    off += 8 + size + (size % 2);
  }
  throw new Error('no data');
}
function to16k({ pcm, sampleRate, channels }) {
  const n = Math.floor(pcm.length / 2 / channels); const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < channels; c++) s += pcm.readInt16LE((i * channels + c) * 2); mono[i] = s / channels / 32768; }
  if (sampleRate === 16000) return mono;
  const ratio = sampleRate / 16000; const out = new Float32Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) out[i] = mono[Math.round(i * ratio)];
  return out;
}
// intended text, with digits written the way a Chinese speaker reads them
const target = '费加罗现在上午十点今天气温十八度湿度百分之四十二下午三点有个视频会议需要在两点半之前把材料准备好另外你昨天的快递已经到驿站了记得去取';
const clean = (s) => (s || '').replace(/[，。！？、,.!?%：:；;\s]/g, '');
function edit(a, b) {
  const m = a.length, n = b.length;
  let prev = Array(n + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...Array(n).fill(0)];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const dir = new URL('./out/', import.meta.url).pathname;
for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('preview__') && x.endsWith('.wav')).sort()) {
  const wav = readWav(path.join(dir, f));
  const samples = to16k(wav);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: 16000 });
  recognizer.decode(stream);
  const text = clean(recognizer.getResult(stream).text);
  const cer = edit(text, target) / target.length;
  console.log(`\n${f}\n  ASR: "${clean(recognizer.getResult(stream).text)}"\n  CER=${(cer * 100).toFixed(1)}%  (target ${target.length} chars, got ${text.length})`);
}
