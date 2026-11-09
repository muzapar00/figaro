#!/usr/bin/env node
// Voice / model selection benchmark (manual; needs network + API key + quota).
//
//   node tests/tts/bench-voice.mjs
//   node tests/tts/bench-voice.mjs --models=speech-2.6-turbo,speech-2.8-turbo \
//        --voices=male-qn-jingying,Chinese (Mandarin)_Gentleman --repeats=3
//
// Measures, for every (model, voice) pair:
//   connect   — establish WSS + task_started handshake
//   ttfb      — task_continue sent -> first PCM chunk (median of `repeats`)
//   gen       — task_continue sent -> is_final (full audio synthesized)
//   audio     — synthesized audio length, chars/sec (speech-rate sanity check)
//
// Writes 32 kHz mono s16le WAV samples + a JSON summary under tests/tts/out/
// (git-ignored). These are the files a human should listen to when judging
// naturalness — latency alone cannot decide that.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMiniMaxClient } from '../../src/voice/tts/minimax-client.js';
import { loadConfig } from '../../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');

// ------------------------------------------------------------------ args ----
function parseArgs(argv) {
  const args = { repeats: 3, models: null, voices: null, out: OUT_DIR, timeoutMs: 20000, pace: 3600 };
  for (const raw of argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (key === 'repeats') args.repeats = Number(value) || 3;
    else if (key === 'models') args.models = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'voices') args.voices = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'out') args.out = value;
    else if (key === 'timeout') args.timeoutMs = Number(value) || 20000;
    else if (key === 'pace') args.pace = Math.max(0, Number(value) || 3600);
  }
  return args;
}

// 5 male candidates: 2 from the legacy male-qn-* series + 3 newer
// Chinese (Mandarin)_* voices. Kept small on purpose: t2a_v2 is limited to
// 20 RPM, and the benchmark must not chew through the quota.
const VOICE_CANDIDATES = [
  { id: 'male-qn-jingying', label: '精英青年音色' },
  { id: 'male-qn-qingse', label: '青涩青年音色' },
  { id: 'Chinese (Mandarin)_Gentleman', label: '温润男声' },
  { id: 'Chinese (Mandarin)_Radio_Host', label: '电台男主播' },
  { id: 'Chinese (Mandarin)_Male_Announcer', label: '播报男声' },
];

const MODEL_CANDIDATES = ['speech-2.6-turbo', 'speech-2.8-turbo', 'speech-02-turbo'];

// Similar-length sentences, rotated per repeat so server-side caching cannot
// flatter (or penalise) a particular model.
const TEST_SENTENCES = [
  '费加罗，现在是上午九点。',
  '今天气温十八度，适合出去散步。',
  '帮你查了一下，日程安排没有问题。',
];

const SAMPLE_RATE = 32000;

// ----------------------------------------------------------------- utils ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const slug = (s) => s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);

