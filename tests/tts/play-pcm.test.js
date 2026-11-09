// playPcm() / synthesize() tests: cached wake-acknowledgement audio.
//
// Everything is hermetic: file sink instead of pw-cat, fake WS server instead of
// MiniMax, fake sink probe instead of pactl.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTts } from '../../src/voice/tts/index.js';
import { startFakeMiniMaxServer, fakePcm } from './fake-minimax-server.js';
import {
  makeTempDir,
  fileSinkCommand,
  blockingSinkCommand,
  makeConfig,
  fakeSinkProbe,
  fileSize,
  readFile,
  trackedCallbacks,
  delay,
  withTimeout,
} from './helpers.js';

function sineS16(samples, amplitude = 8000) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((i / 32) * Math.PI * 2)), i * 2);
  }
  return buf;
}

async function makeTts(t, { server = null, ttsOptions = {}, configPatch = {}, playerCommand = null } = {}) {
  const dir = makeTempDir();
  const sink = path.join(dir, 'out.pcm');
  const calls = trackedCallbacks();
  const cfg = makeConfig({
    wsUrl: server ? server.url : 'ws://127.0.0.1:1',
    playerCommand: playerCommand || fileSinkCommand(sink),
    ...configPatch,
  });
  const tts = createTts({
    config: cfg,
    logger: null,
    sinkProbe: fakeSinkProbe,
    onLevel: calls.onLevel,
    onState: calls.onState,
    onError: calls.onError,
    ...ttsOptions,
  });
  t.after(async () => {
    try {
      tts.close();
    } catch {
      /* ignore */
    }
    if (server) await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { tts, calls, sink, dir };
}

test('playPcm plays a raw s16le buffer through the same player and level pipeline', async (t) => {
  const { tts, calls, sink } = await makeTts(t);
  const pcm = sineS16(32000 * 0.4); // 400ms
  const started = Date.now();
  const result = await tts.playPcm(pcm, { rate: 32000, channels: 1 });
  const elapsed = Date.now() - started;

  assert.equal(result.bytes, pcm.length);
  assert.equal(result.durationMs, 400);
  assert.equal(result.completed, true);
  assert.ok(readFile(sink).equals(pcm), 'sink must receive exactly the given PCM');
  assert.ok(elapsed >= 300 && elapsed < 3000, `playPcm resolved after ${elapsed}ms (expected ~550)`);
  assert.deepEqual(calls.states.map((s) => s.state), ['speaking', 'idle']);
  assert.equal(tts.speaking, false);
  assert.ok(calls.levels.some((l) => l.value > 0.1), 'onLevel must fire for playPcm audio');
  assert.equal(tts.stats.pcmPlays, 1);
  assert.equal(tts.stats.pcmBytes, pcm.length);
  assert.ok(tts.stats.lastPcmWriteMs !== null && tts.stats.lastPcmWriteMs < 1000, 'first write must be fast');
  assert.equal(calls.errors.length, 0);
});

test('playPcm accepts Float32Array at another sample rate and resamples', async (t) => {
  const { tts, sink } = await makeTts(t);
  const frames = 1600; // 100ms @16k
  const floats = new Float32Array(frames);
  for (let i = 0; i < frames; i++) floats[i] = 0.25 * Math.sin((i / 16) * Math.PI * 2);
  const result = await tts.playPcm(floats, { rate: 16000, channels: 1 });
  assert.equal(result.durationMs, 100);
  const written = readFile(sink);
  assert.equal(written.length, frames * 2 * 2, '16k -> 32k doubles the samples');
  let max = 0;
  for (let i = 0; i < written.length; i += 2) max = Math.max(max, Math.abs(written.readInt16LE(i)));
  assert.ok(max > 6000 && max <= 8192, `resampled amplitude looks wrong: ${max}`);
});

test('flush() waits for playPcm audio too', async (t) => {
  const { tts } = await makeTts(t);
  const pcm = sineS16(32000 * 0.2);
  const play = tts.playPcm(pcm);
  const flush = tts.flush();
  await withTimeout(Promise.all([play, flush]), 3000, 'flush after playPcm');
  assert.equal(tts.speaking, false);
});

test('stop() interrupts playPcm immediately and resolves its promise', async (t) => {
  const { tts, calls } = await makeTts(t, { playerCommand: blockingSinkCommand() });
  const pcm = Buffer.alloc(32000 * 4 * 2, 100); // 4s
  const play = tts.playPcm(pcm);
  await delay(120);
  assert.equal(tts.speaking, true);
  const tStopWall = Date.now();
  tts.stop();
  const result = await withTimeout(play, 1000, 'playPcm after stop');
  assert.equal(result.completed, false, 'interrupted playback must not report completed');
  assert.equal(tts.speaking, false);
  await delay(300);
  assert.deepEqual(
    calls.levels.filter((l) => l.at > tStopWall + 5),
    [],
    'no level events after stop',
  );
  assert.ok(tts.stats.lastInterruptPlayerExitMs !== null && tts.stats.lastInterruptPlayerExitMs < 200);
  await withTimeout(tts.flush(), 1000, 'flush after stop');
});

test('playPcm rejects unsupported input via onError, without throwing or hanging', async (t) => {
  const { tts, calls, sink } = await makeTts(t);
  const result = await withTimeout(tts.playPcm('not-audio'), 1000, 'playPcm invalid');
  assert.equal(result.bytes, 0);
  assert.equal(calls.errors.length, 1);
  assert.match(calls.errors[0].message, /playPcm|Buffer|Float32Array/);
  assert.equal(fileSize(sink), 0);
});

test('playPcm with empty input is a silent no-op', async (t) => {
  const { tts, calls } = await makeTts(t);
  const result = await tts.playPcm(Buffer.alloc(0));
  assert.equal(result.bytes, 0);
  assert.equal(result.completed, false);
  assert.equal(calls.errors.length, 0);
});

test('synthesize() returns PCM without playing it', async (t) => {
  const server = await startFakeMiniMaxServer({ chunkBytes: 1024, chunks: 2, chunkDelayMs: 1 });
  const { tts, sink, calls } = await makeTts(t, { server });

  const result = await withTimeout(tts.synthesize('在的，请说。'), 5000, 'synthesize');
  const expected = fakePcm('在的，请说。', 0, 1024 * 2);
  assert.equal(result.sentences, 1);
  assert.equal(result.sampleRate, 32000);
  assert.equal(result.pcm.length, expected.length);
  assert.ok(result.pcm.equals(expected), 'synthesize must collect the same PCM the server sent');
  assert.equal(result.durationMs, Math.round(expected.length / 64));
  assert.equal(fileSize(sink), 0, 'synthesize must not play anything');
  assert.equal(calls.states.length, 0, 'synthesize must not change speaking state');
  assert.equal(tts.stats.synthRequests, 1);
  assert.ok(tts.stats.lastSynthMs !== null);
  // one task_continue with the cleaned text
  assert.deepEqual(
    server.requests.map((r) => r.text),
    ['在的，请说。'],
  );
});

test('synthesize() splits long text into sentences and concatenates in order', async (t) => {
  const server = await startFakeMiniMaxServer({ chunkBytes: 512, chunks: 1, chunkDelayMs: 1 });
  const { tts } = await makeTts(t, { server });
  const result = await withTimeout(tts.synthesize('第一句。第二句！第三句？'), 8000, 'synthesize');
  assert.equal(result.sentences, 3);
  const expected = Buffer.concat(
    server.requests.map((r, i) => fakePcm(r.text, i, 512)),
  );
  assert.equal(result.pcm.length, expected.length);
  assert.deepEqual(
    server.requests.map((r) => r.text),
    ['第一句。', '第二句！', '第三句？'],
  );
});

test('synthesize() rejects without an API key', async (t) => {
  const prev = process.env.FIGARO_MINIMAX_API_KEY;
  const prev2 = process.env.MINIMAX_API_KEY;
  process.env.FIGARO_MINIMAX_API_KEY = '';
  process.env.MINIMAX_API_KEY = '';
  try {
    const { tts } = await makeTts(t, { configPatch: { minimax: { apiKey: '' } } });
    await assert.rejects(() => tts.synthesize('你好。'), /API key/i);
  } finally {
    process.env.FIGARO_MINIMAX_API_KEY = prev;
    process.env.MINIMAX_API_KEY = prev2;
  }
});

test('synthesize() with only markup returns empty PCM without a request', async (t) => {
  const server = await startFakeMiniMaxServer({ chunkBytes: 512, chunks: 1 });
  const { tts } = await makeTts(t, { server });
  const result = await withTimeout(tts.synthesize('```js\nconsole.log(1)\n```'), 2000, 'synthesize empty');
  assert.equal(result.pcm.length, 0);
  assert.equal(result.sentences, 0);
  assert.equal(server.requests.length, 0);
});
