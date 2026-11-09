// Sentence chunking unit tests plus the daemon's "think while speaking" wiring:
// streamed deltas are cut into sentences and spoken as soon as they are complete,
// and cancel/barge-in really stops the speaker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDaemon, drainSentences } from '../../src/daemon.js';
import { createIpcClient } from '../../src/ipc.js';
import { makeTestConfig, silentLogger, waitFor } from './fake-llm.js';

function makeFakeTts() {
  const record = { spoken: [], flushes: 0, stops: 0, speakResolvers: [] };
  const tts = {
    async speak(text) {
      record.spoken.push(text);
    },
    async flush() {
      record.flushes += 1;
    },
    stop() {
      record.stops += 1;
    },
    get speaking() {
      return false;
    },
  };
  return { tts, record };
}

async function startVoiceDaemon(t, { agentFactory, ttsFactory }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figaro-voice-test-'));
  const socketPath = path.join(dir, 'sock');
  const daemon = createDaemon({
    config: makeTestConfig({ socket: socketPath, tts: { enabled: true }, asr: { enabled: false } }),
    voice: true,
    logger: silentLogger,
    agentFactory,
    ...(ttsFactory ? { ttsFactory } : {}),
  });
  await daemon.start();
  t.after(async () => {
    await daemon.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { daemon, socketPath };
}

async function connect(t, socketPath) {
  const messages = [];
  const client = createIpcClient({ socketPath, onMessage: (message) => messages.push(message) });
  await client.connect();
  t.after(() => client.close());
  return { client, messages };
}

const repliesFor = (messages, requestId) => messages.filter((m) => m.type === 'reply' && m.requestId === requestId);

test('drainSentences splits spoken punctuation and keeps the unfinished rest', () => {
  const first = drainSentences('你好。今天 3.14 是圆周率！还有');
  assert.deepEqual(first.sentences, ['你好。', '今天 3.14 是圆周率！']);
  assert.equal(first.rest, '还有');

  const english = drainSentences('Hello there. This is fine.');
  assert.deepEqual(english.sentences, ['Hello there.', 'This is fine.']);
  assert.equal(english.rest, '');

  const long = drainSentences('这是一个很长的句子没有标点'.repeat(20), 40);
  assert.ok(long.sentences.length >= 5, 'a long unpunctuated run is cut at maxChars');
  assert.ok(long.sentences.every((sentence) => sentence.length <= 41));
  assert.ok(long.rest.length > 0);
});

test('streamed deltas are spoken sentence by sentence (边想边说), then flushed', async (t) => {
  const { tts, record } = makeFakeTts();
  const agentFactory = (callbacks) => ({
    history: [],
    reset() {},
    async run() {
      // Simulate token-by-token streaming from the model.
      for (const delta of ['你好。', '今天', '天气不错！', '想出去走走吗？']) {
        callbacks.onTextDelta(delta);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return { text: '你好。今天天气不错！想出去走走吗？' };
    },
  });
  const { daemon, socketPath } = await startVoiceDaemon(t, {
    agentFactory,
    ttsFactory: () => tts,
  });
  await waitFor(() => daemon.voice.tts !== null, { label: 'tts module loaded' });
  const { client, messages } = await connect(t, socketPath);
  client.send({ type: 'subscribe' });
  client.send({ type: 'ask', text: '说点什么', requestId: 'tts-1' });

  const reply = await waitFor(() => repliesFor(messages, 'tts-1')[0], { label: 'reply' });
  assert.equal(reply.text, '你好。今天天气不错！想出去走走吗？');

  // Each complete sentence went to the TTS queue in order, and flush() was awaited.
  assert.deepEqual(record.spoken, ['你好。', '今天天气不错！', '想出去走走吗？']);
  assert.equal(record.flushes, 1);

  // The state machine visited speaking and came back to idle.
  const states = messages.filter((m) => m.type === 'state').map((m) => m.state);
  assert.ok(states.includes('speaking'), `saw states ${states.join(',')}`);
  assert.equal(states.at(-1), 'idle');

  // The reply was broadcast before the speaker finished: text reaches the UI first.
  const replyIndex = messages.findIndex((m) => m.type === 'reply' && m.requestId === 'tts-1');
  const idleIndex = messages.map((m) => m.type).lastIndexOf('state');
  assert.ok(replyIndex < idleIndex, 'reply precedes the final idle state');
});

test('cancel during a streamed answer stops the speaker (barge-in)', async (t) => {
  const { tts, record } = makeFakeTts();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const agentFactory = (callbacks) => ({
    history: [],
    reset() {},
    async run({ signal }) {
      callbacks.onTextDelta('第一句。');
      await blocked;
      if (signal.aborted) return { text: '第一句。', aborted: true };
      return { text: '第一句。' };
    },
  });
  const { daemon, socketPath } = await startVoiceDaemon(t, { agentFactory, ttsFactory: () => tts });
  await waitFor(() => daemon.voice.tts !== null, { label: 'tts loaded' });
  const { client, messages } = await connect(t, socketPath);
  client.send({ type: 'subscribe' });
  client.send({ type: 'ask', text: '长回答', requestId: 'cancel-voice' });
  await waitFor(() => record.spoken.length > 0, { label: 'first sentence spoken' });
  // The ask handler calls tts.stop() once up front to clear any leftover queue;
  // only a stop after that baseline counts as the barge-in.
  const stopBaseline = record.stops;
  client.send({ type: 'cancel' });
  await waitFor(() => record.stops > stopBaseline, { label: 'tts.stop() called on cancel' });
  release();
  await waitFor(() => messages.filter((m) => m.type === 'state').at(-1)?.state === 'idle', {
    label: 'idle after cancel',
  });
  assert.equal(repliesFor(messages, 'cancel-voice').length, 0);
});

test('ask with TTS enabled still works when the TTS module fails to load', async (t) => {
  const agentFactory = () => ({
    history: [],
    reset() {},
    async run() {
      return { text: '没有嗓子也能说话。' };
    },
  });
  // The factory throws: initVoice must catch it and keep the text path alive.
  const { daemon, socketPath } = await startVoiceDaemon(t, {
    agentFactory,
    ttsFactory: () => {
      throw new Error('no audio device');
    },
  });
  await waitFor(() => daemon.voice.tts === null, { label: 'tts stays null' });
  const { client, messages } = await connect(t, socketPath);
  client.send({ type: 'subscribe' });
  client.send({ type: 'ask', text: '你好', requestId: 'no-tts' });
  const reply = await waitFor(() => repliesFor(messages, 'no-tts')[0], { label: 'reply without tts' });
  assert.equal(reply.text, '没有嗓子也能说话。');
  client.send({ type: 'ping' });
  const pong = await waitFor(() => messages.find((m) => m.type === 'pong'), { label: 'pong' });
  assert.deepEqual(pong.voice, { asr: false, tts: false });
});

test('ASR callbacks drive the listening state and finish with a real ask', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figaro-asr-test-'));
  const socketPath = path.join(dir, 'sock');
  const record = { begin: 0, end: 0, starts: 0, stops: 0, callbacks: null };
  const asrFactory = (callbacks) => {
    record.callbacks = callbacks;
    return {
      async start() {
        record.starts += 1;
      },
      async stop() {
        record.stops += 1;
      },
      beginCapture() {
        record.begin += 1;
      },
      endCapture() {
        record.end += 1;
      },
      capturing: false,
    };
  };
  const daemon = createDaemon({
    config: makeTestConfig({ socket: socketPath, asr: { enabled: true }, tts: { enabled: false } }),
    voice: true,
    logger: silentLogger,
    asrFactory,
    agentFactory: (callbacks) => ({
      history: [],
      reset() {},
      async run({ text }) {
        callbacks.onTextDelta('听到了。');
        return { text: `回声：${text}` };
      },
    }),
  });
  await daemon.start();
  t.after(async () => {
    await daemon.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await waitFor(() => daemon.voice.asr !== null && record.callbacks !== null, { label: 'asr loaded' });

  const { client, messages } = await connect(t, socketPath);
  client.send({ type: 'subscribe' });

  // wake → listening state + beginCapture()
  client.send({ type: 'wake' });
  await waitFor(() => record.begin > 0, { label: 'beginCapture' });
  await waitFor(
    () => messages.filter((m) => m.type === 'state').at(-1)?.state === 'listening',
    { label: 'listening state' },
  );

  // partial transcript is forwarded to subscribers
  record.callbacks.onPartial('现在');
  const partial = await waitFor(() => messages.find((m) => m.type === 'partial'), { label: 'asr partial' });
  assert.equal(partial.text, '现在');

  // final transcript starts a normal turn
  record.callbacks.onFinal('现在几点了');
  const reply = await waitFor(() => messages.find((m) => m.type === 'reply'), { label: 'asr turn reply' });
  assert.equal(reply.text, '回声：现在几点了');

  // push-to-talk messages call beginCapture/endCapture on the module
  client.send({ type: 'listen_begin' });
  await waitFor(() => record.begin >= 2, { label: 'second beginCapture' });
  client.send({ type: 'listen_end' });
  await waitFor(() => record.end >= 1, { label: 'endCapture' });

  // ASR errors do not crash the daemon
  record.callbacks.onError(new Error('mic exploded'));
  await waitFor(() => messages.some((m) => m.type === 'error' && /语音识别出错/.test(m.message)), {
    label: 'asr error broadcast',
  });
  client.send({ type: 'ping' });
  await waitFor(() => messages.find((m) => m.type === 'pong'), { label: 'pong after asr error' });
});
