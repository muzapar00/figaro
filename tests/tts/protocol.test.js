// Protocol-level tests for the MiniMax t2a_v2 WebSocket client + createTts().
//
// A local fake WS server implements the same event flow as MiniMax, so these
// tests need no network and no API quota. They assert:
//  - request shape (model/voice/format pcm/32000/mono/Authorization header)
//  - event order task_start -> task_continue -> (audio -> is_final)
//  - streaming append, pipelining and gapless byte concatenation
//  - error paths: task_failed, handshake failure, missing api key, timeout+retry
//  - reconnect-once after an abrupt disconnect, then fail-fast

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTts } from '../../src/voice/tts/index.js';
import { startFakeMiniMaxServer, fakePcm } from './fake-minimax-server.js';
import {
  makeTempDir,
  fileSinkCommand,
  makeConfig,
  fakeSinkProbe,
  fileSize,
  readFile,
  trackedCallbacks,
  delay,
  withTimeout,
} from './helpers.js';

function setup(t, serverOpts = {}, cfgOpts = {}) {
  const dir = makeTempDir();
  const sink = path.join(dir, 'out.pcm');
  const calls = trackedCallbacks();
  const ctx = { dir, sink, calls, tts: null, server: null };
  return (async () => {
    ctx.server = await startFakeMiniMaxServer(serverOpts);
    const config = makeConfig({
      wsUrl: ctx.server.url,
      playerCommand: fileSinkCommand(sink),
      ...cfgOpts,
    });
    ctx.tts = createTts({
      config,
      logger: null, // keep test output clean; sink resolution is unit-tested separately
      sinkProbe: fakeSinkProbe,
      onLevel: calls.onLevel,
      onState: calls.onState,
      onError: calls.onError,
    });
    t.after(async () => {
      try {
        ctx.tts.close();
      } catch {
        /* ignore */
      }
      await ctx.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return ctx;
  })();
}

test('happy path: correct request, streamed audio, flush() waits for playback end', async (t) => {
  const { sink, calls, tts, server } = await setup(t, { chunkBytes: 2048, chunks: 2, chunkDelayMs: 2 });

  const tSpeak = Date.now();
  await withTimeout(tts.speak('你好，费加罗。'), 1000, 'speak');
  assert.ok(Date.now() - tSpeak < 300, 'speak() must only enqueue, not wait for playback');
  await withTimeout(tts.flush(), 5000, 'flush');

  // request shape
  assert.equal(server.messages[0].event, 'task_start');
  const start = server.messages[0];
  assert.equal(start.model, 'speech-2.6-turbo');
  assert.equal(start.voice_setting.voice_id, 'male-qn-jingying');
  assert.equal(start.audio_setting.format, 'pcm');
  assert.equal(start.audio_setting.sample_rate, 32000);
  assert.equal(start.audio_setting.channel, 1);
  assert.equal(server.authHeaders[0], 'Bearer test-api-key');

  // event order + text
  const events = server.messages.map((m) => m.event);
  assert.deepEqual(events.slice(0, 2), ['task_start', 'task_continue']);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].text, '你好，费加罗。');

  // audio actually reached the sink, byte for byte
  const expected = fakePcm('你好，费加罗。', 0, 2048 * 2);
  assert.equal(fileSize(sink), expected.length);
  assert.ok(readFile(sink).equals(expected), 'sink bytes must equal synthesized PCM');

  // state + stats
  assert.deepEqual(
    calls.states.map((s) => s.state),
    ['speaking', 'idle'],
  );
  assert.equal(calls.errors.length, 0);
  assert.equal(tts.speaking, false);
  assert.equal(tts.stats.finals, 1);
  assert.equal(tts.stats.bytes, 4096);
  assert.equal(tts.stats.requests, 1);
  assert.ok(tts.stats.lastFirstAudioMs !== null, 'first-audio latency must be measured');
  assert.ok(tts.stats.lastRequestToFirstAudioMs !== null);
  // connection is reused across turns: still open after flush
  assert.equal(server.lastCloseAt, 0);
});

test('multi-sentence speak() is pipelined in order, audio concatenates without gaps', async (t) => {
  const { sink, calls, tts, server } = await setup(t, { chunkBytes: 1024, chunks: 3, chunkDelayMs: 1 });
  await tts.speak('第一句。第二句！第三句？');
  await withTimeout(tts.flush(), 8000, 'flush');

  assert.deepEqual(
    server.requests.map((r) => r.text),
    ['第一句。', '第二句！', '第三句？'],
  );
  const expected = Buffer.concat(server.requests.map((r, i) => fakePcm(r.text, i, 1024 * 3)));
  assert.ok(readFile(sink).equals(expected), 'all sentence audio must be concatenated in order');
  assert.equal(calls.errors.length, 0);
});

