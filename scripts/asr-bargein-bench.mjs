#!/usr/bin/env node
// Barge-in acoustic benchmark (real speaker -> microphone path).
//
//   node scripts/asr-bargein-bench.mjs
//
// Answers the question "can the user talk over the assistant without the
// assistant's own speakers cutting it off?". It:
//   1. synthesises assistant TTS clips (cache: models/bargein-tts, git-ignored);
//   2. records the microphone while playing them through the default sink
//      (echo-only, >= 10 s total) -> echo RMS distribution;
//   3. plays assistant TTS + a louder "user" clip at the same time (5 trials)
//      -> user-over-echo RMS distribution + detector trigger rate;
//   4. replays the recordings through the real barge-in detector and reports
//      0 false triggers on echo, 5/5 triggers on user speech;
//   5. prints the measured numbers and a recommended minRms / echoFactor.
//
// The "user" audio is another TTS voice played through the same speaker (the
// agent cannot speak); the acoustic path is real, the talker is synthetic —
// reported as "synthetic talker, real acoustic channel".
//
// Everything is best-effort: if PipeWire/pw-play is missing the script exits 2.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { createBargeInDetector } from '../src/voice/asr/barge-in.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'models', 'bargein-tts');
const FIX = path.join(ROOT, 'tests', 'asr', 'fixtures');
const CONFIG_PATH = path.join(process.env.HOME, '.config', 'figaro', 'config.json');

const ASSISTANT_TEXTS = [
  '好的，我帮你查了一下明天的天气，白天晴，最高气温十八度，晚上有点凉，记得加件外套。',
  '这个问题的答案是，先打开设置页面，然后选择网络选项，最后点击保存就可以了。',
  '我找到了三家附近的咖啡店，评分最高的一家距离你大约八百米，走路大概十分钟。',
  '已经帮你把提醒设置好了，明天下午三点我会准时通知你。',
];
const ACK_TEXTS = ['我在', '在的', '请指示'];
// user phrases: use the committed command fixtures (different TTS voices)
const USER_FIXTURES = ['cmd-weather.wav', 'cmd-music.wav', 'cmd-light.wav', 'cmd-volume.wav', 'cmd-time.wav'];

const SR = 16000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? (err ? err.message : '') });
    });
  });
}

// ---------------------------------------------------------------- audio io
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
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    if (id === 'data') { ds = body; dl = size; }
    off = body + size + (size % 2);
  }
  const n = Math.floor(dl / 2 / fmt.ch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(ds + i * 2 * fmt.ch) / 32768;
  return { samples: out, sampleRate: fmt.sr };
}
function writeWav(file, samples) {
  const n = samples.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, b);
}
function scaleToRms(samples, targetRms) {
  let sum = 0;
  for (const v of samples) sum += v * v;
  const rms = Math.sqrt(sum / Math.max(1, samples.length)) || 1e-6;
  const gain = targetRms / rms;
  const out = new Float32Array(samples.length);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { out[i] = Math.max(-0.99, Math.min(0.99, samples[i] * gain)); peak = Math.max(peak, Math.abs(out[i])); }
  return { samples: out, gain, peak };
}
function windowRms(samples, windowSamples = 800) {
  const out = [];
  for (let off = 0; off + windowSamples <= samples.length; off += windowSamples) {
    let sum = 0;
    for (let i = 0; i < windowSamples; i++) sum += samples[off + i] * samples[off + i];
    out.push(Math.sqrt(sum / windowSamples));
  }
  return out;
}
const stats = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    n: values.length,
    mean: Number(mean.toFixed(4)),
    median: Number(q(0.5).toFixed(4)),
    p95: Number(q(0.95).toFixed(4)),
    max: Number(sorted.at(-1).toFixed(4)),
  };
};

