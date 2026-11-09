#!/usr/bin/env node
// Acceptance benchmark for the Figaro hearing module (no microphone by default).
//
//   node scripts/asr-bench.mjs
//   node scripts/asr-bench.mjs --live=60                  # also listen 60 s to the real mic
//   node scripts/asr-bench.mjs --false-audio=/tmp/a.raw --false-audio=/tmp/b.wav
//
// Reports: wake hit rate, false-alarm count/duration, wake latency (real-time
// paced), transcription accuracy, model size, memory, start-up time.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { createAsr } from '../src/voice/asr/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(ROOT, 'tests', 'asr', 'fixtures');
const args = process.argv.slice(2);
const liveArg = args.find((a) => a.startsWith('--live='));
const liveSeconds = liveArg ? Number(liveArg.split('=')[1]) : 0;
const falseAudio = args.filter((a) => a.startsWith('--false-audio=')).map((a) => a.slice('--false-audio='.length));

// ---------- helpers ----------
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`not a wav: ${file}`);
  let off = 12;
  let fmt = null;
  let dataStart = 0;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') { dataStart = body; dataLen = size; }
    off = body + size + (size % 2);
  }
  if (!fmt || fmt.sampleRate !== 16000 || fmt.bits !== 16) throw new Error(`need 16 kHz mono s16 wav: ${file}`);
  const n = Math.floor(dataLen / 2 / fmt.channels);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(dataStart + i * 2 * fmt.channels) / 32768;
  return samples;
}
function readRaw(file) {
  const buf = fs.readFileSync(file);
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}
function loadAudio(file) {
  return /\.wav$/i.test(file) ? readWav(file) : readRaw(file);
}
const silence = (ms) => new Float32Array(Math.round((16000 * ms) / 1000));
function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
const fixture = (name) => readWav(path.join(FIXTURES, manifest.find((m) => m.name === name).file));

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}

/** Realtime-paced audio source (100 ms chunks) so latency numbers are meaningful. */
function realtimeSource(pcm) {
  return ({ onPcm }) => {
    let cancelled = false;
    let timer = null;
    let offset = 0;
    const chunk = 1600;
    return {
      async start() {
        const pump = () => {
          if (cancelled || offset >= pcm.length) return;
          const end = Math.min(offset + chunk, pcm.length);
          onPcm(pcm.subarray(offset, end));
          offset = end;
          if (offset < pcm.length) timer = setTimeout(pump, 100);
        };
        pump();
      },
      async stop() { cancelled = true; if (timer) clearTimeout(timer); },
    };
  };
}

async function withModule(pcm, { sourceFactory, waitFor = 'final', timeoutMs = 20000, beginCapture = false, realParec = false } = {}) {
  const config = loadConfig();
  config.asr.hotkey = '';
  config.asr.wakeCaptureFallbackMs = 0; // measure the ASR pipeline itself (no daemon ack)
  const events = [];
  let srcStart = 0;
  let asrRef = null;
  const rawFactory = (sourceFactory ?? realtimeSource)(pcm);
  const factory = (factoryOpts) => {
    const src = rawFactory(factoryOpts);
    return {
      async start() { srcStart = Date.now(); return src.start(); },
      stop: () => src.stop(),
    };
  };
  const asr = createAsr({
    config,
    hotkey: false,
    source: realParec ? undefined : factory,
    onWake: () => {
      const wall = Date.now();
      events.push({ type: 'wake', at: srcStart ? wall - srcStart : 0, wall });
      // measure how quickly capturing becomes true (module auto-starts capture a
      // microtask after onWake when the daemon does not do it synchronously)
      const poll = () => {
        if (asrRef && asrRef.capturing) {
          events.push({ type: 'capture-start', delayMs: Date.now() - wall, at: srcStart ? Date.now() - srcStart : 0 });
        } else if (Date.now() - wall < 3000) {
          setTimeout(poll, 2);
        }
      };
      poll();
    },
    onPartial: (text) => events.push({ type: 'partial', text, at: srcStart ? Date.now() - srcStart : 0 }),
    onFinal: (text) => events.push({ type: 'final', text, at: srcStart ? Date.now() - srcStart : 0, wall: Date.now() }),
    onVadStart: () => events.push({ type: 'vadStart', at: srcStart ? Date.now() - srcStart : 0 }),
    onError: (err) => events.push({ type: 'error', message: err.message, at: srcStart ? Date.now() - srcStart : 0 }),
    onLog: () => {},
  });
  asrRef = asr;
  const t0 = Date.now();
  await asr.start();
  const startMs = Date.now() - t0;
  if (beginCapture) asr.beginCapture();
  const wantWake = waitFor === 'wake';
  const deadline = Date.now() + timeoutMs;
  const has = (type) => events.some((e) => e.type === type);
  while (Date.now() < deadline) {
    if (wantWake && (has('wake') || has('final'))) break;
    if (!wantWake && has('final')) break;
    if (has('error')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const state = asr.state;
  const modelInfo = asr.modelInfo;
  await asr.stop();
  return { events, startMs, modelInfo, state, rssMb: process.memoryUsage().rss / 1e6 };
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) total += dirSize(p);
      else total += st.size;
    }
  } catch { /* ignore */ }
  return total;
}
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

