// Barge-in detector tests: loudness + adaptive echo baseline (fix for "assistant
// keeps cutting off its own answers").
//
// The detector is pure logic (RMS windows in, trigger out), plus module-level
// integration through createAsr({ onUserSpeech }).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBargeInDetector, normalizeBargeInConfig, BARGE_IN_DEFAULTS } from '../../src/voice/asr/barge-in.js';
import { createAsr } from '../../src/voice/asr/index.js';
import { makeConfig, modelsAvailable, skipMessage, recorder, waitUntil } from './helpers.js';

const SR = 16000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PCM chunk of `ms` at a deterministic RMS (440 Hz sine, amp = rms * sqrt(2)). */
function pcmAtRms(ms, rms) {
  const n = Math.round((SR * ms) / 1000);
  const amp = Math.min(0.99, rms * Math.SQRT2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / SR);
  return out;
}

function manualSource() {
  let emit = null;
  return {
    factory: ({ onPcm }) => {
      emit = onPcm;
      return { async start() {}, async stop() { emit = null; } };
    },
    push(samples) {
      for (let i = 0; i < samples.length; i += 800) emit(samples.subarray(i, Math.min(i + 800, samples.length)));
    },
    get ready() {
      return Boolean(emit);
    },
  };
}

function startModule(asrOverrides = {}) {
  const events = recorder();
  const manual = manualSource();
  const config = makeConfig({ asr: { hotkey: '', ...asrOverrides } });
  const asr = createAsr({
    config,
    micGain: false,
    source: manual.factory,
    onWake: () => events.push({ type: 'wake' }),
    onLevel: () => {},
    onPartial: () => {},
    onFinal: (text) => events.push({ type: 'final', text }),
    onError: (err) => events.push({ type: 'error', message: err.message }),
    onUserSpeech: () => events.push({ type: 'userSpeech' }),
    onLog: () => {},
  });
  return { asr, events, manual };
}

/** Feed the 300 ms echo-baseline measurement, then `ms` at `rms`. */
function feedBaselineThen(manual, baselineRms, speechRms, speechMs) {
  manual.push(pcmAtRms(300, baselineRms));
  manual.push(pcmAtRms(speechMs, speechRms));
}

// ---------------------------------------------------------------- pure logic
test('detector: echo baseline suppresses the echo itself', () => {
  const d = createBargeInDetector({ enabled: true, minRms: 0.14, echoFactor: 2.0, minMs: 500 });
  d.arm({ phase: 'tts' });
  assert.equal(d.process(0.08, 50), false, 'still measuring baseline');
  // 300 ms baseline around 0.08
  for (let i = 0; i < 5; i++) d.process(0.08, 50);
  assert.ok(d.baseline > 0.05 && d.baseline < 0.11, `baseline=${d.baseline}`);
  // echo at 0.15 < max(0.14, 0.16) -> never triggers, however long
  let fired = 0;
  for (let i = 0; i < 40; i++) if (d.process(0.15, 50)) fired += 1;
  assert.equal(fired, 0);
  // a deliberate, louder voice (0.4 > 0.16) sustained 500 ms does trigger
  for (let i = 0; i < 9; i++) if (d.process(0.4, 50)) fired += 1;
  assert.equal(fired, 0, 'not before minMs');
  assert.equal(d.process(0.4, 50), true);
});

test('detector: high TTS echo raises the baseline, so it cannot self-trigger', () => {
  const d = createBargeInDetector({ enabled: true, minRms: 0.14, echoFactor: 2.0, minMs: 500 });
  d.arm({ phase: 'tts' });
  for (let i = 0; i < 6; i++) d.process(0.2, 50); // loud echo baseline
  assert.ok(d.baseline > 0.15);
  let fired = 0;
  for (let i = 0; i < 40; i++) if (d.process(0.3, 50)) fired += 1; // 0.3 < 0.4
  assert.equal(fired, 0, 'echo level + margin must not trigger');
  for (let i = 0; i < 10; i++) if (d.process(0.55, 50)) fired += 1; // > 0.4
  assert.ok(fired >= 1);
});