test('streaming append while speaking: later speak() calls are not lost', async (t) => {
  // slow-ish first sentence so the second speak() lands mid-synthesis
  const { calls, tts, server } = await setup(t, { chunkBytes: 2048, chunks: 2, chunkDelayMs: 30 });
  await tts.speak('先说这一句。');
  await delay(20);
  await tts.speak('再说这一句。');
  await delay(20);
  await tts.speak('最后一句。');
  await withTimeout(tts.flush(), 8000, 'flush');

  assert.deepEqual(
    server.requests.map((r) => r.text),
    ['先说这一句。', '再说这一句。', '最后一句。'],
  );
  assert.equal(calls.errors.length, 0);
});

test('task_failed is reported through onError and does not throw or hang', async (t) => {
  const { calls, tts } = await setup(
    t,
    {
      failTextMatcher: (text) => (text.includes('炸') ? { code: 1004, msg: 'fake auth failure' } : null),
    },
  );
  await tts.speak('给我炸一个。');
  await withTimeout(tts.flush(), 5000, 'flush');
  assert.ok(calls.errors.length >= 1, 'expected an onError for task_failed');
  assert.match(calls.errors.map((e) => e.message).join(' | '), /1004|auth/i);
  assert.equal(tts.speaking, false);
  assert.ok(tts.stats.failures >= 1);
});

test('handshake failure (task_started error code) fails fast and reports', async (t) => {
  const { calls, tts } = await setup(t, { taskStartedCode: 1004 });
  await tts.speak('你好。');
  await withTimeout(tts.flush(), 5000, 'flush');
  assert.ok(calls.errors.length >= 1);
  assert.match(calls.errors.map((e) => e.message).join(' | '), /task_start failed|1004/i);
  assert.equal(tts.speaking, false);
});

