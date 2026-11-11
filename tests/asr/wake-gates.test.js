// Regression tests for the wake gates:
//   1. verifyWake (two-stage ASR confirm) must not bypass the voiceprint gate.
//   2. TTS/ack echo must not leak into the pre-roll the voiceprint gate sees.
//   3. A hot sensitivity switch must keep the bilingual English wake words.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAsr } from '../../src/voice/asr/index.js';
import { makeConfig, modelsAvailable, loadFixture, skipMessage, recorder, silence, concat, waitUntil } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeGate(verdict = { ok: true, score: 0.9 }) {
  const calls = [];
  return {
    calls,
    enabled: true,
    threshold: 0.65,
    prepare() { return { state: 'ready' }; },
    status() { return { enabled: true, state: 'ready', threshold: 0.65, enrolled: true }; },
    verify(pcm) {
      calls.push(pcm);
      return typeof verdict === 'function' ? verdict(pcm) : verdict;
    },
  };
}

function pacedSource(pcm, delay = 100) {
  return ({ onPcm }) => {
    let cancelled = false;
    let timer = null;
    let off = 0;
    return {
      async start() {
        const pump = () => {
          if (cancelled || off >= pcm.length) return;
          const end = Math.min(off + 1600, pcm.length);
          onPcm(pcm.subarray(off, end));
          off = end;
          if (off < pcm.length) timer = setTimeout(pump, delay);
        };
        pump();
      },
      async stop() { cancelled = true; clearTimeout(timer); },
    };
  };
}

function manualSource() {
  let push = null;
  const factory = ({ onPcm }) => {
    push = (samples) => onPcm(samples);
    return { async start() {}, async stop() {} };
  };
  return { factory, push: (samples) => push?.(samples) };
}

function startModule({ source, asrOverrides = {}, gate = null } = {}) {
  const events = recorder();
  const config = makeConfig({
    asr: {
      hotkey: '',
      wakeCaptureFallbackMs: 60000,
      wakeCooldownMs: 0,
      verifyWake: { enabled: false, timeoutMs: 1800 },
      ...asrOverrides,
    },
  });
  const asr = createAsr({
    config,
    hotkey: false,
    micGain: false,
    source,
    ...(gate ? { speakerGate: gate } : {}),
    onWake: () => events.push({ type: 'wake' }),
    onLevel: () => {},
    onPartial: () => {},
    onFinal: (text) => events.push({ type: 'final', text }),
    onError: (err) => events.push({ type: 'error', message: err.message }),
    onLog: () => {},
  });
  return { asr, events };
}

test('a hot sensitivity switch keeps the bilingual English wake words', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const source = manualSource();
  const { asr } = startModule({ source: source.factory });
  await asr.start();
  try {
    const before = asr.modelInfo;
    assert.ok(before.englishKeywords.length > 0, 'startup must load the English wake words');
    asr.applyRuntimeConfig({ sensitivity: 'medium' });
    const after = asr.modelInfo;
    assert.deepEqual(after.englishKeywords, before.englishKeywords, 'English keywords survived the rebuild');
    assert.equal(after.keywords.length, before.keywords.length, 'Chinese + English keyword count is unchanged');
  } finally {
    await asr.stop();
  }
});

test('verifyWake no longer bypasses the voiceprint gate (reject means no wake)', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const clip = loadFixture('wake-nijialuo-male');
  const pcm = concat([silence(300), clip.samples, silence(3500)]);
  const gate = fakeGate({ ok: false, score: 0.2, reason: 'mismatch' });
  const { asr, events } = startModule({
    source: pacedSource(pcm),
    asrOverrides: { verifyWake: { enabled: true, timeoutMs: 1800 } },
    gate,
  });
  await asr.start();
  try {
    await sleep(4000);
    assert.deepEqual(events.ofType('wake'), [], 'gate rejection must suppress the wake');
    assert.ok(gate.calls.length >= 1, 'the gate was consulted after verification passed');
    assert.ok(asr.modelInfo.verifyStats.rejected >= 1, JSON.stringify(asr.modelInfo.verifyStats));
  } finally {
    await asr.stop();
  }
});

test('verifyWake + accepting gate still wakes', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const clip = loadFixture('wake-nijialuo-male');
  const pcm = concat([silence(300), clip.samples, silence(3500)]);
  const gate = fakeGate({ ok: true, score: 0.88 });
  const { asr, events } = startModule({
    source: pacedSource(pcm),
    asrOverrides: { verifyWake: { enabled: true, timeoutMs: 1800 } },
    gate,
  });
  await asr.start();
  try {
    await events.waitFor((e) => e.type === 'wake', 8000, 'wake after both gates pass');
    assert.ok(gate.calls.length >= 1);
  } finally {
    await asr.stop();
  }
});

test('TTS/ack echo is kept out of the pre-roll the voiceprint gate reads', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const clip = loadFixture('wake-nijialuo-male');
  const source = manualSource();
  const gate = fakeGate({ ok: true, score: 0.9 });
  const { asr, events } = startModule({ source: source.factory, gate });
  await asr.start();
  try {
    // Simulate the assistant speaking: the daemon mutes wake listening while
    // TTS/ack plays, and the mic hears a loud echo of the assistant's voice.
    asr.setMuted(true);
    source.push(new Float32Array(16000 * 0.6).fill(0.9));
    await sleep(80);
    asr.setMuted(false);
    // Feed in parec-sized chunks: the KWS needs a stream, not one huge buffer.
    const all = concat([silence(300), clip.samples, silence(2500)]);
    for (let off = 0; off < all.length; off += 1600) {
      source.push(all.subarray(off, Math.min(off + 1600, all.length)));
      await sleep(5);
    }
    await events.waitFor((e) => e.type === 'wake', 8000, 'wake after the muted echo');
    assert.ok(gate.calls.length >= 1, 'gate ran on the wake');
    let maxAbs = 0;
    for (const v of gate.calls[0]) maxAbs = Math.max(maxAbs, Math.abs(v));
    assert.ok(maxAbs < 0.5, `the muted TTS echo must not be in the pre-roll (maxAbs=${maxAbs})`);
  } finally {
    await asr.stop();
  }
});

test('a voiceprint rejection keeps only a short retry window', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const clip = loadFixture('wake-nijialuo-male');
  const gate = fakeGate({ ok: false, score: 0.2, reason: 'mismatch' });
  const pcm = concat([silence(300), clip.samples, silence(3500)]);
  const { asr } = startModule({
    source: pacedSource(pcm),
    asrOverrides: { wakeCooldownMs: 2500 },
    gate,
  });
  await asr.start();
  try {
    await waitUntil(() => gate.calls.length > 0, 8000, 'gate consulted');
    const remaining = asr.modelInfo.wakeCooldownRemainingMs;
    assert.ok(remaining > 0 && remaining <= 1000, `owner should be able to retry soon, remaining=${remaining}ms`);
  } finally {
    await asr.stop();
  }
});
