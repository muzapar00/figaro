// docs/voice-interaction.md acceptance tests: the Siri-style wake/cancel/
// barge-in/give-up state machine. One test per checklist item (numbers in the
// test names), all with fake ASR/TTS so they are deterministic and headless.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDaemon, STATES } from '../../src/daemon.js';
import { createIpcClient } from '../../src/ipc.js';
import { makeTestConfig, silentLogger, waitFor } from './fake-llm.js';

const SOCKET_DIR = () => fs.mkdtemp(path.join(os.tmpdir(), 'figaro-interaction-test-'));

function makeFakeAsr() {
  const record = {
    cbs: null,
    begin: 0,
    end: 0,
    capturing: false,
    muted: false,
    muteCalls: [],
  };
  const factory = (callbacks) => {
    record.cbs = callbacks;
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
      setMuted(value) {
        record.muted = Boolean(value);
        record.muteCalls.push(Boolean(value));
      },
      get muted() {
        return record.muted;
      },
    };
  };
  return { factory, record };
}

function makeFakeTts({ blockFlush = false } = {}) {
  const record = { speak: [], stops: 0, flushes: 0, callbacks: null, resolveFlush: null };
  const factory = (callbacks) => {
    record.callbacks = callbacks;
    return {
      async speak(text) {
        record.speak.push(text);
      },
      flush() {
        record.flushes += 1;
        if (!blockFlush) return Promise.resolve();
        return new Promise((resolve) => {
          record.resolveFlush = resolve;
        });
      },
      stop() {
        record.stops += 1;
        record.resolveFlush?.();
        record.resolveFlush = null;
        callbacks.onState?.('idle');
      },
      get speaking() {
        return false;
      },
      stats: {
        model: 'speech-2.6-turbo',
        voiceId: 'male-qn-jingying',
        audioSink: 'sink-a',
        audioSinkName: 'sink-a',
        sinkStatus: 'configured',
        connected: false,
        lastFirstAudioMs: 1,
        lastSpeakingMs: 1,
      },
      async synthesize() {
        return { pcm: Buffer.alloc(640, 1), sampleRate: 32000, durationMs: 20, sentences: 1, ms: 5, ttfbMs: 3 };
      },
      playPcm() {
        return Promise.resolve({ bytes: 640, durationMs: 20, completed: true });
      },
    };
  };
  return { factory, record };
}

function makeFakeAck() {
  const record = { plays: 0, stops: 0 };
  const playbacks = [];
  const factory = () => ({
    enabled: true,
    timeoutMs: 800,
    phrases: ['我在'],
    get ready() {
      return true;
    },
    async prepare() {
      return true;
    },
    play() {
      record.plays += 1;
      let resolveStarted;
      let resolveDone;
      const started = new Promise((resolve) => {
        resolveStarted = resolve;
      });
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      const playback = {
        phrase: '我在',
        started,
        done,
        finish: () => resolveDone({ phrase: '我在', ok: true, durationMs: 400 }),
        settleStart: () => resolveStarted(1),
        stop: () => {
          record.stops += 1;
          resolveDone({ phrase: '我在', ok: false, stopped: true });
        },
      };
      playbacks.push(playback);
      return playback;
    },
    stop() {},
    close() {},
    stats: { model: 'speech-2.6-turbo', voiceId: 'male-qn-jingying', disabledReason: null, lastPhrase: null, lastPlayDurationMs: null, failures: 0 },
  });
  return { factory, record, playbacks };
}

/**
 * Fake agent: replies with `回声：<text>`; text starting with "慢" never resolves
 * until aborted (so wake/cancel can be tested while thinking), text "炸" throws.
 */
