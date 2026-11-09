// Wake acknowledgement tests: pre-synthesis cache, playback handle lifecycle,
// degradation when the TTS module lacks the PCM APIs or synthesis fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakeAck, DEFAULT_PHRASES } from '../../src/agent/wake-ack.js';

const silentLogger = { info() {}, warn() {}, error() {} };

function makeTts({
  synthesizeImpl,
  playPcmImpl,
  stats = { model: 'speech-2.6-turbo', voiceId: 'male-qn-jingying', sampleRate: 32000 },
} = {}) {
  const calls = { synthesize: [], playPcm: [], stop: 0 };
  const tts = {
    stats,
    async synthesize(text) {
      calls.synthesize.push(text);
      if (synthesizeImpl) return synthesizeImpl(text);
      return { pcm: Buffer.alloc(640, 7), sampleRate: 32000, durationMs: 20, sentences: 1, ms: 8, ttfbMs: 5 };
    },
    playPcm(pcm, opts) {
      calls.playPcm.push({ bytes: pcm.length, opts });
      if (playPcmImpl) return playPcmImpl(pcm, opts);
      return Promise.resolve({ bytes: pcm.length, durationMs: 20, completed: true });
    },
    stop() {
      calls.stop += 1;
    },
  };
  return { tts, calls };
}

function makeConfig(overrides = {}) {
  return {
    minimax: { apiKey: 'test', model: 'speech-2.6-turbo', voiceId: 'male-qn-jingying', sampleRate: 32000 },
    tts: { enabled: true, ack: { enabled: true, phrases: ['我在', '在的'], timeoutMs: 800 }, ...overrides.tts },
    ...overrides,
  };
}

test('prepare() pre-synthesizes the configured phrases and reports voice identity', async () => {
  const { tts, calls } = makeTts();
  const ack = createWakeAck({ config: makeConfig(), logger: silentLogger, getTts: () => tts });
  assert.equal(ack.enabled, true);
  assert.equal(await ack.prepare(), true);
  assert.deepEqual(calls.synthesize, ['我在', '在的']);
  assert.equal(ack.ready, true);
  const stats = ack.stats;
  assert.equal(stats.phrases, 2);
  assert.equal(stats.model, 'speech-2.6-turbo');
  assert.equal(stats.voiceId, 'male-qn-jingying');
  assert.deepEqual(stats.cachedPhrases, ['我在', '在的']);
  assert.ok(stats.synthMs >= 0);
});

test('play() uses the TTS module player and resolves when playback ends', async () => {
  let finishPlayback;
  const { tts, calls } = makeTts({
    playPcmImpl: () =>
      new Promise((resolve) => {
        finishPlayback = () => resolve({ bytes: 640, durationMs: 20, completed: true });
      }),
  });
  const ack = createWakeAck({ config: makeConfig(), logger: silentLogger, getTts: () => tts, random: () => 0 });
  await ack.prepare();
  const playback = ack.play();
  assert.ok(playback);
  assert.equal(playback.phrase, '我在');
  assert.equal(calls.playPcm.length, 1);
  assert.equal(calls.playPcm[0].opts.rate, 32000);
  const firstWriteMs = await playback.started;
  assert.ok(Number.isFinite(firstWriteMs) && firstWriteMs >= 0);
  finishPlayback();
  const done = await playback.done;
  assert.equal(done.ok, true);
  assert.equal(done.phrase, '我在');
  assert.equal(ack.stats.plays, 1);
});

test('play() picks randomly across the cached phrases', async () => {
  const { tts } = makeTts();
  const picks = [];
  for (const r of [0, 0.49, 0.99]) {
    const ack = createWakeAck({ config: makeConfig(), logger: silentLogger, getTts: () => tts, random: () => r });
    await ack.prepare();
    picks.push(ack.play().phrase);
    ack.close();
  }
  assert.deepEqual(picks, ['我在', '我在', '在的']);
});

