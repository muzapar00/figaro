// IPC + daemon integration tests: a real unix-socket server and client, the
// documented state machine, subscribe/state/ask/reply/ack/ping/cancel round
// trips, and the text-only degradation path when no voice modules are loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDaemon } from '../../src/daemon.js';
import { createIpcClient } from '../../src/ipc.js';
import { createAgent } from '../../src/agent/index.js';
import { fakeFetchSequence, makeTestConfig, silentLogger, textResponse, waitFor } from './fake-llm.js';

const echoAgentFactory = () => ({
  history: [],
  reset() {},
  async run({ text }) {
    return { text: `回声：${text}` };
  },
});

async function startDaemon(t, { agentFactory, config } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figaro-daemon-test-'));
  const socketPath = path.join(dir, 'sock');
  const daemon = createDaemon({
    config: config ?? makeTestConfig({ socket: socketPath }),
    voice: false, // never touch a microphone or speaker in tests
    logger: silentLogger,
    agentFactory: agentFactory ?? echoAgentFactory,
  });
  await daemon.start();
  t.after(async () => {
    await daemon.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { daemon, socketPath, dir };
}

async function connectClient(t, socketPath) {
  const messages = [];
  const client = createIpcClient({ socketPath, onMessage: (message) => messages.push(message) });
  await client.connect();
  t.after(() => client.close());
  return { client, messages };
}

const messageOfType = (messages, type) => messages.filter((message) => message.type === type);

test('subscribe → state, ask → ack/state/reply round trip', async (t) => {
  const { socketPath } = await startDaemon(t);
  const { client, messages } = await connectClient(t, socketPath);

  // Every new connection learns the current state immediately.
  await waitFor(() => messageOfType(messages, 'state').length > 0, { label: 'initial state' });
  assert.equal(messageOfType(messages, 'state')[0].state, 'idle');

  client.send({ type: 'subscribe' });
  await waitFor(() => messageOfType(messages, 'state').length >= 2, { label: 'post-subscribe state' });

  client.send({ type: 'ask', text: '你好', requestId: 'r1' });
  const reply = await waitFor(() => messageOfType(messages, 'reply')[0], { label: 'reply' });
  assert.equal(reply.text, '回声：你好');
  assert.equal(reply.requestId, 'r1');

  const ack = await waitFor(() => messageOfType(messages, 'ack')[0], { label: 'ack' });
  assert.equal(ack.requestId, 'r1');

  // state machine sequence observed by a subscriber
  const states = messageOfType(messages, 'state').map((message) => message.state);
  assert.ok(states.includes('thinking'), `thinking state is broadcast (saw ${states.join(',')})`);
  assert.equal(states.at(-1), 'idle', 'turn returns to idle');
});

test('two asks keep their conversation context and answer in order', async (t) => {
  const seen = [];
  const { socketPath } = await startDaemon(t, {
    agentFactory: () => ({
      history: [],
      reset() {},
      async run({ text }) {
        seen.push(text);
        return { text: `第${seen.length}次：${text}`, usage: { total_tokens: seen.length } };
      },
    }),
  });
  const { client, messages } = await connectClient(t, socketPath);
  client.send({ type: 'subscribe' });

  client.send({ type: 'ask', text: '问题一', requestId: 'a' });
  const first = await waitFor(
    () => messageOfType(messages, 'reply').find((message) => message.requestId === 'a'),
    { label: 'first reply' },
  );
  client.send({ type: 'ask', text: '问题二', requestId: 'b' });
  const second = await waitFor(
    () => messageOfType(messages, 'reply').find((message) => message.requestId === 'b'),
    { label: 'second reply' },
  );

  assert.equal(first.text, '第1次：问题一');
  assert.equal(second.text, '第2次：问题二');
  assert.deepEqual(seen, ['问题一', '问题二']);
});

test('ping reports health, model and voice availability', async (t) => {
  const { socketPath } = await startDaemon(t);
  const { client, messages } = await connectClient(t, socketPath);
  client.send({ type: 'ping' });
  const pong = await waitFor(() => messageOfType(messages, 'pong')[0], { label: 'pong' });
  assert.equal(pong.state, 'idle');
  assert.equal(typeof pong.pid, 'number');
  assert.equal(pong.model, 'deepseek-flash');
  assert.deepEqual(pong.voice, { asr: false, tts: false });
  assert.equal(pong.socket, socketPath);
  assert.equal(typeof pong.uptimeMs, 'number');
});

test('cancel aborts the running turn and sends no reply, daemon stays usable', async (t) => {
  let aborted = false;
  const { socketPath } = await startDaemon(t, {
    agentFactory: () => ({
      history: [],
      reset() {},
      run({ text, signal }) {
        if (text === '打断我') {
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve({ text: '', aborted: true });
            }, { once: true });
          });
        }
        return Promise.resolve({ text: '还能用' });
      },
    }),
  });
  const { client, messages } = await connectClient(t, socketPath);
  client.send({ type: 'subscribe' });

  client.send({ type: 'ask', text: '打断我', requestId: 'cancel-me' });
  await waitFor(
    () => messageOfType(messages, 'state').some((message) => message.state === 'thinking'),
    { label: 'thinking state' },
  );
  client.send({ type: 'cancel' });

  await waitFor(() => aborted, { label: 'agent abort' });
  await waitFor(
    () => messageOfType(messages, 'state').at(-1)?.state === 'idle',
    { label: 'idle after cancel' },
  );
  assert.equal(
    messageOfType(messages, 'reply').filter((message) => message.requestId === 'cancel-me').length,
    0,
    'a cancelled turn must not emit a reply',
  );

  // The daemon is still fully usable after a cancel.
  client.send({ type: 'ask', text: '还在吗', requestId: 'after' });
  const reply = await waitFor(
    () => messageOfType(messages, 'reply').find((message) => message.requestId === 'after'),
    { label: 'reply after cancel' },
  );
  assert.equal(reply.text, '还能用');
});