function makeFakeAgent() {
  const record = { texts: [], aborts: 0, runs: 0 };
  const factory = () => ({
    history: [],
    reset() {},
    run({ text, signal }) {
      record.runs += 1;
      record.texts.push(text);
      if (text.startsWith('炸')) throw new Error('agent boom');
      if (text.startsWith('慢')) {
        return new Promise((resolve) => {
          const abort = () => {
            record.aborts += 1;
            resolve({ text: '', aborted: true });
          };
          if (signal?.aborted) return abort();
          signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return Promise.resolve({ text: `回声：${text}` });
    },
  });
  return { factory, record };
}

async function startInteractionDaemon(t, overrides = {}) {
  const dir = await SOCKET_DIR();
  const socketPath = path.join(dir, 'sock');
  const config = {
    ...makeTestConfig({ socket: socketPath }),
    asr: { enabled: true, wakeGiveUpMs: overrides.wakeGiveUpMs ?? 5000 },
    tts: { enabled: true, ack: { enabled: true, phrases: ['我在'], timeoutMs: 800 } },
    interaction: {
      cancelPhrases: ['取消', '算了', '别说了', '停下', '停止', '不用了', '退出'],
      followUpWindowMs: overrides.followUpWindowMs ?? 0,
      followUpMinRms: overrides.followUpMinRms ?? 0.012,
      followUpMinMs: overrides.followUpMinMs ?? 180,
    },
  };
  const asr = overrides.asr ?? makeFakeAsr();
  const tts = overrides.tts ?? makeFakeTts();
  const ack = overrides.ack ?? makeFakeAck();
  void ack;
  const agent = overrides.agent ?? makeFakeAgent();
  const daemon = createDaemon({
    config,
    voice: true,
    logger: silentLogger,
    agentFactory: agent.factory,
    asrFactory: asr.factory,
    ttsFactory: tts.factory,
    ackFactory: ack.factory,
    listSinks: async () => [{ name: 'sink-a', description: 'A', isDefault: true }],
  });
  await daemon.start();
  const messages = [];
  const client = createIpcClient({ socketPath, onMessage: (message) => messages.push(message) });
  await client.connect();
  t.after(async () => {
    client.close();
    await daemon.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });
  client.send({ type: 'subscribe' });
  await waitFor(() => messages.some((message) => message.type === 'state'), { label: 'initial state' });
  await waitFor(() => daemon.voice.asr && daemon.voice.tts, { label: 'voice modules' });
  return { daemon, client, messages, asr, tts, ack, agent };
}

const statesOf = (messages) => messages.filter((message) => message.type === 'state').map((message) => message.state);

/** Deliver a final transcript the way the real ASR does: capture already ended. */
function deliverFinal(asr, text, meta) {
  asr.record.capturing = false;
  asr.record.cbs.onFinal(text, meta);
}
const repliesOf = (messages) => messages.filter((message) => message.type === 'reply');
const errorsOf = (messages) => messages.filter((message) => message.type === 'error');
const lastState = (messages) => statesOf(messages).at(-1);

// ---------------------------------------------------------------- checklist 1

test('checklist 1: voice/UI wake abort the running turn and go through waking; text ask skips waking', async (t) => {
  const { client, messages, asr, ack, agent } = await startInteractionDaemon(t);

  // A slow turn is running (thinking).
  client.send({ type: 'ask', text: '慢一点', requestId: 'slow-1' });
  await waitFor(() => lastState(messages) === 'thinking', { label: 'thinking' });

  // Voice/hotkey wake arrives as onWake: abort the LLM request, play ack.
  asr.record.cbs.onWake();
  await waitFor(() => statesOf(messages).includes('waking'), { label: 'waking after voice wake' });
  await waitFor(() => agent.record.aborts >= 1, { label: 'running turn aborted' });
  let playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening after ack' });
  assert.ok(asr.record.begin >= 1, 'capture started');

  // UI wake path behaves the same.
  client.send({ type: 'cancel' });
  await waitFor(() => lastState(messages) === 'idle', { label: 'idle' });
  client.send({ type: 'wake' });
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking via UI wake' });
  playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening via UI wake' });

  // Text ask skips waking entirely and answers directly.
  const from = messages.length;
  client.send({ type: 'ask', text: '你好', requestId: 'text-1' });
  await waitFor(
    () => messages.slice(from).some((message) => message.type === 'reply' && message.requestId === 'text-1'),
    { label: 'text reply' },
  );
  assert.ok(!statesOf(messages).slice(from).includes('waking'), 'text ask never enters waking');
});

// ---------------------------------------------------------------- checklist 2

test('checklist 2: speaking during the ack stops it immediately and starts listening', async (t) => {
  const { client, messages, asr, ack } = await startInteractionDaemon(t);
  client.send({ type: 'wake' });
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking' });
  assert.equal(ack.record.plays, 1);
  const stopsBefore = ack.record.stops;
  asr.record.cbs.onUserSpeech();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening after ack interrupted' });
  assert.ok(ack.record.stops > stopsBefore, 'ack playback was stopped');
  assert.ok(asr.record.begin >= 1, 'capture started');
});

// ---------------------------------------------------------------- checklist 3

test('checklist 3: no speech within wakeGiveUpMs -> silent idle (no ack again, no error, no LLM)', async (t) => {
  const { client, messages, asr, ack, agent } = await startInteractionDaemon(t, { wakeGiveUpMs: 250 });
  client.send({ type: 'wake' });
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking' });
  const playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening' });
  // A premature empty final (ASR's own 1.5s no-speech window) keeps listening.
  deliverFinal(asr, '');
  await waitFor(() => asr.record.begin >= 2, { label: 'capture re-armed silently' });
  await waitFor(() => lastState(messages) === 'idle', { label: 'idle after give-up', timeoutMs: 3000 });
  assert.equal(repliesOf(messages).length, 0, 'no reply on give-up');
  assert.equal(errorsOf(messages).length, 0, 'no error on give-up');
  assert.deepEqual(agent.record.texts, [], 'LLM never called on give-up');
  assert.equal(ack.record.plays, 1, 'ack is not replayed');
});

// ---------------------------------------------------------------- checklist 4

test('checklist 4a: cancel phrases never reach the LLM', async (t) => {
  const { client, messages, asr, ack, agent } = await startInteractionDaemon(t);
  for (const phrase of ['取消', '算了', '别说了', '停下']) {
    client.send({ type: 'wake' });
    await waitFor(() => lastState(messages) === 'waking', { label: `waking (${phrase})` });
    const playback = ack.playbacks.at(-1);
    playback.settleStart();
    playback.finish();
    await waitFor(() => lastState(messages) === 'listening', { label: `listening (${phrase})` });
    deliverFinal(asr, phrase);
    await waitFor(() => lastState(messages) === 'idle', { label: `idle after "${phrase}"` });
  }
  assert.deepEqual(agent.record.texts, [], 'cancel phrases never reach the LLM');
  assert.equal(repliesOf(messages).length, 0);
});

test('checklist 4b: cancel while thinking aborts the LLM and emits no reply', async (t) => {
  const { client, messages, agent } = await startInteractionDaemon(t);
  client.send({ type: 'ask', text: '慢一点', requestId: 'slow-cancel' });
  await waitFor(() => lastState(messages) === 'thinking', { label: 'thinking' });
  client.send({ type: 'cancel' });
  await waitFor(() => agent.record.aborts >= 1, { label: 'LLM aborted' });
  await waitFor(() => lastState(messages) === 'idle', { label: 'idle after cancel' });
  assert.equal(
    repliesOf(messages).filter((reply) => reply.requestId === 'slow-cancel').length,
    0,
    'cancelled turn must not emit reply',
  );
});

test('checklist 4c: cancel phrase during speaking stops the audio', async (t) => {
  const { client, messages, asr, ack, tts } = await startInteractionDaemon(t, { tts: makeFakeTts({ blockFlush: true }) });
  // A spoken reply keeps the TTS "speaking" until stop() resolves flush.
  client.send({ type: 'ask', text: '你好', speak: true, requestId: 'speak-turn' });
  await waitFor(() => lastState(messages) === 'speaking', { label: 'speaking reply' });
  // User barges in, then says "取消".
  asr.record.cbs.onUserSpeech();
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking after barge-in' });
  const playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening after ack' });
  deliverFinal(asr, '取消');
  await waitFor(() => lastState(messages) === 'idle', { label: 'idle after cancel phrase' });
  assert.ok(tts.record.stops >= 1, 'TTS was stopped');
});

// ---------------------------------------------------------------- checklist 5

test('checklist 5: hotkey short tap cancels, long press wakes', async (t) => {
  const { client, messages, asr, ack } = await startInteractionDaemon(t);
  // Tap while idle: nothing to cancel, stays idle.
  asr.record.cbs.onTap({ heldMs: 120 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(lastState(messages), 'idle');

  // Long press = wake (ASR reports it through onWake).
  asr.record.cbs.onWake();
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking via long press' });
  const playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening' });

  // Short tap while listening = cancel.
  asr.record.cbs.onTap({ heldMs: 90 });
  await waitFor(() => lastState(messages) === 'idle', { label: 'idle after tap cancel' });
  assert.equal(ack.record.plays, 1, 'tap does not play the ack');
});

// ---------------------------------------------------------------- checklist 6

test('checklist 6: barge-in while speaking stops TTS, then wakes with the ack and listens', async (t) => {
  const { client, messages, asr, ack, tts } = await startInteractionDaemon(t, { tts: makeFakeTts({ blockFlush: true }) });
  client.send({ type: 'ask', text: '讲个故事', speak: true, requestId: 'story' });
  await waitFor(() => lastState(messages) === 'speaking', { label: 'speaking' });
  const stopsBefore = tts.record.stops;
  asr.record.cbs.onUserSpeech();
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking (ack after barge-in)' });
  assert.ok(tts.record.stops > stopsBefore, 'TTS stopped by barge-in');
  assert.equal(ack.record.plays, 1, 'ack plays on barge-in');
  const playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening after barge-in ack' });
  await waitFor(() => messages.some((message) => message.type === 'reply' && message.requestId === 'story'), {
    label: 'original reply still delivered before barge-in',
  });
  assert.ok(asr.record.begin >= 1);
});

// ---------------------------------------------------------------- checklist 7

test('checklist 7: every cancel/error path ends idle, mic unmuted, wake word works again', async (t) => {
  const { client, messages, asr, ack } = await startInteractionDaemon(t);

  // Cancel from listening.
  client.send({ type: 'wake' });
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking' });
  let playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening' });
  client.send({ type: 'cancel' });
  await waitFor(() => lastState(messages) === 'idle', { label: 'idle after cancel' });
  assert.equal(asr.record.muted, false, 'mic unmuted after cancel');

  // Error path: the agent throws -> idle, no reply.
  const errorFrom = messages.length;
  client.send({ type: 'ask', text: '炸了', requestId: 'boom' });
  await waitFor(
    () => messages.slice(errorFrom).some((message) => message.type === 'error' && /处理失败/.test(message.message)),
    { label: 'error reported' },
  );
  await waitFor(() => lastState(messages) === 'idle', { label: 'idle after agent error' });
  assert.equal(repliesOf(messages).filter((reply) => reply.requestId === 'boom').length, 0);
  assert.equal(asr.record.muted, false);

  // The wake word still works afterwards.
  asr.record.cbs.onWake();
  await waitFor(() => lastState(messages) === 'waking', { label: 'wake still works after errors' });
  playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening again' });
});

// ---------------------------------------------------------------- checklist 8

test('checklist 8: after a reply the assistant waits, ignores a quiet room, and only continues on a loud voice', async (t) => {
  const { client, messages, asr, ack, agent } = await startInteractionDaemon(t, {
    followUpWindowMs: 700,
    followUpMinRms: 0.012,
    followUpMinMs: 120,
  });
  client.send({ type: 'wake' });
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking' });
  const playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening' });

  const firstFrom = messages.length;
  deliverFinal(asr, '第一句');
  await waitFor(() => messages.slice(firstFrom).some((message) => message.type === 'reply'), { label: 'first reply' });
  await waitFor(() => agent.record.texts.length === 1, { label: 'first turn' });

  // The reply is over: the assistant stays on screen in a dedicated waiting
  // state, with the caption retracted, and replays no acknowledgement.
  await waitFor(() => lastState(messages) === 'waiting', { label: 'waiting after reply' });
  assert.equal(ack.record.plays, 1, 'the follow-up window does not replay the ack');
  const cleared = messages.slice(firstFrom).some((message) => message.type === 'partial' && message.text === '');
  assert.ok(cleared, 'the caption is cleared so the pill retracts into a ball');

  // A quiet room must not open the conversation again.
  for (let i = 0; i < 12; i++) {
    asr.record.cbs.onLevel(0.004);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(lastState(messages), 'waiting', 'quiet background noise is ignored');

  // A loud voice does, without a wake word. Levels arrive at ~20 Hz in
  // production, so the test paces them the same way: the gate measures how long
  // the voice stays loud, not how many samples arrived.
  for (let i = 0; i < 10; i++) {
    asr.record.cbs.onLevel(0.25);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await waitFor(() => lastState(messages) === 'listening', { label: 'loud voice continues the conversation' });
  deliverFinal(asr, '第二句');
  await waitFor(() => agent.record.texts.length === 2, { label: 'second turn without wake word' });
  assert.deepEqual(agent.record.texts, ['第一句', '第二句']);

  // Then it waits again and finally leaves silently.
  await waitFor(() => lastState(messages) === 'waiting', { label: 'waiting again' });
  await waitFor(() => lastState(messages) === 'idle', { label: 'follow-up window expires', timeoutMs: 3000 });
});

test('a TTS that reports idle before flush resolves still opens the waiting window', async (t) => {
  // Regression: TTS onState('idle') used to force the daemon to idle while the
  // turn runner was still awaiting flush(), so the follow-up window was skipped
  // and the overlay vanished the moment the reply ended.
  const tts = makeFakeTts();
  const originalFactory = tts.factory;
  const eager = (options) => {
    const instance = originalFactory(options);
    const flush = instance.flush.bind(instance);
    instance.flush = async () => {
      options.onState?.('speaking');
      await flush();
      options.onState?.('idle'); // arrives before flush() resolves below
      return undefined;
    };
    return instance;
  };
  const { client, messages, asr, ack, agent } = await startInteractionDaemon(t, {
    followUpWindowMs: 400,
    tts: { factory: eager, record: tts.record, playbacks: tts.playbacks },
  });
  client.send({ type: 'wake' });
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking' });
  const playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening' });

  deliverFinal(asr, '说一句话');
  await waitFor(() => agent.record.texts.length === 1, { label: 'turn ran' });
  await waitFor(() => lastState(messages) === 'waiting', { label: 'waiting window after the reply' });
});

// ---------------------------------------------------------------- extras

test('waking is debounced: a second wake during the ack is ignored', async (t) => {
  const { client, messages, asr, ack } = await startInteractionDaemon(t);
  client.send({ type: 'wake' });
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking' });
  asr.record.cbs.onWake();
  client.send({ type: 'wake' });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(ack.record.plays, 1, 'only one ack playback');
  assert.equal(lastState(messages), 'waking');
});

test('asr finalizing hook moves listening -> finalizing before the transcript', async (t) => {
  const { client, messages, asr, ack } = await startInteractionDaemon(t);
  client.send({ type: 'wake' });
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking' });
  const playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening' });
  asr.record.cbs.onFinalizing?.();
  await waitFor(() => lastState(messages) === 'finalizing', { label: 'finalizing state' });
});

test('all new states are part of the exported state machine', () => {
  for (const state of ['idle', 'waking', 'listening', 'finalizing', 'thinking', 'speaking', 'waiting']) {
    assert.ok(STATES.includes(state), `${state} is in STATES`);
  }
});

// ---------------------------------------------------------------- dismissal

test('dismiss: saying 退下 during the waiting window answers once, then leaves', async (t) => {
  const { client, messages, asr, ack, agent } = await startInteractionDaemon(t, {
    followUpWindowMs: 1500,
    followUpMinRms: 0.012,
    followUpMinMs: 120,
  });
  client.send({ type: 'wake' });
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking' });
  const playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening' });
  deliverFinal(asr, '你好');
  await waitFor(() => lastState(messages) === 'waiting', { label: 'waiting' });
  const before = agent.record.texts.length;

  // The follow-up voice opens the conversation, then says 退下.
  for (let i = 0; i < 10; i++) {
    asr.record.cbs.onLevel(0.10);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await waitFor(() => lastState(messages) === 'listening', { label: 'follow-up listening' });
  deliverFinal(asr, '退下');
  await waitFor(() => agent.record.texts.length === before + 1, { label: 'farewell turn ran' });
  assert.deepEqual(agent.record.texts.at(-1), '退下', 'the dismissal is answered once');
  await waitFor(() => lastState(messages) === 'idle', { label: 'left after the farewell' });
});

test('dismiss: a spoken reply is finished before standing down', async (t) => {
  const heldTts = makeFakeTts({ blockFlush: true });
  const { client, messages, asr, ack, agent } = await startInteractionDaemon(t, {
    followUpWindowMs: 1500,
    followUpMinRms: 0.012,
    followUpMinMs: 120,
    tts: { factory: heldTts.factory, record: heldTts.record },
  });
  client.send({ type: 'wake' });
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking' });
  const playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening' });

  deliverFinal(asr, '讲个长故事');
  await waitFor(() => agent.record.texts.length === 1, { label: 'turn ran' });
  // The reply is being spoken now (flush is held open); a dismissal must not
  // cut it off.
  await waitFor(() => lastState(messages) === 'speaking', { label: 'speaking' });
  const replyCount = messages.filter((message) => message.type === 'reply').length;
  asr.record.cbs.onFinal('退下', { reason: 'speech-end' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(lastState(messages), 'speaking', 'still speaking: the dismissal waits');
  // Playback ends -> it leaves instead of opening the follow-up window.
  heldTts.record.resolveFlush?.();
  await waitFor(() => lastState(messages) === 'idle', { label: 'left after the reply finished' });
  assert.equal(messages.filter((message) => message.type === 'reply').length, replyCount, 'no extra reply');
  void agent;
});

test('dismiss tool: the goodbye is spoken before the assistant stands down', async (t) => {
  // The model calls the dismiss tool while it is still thinking; the daemon must
  // not settle right there, or the goodbye would never be heard.
  const heldTts = makeFakeTts({ blockFlush: true });
  let controlled = null;
  const agentFactory = (options) => {
    controlled = options;
    return {
      async run() {
        options.control?.dismiss();
        return { text: '好，我先退下' };
      },
      reset() {},
      history: [],
    };
  };
  const { client, messages, asr, ack } = await startInteractionDaemon(t, {
    tts: { factory: heldTts.factory, record: heldTts.record },
    agent: { factory: agentFactory, record: { texts: [] } },
  });
  client.send({ type: 'wake' });
  await waitFor(() => lastState(messages) === 'waking', { label: 'waking' });
  const playback = ack.playbacks.at(-1);
  playback.settleStart();
  playback.finish();
  await waitFor(() => lastState(messages) === 'listening', { label: 'listening' });

  deliverFinal(asr, '你可以退下了');
  // The phrase list catches this exact wording, so the turn still runs and the
  // model answers through the control hook.
  await waitFor(() => lastState(messages) === 'speaking', { label: 'goodbye is being spoken' });
  const replies = messages.filter((message) => message.type === 'reply').length;
  assert.ok(replies >= 1, 'the goodbye reply was emitted');
  assert.ok(controlled, 'the agent received the control hook');
  // Not gone yet: audio is still playing.
  assert.equal(lastState(messages), 'speaking');
  heldTts.record.resolveFlush?.();
  await waitFor(() => lastState(messages) === 'idle', { label: 'left after the goodbye' });
});