test('stop() interrupts playback and calls the TTS stop()', async () => {
  const { tts, calls } = makeTts({ playPcmImpl: () => new Promise(() => {}) });
  const ack = createWakeAck({ config: makeConfig(), logger: silentLogger, getTts: () => tts });
  await ack.prepare();
  const playback = ack.play();
  const donePromise = playback.done;
  playback.stop();
  const done = await donePromise;
  assert.equal(done.ok, false);
  assert.equal(done.stopped, true);
  assert.ok(calls.stop >= 1, 'TTS stop() was called');
});

test('missing TTS module or missing PCM APIs disables the ack without throwing', async () => {
  const noTts = createWakeAck({ config: makeConfig(), logger: silentLogger, getTts: () => null });
  assert.equal(await noTts.prepare(), false);
  assert.equal(noTts.ready, false);
  assert.match(noTts.stats.disabledReason, /tts module not loaded/);
  assert.equal(noTts.play(), null);

  const oldTts = createWakeAck({
    config: makeConfig(),
    logger: silentLogger,
    getTts: () => ({ speak: async () => {}, flush: async () => {}, stop() {} }),
  });
  assert.equal(await oldTts.prepare(), false);
  assert.match(oldTts.stats.disabledReason, /no synthesize\(\)\/playPcm\(\)/);
});

test('tts.ack.enabled=false disables the ack entirely', async () => {
  const { tts } = makeTts();
  const ack = createWakeAck({
    config: makeConfig({ tts: { enabled: true, ack: { enabled: false, phrases: ['我在'] } } }),
    logger: silentLogger,
    getTts: () => tts,
  });
  assert.equal(ack.enabled, false);
  assert.equal(await ack.prepare(), false);
  assert.equal(ack.play(), null);
});

test('synthesis failures degrade silently but partial caches still work', async () => {
  const { tts } = makeTts({
    synthesizeImpl: async (text) => {
      if (text === '在的') throw new Error('network down');
      return { pcm: Buffer.alloc(640, 1), sampleRate: 32000, durationMs: 20 };
    },
  });
  const ack = createWakeAck({ config: makeConfig(), logger: silentLogger, getTts: () => tts });
  assert.equal(await ack.prepare(), true);
  assert.deepEqual(ack.stats.cachedPhrases, ['我在']);
  assert.ok(ack.stats.errors.some((message) => /network down/.test(message)));

  const allBad = makeTts({ synthesizeImpl: async () => { throw new Error('boom'); } });
  const badAck = createWakeAck({ config: makeConfig(), logger: silentLogger, getTts: () => allBad.tts });
  assert.equal(await badAck.prepare(), false);
  assert.equal(badAck.ready, false);
  assert.match(badAck.stats.disabledReason, /synthesis failed/);
});

test('too-short synthesis output is rejected', async () => {
  const { tts } = makeTts({
    synthesizeImpl: async () => ({ pcm: Buffer.alloc(10), sampleRate: 32000, durationMs: 1 }),
  });
  const ack = createWakeAck({ config: makeConfig(), logger: silentLogger, getTts: () => tts });
  assert.equal(await ack.prepare(), false);
  assert.match(ack.stats.errors[0], /no usable PCM/);
});

test('playPcm throwing synchronously is reported, not thrown', async () => {
  const { tts } = makeTts({
    playPcmImpl: () => {
      throw new Error('player missing');
    },
  });
  const ack = createWakeAck({ config: makeConfig(), logger: silentLogger, getTts: () => tts });
  await ack.prepare();
  const playback = ack.play();
  assert.ok(playback);
  const done = await playback.done;
  assert.equal(done.ok, false);
  assert.match(done.error, /player missing/);
});

test('default phrases are the user-facing three when config omits them', () => {
  assert.deepEqual(DEFAULT_PHRASES, ['我在', '在的', '请指示']);
  const { tts } = makeTts();
  const ack = createWakeAck({
    config: { minimax: {}, tts: { enabled: true } },
    logger: silentLogger,
    getTts: () => tts,
  });
  assert.deepEqual(ack.phrases, DEFAULT_PHRASES);
  assert.equal(ack.timeoutMs, 800);
});
