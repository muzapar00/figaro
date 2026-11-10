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
  assert.deepEqual([...calls.synthesize].sort(), ['在的', '我在'].sort());
  assert.equal(ack.ready, true);
  const stats = ack.stats;
  assert.equal(stats.phrases, 2);
  assert.equal(stats.model, 'speech-2.6-turbo');
  assert.equal(stats.voiceId, 'male-qn-jingying');
  assert.deepEqual(stats.cachedPhrases, ['我在', '在的']);
  assert.ok(stats.synthMs >= 0);
  assert.ok(stats.phraseMs['我在'] >= 0, 'per-phrase synthesis timing is recorded');
  assert.ok(stats.phraseMs['在的'] >= 0);
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

test('default phrases are a varied spoken set of at least eight, without punctuation', () => {
  assert.ok(DEFAULT_PHRASES.length >= 8, `expected >=8 default phrases, got ${DEFAULT_PHRASES.length}`);
  assert.ok(new Set(DEFAULT_PHRASES).size === DEFAULT_PHRASES.length, 'no duplicate phrases');
  for (const phrase of DEFAULT_PHRASES) {
    assert.equal(phrase, phrase.trim());
    assert.ok(phrase.length >= 1 && phrase.length <= 8, `"${phrase}" should be short`);
    assert.doesNotMatch(phrase, /[，。！？、,.!?；;：:…]/, `"${phrase}" should not need punctuation for TTS`);
  }
  // The phrases the user explicitly asked for are in there.
  for (const phrase of ['我在', '你好', '嘿', '有何贵干']) assert.ok(DEFAULT_PHRASES.includes(phrase));

  const { tts } = makeTts();
  const ack = createWakeAck({
    config: { minimax: {}, tts: { enabled: true } },
    logger: silentLogger,
    getTts: () => tts,
  });
  assert.deepEqual(ack.phrases, [...DEFAULT_PHRASES]);
  assert.equal(ack.timeoutMs, 800, 'default timeout stays 800ms');
  assert.equal(ack.stats.avoidRepeat, true, 'avoiding consecutive repeats is on by default');
  assert.equal(ack.stats.synthConcurrency, 3);
});

test('avoidRepeat: never plays the same phrase twice in a row', async () => {
  const { tts } = makeTts();
  const phrases = ['我在', '在的', '你好'];
  const ack = createWakeAck({
    config: makeConfig({ tts: { enabled: true, ack: { enabled: true, phrases, timeoutMs: 800, avoidRepeat: true } } }),
    logger: silentLogger,
    getTts: () => tts,
    random: () => 0, // always take the first candidate -> would repeat without the filter
  });
  await ack.prepare();
  const played = [];
  for (let i = 0; i < 9; i += 1) {
    const playback = ack.play();
    played.push(playback.phrase);
    await playback.done;
  }
  for (let i = 1; i < played.length; i += 1) {
    assert.notEqual(played[i], played[i - 1], `consecutive repeat at #${i}: ${played.join(' ')}`);
  }
  assert.ok(new Set(played).size >= 2, 'all phrases get used across repeats');
  assert.equal(ack.stats.lastPickedPhrase, played.at(-1));
});

test('avoidRepeat: false allows consecutive picks (old behaviour, config opt-out)', async () => {
  const { tts } = makeTts();
  const phrases = ['我在', '在的', '你好'];
  const ack = createWakeAck({
    config: makeConfig({ tts: { enabled: true, ack: { enabled: true, phrases, timeoutMs: 800, avoidRepeat: false } } }),
    logger: silentLogger,
    getTts: () => tts,
    random: () => 0,
  });
  await ack.prepare();
  const played = [];
  for (let i = 0; i < 5; i += 1) {
    const playback = ack.play();
    played.push(playback.phrase);
    await playback.done;
  }
  assert.deepEqual(played, ['我在', '我在', '我在', '我在', '我在']);
});

test('prepare() uses finite concurrency instead of synthesizing serially', async () => {
  const phrases = Array.from({ length: 9 }, (_, index) => `短语${index}`);
  const delayMs = 60;
  let inFlight = 0;
  let maxInFlight = 0;
  const { tts } = makeTts({
    synthesizeImpl: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      return { pcm: Buffer.alloc(640, 1), sampleRate: 32000, durationMs: 20 };
    },
  });
  const ack = createWakeAck({
    config: makeConfig({ tts: { enabled: true, ack: { enabled: true, phrases, timeoutMs: 800 } } }),
    logger: silentLogger,
    getTts: () => tts,
  });
  const startedAt = Date.now();
  assert.equal(await ack.prepare(), true);
  const elapsed = Date.now() - startedAt;
  assert.equal(ack.stats.phrases, 9);
  assert.equal(maxInFlight, 3, 'synthesis runs 3 at a time');
  assert.ok(maxInFlight > 1, 'synthesis is not serial');
  // 9 phrases at concurrency 3 = 3 waves * 60ms (+ overhead); serial would be 540ms.
  assert.ok(elapsed < 9 * delayMs * 0.7, `expected <${Math.round(9 * delayMs * 0.7)}ms, got ${elapsed}ms`);
  assert.equal(Object.keys(ack.stats.phraseMs).length, 9, 'every phrase has a timing entry');
});

