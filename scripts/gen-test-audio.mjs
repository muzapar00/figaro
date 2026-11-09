#!/usr/bin/env node
// Generate deterministic ASR/KWS test fixtures with MiniMax TTS.
//
// Output: tests/asr/fixtures/<name>.wav (16 kHz mono 16-bit PCM) + manifest.json
// The API key is read from ~/.config/figaro/config.json (or FIGARO_CONFIG_DIR) and is
// never printed, logged nor copied into the repository.
//
// Usage:
//   node scripts/gen-test-audio.mjs            # regenerate every fixture that is missing
//   node scripts/gen-test-audio.mjs --force    # regenerate everything
//   node scripts/gen-test-audio.mjs --only=wake
//
// The fixtures are committed so the test suite is offline + deterministic; this script
// only needs to run when the fixture set changes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'asr', 'fixtures');

const CONFIG_DIR = process.env.FIGARO_CONFIG_DIR || path.join(os.homedir(), '.config', 'figaro');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// Voice ids available on MiniMax t2a_v2 (tried in this order; failures fall back).
const VOICES = ['male-qn-jingying', 'female-shaonv', 'male-qn-qingse', 'female-tianmei', 'audiobook_male_1'];
// English voices used by the bilingual wake-word fixtures (voice field overrides VOICES).
const ENGLISH_VOICES = ['English_Trustworth_Man', 'English_Graceful_Lady', 'English_DecentYoungMan', 'English_ConfidentWoman'];

// name -> {text, voice, speed, tag}
// tag "wake": MUST trigger the wake word; "neg": MUST NOT; "cmd": capture/transcription.
const CLIPS = [
  // --- wake word positives (different voices / speeds, like different speakers) ---
  { name: 'wake-nijialuo-male', text: '费加罗', voice: 'male-qn-jingying', speed: 1.0, tag: 'wake' },
  { name: 'wake-nijialuo-female', text: '费加罗', voice: 'female-shaonv', speed: 1.0, tag: 'wake' },
  { name: 'wake-nijialuo-male-fast', text: '费加罗', voice: 'male-qn-qingse', speed: 1.15, tag: 'wake' },
  { name: 'wake-nijialuo-female-slow', text: '费加罗', voice: 'female-tianmei', speed: 0.9, tag: 'wake' },
  { name: 'wake-feijialuo', text: '菲加罗', voice: 'male-qn-jingying', speed: 1.0, tag: 'wake' },
  { name: 'wake-feijialuo2', text: '飞加罗', voice: 'female-shaonv', speed: 1.0, tag: 'wake' },
  { name: 'wake-with-command', text: '费加罗，现在几点了', voice: 'male-qn-jingying', speed: 1.0, tag: 'wake' },
  { name: 'wake-greeting', text: '你好费加罗', voice: 'female-shaonv', speed: 1.0, tag: 'wake' },

  // --- distractors: ordinary speech that must NOT wake ---
  { name: 'neg-weather', text: '今天天气真不错', voice: 'male-qn-jingying', speed: 1.0, tag: 'neg' },
  { name: 'neg-meeting', text: '明天下午三点开会', voice: 'female-shaonv', speed: 1.0, tag: 'neg' },
  { name: 'neg-music', text: '播放周杰伦的七里香', voice: 'male-qn-qingse', speed: 1.0, tag: 'neg' },
  { name: 'neg-express', text: '帮我查一下快递到哪了', voice: 'female-tianmei', speed: 1.0, tag: 'neg' },
  { name: 'neg-light', text: '打开客厅的灯', voice: 'male-qn-jingying', speed: 1.0, tag: 'neg' },
  { name: 'neg-xiaoyi', text: '你好小艺小艺', voice: 'female-shaonv', speed: 1.0, tag: 'neg' },
  { name: 'neg-dinner', text: '我晚上想吃火锅', voice: 'male-qn-qingse', speed: 1.0, tag: 'neg' },

  // --- English wake word positives (bilingual KWS) ---
  { name: 'wake-en-figaro-man', text: 'Figaro', voice: 'English_Trustworth_Man', speed: 1.0, tag: 'wake-en' },
  { name: 'wake-en-figaro-woman', text: 'Figaro', voice: 'English_Graceful_Lady', speed: 1.0, tag: 'wake-en' },
  { name: 'wake-en-hey-figaro', text: 'Hey Figaro', voice: 'English_DecentYoungMan', speed: 1.0, tag: 'wake-en' },

  // --- English distractors (must not wake) ---
  { name: 'neg-en-weather', text: 'What is the weather like tomorrow?', voice: 'English_ConfidentWoman', speed: 1.0, tag: 'neg-en' },
  { name: 'neg-en-music', text: 'Play some music please', voice: 'English_Trustworth_Man', speed: 1.0, tag: 'neg-en' },

  // --- capture / transcription sentences ---
  { name: 'cmd-time', text: '现在几点了', voice: 'male-qn-jingying', speed: 1.0, tag: 'cmd', expect: '现在几点了' },
  { name: 'cmd-weather', text: '明天北京天气怎么样', voice: 'female-shaonv', speed: 1.0, tag: 'cmd', expect: '明天北京天气怎么样' },
  { name: 'cmd-light', text: '帮我打开客厅的灯', voice: 'male-qn-qingse', speed: 1.0, tag: 'cmd', expect: '帮我打开客厅的灯' },
  { name: 'cmd-music', text: '播放周杰伦的七里香', voice: 'female-tianmei', speed: 1.0, tag: 'cmd', expect: '播放周杰伦的七里香' },
  { name: 'cmd-volume', text: '把音量调小一点', voice: 'male-qn-jingying', speed: 1.0, tag: 'cmd', expect: '把音量调小一点' },
];