test('unknown message types and empty ask texts get an error, not a crash', async (t) => {
  const { socketPath } = await startDaemon(t);
  const { client, messages } = await connectClient(t, socketPath);
  client.send({ type: 'subscribe' });

  client.send({ type: 'not-a-real-message' });
  const unknown = await waitFor(() => messageOfType(messages, 'error')[0], { label: 'unknown-type error' });
  assert.match(unknown.message, /unknown message type/);

  client.send({ type: 'ask', text: '   ', requestId: 'blank' });
  const emptyAsk = await waitFor(
    () => messageOfType(messages, 'error').find((message) => /ask\.text/.test(message.message)),
    { label: 'empty ask error' },
  );
  assert.match(emptyAsk.message, /non-empty/);

  // Still healthy afterwards.
  client.send({ type: 'ping' });
  await waitFor(() => messageOfType(messages, 'pong')[0], { label: 'pong after errors' });
});

test('ask with speak=true degrades gracefully when TTS is absent', async (t) => {
  const { socketPath } = await startDaemon(t);
  const { client, messages } = await connectClient(t, socketPath);
  client.send({ type: 'subscribe' });
  client.send({ type: 'ask', text: '朗读模式', speak: true, requestId: 'speak' });
  const reply = await waitFor(
    () => messageOfType(messages, 'reply').find((message) => message.requestId === 'speak'),
    { label: 'speak-mode reply' },
  );
  assert.equal(reply.text, '回声：朗读模式');
  assert.equal(messageOfType(messages, 'state').at(-1).state, 'idle');
});

test('wake/listen messages without a microphone report an error instead of crashing', async (t) => {
  const { socketPath } = await startDaemon(t);
  const { client, messages } = await connectClient(t, socketPath);
  client.send({ type: 'subscribe' });
  client.send({ type: 'wake' });
  const error = await waitFor(() => messageOfType(messages, 'error')[0], { label: 'no-mic error' });
  assert.match(error.message, /麦克风|文字/);

  client.send({ type: 'ping' });
  const pong = await waitFor(() => messageOfType(messages, 'pong')[0], { label: 'pong after wake' });
  assert.equal(pong.state, 'idle');

  // listen_begin / listen_end must not throw either.
  client.send({ type: 'listen_begin' });
  client.send({ type: 'listen_end' });
  await waitFor(() => messageOfType(messages, 'error').length >= 2, { label: 'listen errors' });
  client.send({ type: 'ping' });
  await waitFor(() => messageOfType(messages, 'pong').length >= 2, { label: 'second pong' });
});

