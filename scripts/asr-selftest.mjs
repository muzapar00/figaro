#!/usr/bin/env node
// No-microphone self test for the Figaro ASR module.
//
//   node scripts/asr-selftest.mjs
//
// Feeds the committed TTS fixtures through createAsr() (injected audio source)
// and checks: wake word -> onWake, command -> onFinal text, ordinary speech ->
// no wake. Exits non-zero on failure. No microphone, no D-Bus portal dialog.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { createAsr } from '../src/voice/asr/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(ROOT, 'tests', 'asr', 'fixtures');

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
  if (!fmt || fmt.sampleRate !== 16000 || fmt.bits !== 16) throw new Error(`unsupported wav: ${file}`);
  const n = Math.floor(dataLen / 2 / fmt.channels);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(dataStart + i * 2 * fmt.channels) / 32768;
  return samples;
}

function fixturePcm(...parts) {
  const bufs = parts.map((p) => (typeof p === 'string' ? readWav(path.join(FIXTURES, p)) : p));
  const total = bufs.reduce((n, b) => n + b.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const b of bufs) { out.set(b, off); off += b.length; }
  return out;
}
const silence = (ms) => new Float32Array(Math.round((16000 * ms) / 1000));

async function run(pcm, { beginCaptureAtOnce = false, timeoutMs = 15000 } = {}) {
  const config = loadConfig();
  config.asr.hotkey = ''; // never touch the portal in self test
  const events = [];
  let fedSamples = 0;
  const asr = createAsr({
    config,
    hotkey: false,
    source: ({ onPcm }) => {
      let cancelled = false;
      let timer = null;
      let offset = 0;
      const chunk = 1600;
      return {
        async start() {
          const pump = () => {
            if (cancelled || offset >= pcm.length) return;
            const end = Math.min(offset + chunk, pcm.length);
            fedSamples = end;
            onPcm(pcm.subarray(offset, end));
            offset = end;
            if (offset < pcm.length) timer = setImmediate(pump);
          };
          pump();
        },
        async stop() { cancelled = true; if (timer) clearImmediate(timer); },
      };
    },
    onWake: () => events.push({ type: "wake", at: fedSamples / 16000, wall: Date.now() }),
    onPartial: () => {},
    onFinal: (text) => events.push({ type: 'final', text, wall: Date.now() }),
    onError: (err) => events.push({ type: 'error', message: err.message }),
    onLog: () => {},
  });
  const t0 = Date.now();
  await asr.start();
  const startMs = Date.now() - t0;
  if (beginCaptureAtOnce) asr.beginCapture();
  const deadline = Date.now() + timeoutMs;
  const wantFinal = beginCaptureAtOnce || true;
  while (Date.now() < deadline) {
    if (wantFinal && events.some((e) => e.type === 'final')) break;
    if (!wantFinal && events.some((e) => e.type === 'wake')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await asr.stop();
  return { events, startMs, asr };
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

console.log('== Figaro ASR self test（无麦克风，注入音频）==');
const config = loadConfig();
console.log(`models: kws=${config.asr.kwsModelDir} stream=${config.asr.streamingModelDir} offline=${config.asr.offlineModelDir}`);

// 1. wake word
{
  const pcm = fixturePcm(silence(300), 'wake-nijialuo-male.wav', silence(2500));
  const { events, startMs } = await run(pcm);
  const wake = events.find((e) => e.type === 'wake');
  const final = events.find((e) => e.type === 'final');
  check('唤醒词「费加罗」触发 onWake', Boolean(wake), wake ? `音频位置 ${wake.at.toFixed(2)}s，模型加载 ${startMs}ms` : '未触发');
  check('唤醒后自动结束采集并回调 onFinal', Boolean(final), final ? `text=${JSON.stringify(final.text)}` : '无 onFinal');
  check('唤醒后回到常驻监听（模块未报错）', !events.some((e) => e.type === 'error'), events.filter((e) => e.type === 'error').map((e) => e.message).join('; '));
}

// 2. command transcription (push-to-talk path)
{
  const pcm = fixturePcm(silence(400), 'cmd-time.wav', silence(2500));
  const { events } = await run(pcm, { beginCaptureAtOnce: true });
  const final = events.find((e) => e.type === 'final');
  check('按住说话 → 转写出「现在几点了」', final?.text === '现在几点了', final ? JSON.stringify(final.text) : '无 onFinal');
}

// 3. ordinary speech must not wake
{
  const pcm = fixturePcm(silence(300), 'neg-weather.wav', silence(1200));
  const { events } = await run(pcm, { timeoutMs: 1200 });
  check('普通语句不误唤醒', !events.some((e) => e.type === 'wake'), events.filter((e) => e.type === 'wake').length ? '发生了误唤醒' : '');
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
