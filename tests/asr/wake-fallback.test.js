// config.asr.wakeCaptureFallbackMs: let the daemon play a short ack before
// capture starts, with a timer fallback so a lost ack never leaves Figaro deaf.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAsr } from '../../src/voice/asr/index.js';
import { makeConfig, modelsAvailable, loadFixture, skipMessage, recorder, arraySource, silence, concat, waitUntil } from './helpers.js';

function startWithFallback(pcm, fallbackMs) {
  const events = recorder();
  const config = makeConfig({ asr: { hotkey: '', wakeCaptureFallbackMs: fallbackMs } });
  const asr = createAsr({
    micGain: false,
    config,
    hotkey: false,
    source: arraySource(pcm),
    onWake: () => events.push({ type: 'wake' }),
    onLevel: () => {},
    onPartial: () => {},
    onFinal: (text) => events.push({ type: 'final', text }),
    onVadStart: () => {},
    onError: (err) => events.push({ type: 'error', message: err.message }),
    onLog: () => {},
  });
  return { asr, events };
}

test('wakeCaptureFallbackMs > 0: daemon decides when to start capture', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const wake = loadFixture('wake-nijialuo-male');
  const pcm = concat([silence(300), wake.samples, silence(2500)]);
  const { asr, events } = startWithFallback(pcm, 5000); // long fallback: must not fire during the test
  try {
    await asr.start();
    await events.waitFor((e) => e.type === 'wake', 5000, 'onWake');
    // give the module time: with a 5 s fallback it must stay in listening
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(asr.capturing, false, 'must not auto-capture when wakeCaptureFallbackMs is large');
    // daemon now starts capture itself
    asr.beginCapture();
    assert.equal(asr.capturing, true);
    const finalEvent = await events.waitFor((e) => e.type === 'final', 8000, 'onFinal');
    assert.equal(finalEvent.text, '');
    assert.deepEqual(events.ofType('error'), []);
  } finally {
    await asr.stop();
  }
});

test('wakeCaptureFallbackMs > 0: timer is a fallback and fires exactly once', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const wake = loadFixture('wake-nijialuo-male');
  const pcm = concat([silence(300), wake.samples, silence(3000)]);
  const { asr, events } = startWithFallback(pcm, 250);
  try {
    await asr.start();
    await events.waitFor((e) => e.type === 'wake', 5000, 'onWake');
    await waitUntil(() => asr.capturing, 2000, 'fallback timer starts capture');
    const finalEvent = await events.waitFor((e) => e.type === 'final', 8000, 'onFinal');
    assert.equal(finalEvent.text, '');
    // one wake -> one capture -> one final
    assert.equal(events.ofType('wake').length, 1);
    assert.equal(events.ofType('final').length, 1);
  } finally {
    await asr.stop();
  }
});

test('wakeCaptureFallbackMs = 0 keeps the old immediate behaviour', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const wake = loadFixture('wake-nijialuo-male');
  const pcm = concat([silence(300), wake.samples, silence(2500)]);
  const { asr, events } = startWithFallback(pcm, 0);
  try {
    await asr.start();
    await events.waitFor((e) => e.type === 'wake', 5000, 'onWake');
    await waitUntil(() => asr.capturing, 1000, 'immediate capture');
    await events.waitFor((e) => e.type === 'final', 8000, 'onFinal');
  } finally {
    await asr.stop();
  }
});