test('daemon with a real agent (fake model + real tools) answers end to end', async (t) => {
  const fetchImpl = fakeFetchSequence([
    // The model asks for bash, then answers.
    'data: ' +
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_e2e',
                  type: 'function',
                  function: { name: 'bash', arguments: JSON.stringify({ command: 'echo e2e-ok', description: 'e2e marker' }) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }) +
      '\n\ndata: [DONE]\n\n',
    textResponse('工具跑通了。'),
  ]);
  const { socketPath } = await startDaemon(t, {
    agentFactory: (callbacks) =>
      createAgent({ config: makeTestConfig(), fetchImpl, ...callbacks, workdir: os.tmpdir() }),
  });
  const { client, messages } = await connectClient(t, socketPath);
  client.send({ type: 'subscribe' });
  client.send({ type: 'ask', text: '跑个命令', requestId: 'e2e' });
  const reply = await waitFor(
    () => messageOfType(messages, 'reply').find((message) => message.requestId === 'e2e'),
    { label: 'e2e reply' },
  );
  assert.equal(reply.text, '工具跑通了。');
  assert.equal(reply.toolRounds, 1);
  const toolMessages = messageOfType(messages, 'tool');
  assert.deepEqual(toolMessages.map((message) => `${message.name}:${message.status}`), ['bash:start', 'bash:end']);
});

test('daemon start fails cleanly when another daemon already owns the socket', async (t) => {
  const first = await startDaemon(t);
  const dir = path.dirname(first.socketPath);
  const second = createDaemon({
    config: makeTestConfig({ socket: first.socketPath }),
    voice: false,
    logger: silentLogger,
  });
  await assert.rejects(() => second.start(), /another figaro daemon is already listening/);
  // The first daemon is unaffected.
  const { client, messages } = await connectClient(t, first.socketPath);
  client.send({ type: 'ping' });
  await waitFor(() => messageOfType(messages, 'pong')[0], { label: 'pong from first daemon' });
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

test('a late subscriber sees state, partial text and the running tool (overlay reconnect)', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { socketPath } = await startDaemon(t, {
    agentFactory: (callbacks) => ({
      history: [],
      reset() {},
      async run() {
        callbacks.onToolEvent({ name: 'bash', status: 'start', summary: 'Show clock' });
        callbacks.onTextDelta('我查一下。');
        await gate;
        callbacks.onToolEvent({ name: 'bash', status: 'end', summary: 'Show clock', ok: true });
        return { text: '我查一下。现在是十一点。' };
      },
    }),
  });

  // First client starts the turn.
  const first = await connectClient(t, socketPath);
  first.client.send({ type: 'subscribe' });
  first.client.send({ type: 'ask', text: '现在几点', requestId: 'late-1' });
  await waitFor(
    () => first.messages.some((message) => message.type === 'partial'),
    { label: 'first client partial' },
  );

  // The overlay connects in the middle of the turn and sends subscribe.
  const late = await connectClient(t, socketPath);
  late.client.send({ type: 'subscribe' });
  await waitFor(
    () => late.messages.some((message) => message.type === 'state' && message.state === 'thinking'),
    { label: 'late subscriber state' },
  );
  const replayPartial = await waitFor(
    () => late.messages.find((message) => message.type === 'partial'),
    { label: 'late subscriber partial replay' },
  );
  assert.match(replayPartial.text, /我查一下/);
  const replayTool = await waitFor(
    () => late.messages.find((message) => message.type === 'tool' && message.status === 'start'),
    { label: 'late subscriber tool replay' },
  );
  assert.equal(replayTool.name, 'bash');

  release();
  const reply = await waitFor(
    () => late.messages.find((message) => message.type === 'reply' && message.requestId === 'late-1'),
    { label: 'late subscriber reply' },
  );
  assert.equal(reply.text, '我查一下。现在是十一点。');
});