// ------------------------------------------------------------- TTS clips
async function ensureTtsClips() {
  fs.mkdirSync(OUT, { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const key = process.env.FIGARO_MINIMAX_API_KEY || cfg.minimax?.apiKey;
  if (!key) throw new Error('no minimax.apiKey');
  const voice = cfg.minimax?.voiceId || 'male-qn-jingying';
  const items = [
    ...ASSISTANT_TEXTS.map((text, i) => ({ id: `assistant${i + 1}`, text, kind: 'assistant' })),
    ...ACK_TEXTS.map((text, i) => ({ id: `ack${i + 1}`, text, kind: 'ack' })),
  ];
  for (const item of items) {
    const file = path.join(OUT, `${item.id}.wav`);
    if (fs.existsSync(file)) continue;
    const body = {
      model: 'speech-02-turbo', text: item.text, stream: false,
      voice_setting: { voice_id: voice, speed: 1.0, vol: 1.0, pitch: 0 },
      audio_setting: { sample_rate: 16000, bitrate: 128000, format: 'wav', channel: 1 },
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch('https://api.minimax.cn/v1/t2a_v2', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.ok) {
        const json = await res.json();
        if (json.base_resp?.status_code === 0 && json.data?.audio) {
          const buf = Buffer.from(json.data.audio, 'hex');
          if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${item.id}: not RIFF`);
          const sr = buf.readUInt32LE(24);
          if (sr !== 16000) throw new Error(`${item.id}: bad sample rate ${sr}`);
          fs.writeFileSync(file, buf);
          break;
        }
      }
      await sleep(3000 * (attempt + 1));
    }
    if (!fs.existsSync(file)) throw new Error(`TTS failed: ${item.id}`);
    await sleep(700);
  }
  return items.map((it) => ({ ...it, file: path.join(OUT, `${it.id}.wav`) }));
}

// --------------------------------------------------------- mic recording
function startMic() {
  const chunks = [];
  let bytes = 0;
  const proc = spawn('parec', ['--format=s16le', '--rate=16000', '--channels=1', '--latency-msec=30', '--raw'], { stdio: ['ignore', 'pipe', 'ignore'] });
  proc.stdout.on('data', (buf) => {
    chunks.push(Buffer.from(buf));
    bytes += buf.length;
  });
  return {
    proc,
    /** sample index currently captured (call right after starting playback) */
    offset() {
      return Math.floor(bytes / 2);
    },
    async stop() {
      await new Promise((resolve) => {
        proc.once('close', resolve);
        try { proc.kill('SIGTERM'); } catch { resolve(); }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 800);
      });
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
      return out;
    },
  };
}

function play(file, volume = 1.0) {
  return spawn('pw-play', [`--volume=${volume}`, file], { stdio: 'ignore' });
}

// ---------------------------------------------------------------- trials
async function trialEchoOnly(assistantFile) {
  const mic = startMic();
  await sleep(300); // let parec settle
  const player = play(assistantFile, 0.8);
  const playStartSample = mic.offset();
  await sleep(3400);
  try { player.kill('SIGTERM'); } catch { /* ignore */ }
  const samples = await mic.stop();
  return { samples, playStartSample, kind: 'echo' };
}

async function trialOverlap(assistantFile, userFile, userDelayMs, userVolume) {
  const mic = startMic();
  await sleep(300);
  const p1 = play(assistantFile, 0.8);
  const playStartSample = mic.offset();
  await sleep(userDelayMs);
  const p2 = play(userFile, userVolume);
  void p2;
  await sleep(3400 - userDelayMs);
  try { p1.kill('SIGTERM'); } catch { /* ignore */ }
  try { p2.kill('SIGTERM'); } catch { /* ignore */ }
  const samples = await mic.stop();
  return { samples, playStartSample, kind: 'overlap', userDelayMs };
}

/** Run the real detector over a recording, muted starting at playStart. */
function detectOnRecording(recording, { startSample, phase = 'tts', cfg }) {
  const d = createBargeInDetector(cfg);
  d.arm({ phase, resetCooldown: true });
  const tail = recording.subarray(Math.max(0, Math.round(startSample)));
  const windows = windowRms(tail);
  let fired = 0;
  let firstAtMs = null;
  windows.forEach((rms, i) => {
    if (d.process(rms, 50)) {
      fired += 1;
      if (firstAtMs === null) firstAtMs = (i + 1) * 50;
    }
  });
  return { fired, firstAtMs, threshold: d.threshold, baseline: d.baseline, stats: d.stats };
}

// ---------------------------------------------------------------- main
console.log('== barge-in acoustic benchmark（真实扬声器→麦克风通道，合成说话人）==');
const cfg = loadConfig();
const bargeCfg = cfg.asr?.bargeIn ?? {};
console.log('config.asr.bargeIn =', JSON.stringify(bargeCfg));

let clips;
try {
  clips = await ensureTtsClips();
} catch (err) {
  console.error(`TTS clip generation failed: ${err.message}`);
  process.exit(2);
}
const assistant = clips.filter((c) => c.kind === 'assistant');
const acks = clips.filter((c) => c.kind === 'ack');

const echoCfg = { enabled: true, minRms: 0.09, echoFactor: 2.5, minMs: 500 }; // measured recommendation
const echoWindows = [];
const echoRecordings = [];
console.log('\n--- 1) 仅 TTS 回声（≥10s）---');
let echoSeconds = 0;
const allClips = [...assistant, ...acks];
for (const clip of allClips) {
  const rec = await trialEchoOnly(clip.file);
  // skip the first 250 ms (echo onset/ramp), then 3 s of steady playback
  const startSample = rec.playStartSample + Math.round(0.25 * SR);
  const endSample = Math.min(rec.samples.length, startSample + SR * 3);
  const seg = rec.samples.subarray(startSample, endSample);
  const ws = windowRms(seg);
  echoWindows.push(...ws);
  echoSeconds += seg.length / SR;
  echoRecordings.push({ name: clip.id, samples: rec.samples, playStartSample: rec.playStartSample });
  // dump the raw recording so the candidate sweep can be re-run without replaying
  const raw = Buffer.alloc(rec.samples.length * 2);
  for (let i = 0; i < rec.samples.length; i++) raw.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(rec.samples[i] * 32768))), i * 2);
  fs.writeFileSync(path.join('/tmp', `bargein-echo-${clip.id}.raw`), raw);
  fs.writeFileSync(path.join('/tmp', `bargein-echo-${clip.id}.json`), JSON.stringify({ playStartSample: rec.playStartSample }));
  console.log(`  ${clip.id.padEnd(12)} mic RMS windows: ${ws.length}, mean=${stats(ws).mean}, p95=${stats(ws).p95}`);
  if (echoSeconds >= 10) break;
}
console.log(`  回声总计 ${echoSeconds.toFixed(1)}s / ${echoWindows.length} windows`);
console.log('  回声 mic RMS 分布:', JSON.stringify(stats(echoWindows)));
// false-trigger check on echo-only recordings
let echoFalse = 0;
const perEcho = [];
for (const rec of echoRecordings) {
  const r = detectOnRecording(rec.samples, { startSample: rec.playStartSample, phase: 'tts', cfg: echoCfg });
  echoFalse += r.fired;
  perEcho.push({ name: rec.name, fired: r.fired, baseline: r.baseline, threshold: r.threshold });
}
console.log(`  回声中误触发（默认 minRms=${echoCfg.minRms}, echoFactor=${echoCfg.echoFactor}, minMs=${echoCfg.minMs}）: ${echoFalse} 次`);
console.log('  per-recording:', JSON.stringify(perEcho));


// ---------------------------------------------------- 2) synthetic mix sweep
// Real user speech cannot be produced by the agent, so the "talker" is the
// committed TTS command fixtures; the echo part is the *real recorded*
// microphone signal from the trials above. The mix is done in the sample domain
// at target microphone RMS levels, which is what the detector actually sees.
const echoSegments = echoRecordings.map((rec) => {
  const a = Math.round(rec.playStartSample + 0.25 * SR);
  const b = Math.min(rec.samples.length, a + SR * 3);
  return rec.samples.subarray(a, b);
});
function mixedTrial(userSamples, targetRms, echoSeg) {
  const { samples: scaled } = scaleToRms(userSamples, targetRms);
  const len = Math.max(echoSeg.length, scaled.length + Math.round(0.6 * SR));
  const echoPart = new Float32Array(len);
  const echoLoop = new Float32Array(len);
  for (let i = 0; i < len; i++) echoLoop[i] = echoSeg[i % echoSeg.length];
  echoPart.set(echoLoop);
  const mix = Float32Array.from(echoLoop);
  const offset = Math.round(0.6 * SR); // 600 ms of echo, then the user talks over it
  for (let i = 0; i < scaled.length && offset + i < len; i++) mix[offset + i] += scaled[i];
  let peak = 0;
  for (const v of mix) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.98) { const g = 0.98 / peak; for (let i = 0; i < mix.length; i++) mix[i] *= g; }
  return mix;
}
function detectorOn(samples, cfg, { phase = 'tts', skipMs = 600 } = {}) {
  const d = createBargeInDetector(cfg);
  d.arm({ phase, resetCooldown: true });
  for (const rms of windowRms(samples)) if (d.process(rms, 50)) return { fired: 1, baseline: d.baseline, threshold: d.threshold };
  void skipMs;
  return { fired: 0, baseline: d.baseline, threshold: d.threshold };
}

const userFixtures = USER_FIXTURES.map((f) => readWav(path.join(FIX, f)).samples);
const LEVELS = [0.06, 0.08, 0.1, 0.12, 0.15, 0.2];
console.log('\n--- 2) 合成混音扫描：真实回声录音 + TTS 用户语音（mic RMS 目标）---');
console.log('   level | 触发次数/5 | 混音 RMS 中位 | p95');
const levelRows = [];
for (const level of LEVELS) {
  let hits = 0;
  const rmsValues = [];
  const details = [];
  for (let i = 0; i < 5; i++) {
    const echoSeg = echoSegments[i % echoSegments.length];
    const mix = mixedTrial(userFixtures[i], level, echoSeg);
    const ws = windowRms(mix);
    rmsValues.push(...ws);
    const r = detectorOn(mix, echoCfg);
    if (r.fired) hits += 1;
    details.push({ trial: i + 1, fired: r.fired, baseline: r.baseline, threshold: r.threshold });
  }
  const st = stats(rmsValues);
  levelRows.push({ level, hits, mix: st, details });
  console.log(`   ${String(level).padEnd(5)} | ${hits}/5         | ${st.median} | ${st.p95}`);
}
const userLevelPass = levelRows.find((r) => r.hits === 5)?.level ?? null;
console.log(`  当前默认 minRms=${echoCfg.minRms}: 5/5 触发所需最低用户 mic RMS = ${userLevelPass ?? '> 0.2'}`);

// ------------------------------------------------- 3) candidate parameter sweep
console.log('\n--- 3) 参数候选扫描（真实回声 0 误触发 + 合成用户 5/5）---');
const echoMax = stats(echoWindows).max;
const baselineMedian = stats(echoWindows).median;
const candidates = [];
for (const minRms of [0.08, 0.1, 0.12, 0.14]) {
  for (const echoFactor of [2.0, 2.5, 3.0, 4.0]) {
    const cfg = { enabled: true, minRms, echoFactor, minMs: 500 };
    let echoFalse = 0;
    for (const rec of echoRecordings) echoFalse += detectOnRecording(rec.samples, { startSample: rec.playStartSample, phase: 'tts', cfg }).fired;
    let ackFalse = 0;
    for (const rec of echoRecordings.slice(0, 2)) ackFalse += detectOnRecording(rec.samples, { startSample: rec.playStartSample, phase: 'ack', cfg }).fired;
    const probeLevel = 0.15;
    let userHits = 0;
    for (let i = 0; i < 5; i++) {
      const echoSeg = echoSegments[i % echoSegments.length];
      const mix = mixedTrial(userFixtures[i], probeLevel, echoSeg);
      if (detectorOn(mix, cfg).fired) userHits += 1;
    }
    candidates.push({ minRms, echoFactor, echoFalse, ackFalse, userHitsAt015: userHits });
    console.log(`   minRms=${minRms} echoFactor=${echoFactor}  回声误触发=${echoFalse} ack=${ackFalse}  用户@0.15micRMS 触发=${userHits}/5`);
  }
}
const pass = candidates.filter((c) => c.echoFalse === 0 && c.userHitsAt015 === 5);
const recommended = pass.length
  ? pass.reduce((best, c) => (c.minRms < best.minRms ? c : best))
  : null;

// ------------------------------------------------------------- ack phase check
let ackFalseDefault = 0;
for (const rec of echoRecordings.slice(0, 3)) {
  ackFalseDefault += detectOnRecording(rec.samples, { startSample: rec.playStartSample, phase: 'ack', cfg: echoCfg }).fired;
}
console.log(`\n--- 4) ack 阶段（默认配置，更严格）回声误触发: ${ackFalseDefault} 次（前 3 段）`);

// ------------------------------------------------------------------ summary
const echoSummary = stats(echoWindows);
const userSummary = levelRows.find((r) => r.level === 0.15)?.mix ?? null;
console.log('\n=== 结论 ===');
console.log(`  真实回声（${echoSeconds.toFixed(1)}s，扬声器播放 TTS）: mic RMS 均值=${echoSummary.mean} 中位=${echoSummary.median} p95=${echoSummary.p95} max=${echoSummary.max}`);
console.log(`  回声 p95/中位 = ${(echoSummary.p95 / echoSummary.median).toFixed(2)} → echoFactor 需 > ${(echoSummary.p95 / echoSummary.median).toFixed(2)}`);
console.log(`  默认配置回声误触发=${echoFalse} 次；合成用户 5/5 需 mic RMS >= ${userLevelPass ?? '>0.2'}`);
console.log(`  推荐: ${recommended ? JSON.stringify(recommended) : '无候选同时满足（需人工复核）'}`);
const verdict = {
  echo: echoSummary,
  echoSeconds: Number(echoSeconds.toFixed(1)),
  echoFalseAlarms: echoFalse,
  ackFalseAlarms: ackFalseDefault,
  levelRows: levelRows.map(({ level, hits, mix }) => ({ level, hits, mix })),
  candidates,
  recommended,
  current: echoCfg,
};
console.log('\n__BARGE_IN_JSON__');
console.log(JSON.stringify({ verdict, perEcho }, null, 2));