test('detector: ack phase is stricter than normal TTS phase', () => {
  const tts = createBargeInDetector({ enabled: true, minRms: 0.14, echoFactor: 2.0, minMs: 500 });
  tts.arm({ phase: 'tts' });
  for (let i = 0; i < 6; i++) tts.process(0.1, 50);
  let ttsFired = 0;
  for (let i = 0; i < 12; i++) if (tts.process(0.22, 50)) ttsFired += 1; // > 0.2
  assert.equal(ttsFired, 1, 'normal TTS: 0.22 triggers');

  const ack = createBargeInDetector({ enabled: true, minRms: 0.14, echoFactor: 2.0, minMs: 500 });
  ack.arm({ phase: 'ack' });
  for (let i = 0; i < 6; i++) ack.process(0.1, 50);
  let ackFired = 0;
  for (let i = 0; i < 12; i++) if (ack.process(0.22, 50)) ackFired += 1; // < 0.25
  assert.equal(ackFired, 0, 'ack: 0.22 must not interrupt "我在"');
  for (let i = 0; i < 12; i++) if (ack.process(0.35, 50)) ackFired += 1;
  assert.equal(ackFired, 1, 'ack: a clearly louder voice still interrupts');
});

test('detector: enabled=false never fires; hot config can disable/enable', () => {
  const d = createBargeInDetector({ enabled: false });
  d.arm({ phase: 'tts' });
  let fired = 0;
  for (let i = 0; i < 60; i++) if (d.process(0.9, 50)) fired += 1;
  assert.equal(fired, 0);
  d.setConfig({ enabled: true });
  d.arm({ phase: 'tts' });
  for (let i = 0; i < 6; i++) d.process(0.1, 50);
  for (let i = 0; i < 12; i++) if (d.process(0.9, 50)) fired += 1;
  assert.equal(fired, 1);
  d.setConfig({ enabled: false });
  assert.equal(d.active, false);
});

test('detector: speech gaps are tolerated (accumulate >= minMs of loud voice)', () => {
  const d = createBargeInDetector({ enabled: true, minRms: 0.14, echoFactor: 2.0, minMs: 500 });
  d.arm({ phase: 'tts' });
  for (let i = 0; i < 6; i++) d.process(0.02, 50); // quiet baseline
  let fired = 0;
  // 400 ms voice, 200 ms gap (tolerated), 400 ms voice -> 800 >= 500
  for (let i = 0; i < 8; i++) if (d.process(0.3, 50)) fired += 1;
  for (let i = 0; i < 4; i++) if (d.process(0.02, 50)) fired += 1;
  for (let i = 0; i < 8; i++) if (d.process(0.3, 50)) fired += 1;
  assert.equal(fired, 1, 'gaps between words still trigger');
  // a pause longer than the tolerance resets the accumulator
  const d2 = createBargeInDetector({ enabled: true, minRms: 0.14, echoFactor: 2.0, minMs: 500 });
  d2.arm({ phase: 'tts' });
  for (let i = 0; i < 6; i++) d2.process(0.02, 50);
  let fired2 = 0;
  for (let i = 0; i < 8; i++) if (d2.process(0.3, 50)) fired2 += 1;
  for (let i = 0; i < 12; i++) if (d2.process(0.02, 50)) fired2 += 1; // 600 ms
  for (let i = 0; i < 8; i++) if (d2.process(0.3, 50)) fired2 += 1; // 400 ms
  assert.equal(fired2, 0, 'a long pause resets the requirement');
});

test('normalizeBargeInConfig clamps and merges partial patches', () => {
  assert.deepEqual(normalizeBargeInConfig({}), { ...BARGE_IN_DEFAULTS });
  const merged = normalizeBargeInConfig({ minMs: 10 }, { enabled: false, minRms: 0.2, echoFactor: 3, minMs: 500 });
  assert.equal(merged.minMs, 50, 'clamped to >= 50ms');
  assert.equal(merged.enabled, false, 'keeps base when patch omits it');
  assert.equal(merged.minRms, 0.2);
});