test('missing api key fails fast without touching the network', async (t) => {
  const prevEnv = process.env.FIGARO_MINIMAX_API_KEY;
  const prevEnv2 = process.env.MINIMAX_API_KEY;
  process.env.FIGARO_MINIMAX_API_KEY = '';
  process.env.MINIMAX_API_KEY = '';
  try {
    const dir = makeTempDir();
    const sink = path.join(dir, 'out.pcm');
    const calls = trackedCallbacks();
    const tts = createTts({
      config: makeConfig({ wsUrl: 'ws://127.0.0.1:1', apiKey: '', playerCommand: fileSinkCommand(sink) }),
      logger: null,
      sinkProbe: fakeSinkProbe,
      onLevel: calls.onLevel,
      onState: calls.onState,
      onError: calls.onError,
    });
    t.after(() => {
      tts.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    tts.speak('你好。');
    await withTimeout(tts.flush(), 3000, 'flush');
    assert.ok(calls.errors.length >= 1);
    assert.match(calls.errors[0].message, /API key/i);
    assert.equal(tts.speaking, false);
  } finally {
    process.env.FIGARO_MINIMAX_API_KEY = prevEnv;
    process.env.MINIMAX_API_KEY = prevEnv2;
  }
});

test('reconnects once after an abrupt disconnect and re-sends the unplayed sentence', async (t) => {
  const { sink, calls, tts, server } = await setup(
    t,
    { dropFirstContinue: true, chunkBytes: 2048, chunks: 2, chunkDelayMs: 2 },
  );
  await tts.speak('这句要能重发。');
  await withTimeout(tts.flush(), 8000, 'flush');

  assert.ok(server.connections >= 2, `expected a reconnect, saw ${server.connections} connections`);
  assert.equal(tts.stats.reconnects, 1);
  assert.equal(fileSize(sink), 4096, 'audio must be delivered after the retry');
  assert.equal(calls.errors.length, 0, 'a clean one-shot retry should not surface an error');
});

test('request timeout triggers one retry and then fail-fast', async (t) => {
  const { calls, tts } = await setup(
    t,
    { chunks: 0 }, // server never answers task_continue
    { tts: { requestTimeoutMs: 150, maxReconnects: 1 } },
  );
  await tts.speak('服务器不回话。');
  await withTimeout(tts.flush(), 6000, 'flush');
  assert.ok(calls.errors.length >= 1);
  assert.match(calls.errors.map((e) => e.message).join(' | '), /timed out/i);
  assert.ok(tts.stats.failures >= 1, 'must fail fast after the single retry');
  assert.equal(tts.speaking, false);
});

test('idle ws close sends task_finish and releases the player', async (t) => {
  const { tts, server } = await setup(t, { chunkBytes: 1024, chunks: 1 }, { tts: { wsIdleCloseMs: 300, playerKeepAliveMs: 50 } });
  await tts.speak('短句。');
  await withTimeout(tts.flush(), 5000, 'flush');
  await delay(700);
  assert.ok(server.messages.some((m) => m.event === 'task_finish'), 'expected task_finish on idle');
  assert.ok(server.lastCloseAt > 0, 'expected the socket to be closed after idle timeout');
  assert.equal(tts.stats.playerAlive, false, 'player must be released after idle');
});

test('two separate turns reuse the connection and the player', async (t) => {
  const { sink, calls, tts, server } = await setup(t, { chunkBytes: 1024, chunks: 2, chunkDelayMs: 1 });
  await tts.speak('第一轮。');
  await withTimeout(tts.flush(), 5000, 'flush turn 1');
  assert.deepEqual(
    calls.states.map((s) => s.state),
    ['speaking', 'idle'],
  );
  await tts.speak('第二轮。');
  await withTimeout(tts.flush(), 5000, 'flush turn 2');
  assert.deepEqual(
    calls.states.map((s) => s.state),
    ['speaking', 'idle', 'speaking', 'idle'],
  );
  assert.equal(server.connections, 1, 'second turn should reuse the warm WebSocket');
  assert.deepEqual(
    server.requests.map((r) => r.text),
    ['第一轮。', '第二轮。'],
  );
  const expected = Buffer.concat(server.requests.map((r, i) => fakePcm(r.text, i, 1024 * 2)));
  assert.ok(readFile(sink).equals(expected));
  assert.equal(calls.errors.length, 0);
});

test('long text (8 sentences) keeps every sentence, in order, with a pipelining window', async (t) => {
  const { sink, calls, tts, server } = await setup(t, { chunkBytes: 256, chunks: 1, chunkDelayMs: 1 });
  const sentences = ['第一句话。', '第二句话！', '第三句话？', '第四句话。', '第五句话。', '第六句话。', '第七句话。', '第八句话。'];
  await tts.speak(sentences.join(''));
  await withTimeout(tts.flush(), 10000, 'flush');
  assert.deepEqual(server.requests.map((r) => r.text), sentences, 'no sentence may be lost or reordered');
  const expected = Buffer.concat(server.requests.map((r, i) => fakePcm(r.text, i, 256)));
  assert.ok(readFile(sink).equals(expected), 'all 8 sentences concatenated in order');
  assert.equal(calls.errors.length, 0);
});

test('markdown / urls / emoji are cleaned before hitting the API', async (t) => {
  const { calls, tts, server } = await setup(t, { chunkBytes: 512, chunks: 1 });
  await tts.speak('**重点**：看这里 https://example.com/x 😀（注：不该读出来）然后继续。');
  await withTimeout(tts.flush(), 5000, 'flush');
  assert.equal(server.requests.length, 1);
  const sent = server.requests[0].text;
  assert.doesNotMatch(sent, /\*\*|https?:\/\/|😀|不该读出来/);
  assert.match(sent, /重点/);
  assert.match(sent, /然后继续/);
  assert.equal(calls.errors.length, 0);
});

test('speak() with only markup sends nothing and flush() resolves', async (t) => {
  const { calls, tts, server } = await setup(t, { chunkBytes: 512, chunks: 1 });
  await tts.speak('```js\nconsole.log(1)\n```');
  await withTimeout(tts.flush(), 1500, 'flush');
  assert.equal(server.requests.length, 0, 'nothing to say => no API request');
  assert.deepEqual(calls.states, []);
  assert.equal(calls.errors.length, 0);
});

test('concurrent flush() calls all resolve on the same turn end', async (t) => {
  const { calls, tts } = await setup(t, { chunkBytes: 1024, chunks: 2, chunkDelayMs: 5 });
  await tts.speak('你好。');
  const waits = [tts.flush(), tts.flush(), tts.flush()];
  await withTimeout(Promise.all(waits), 5000, 'concurrent flushes');
  assert.equal(calls.errors.length, 0);
});
