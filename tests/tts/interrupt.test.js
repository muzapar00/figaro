// Interrupt (barge-in) tests.
//
// The most important property of a voice assistant: when the user talks over it,
// the voice must stop *immediately* — no queued sentences, no stale network
// audio from the old generation, no stuck playback process.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTts } from '../../src/voice/tts/index.js';
import { startFakeMiniMaxServer } from './fake-minimax-server.js';
import {
  makeTempDir,
  fileSinkCommand,
  makeConfig,
  fileSize,
  trackedCallbacks,
  waitForFileSize,
  delay,
  withTimeout,
} from './helpers.js';

async function setup(t, serverOpts, configOpts = {}) {
  const dir = makeTempDir();
  const sink = path.join(dir, 'out.pcm');
  const calls = trackedCallbacks();
  const server = await startFakeMiniMaxServer(serverOpts);
  const tts = createTts({
    config: makeConfig({ wsUrl: server.url, playerCommand: fileSinkCommand(sink), ...configOpts }),
    onLevel: calls.onLevel,
    onState: calls.onState,
    onError: calls.onError,
  });
  t.after(async () => {
    try {
      tts.close();
    } catch {
      /* ignore */
    }
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, sink, calls, server, tts };
}

test('stop() cuts playback fast, freezes the sink and drops the old generation', async (t) => {
  // 30 frames * 20ms delay: a long, slow audio stream we can interrupt mid-way
  const { sink, calls, server, tts } = await setup(t, {
    chunkBytes: 2048,
    chunks: 30,
    chunkDelayMs: 20,
  });

  tts.speak('这是一段很长的回复，用来测试打断功能。第二句还没说呢。');
  const flushed = tts.flush();
  await waitForFileSize(sink, 2048, 3000);
  assert.equal(tts.speaking, true, 'should be speaking before stop()');
  const sizeBeforeStop = fileSize(sink);
  const tStopWall = Date.now();
  const tSync = performance.now();
  tts.stop();
  const stopSyncMs = performance.now() - tSync;
  assert.ok(stopSyncMs < 200, `stop() must be fast, took ${stopSyncMs}ms`);
  assert.equal(tts.speaking, false, 'speaking must flip to false immediately');
  assert.ok(tts.stats.lastInterruptMs < 200, `stats.lastInterruptMs=${tts.stats.lastInterruptMs}`);
  assert.deepEqual(calls.states[calls.states.length - 1].state, 'idle');

  // flush() must resolve after an interrupt (no deadlock for the daemon)
  await withTimeout(flushed, 1000, 'flush after stop');

  // no more bytes may reach the sink (old network audio + old timers are dead)
  await delay(400);
  assert.equal(fileSize(sink), sizeBeforeStop, 'sink must not grow after stop()');

  // no level events after stop (the one 0-level emitted by stop itself is ok)
  const lateLevels = calls.levels.filter((l) => l.at > tStopWall + 5);
  assert.deepEqual(lateLevels, [], `unexpected levels after stop: ${JSON.stringify(lateLevels)}`);

  // playback process is really gone
  await withTimeout(
    (async () => {
      for (let i = 0; i < 100 && tts.stats.lastInterruptPlayerExitMs === null; i++) await delay(10);
    })(),
    2000,
    'player kill',
  );
  assert.ok(
    tts.stats.lastInterruptPlayerExitMs !== null && tts.stats.lastInterruptPlayerExitMs < 200,
    `player exit latency ${tts.stats.lastInterruptPlayerExitMs}`,
  );

  // the WebSocket really got torn down
  await withTimeout(
    (async () => {
      const start = Date.now();
      while (Date.now() - start < 2000 && server.lastCloseAt === 0) await delay(10);
    })(),
    2500,
    'ws close',
  );
  assert.ok(server.lastCloseAt > 0, 'expected the interrupted WebSocket to close');

  // and a new utterance after the interrupt works on a fresh connection
  await tts.speak('打断之后还能继续说话。');
  await waitForFileSize(sink, sizeBeforeStop + 128, 4000);
  assert.equal(tts.speaking, true);
  tts.stop();
});

test('stop() while idle is a harmless no-op', async (t) => {
  const { calls, tts } = await setup(t, { chunkBytes: 512, chunks: 1 });
  assert.doesNotThrow(() => tts.stop());
  assert.equal(tts.speaking, false);
  await withTimeout(tts.flush(), 1000, 'flush idle');
  assert.deepEqual(calls.errors, []);
});

test('stop() before the first audio chunk prevents any playback', async (t) => {
  // delayed task_started, so stop() lands while still connecting
  const { sink, calls, tts } = await setup(t, { chunks: 2, chunkBytes: 1024, startDelayMs: 200 });
  tts.speak('这一句不该被听见。');
  await delay(30);
  tts.stop();
  await delay(500);
  assert.equal(fileSize(sink), 0, 'no audio may be played after an early stop');
  assert.deepEqual(calls.errors, []);
  assert.equal(tts.speaking, false);
});