// ----------------------------------------------------------- module wiring
test('createAsr: muted echo does not fire, a loud voice does (once / 1s)', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const { asr, events, manual } = startModule();
  await asr.start();
  try {
    asr.setMuted(true);
    // 300 ms of echo baseline at 0.06, then 1 s of echo at 0.10 -> no trigger
    manual.push(pcmAtRms(300, 0.06));
    manual.push(pcmAtRms(1000, 0.1));
    await sleep(120);
    assert.deepEqual(events.ofType('userSpeech'), [], 'echo must not barge in');
    // deliberate voice at 0.35 for 700 ms -> triggers once
    manual.push(pcmAtRms(700, 0.35));
    await events.waitFor((e) => e.type === 'userSpeech', 2000, 'onUserSpeech');
    assert.equal(events.ofType('userSpeech').length, 1);
    // sustained loud voice again inside the 1 s cooldown -> still once
    manual.push(pcmAtRms(700, 0.35));
    await sleep(120);
    assert.equal(events.ofType('userSpeech').length, 1, 'cooldown suppresses repeats');
    await sleep(1100);
    manual.push(pcmAtRms(700, 0.35));
    await waitUntil(() => events.ofType('userSpeech').length === 2, 2000, 'second barge-in');
    assert.deepEqual(events.ofType('wake'), [], 'muted: no wake');
    assert.deepEqual(events.ofType('final'), [], 'muted: no transcription');
    assert.equal(asr.capturing, false);
  } finally {
    await asr.stop();
  }
});

test('createAsr: ack phase needs a louder voice than normal TTS playback', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const { asr, events, manual } = startModule();
  await asr.start();
  try {
    asr.setMuted(true, { phase: 'ack' });
    assert.equal(asr.modelInfo.bargeInStats.phase, 'ack');
    manual.push(pcmAtRms(300, 0.1));
    manual.push(pcmAtRms(800, 0.2)); // > tts(0.2) but < ack(0.25)
    await sleep(120);
    assert.deepEqual(events.ofType('userSpeech'), [], 'ack echo margin protects "我在"');
    manual.push(pcmAtRms(800, 0.4));
    await events.waitFor((e) => e.type === 'userSpeech', 2000, 'clear barge-in during ack');
  } finally {
    await asr.stop();
  }
});

test('createAsr: bargeIn config is hot-changeable and visible in modelInfo', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const { asr, events, manual } = startModule();
  await asr.start();
  try {
    assert.deepEqual(asr.bargeIn, { ...BARGE_IN_DEFAULTS });
    const off = asr.applyRuntimeConfig({ bargeIn: { enabled: false } });
    assert.deepEqual(off.applied, ['bargeIn']);
    assert.equal(asr.modelInfo.bargeIn.enabled, false);
    asr.setMuted(true);
    manual.push(pcmAtRms(300, 0.05));
    manual.push(pcmAtRms(800, 0.5));
    await sleep(150);
    assert.deepEqual(events.ofType('userSpeech'), [], 'disabled: never callbacks');
    asr.applyRuntimeConfig({ bargeIn: { enabled: true, minRms: 0.05 } });
    assert.equal(asr.modelInfo.bargeIn.minRms, 0.05);
    asr.setMuted(false);
    asr.setMuted(true);
    manual.push(pcmAtRms(300, 0.05));
    manual.push(pcmAtRms(800, 0.4));
    await events.waitFor((e) => e.type === 'userSpeech', 2000, 're-enabled barge-in');
    // shortcut setter
    asr.setBargeIn({ minMs: 800 });
    assert.equal(asr.bargeIn.minMs, 800);
  } finally {
    await asr.stop();
  }
});