// ---------- run ----------
const summary = { when: new Date().toISOString(), models: {}, startup: {}, wake: {}, falseAlarms: {}, transcription: {} };
const config0 = loadConfig();
const root = config0.paths.root;
for (const [k, rel] of Object.entries({ kws: config0.asr.kwsModelDir, stream: config0.asr.streamingModelDir, offline: config0.asr.offlineModelDir })) {
  const dir = path.isAbsolute(rel) ? rel : path.resolve(root, rel);
  summary.models[k] = dirSize(dir);
}
const vadPath = path.join(path.dirname(path.resolve(root, config0.asr.kwsModelDir)), 'vad', 'silero_vad.onnx');
summary.models.vad = fs.existsSync(vadPath) ? fs.statSync(vadPath).size : 0;
console.log('== 模型体积 ==');
for (const [k, v] of Object.entries(summary.models)) console.log(`  ${k.padEnd(8)} ${mb(v)}`);
console.log(`  total    ${mb(Object.values(summary.models).reduce((a, b) => a + b, 0))}`);

// 0) startup + memory (measured first: fresh process, single ASR instance)
{
  const rssBefore = process.memoryUsage().rss / 1e6;
  const rIdle = await withModule(silence(2500), { waitFor: 'none', timeoutMs: 1200 });
  const idleRss = process.memoryUsage().rss / 1e6;
  const r = await withModule(concat([silence(400), fixture('cmd-time'), silence(2000)]), { beginCapture: true, timeoutMs: 15000 });
  summary.startup = {
    startMs: rIdle.startMs,
    rssBeforeMb: Number(rssBefore.toFixed(0)),
    idleRssMb: Number(idleRss.toFixed(0)),
    afterCaptureRssMb: Number((process.memoryUsage().rss / 1e6).toFixed(0)),
    modelInfo: rIdle.modelInfo,
  };
  console.log('\n== 启动与内存 ==');
  console.log(`  模型加载+启动 ${rIdle.startMs} ms`);
  console.log(`  RSS: 启动前 ${summary.startup.rssBeforeMb} MB -> 常驻监听(未唤醒过) ${summary.startup.idleRssMb} MB -> 首次唤醒加载离线模型后 ${summary.startup.afterCaptureRssMb} MB`);
  console.log(`  KWS=${rIdle.modelInfo.kws?.epoch} threads=${JSON.stringify(rIdle.modelInfo.threads)} streaming=${rIdle.modelInfo.streaming} offline=${rIdle.modelInfo.offline} vad=${rIdle.modelInfo.vad} keywords=${rIdle.modelInfo.keywords.length}`);
}