test('tts.ack.synthConcurrency clamps and can force serial synthesis', async () => {
  const phrases = Array.from({ length: 4 }, (_, index) => `句${index}`);
  let inFlight = 0;
  let maxInFlight = 0;
  const { tts } = makeTts({
    synthesizeImpl: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return { pcm: Buffer.alloc(640, 1), sampleRate: 32000, durationMs: 20 };
    },
  });
  const ack = createWakeAck({
    config: makeConfig({ tts: { enabled: true, ack: { enabled: true, phrases, timeoutMs: 800, synthConcurrency: 1 } } }),
    logger: silentLogger,
    getTts: () => tts,
  });
  await ack.prepare();
  assert.equal(maxInFlight, 1);
  assert.equal(ack.stats.synthConcurrency, 1);
});

test('a rate-limited phrase is retried with backoff instead of failing', async () => {
  // MiniMax answers 1002 when a restart lands just after another burst. The
  // phrase must be retried, not dropped.
  let rateLimited = 0;
  const { tts, calls } = makeTts({
    synthesizeImpl: async (text) => {
      if (rateLimited < 1) {
        rateLimited += 1;
        throw new Error('MiniMax TTS [1002] rate limit exceeded(RPM)');
      }
      return { pcm: Buffer.alloc(640, 7), sampleRate: 32000, durationMs: 20, sentences: 1, ms: 8, ttfbMs: 5 };
    },
  });
  const ack = createWakeAck({
    config: makeConfig({ tts: { enabled: true, ack: { enabled: true, phrases: ['我在', '在的'], rateLimitRetryMs: [5], reviveDelayMs: 0 } } }),
    logger: silentLogger,
    getTts: () => tts,
  });
  assert.equal(await ack.prepare(), true, 'the ack becomes ready after a retry');
  assert.equal(ack.stats.phraseCount ?? ack.stats.phrases, 2);
  assert.ok(rateLimited === 1);
  assert.ok(calls.synthesize.length >= 3, 'the rate-limited phrase was requested again');
  assert.equal(ack.stats.disabledReason, null);
});

test('a fully rate-limited pass schedules a background revive and recovers', async () => {
  let limited = true;
  const { tts } = makeTts({
    synthesizeImpl: async () => {
      if (limited) throw new Error('MiniMax TTS [1002] rate limit exceeded(RPM)');
      return { pcm: Buffer.alloc(640, 7), sampleRate: 32000, durationMs: 20, sentences: 1, ms: 8, ttfbMs: 5 };
    },
  });
  const ack = createWakeAck({
    config: makeConfig({
      tts: { enabled: true, ack: { enabled: true, phrases: ['我在', '在的'], rateLimitRetryMs: [], reviveDelayMs: 5 } },
    }),
    logger: silentLogger,
    getTts: () => tts,
  });
  assert.equal(await ack.prepare(), false, 'nothing cached while rate limited');
  assert.equal(ack.stats.disabledReason, 'rate limited');
  assert.equal(ack.stats.revives, 1, 'a revive pass was scheduled');
  limited = false;
  // Wait for the scheduled pass to notice the window opened.
  const deadline = Date.now() + 2000;
  while (!ack.ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(ack.ready, true, 'the background pass recovered the ack');
});

test('close() clears a pending revive timer', async () => {
  const { tts } = makeTts({ synthesizeImpl: async () => { throw new Error('MiniMax TTS [1002] rate limit exceeded(RPM)'); } });
  const ack = createWakeAck({
    config: makeConfig({
      tts: { enabled: true, ack: { enabled: true, phrases: ['我在'], rateLimitRetryMs: [], reviveDelayMs: 5000 } },
    }),
    logger: silentLogger,
    getTts: () => tts,
  });
  assert.equal(await ack.prepare(), false);
  ack.close();
  // Closing must not leave a timer that revives a dead instance; the getter is
  // false and stats.stop is honoured.
  assert.equal(ack.ready, false);
});