function loadKey() {
  if (process.env.FIGARO_MINIMAX_API_KEY) return process.env.FIGARO_MINIMAX_API_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg.minimax?.apiKey) return cfg.minimax.apiKey;
  } catch (err) {
    throw new Error(`cannot read MiniMax key from ${CONFIG_PATH}: ${err.message}`);
  }
  throw new Error('no minimax.apiKey in config and FIGARO_MINIMAX_API_KEY unset');
}

/** Parse a canonical PCM WAV: returns format info + duration (data chunk based). */
function wavInfo(buf) {
  let off = 12;
  let fmt = null;
  let dataBytes = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataBytes = size;
    }
    off = body + size + (size % 2);
  }
  if (!fmt) throw new Error('not a PCM wav: missing fmt chunk');
  const frameBytes = (fmt.channels * fmt.bits) / 8;
  return { ...fmt, dataBytes, durationMs: Math.round((dataBytes / frameBytes / fmt.sampleRate) * 1000) };
}

async function synthOnce(key, clip) {
  const body = {
    model: 'speech-02-turbo',
    text: clip.text,
    stream: false,
    voice_setting: { voice_id: clip.voice, speed: clip.speed ?? 1.0, vol: 1.0, pitch: 0 },
    audio_setting: { sample_rate: 16000, bitrate: 128000, format: 'wav', channel: 1 },
  };
  const res = await fetch('https://api.minimax.cn/v1/t2a_v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.base_resp?.status_code !== 0) throw new Error(`minimax ${json.base_resp?.status_code}: ${json.base_resp?.status_msg}`);
  const audioHex = json.data?.audio;
  if (!audioHex) throw new Error('empty audio');
  return Buffer.from(audioHex, 'hex');
}

// Retry wrapper: MiniMax rate-limits at a low RPM; back off and retry a few times.
async function synth(key, clip) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await synthOnce(key, clip);
    } catch (err) {
      lastErr = err;
      const transient = /rate limit|RPM|HTTP 5\d\d|empty audio|fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(err.message));
      if (!transient) throw err;
      const wait = 3000 * (attempt + 1);
      console.log(`    retry ${attempt + 1}/6 in ${wait}ms: ${String(err.message).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : null;

fs.mkdirSync(OUT, { recursive: true });
const manifestPath = path.join(OUT, 'manifest.json');
let manifest = [];
if (fs.existsSync(manifestPath) && !force) {
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { manifest = []; }
}
const byName = new Map(manifest.map((m) => [m.name, m]));

const key = loadKey();
let made = 0, skipped = 0;
const todo = CLIPS.filter((c) => (!only || c.tag === only) && (force || !fs.existsSync(path.join(OUT, `${c.name}.wav`))));
console.log(`fixtures dir: ${OUT}`);
console.log(`${todo.length} clip(s) to generate, ${CLIPS.length - todo.length} already present/skipped`);

for (const clip of todo) {
  const file = path.join(OUT, `${clip.name}.wav`);
  const t0 = Date.now();
  const buf = await synth(key, clip);
  // Validate it is a real RIFF/WAVE 16k mono file.
  if (buf.subarray(0, 4).toString() !== 'RIFF') throw new Error(`${clip.name}: not RIFF`);
  const info = wavInfo(buf);
  if (info.sampleRate !== 16000 || info.channels !== 1 || info.bits !== 16) {
    throw new Error(`${clip.name}: unexpected wav format ${JSON.stringify(info)}`);
  }
  fs.writeFileSync(file, buf);
  const durationMs = info.durationMs;
  const entry = {
    name: clip.name,
    file: `${clip.name}.wav`,
    text: clip.text,
    voice: clip.voice,
    speed: clip.speed ?? 1.0,
    tag: clip.tag,
    expect: clip.expect ?? null,
    sampleRate: info.sampleRate,
    durationMs,
    bytes: buf.length,
    tts: 'minimax/t2a_v2 speech-02-turbo',
  };
  byName.set(clip.name, entry);
  made++;
  console.log(`  + ${clip.name.padEnd(26)} ${String(durationMs).padStart(5)}ms  ${(Date.now() - t0)}ms tts-latency  "${clip.text}"`);
  await new Promise((r) => setTimeout(r, 700)); // stay under the TTS RPM limit
}
skipped = CLIPS.length - made;
// Rebuild the manifest from CLIPS + whatever wavs are on disk, so that clips
// generated by an earlier (possibly interrupted) run are always described too.
const ordered = [];
for (const clip of CLIPS) {
  const file = path.join(OUT, `${clip.name}.wav`);
  if (!fs.existsSync(file)) continue;
  const existing = byName.get(clip.name);
  const buf = fs.readFileSync(file);
  const info = wavInfo(buf);
  const entry = {
    name: clip.name,
    file: `${clip.name}.wav`,
    text: clip.text,
    voice: clip.voice,
    speed: clip.speed ?? 1.0,
    tag: clip.tag,
    expect: clip.expect ?? null,
    sampleRate: info.sampleRate,
    durationMs: info.durationMs,
    bytes: buf.length,
    tts: 'minimax/t2a_v2 speech-02-turbo',
  };
  ordered.push(existing ? { ...entry, ...existing, durationMs: info.durationMs, sampleRate: info.sampleRate, bytes: buf.length } : entry);
}
fs.writeFileSync(manifestPath, JSON.stringify(ordered, null, 2) + '\n');
console.log(`done: ${made} generated, ${skipped} already existed. manifest: ${path.relative(ROOT, manifestPath)}`);