// 1) wake word: realtime paced, measure detection time from playback start
console.log('\n== 唤醒词命中率 / 延迟（realtime 播放，注入音频）==');
const wakeRows = [];
for (const entry of manifest.filter((m) => m.tag === 'wake')) {
  const samples = readWav(path.join(FIXTURES, entry.file));
  const pcm = concat([silence(300), samples, silence(2600)]);
  const r = await withModule(pcm, { waitFor: 'wake', timeoutMs: 15000 });
  const wake = r.events.find((e) => e.type === 'wake');
  const finalEv = r.events.find((e) => e.type === 'final');
  const captureStart = r.events.find((e) => e.type === 'capture-start');
  const firstPartial = r.events.find((e) => e.type === 'partial');
  wakeRows.push({
    name: entry.name,
    durationMs: entry.durationMs,
    hit: Boolean(wake),
    wakeMs: wake ? wake.at : null,
    captureDelayMs: captureStart?.delayMs ?? null,
    firstPartialMs: firstPartial ? firstPartial.at : null,
    finalText: finalEv?.text ?? null,
    errors: r.events.filter((e) => e.type === 'error').map((e) => e.message),
  });
  console.log(
    `  ${entry.name.padEnd(26)} ${wake ? `onWake @ ${String(wake.at).padStart(4)}ms (clip ${entry.durationMs}ms)` : 'MISS'}` +
    `${captureStart ? `, capturing +${captureStart.delayMs}ms` : ''}${firstPartial ? `, firstPartial @ ${firstPartial.at}ms` : ''}`,
  );
}
const hits = wakeRows.filter((r) => r.hit).length;
const wakeTimes = wakeRows.filter((r) => r.hit).map((r) => r.wakeMs).sort((a, b) => a - b);
const captureDelays = wakeRows.filter((r) => r.captureDelayMs !== null).map((r) => r.captureDelayMs).sort((a, b) => a - b);
summary.wake = {
  hits,
  total: wakeRows.length,
  hitRate: `${hits}/${wakeRows.length}`,
  wakeMsFromPlaybackStart: wakeTimes.length
    ? { min: wakeTimes[0], median: wakeTimes[Math.floor(wakeTimes.length / 2)], max: wakeTimes.at(-1) }
    : null,
  captureDelayMs: captureDelays.length
    ? { min: captureDelays[0], median: captureDelays[Math.floor(captureDelays.length / 2)], max: captureDelays.at(-1) }
    : null,
  rows: wakeRows,
};
// wake latency relative to the end of the spoken wake word: the clip contains the
// word plus ~100 ms of lead-in/out; the KWS matches the 2-syllable prefix early,
// so the measured offset is a conservative upper bound of the perceived latency.
console.log(`  命中 ${hits}/${wakeRows.length}，onWake 出现在播放开始后 ${JSON.stringify(summary.wake.wakeMsFromPlaybackStart)}，onWake->capturing ${JSON.stringify(summary.wake.captureDelayMs)}`);

// 2) transcription accuracy (push to talk)
console.log('\n== 转写正确率（push-to-talk，注入音频）==');
const cmdRows = [];
for (const entry of manifest.filter((m) => m.tag === 'cmd')) {
  const samples = readWav(path.join(FIXTURES, entry.file));
  const pcm = concat([silence(400), samples, silence(2600)]);
  const r = await withModule(pcm, { beginCapture: true, timeoutMs: 15000, sourceFactory: undefined });
  const finalEv = r.events.find((e) => e.type === 'final');
  const got = finalEv?.text ?? '';
  const expected = entry.expect ?? entry.text;
  const cer = levenshtein(got, expected) / Math.max(1, expected.length);
  cmdRows.push({ name: entry.name, expected, got, cer: Number(cer.toFixed(3)), ok: cer <= 0.1 });
  console.log(`  ${entry.name.padEnd(20)} got="${got}"  want="${expected}"  CER=${(cer * 100).toFixed(1)}%`);
}
summary.transcription = {
  rows: cmdRows,
  meanCer: Number((cmdRows.reduce((n, r) => n + r.cer, 0) / Math.max(1, cmdRows.length)).toFixed(4)),
  exact: `${cmdRows.filter((r) => r.cer === 0).length}/${cmdRows.length}`,
};
console.log(`  平均 CER ${(summary.transcription.meanCer * 100).toFixed(2)}%，完全正确 ${summary.transcription.exact}`);