function writeWav(file, pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

// --------------------------------------------------------------- measure ----
async function measureCombo({ wsUrl, apiKey, model, voice, repeats, timeoutMs, pace }) {
  const result = {
    model,
    voice,
    ok: false,
    error: null,
    connectMs: null,
    ttfb: [],
    gen: [],
    audioMs: [],
    chars: [],
    pcm: null,
  };
  let current = null;
  let resolveTurn = null;
  const client = createMiniMaxClient({
    wsUrl,
    apiKey,
    model,
    voiceId: voice,
    sampleRate: SAMPLE_RATE,
    connectTimeoutMs: 10000,
    requestTimeoutMs: timeoutMs,
    onAudio: (buf) => {
      if (!current) return;
      if (current.firstAt === null) current.firstAt = Date.now();
      current.bytes += buf.length;
      current.pcm.push(buf);
    },
    onFinal: () => {
      if (!current) return;
      current.finalAt = Date.now();
      const done = current;
      current = null;
      resolveTurn?.(done);
    },
    onFailed: (err) => {
      if (!current) return;
      current.error = err;
      const done = current;
      current = null;
      resolveTurn?.(done);
    },
    onClose: () => {
      if (!current) return;
      current.error = new Error('connection closed before is_final');
      const done = current;
      current = null;
      resolveTurn?.(done);
    },
  });

  try {
    const tConnect = Date.now();
    await client.connect();
    result.connectMs = Date.now() - tConnect;

    for (let i = 0; i < repeats; i++) {
      const text = TEST_SENTENCES[i % TEST_SENTENCES.length];
      current = { text, sentAt: Date.now(), firstAt: null, finalAt: null, bytes: 0, pcm: [], error: null };
      const turn = new Promise((resolve) => {
        resolveTurn = resolve;
      });
      client.send(text);
      const done = await Promise.race([
        turn,
        sleep(timeoutMs + 2000).then(() => ({ ...current, error: new Error('client timeout') })),
      ]);
      if (done.error) {
        result.error = done.error.message;
        break;
      }
      const ttfb = done.firstAt === null ? null : done.firstAt - done.sentAt;
      const genMs = done.finalAt === null ? null : done.finalAt - done.sentAt;
      const audioMs = (done.bytes / 64) * 1; // 32000 Hz * 2 bytes = 64 bytes/ms
      result.ttfb.push(ttfb);
      result.chars.push(done.text.length);
      result.gen.push(genMs);
      result.audioMs.push(audioMs);
      if (i === 0) result.pcm = Buffer.concat(done.pcm);
      if (i < repeats - 1) await sleep(pace);
    }
    result.ok = result.ttfb.length > 0 && result.ttfb.every((x) => x !== null);
  } catch (err) {
    result.error = err.message;
  } finally {
    try {
      client.close();
    } catch {
      /* ignore */
    }
  }
  return result;
}

// ------------------------------------------------------------------ main ----
async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig();
  const apiKey = cfg.minimax.apiKey;
  if (!apiKey) {
    console.error('No MiniMax API key in config (~/.config/figaro/config.json minimax.apiKey)');
    process.exit(2);
  }
  const wsUrl = cfg.minimax.wsUrl || 'wss://api.minimax.cn/ws/v1/t2a_v2';
  const models = args.models || MODEL_CANDIDATES;
  const voices = args.voices ? args.voices.map((id) => ({ id, label: '' })) : VOICE_CANDIDATES;
  fs.mkdirSync(args.out, { recursive: true });

  console.log(`MiniMax ${wsUrl} | repeats=${args.repeats} | models=${models.length} | voices=${voices.length}`);
  console.log('');

  const rows = [];
  const isRateLimited = (msg) => /rate limit|\[1002\]|\[1039\]/i.test(msg || '');
  for (const model of models) {
    for (const voice of voices) {
      let r;
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await measureCombo({
          wsUrl,
          apiKey,
          model,
          voice: voice.id,
          repeats: args.repeats,
          timeoutMs: args.timeoutMs,
          pace: args.pace,
        });
        if (r.ok || !isRateLimited(r.error)) break;
        console.log(`  rate limited on ${model}/${voice.id}; cooling down 25s (attempt ${attempt + 1}/3)`);
        await sleep(25000);
      }
      const ttfbMed = median(r.ttfb.filter((x) => x !== null));
      const genMed = median(r.gen.filter((x) => x !== null));
      const audioMed = median(r.audioMs);
      const charsMed = median(r.chars);
      const charsPerSec = audioMed ? round((charsMed / audioMed) * 1000, 2) : null;
      const wav = path.join(args.out, `${slug(model)}__${slug(voice.id)}.wav`);
      if (r.pcm) writeWav(wav, r.pcm);
      rows.push({
        model,
        voice: voice.id,
        label: voice.label,
        ok: r.ok,
        error: r.error,
        connectMs: r.connectMs,
        ttfbMs: ttfbMed,
        genMs: genMed,
        audioMs: round(audioMed, 0),
        charsPerSec,
        wav: r.pcm ? path.relative(process.cwd(), wav) : null,
      });
      const status = r.ok ? 'ok' : `FAIL: ${r.error || 'no audio'}`;
      console.log(
        [
          model.padEnd(17),
          voice.id.padEnd(46),
          `conn ${String(r.connectMs ?? '-').padStart(4)}ms`,
          `ttfb ${String(round(ttfbMed, 0) ?? '-').padStart(4)}ms`,
          `gen ${String(round(genMed, 0) ?? '-').padStart(4)}ms`,
          `audio ${String(round(audioMed, 0) ?? '-').padStart(5)}ms`,
          `rate ${String(charsPerSec ?? '-').padStart(4)} 字/s`,
          status,
        ].join(' | '),
      );
      fs.writeFileSync(
        path.join(args.out, 'bench-voice.partial.json'),
        JSON.stringify({ ts: new Date().toISOString(), rows }, null, 2),
      );
      await sleep(args.pace);
    }
  }

  const summaryFile = path.join(args.out, 'bench-voice.json');
  fs.writeFileSync(summaryFile, JSON.stringify({ ts: new Date().toISOString(), wsUrl, repeats: args.repeats, rows }, null, 2));

  console.log('\n=== markdown ===');
  console.log('| model | voice | connect(ms) | TTFB median(ms) | gen median(ms) | audio(s) | 字/s | 试听 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.model} | ${r.voice} | ${r.connectMs ?? '-'} | ${round(r.ttfbMs, 0) ?? '-'} | ${round(r.genMs, 0) ?? '-'} | ${r.audioMs ? round(r.audioMs / 1000, 2) : '-'} | ${r.charsPerSec ?? '-'} | ${r.ok ? '`' + r.wav + '`' : 'FAIL'} |`,
    );
  }
  console.log(`\nJSON: ${path.relative(process.cwd(), summaryFile)}`);
  console.log(`WAVs: ${path.relative(process.cwd(), args.out)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
