// Wake-flow tests: "我在" acknowledgement timing relative to capture, fallbacks
// (no ack / ack timeout / no TTS), echo stripping and barge-in during the ack.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDaemon } from '../../src/daemon.js';
import { createIpcClient } from '../../src/ipc.js';
import { makeTestConfig, silentLogger, waitFor } from './fake-llm.js';

function makeFakeAsr() {
  const record = { begin: 0, end: 0, capturing: false, callbacks: null };
  const factory = (callbacks) => {
    record.callbacks = callbacks;
    return {
      async start() {},
      async stop() {},
      beginCapture() {
        record.begin += 1;
        record.capturing = true;
      },
      endCapture() {
        record.end += 1;
        record.capturing = false;
      },
      get capturing() {
        return record.capturing;
      },
    };
  };
  return { factory, record };
}

function makeFakeTts() {
  const record = { speak: [], stops: 0, flush: 0 };
  return {
    record,
    factory: () => ({
      async speak(text) {
        record.speak.push(text);
      },
      async flush() {
        record.flush += 1;
      },
      stop() {
        record.stops += 1;
      },
      get speaking() {
        return false;
      },
      stats: { model: 'speech-2.6-turbo', voiceId: 'male-qn-jingying' },
    }),
  };
}

/**
 * Fake ack controller. `mode`:
 *  - 'manual': started/done resolve only when the test calls ack.finish()/startSettled()
 *  - 'instant': started resolves, done resolves after finish()
 *  - 'null': play() returns null (ack unavailable)
 *  - 'stuck': never started, never done (timeout path)
 */
function makeFakeAck({ mode = 'manual', timeoutMs = 800, ready = true } = {}) {
  const record = { plays: 0, stops: 0, prepare: 0, finished: 0 };
  let startedResolve;
  let doneResolve;
  const handle = {
    phrase: '我在',
    started: new Promise((resolve) => {
      startedResolve = resolve;
    }),
    done: new Promise((resolve) => {
      doneResolve = resolve;
    }),
    stop: () => {
      record.stops += 1;
      doneResolve({ phrase: '我在', ok: false, stopped: true });
    },
  };
  const ack = {
    enabled: true,
    timeoutMs,
    phrases: ['我在', '在的'],
    record,
    get ready() {
      return ready;
    },
    async prepare() {
      record.prepare += 1;
      return true;
    },
    play() {
      record.plays += 1;
      if (mode === 'null') return null;
      if (mode === 'instant') startedResolve(1);
      return handle;
    },
    stop() {},
    close() {},
    stats: { model: 'speech-2.6-turbo', voiceId: 'male-qn-jingying', disabledReason: null, lastPhrase: null, lastPlayDurationMs: null, failures: 0 },
    startSettled: (ms = 2) => startedResolve(ms),
    finish: (info = { ok: true, phrase: '我在', durationMs: 400 }) => {
      record.finished += 1;
      doneResolve(info);
    },
  };
  return { ack, record, handle };
}

function makeFakeAgent(texts) {
  return (callbacks) => ({
    history: [],
    reset() {},
    async run({ text }) {
      texts.push(text);
      callbacks?.onTextDelta?.('好的。');
      return { text: `回声：${text}` };
    },
  });
}