// 3) false alarms on fixtures + optional external audio
console.log('\n== 误唤醒（普通语句 / 音乐 / 真人语音）==');
let faAudioMs = 0;
let faWakes = 0;
{
  for (const entry of manifest.filter((m) => m.tag === 'neg')) {
    const samples = readWav(path.join(FIXTURES, entry.file));
    const pcm = concat([silence(200), samples, silence(600)]);
    const r = await withModule(pcm, { waitFor: 'wake', timeoutMs: 6000 });
    const woke = r.events.some((e) => e.type === 'wake');
    faAudioMs += (pcm.length / 16000) * 1000;
    if (woke) faWakes += 1;
    console.log(`  fixture ${entry.name.padEnd(20)} ${woke ? 'FALSE WAKE' : 'ok'}`);
  }
}
const extResults = [];
for (const file of falseAudio) {
  if (!fs.existsSync(file)) { console.log(`  (skip missing ${file})`); continue; }
  const pcm = loadAudio(file);
  const fast = (audio) => ({ onPcm }) => {
    let cancelled = false;
    let timer = null;
    let offset = 0;
    const chunk = 1600;
    return {
      async start() {
        const pump = () => {
          if (cancelled || offset >= audio.length) return;
          const end = Math.min(offset + chunk, audio.length);
          onPcm(audio.subarray(offset, end));
          offset = end;
          if (offset < audio.length) timer = setImmediate(pump);
        };
        pump();
      },
      async stop() { cancelled = true; if (timer) clearImmediate(timer); },
    };
  };
  const r = await withModule(pcm, { waitFor: 'wake', timeoutMs: 60000, sourceFactory: fast });
  const wakes = r.events.filter((e) => e.type === 'wake').length;
  const seconds = pcm.length / 16000;
  faAudioMs += seconds * 1000;
  faWakes += wakes;
  extResults.push({ file, seconds: Number(seconds.toFixed(1)), wakes });
  console.log(`  ${path.basename(file).padEnd(24)} ${seconds.toFixed(1)}s  wakes=${wakes}`);
}
summary.falseAlarms = {
  audioSeconds: Number((faAudioMs / 1000).toFixed(1)),
  wakes: faWakes,
  perMinute: Number(((faWakes / Math.max(1, faAudioMs / 1000)) * 60).toFixed(3)),
  external: extResults,
};
console.log(`  合计 ${summary.falseAlarms.audioSeconds}s 音频，误唤醒 ${faWakes} 次（${summary.falseAlarms.perMinute}/分钟）`);

// 5) optional live microphone listen
if (liveSeconds > 0) {
  console.log(`\n== 真实麦克风 ${liveSeconds}s ==`);
  const config = loadConfig();
  config.asr.hotkey = '';
  const levels = [];
  const wakes = [];
  const errors = [];
  let beginCapture = null;
  const asr = createAsr({
    config,
    hotkey: false,
    onWake: () => { beginCapture = Date.now(); wakes.push(Date.now()); },
    onLevel: (v) => levels.push(v),
    onFinal: () => {},
    onError: (err) => errors.push(err.message),
    onLog: () => {},
  });
  await asr.start();
  console.log(`  监听中…（state=${asr.state}）`);
  await new Promise((r) => setTimeout(r, liveSeconds * 1000));
  const parecCount = () => {
    try {
      const out = execSync('pgrep -c -f "parec --format=s16le" || true').toString().trim();
      return Number(out || 0);
    } catch { return -1; }
  };
  const beforeStop = parecCount();
  await asr.stop();
  await new Promise((r) => setTimeout(r, 300));
  const afterStop = parecCount();
  const sorted = [...levels].sort((a, b) => a - b);
  summary.live = {
    seconds: liveSeconds,
    levelEvents: levels.length,
    levelMin: Number((sorted[0] ?? 0).toFixed(4)),
    levelMedian: Number((sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(4)),
    levelMax: Number((sorted.at(-1) ?? 0).toFixed(4)),
    wakes: wakes.length,
    errors,
    parecBeforeStop: beforeStop,
    parecAfterStop: afterStop,
  };
  console.log(`  电平事件 ${levels.length}，min/median/max=${summary.live.levelMin}/${summary.live.levelMedian}/${summary.live.levelMax}`);
  console.log(`  误唤醒 ${wakes.length} 次，错误 ${errors.length} 条`);
  console.log(`  parec 子进程 beforeStop=${beforeStop} afterStop=${afterStop}`);
}

// JSON summary goes last on stdout for copy/paste into the report.
console.log('\n__SUMMARY_JSON__');
console.log(JSON.stringify(summary, null, 2));
