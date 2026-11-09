#!/usr/bin/env node
// Real-machine smoke test for the Figaro TTS module (manual; talks to MiniMax
// and plays through the actual speakers).
//
//   node tests/tts/smoke.mjs                 # 5 short utterances, real playback
//   node tests/tts/smoke.mjs --runs=5 --no-play   # measure without making noise
//   node tests/tts/smoke.mjs --text="费加罗，你好。" --capture=tests/tts/out/smoke.wav
//
// Prints, per run: speak() -> first PCM handed to the sink, request -> first
// audio, and total turn length. This is the number that matters for "首字延迟".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTts } from '../../src/voice/tts/index.js';
import { loadConfig } from '../../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    runs: 5,
    text: '费加罗，现在几点了？',
    model: null,
    voice: null,
    noPlay: false,
    capture: null,
    gapMs: 400,
  };
  for (const raw of argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (key === 'runs') args.runs = Math.max(1, Number(value) || 5);
    else if (key === 'text') args.text = value;
    else if (key === 'model') args.model = value;
    else if (key === 'voice') args.voice = value;
    else if (key === 'no-play') args.noPlay = true;
    else if (key === 'capture') args.capture = value;
    else if (key === 'gap') args.gapMs = Number(value) || 400;
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const round = (n) => (Number.isFinite(n) ? Math.round(n) : null);

function writeWav(file, pcm, sampleRate = 32000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

const PW_CAT =
  'pw-cat --playback --raw --format=s16 --rate=32000 --channels=1 --latency=40ms -';

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  if (args.model) cfg.minimax.model = args.model;
  if (args.voice) cfg.minimax.voiceId = args.voice;
  if (!cfg.minimax.apiKey) {
    console.error('No MiniMax API key in ~/.config/figaro/config.json (minimax.apiKey)');
    process.exit(2);
  }

  let tmpPcm = null;
  if (args.noPlay) {
    cfg.tts.playerCommand = ['bash', '-c', 'exec cat > /dev/null'];
  } else if (args.capture) {
    // play through pw-cat *and* keep a copy of the PCM for a WAV file
    tmpPcm = path.join(__dirname, 'out', `.smoke-${process.pid}.pcm`);
    fs.mkdirSync(path.dirname(tmpPcm), { recursive: true });
    fs.rmSync(tmpPcm, { force: true });
    cfg.tts.playerCommand = ['bash', '-c', `exec tee ${JSON.stringify(tmpPcm)} | ${PW_CAT}`];
  }

  const tts = createTts({ config: cfg, onLevel: () => {}, onState: () => {}, onError: (e) => console.error('onError:', e.message) });
  console.log(
    `TTS smoke: model=${tts.stats.model} voice=${tts.stats.voiceId} text="${args.text}" runs=${args.runs}` +
      `${args.noPlay ? ' (no playback)' : ' (real playback)'}`,
  );
  if (!args.noPlay) console.log('注意：接下来会有 ~1 秒的测试播报，结束后立刻释放声卡。\n');

  const rows = [];
  for (let i = 0; i < args.runs; i++) {
    // one instance, reused across runs: this is the warm path a daemon has
    const started = Date.now();
    let firstAudioAt = null;
    // observe the first transition to "speaking" via stats polling (cheap, 5ms)
    let before = tts.stats.bytes;
    await tts.speak(args.text);
    for (let spin = 0; spin < 600; spin++) {
      if (tts.stats.bytes > before) {
        firstAudioAt = Date.now();
        break;
      }
      await sleep(5);
    }
    await tts.flush();
    const turnMs = Date.now() - started;
    const stats = tts.stats;
    const row = {
      run: i + 1,
      firstAudioMs: firstAudioAt ? firstAudioAt - started : null,
      requestToFirstAudioMs: stats.lastRequestToFirstAudioMs,
      turnMs,
      audioMs: round(stats.bytes > before ? ((stats.bytes - before) / 64) : null),
    };
    rows.push(row);
    console.log(
      `run ${i + 1}: firstAudio=${String(row.firstAudioMs).padStart(4)}ms ` +
        `request->firstAudio=${String(row.requestToFirstAudioMs).padStart(4)}ms ` +
        `turn=${String(turnMs).padStart(5)}ms audio=${row.audioMs}ms` +
        `${i === 0 ? '  (cold: includes ws connect)' : ''}`,
    );
    await sleep(args.gapMs);
  }

  const firsts = rows.map((r) => r.firstAudioMs).filter((x) => x !== null);
  const warm = firsts.slice(1);
  console.log('\n=== summary ===');
  console.log(`first-audio latency: median=${median(firsts)}ms min=${Math.min(...firsts)}ms max=${Math.max(...firsts)}ms (n=${firsts.length})`);
  if (warm.length) console.log(`warm-only (runs 2..n): median=${median(warm)}ms`);
  console.log(`request->first-audio: median=${median(rows.map((r) => r.requestToFirstAudioMs).filter((x) => x !== null))}ms`);
  console.log(`model=${tts.stats.model} voice=${tts.stats.voiceId} errors=${tts.stats.errors}`);
  console.log('note: audible latency = request->first PCM + device buffer (~40ms) + TTS leading silence (~100ms)');

  if (args.capture && tmpPcm && fs.existsSync(tmpPcm)) {
    const pcm = fs.readFileSync(tmpPcm);
    writeWav(args.capture, pcm);
    fs.rmSync(tmpPcm, { force: true });
    console.log(`captured: ${args.capture} (${(pcm.length / 64).toFixed(0)}ms audio)`);
  }

  tts.close();
  await sleep(100);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