async function startTestDaemon(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figaro-wake-test-'));
  const socketPath = path.join(dir, 'sock');
  const config = {
    ...makeTestConfig({ socket: socketPath }),
    asr: { enabled: true },
    tts: { enabled: true, ack: { enabled: true, phrases: ['我在', '在的'], timeoutMs: overrides.ackTimeoutMs ?? 800 } },
  };
  const daemon = createDaemon({
    config,
    voice: true,
    logger: silentLogger,
    agentFactory: overrides.agentFactory,
    asrFactory: overrides.asrFactory,
    ttsFactory: overrides.ttsFactory,
    ackFactory: overrides.ackFactory,
  });
  await daemon.start();
  t.after(async () => {
    await daemon.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const messages = [];
  const client = createIpcClient({ socketPath, onMessage: (message) => messages.push(message) });
  await client.connect();
  t.after(() => client.close());
  client.send({ type: 'subscribe' });
  await waitFor(() => messages.some((message) => message.type === 'state'), { label: 'initial state' });
  return { daemon, socketPath, client, messages };
}

const states = (messages) => messages.filter((m) => m.type === 'state').map((m) => m.state);
const replies = (messages) => messages.filter((m) => m.type === 'reply');

test('wake → ack plays → only then beginCapture(), ending in listening', async (t) => {
  const asr = makeFakeAsr();
  const tts = makeFakeTts();
  const texts = [];
  const { ack, record } = makeFakeAck({ mode: 'manual' });
  const { daemon, client, messages } = await startTestDaemon(t, {
    asrFactory: asr.factory,
    ttsFactory: tts.factory,
    ackFactory: () => ack,
    agentFactory: makeFakeAgent(texts),
  });
  await waitFor(() => daemon.voice.asr && daemon.voice.tts, { label: 'voice modules' });

  client.send({ type: 'wake' });
  await waitFor(() => states(messages).includes('waking'), { label: 'ack waking state' });
  assert.equal(record.plays, 1, 'ack was played once');
  assert.equal(asr.record.begin, 0, 'capture must not start while the ack plays');

  await ack.startSettled();
  ack.finish({ ok: true, phrase: '我在', durationMs: 400 });
  await waitFor(() => asr.record.begin === 1, { label: 'beginCapture after ack' });
  assert.equal(states(messages).at(-1), 'listening');
  assert.equal(asr.record.capturing, true);
});

test('ack unavailable (play returns null) degrades to immediate capture', async (t) => {
  const asr = makeFakeAsr();
  const tts = makeFakeTts();
  const { client, messages } = await startTestDaemon(t, {
    asrFactory: asr.factory,
    ttsFactory: tts.factory,
    ackFactory: () => makeFakeAck({ mode: 'null' }).ack,
    agentFactory: makeFakeAgent([]),
  });
  client.send({ type: 'wake' });
  await waitFor(() => asr.record.begin === 1, { label: 'immediate capture' });
  await waitFor(() => states(messages).at(-1) === 'listening', { label: 'listening state' });
  assert.ok(!states(messages).includes('waking'), 'no ack, no waking state');
});

test('ack that never starts falls back to capture after tts.ack.timeoutMs', async (t) => {
  const asr = makeFakeAsr();
  const tts = makeFakeTts();
  const { ack, record } = makeFakeAck({ mode: 'stuck', timeoutMs: 80 });
  const { client, messages } = await startTestDaemon(t, {
    asrFactory: asr.factory,
    ttsFactory: tts.factory,
    ackFactory: () => ack,
    agentFactory: makeFakeAgent([]),
    ackTimeoutMs: 80,
  });
  client.send({ type: 'wake' });
  await waitFor(() => states(messages).includes('waking'), { label: 'ack playing state' });
  await waitFor(() => asr.record.begin === 1, { label: 'timeout fallback capture', timeoutMs: 3000 });
  await waitFor(() => states(messages).at(-1) === 'listening', { label: 'listening after timeout' });
  assert.ok(record.stops >= 1, 'stuck ack was stopped');
});

test('echo of the ack ("我在现在几点了") is stripped before the turn', async (t) => {
  const asr = makeFakeAsr();
  const tts = makeFakeTts();
  const texts = [];
  const { ack } = makeFakeAck({ mode: 'manual' });
  const { daemon, client, messages } = await startTestDaemon(t, {
    asrFactory: asr.factory,
    ttsFactory: tts.factory,
    ackFactory: () => ack,
    agentFactory: makeFakeAgent(texts),
  });
  await waitFor(() => daemon.voice.asr && daemon.voice.tts, { label: 'voice modules' });
  client.send({ type: 'wake' });
  await waitFor(() => states(messages).includes('waking'), { label: 'ack state' });
  await ack.startSettled();
  ack.finish({ ok: true, phrase: '我在', durationMs: 400 });
  await waitFor(() => asr.record.begin === 1, { label: 'capture after ack' });

  asr.record.callbacks.onFinal('我在现在几点了');
  const reply = await waitFor(() => replies(messages)[0], { label: 'reply' });
  assert.deepEqual(texts, ['现在几点了']);
  assert.equal(reply.text, '回声：现在几点了');
});

test('a transcript that is only the ack echo is discarded and listening re-arms', async (t) => {
  const asr = makeFakeAsr();
  const tts = makeFakeTts();
  const texts = [];
  const { ack } = makeFakeAck({ mode: 'manual' });
  const { daemon, client, messages } = await startTestDaemon(t, {
    asrFactory: asr.factory,
    ttsFactory: tts.factory,
    ackFactory: () => ack,
    agentFactory: makeFakeAgent(texts),
  });
  await waitFor(() => daemon.voice.asr && daemon.voice.tts, { label: 'voice modules' });
  client.send({ type: 'wake' });
  await waitFor(() => states(messages).includes('waking'), { label: 'ack state' });
  await ack.startSettled();
  ack.finish({ ok: true, phrase: '我在', durationMs: 400 });
  await waitFor(() => asr.record.begin === 1, { label: 'capture after ack' });

  // Simulate the ASR ending the capture on silence with only the echo in it.
  asr.record.capturing = false;
  asr.record.callbacks.onFinal('我在');
  await waitFor(() => asr.record.begin === 2, { label: 're-arm capture' });
  assert.deepEqual(texts, [], 'echo-only transcript must not start a turn');
  assert.equal(replies(messages).length, 0);
});

test('speech captured while the ack is still playing is processed after it ends', async (t) => {
  const asr = makeFakeAsr();
  const tts = makeFakeTts();
  const texts = [];
  const { ack } = makeFakeAck({ mode: 'manual' });
  const { daemon, client, messages } = await startTestDaemon(t, {
    asrFactory: asr.factory,
    ttsFactory: tts.factory,
    ackFactory: () => ack,
    agentFactory: makeFakeAgent(texts),
  });
  await waitFor(() => daemon.voice.asr && daemon.voice.tts, { label: 'voice modules' });
  client.send({ type: 'wake' });
  await waitFor(() => states(messages).includes('waking'), { label: 'ack state' });
  asr.record.callbacks.onFinal('现在几点了'); // captured during the ack (fallback path)
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(texts, [], 'turn waits for the ack to finish');

  await ack.startSettled();
  ack.finish({ ok: true, phrase: '我在', durationMs: 400 });
  const reply = await waitFor(() => replies(messages)[0], { label: 'reply after ack' });
  assert.deepEqual(texts, ['现在几点了']);
  assert.equal(reply.text, '回声：现在几点了');
});

test('cancel during the ack stops it and returns to idle', async (t) => {
  const asr = makeFakeAsr();
  const tts = makeFakeTts();
  const { ack, record } = makeFakeAck({ mode: 'manual' });
  const { client, messages } = await startTestDaemon(t, {
    asrFactory: asr.factory,
    ttsFactory: tts.factory,
    ackFactory: () => ack,
    agentFactory: makeFakeAgent([]),
  });
  client.send({ type: 'wake' });
  await waitFor(() => states(messages).includes('waking'), { label: 'ack state' });
  client.send({ type: 'cancel' });
  await waitFor(() => states(messages).at(-1) === 'idle', { label: 'idle after cancel' });
  assert.ok(record.stops >= 1, 'ack playback was stopped');
  assert.equal(asr.record.begin, 0, 'cancel during ack does not start capture');
});

test('without a TTS module there is no ack: wake goes straight to capture', async (t) => {
  const asr = makeFakeAsr();
  const texts = [];
  const { client, messages } = await startTestDaemon(t, {
    asrFactory: asr.factory,
    ttsFactory: () => {
      throw new Error('no audio device');
    },
    ackFactory: () => makeFakeAck({ mode: 'manual' }).ack,
    agentFactory: makeFakeAgent(texts),
  });
  client.send({ type: 'wake' });
  await waitFor(() => asr.record.begin === 1, { label: 'capture without tts' });
  await waitFor(() => states(messages).at(-1) === 'listening', { label: 'listening without tts' });
  assert.ok(!states(messages).includes('waking'));

  // ping reports the ack as not usable
  client.send({ type: 'ping' });
  const pong = await waitFor(() => messages.find((m) => m.type === 'pong'), { label: 'pong' });
  assert.equal(pong.voice.tts, false);
});

test('pong reports wake-ack health and its voice identity', async (t) => {
  const asr = makeFakeAsr();
  const tts = makeFakeTts();
  const { ack } = makeFakeAck({ mode: 'manual' });
  const { client, messages } = await startTestDaemon(t, {
    asrFactory: asr.factory,
    ttsFactory: tts.factory,
    ackFactory: () => ack,
    agentFactory: makeFakeAgent([]),
  });
  client.send({ type: 'ping' });
  const pong = await waitFor(() => messages.find((m) => m.type === 'pong'), { label: 'pong' });
  assert.equal(pong.ack.enabled, true);
  assert.equal(pong.ack.ready, true);
  assert.equal(pong.ack.timeoutMs, 800);
  assert.deepEqual(pong.ack.phrases, ['我在', '在的']);
  assert.equal(pong.ack.voiceId, 'male-qn-jingying');
  assert.equal(pong.ack.model, 'speech-2.6-turbo');
});

test('an explicit cancel is not undone by the empty final of the interrupted capture', async (t) => {
  const asr = makeFakeAsr();
  const tts = makeFakeTts();
  const { ack } = makeFakeAck({ mode: 'manual' });
  const { daemon, client, messages } = await startTestDaemon(t, {
    asrFactory: asr.factory,
    ttsFactory: tts.factory,
    ackFactory: () => ack,
    agentFactory: makeFakeAgent([]),
  });
  await waitFor(() => daemon.voice.asr && daemon.voice.tts, { label: 'voice modules' });
  client.send({ type: 'wake' });
  await waitFor(() => states(messages).includes('waking'), { label: 'ack state' });
  await ack.startSettled();
  ack.finish({ ok: true, phrase: '我在', durationMs: 400 });
  await waitFor(() => asr.record.begin === 1, { label: 'capture after ack' });

  // Capture already finalised (the production race: cancel arrives between
  // endCapture and onFinal), so no suppress flag is armed.
  asr.record.capturing = false;
  client.send({ type: 'cancel' });
  await waitFor(() => states(messages).at(-1) === 'idle', { label: 'idle after cancel' });

  asr.record.callbacks.onFinal('');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(asr.record.begin, 1, 'empty final after cancel must not re-arm capture');
  assert.equal(states(messages).at(-1), 'idle');
});

test('TTS playback pauses wake-word listening and restores it afterwards (echo suppression)', async (t) => {
  const record = { muted: false, muteCalls: [], ttsCallbacks: null };
  const asrFactory = (callbacks) => {
    record.cbs = callbacks;
    return {
      async start() {},
      async stop() {},
      beginCapture() {},
      endCapture() {},
      get capturing() {
        return false;
      },
      setMuted(value) {
        record.muted = Boolean(value);
        record.muteCalls.push(Boolean(value));
      },
      get muted() {
        return record.muted;
      },
    };
  };
  const ttsFactory = (callbacks) => {
    record.ttsCallbacks = callbacks;
    return {
      async speak() {},
      async flush() {},
      stop() {
        callbacks.onState?.('idle');
      },
      get speaking() {
        return false;
      },
      stats: {},
    };
  };
  const texts = [];
  const { daemon, client, messages } = await startTestDaemon(t, {
    asrFactory,
    ttsFactory,
    ackFactory: () => makeFakeAck({ mode: 'manual' }).ack,
    agentFactory: makeFakeAgent(texts),
  });
  await waitFor(() => daemon.voice.asr && record.ttsCallbacks !== null, { label: 'voice modules' });

  record.ttsCallbacks.onState('speaking');
  await waitFor(() => record.muted === true, { label: 'muted during TTS' });
  assert.deepEqual(record.muteCalls, [true]);

  record.ttsCallbacks.onState('idle');
  await waitFor(() => record.muted === false, { label: 'unmuted after TTS' });
  assert.deepEqual(record.muteCalls, [true, false]);

  client.send({ type: 'ping' });
  const pong = await waitFor(() => messages.find((m) => m.type === 'pong'), { label: 'pong' });
  assert.equal(pong.wakeMuted, false);
  void texts;
});

test('echo suppression falls back to pauseListening()/resumeListening()', async (t) => {
  const record = { paused: false, ttsCallbacks: null };
  const asrFactory = (callbacks) => {
    record.cbs = callbacks;
    return {
      async start() {},
      async stop() {},
      beginCapture() {},
      endCapture() {},
      get capturing() {
        return false;
      },
      pauseListening() {
        record.paused = true;
      },
      resumeListening() {
        record.paused = false;
      },
    };
  };
  const ttsFactory = (callbacks) => {
    record.ttsCallbacks = callbacks;
    return {
      async speak() {},
      async flush() {},
      stop() {
        callbacks.onState?.('idle');
      },
      get speaking() {
        return false;
      },
      stats: {},
    };
  };
  const { daemon } = await startTestDaemon(t, {
    asrFactory,
    ttsFactory,
    ackFactory: () => makeFakeAck({ mode: 'manual' }).ack,
    agentFactory: makeFakeAgent([]),
  });
  await waitFor(() => daemon.voice.asr && record.ttsCallbacks !== null, { label: 'voice modules' });
  record.ttsCallbacks.onState('speaking');
  await waitFor(() => record.paused === true, { label: 'paused' });
  record.ttsCallbacks.onState('idle');
  await waitFor(() => record.paused === false, { label: 'resumed' });
});
