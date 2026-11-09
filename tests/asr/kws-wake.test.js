// Integration tests for createAsr(): wake word detection -> capture -> final text.
// Audio is injected (no microphone). Deterministic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAsr } from '../../src/voice/asr/index.js';
import {
  makeConfig, modelsAvailable, loadFixture, skipMessage, recorder, arraySource,
  silence, concat, waitUntil,
} from './helpers.js';

function startModule(pcm, overrides = {}) {
  const events = recorder();
  const config = makeConfig({ asr: { hotkey: '', ...(overrides.asr ?? {}) } });
  const asr = createAsr({
    config,
    hotkey: false,
    source: arraySource(pcm),
    onWake: () => events.push({ type: 'wake' }),
    onLevel: () => {},
    onPartial: (text) => events.push({ type: 'partial', text }),
    onFinal: (text) => events.push({ type: 'final', text }),
    onVadStart: () => events.push({ type: 'vadStart' }),
    onError: (err) => events.push({ type: 'error', message: err.message }),
    onLog: () => {},
  });
  return { asr, events, config };
}

test('wake word wakes, opens capture, auto-closes on silence, returns to listening', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const wake = loadFixture('wake-nijialuo-male');
  const pcm = concat([silence(300), wake.samples, silence(2500)]);
  const { asr, events } = startModule(pcm);
  try {
    await asr.start();
    const wakeEvent = await events.waitFor((e) => e.type === 'wake', 5000, 'onWake');
    assert.ok(wakeEvent);
    const finalEvent = await events.waitFor((e) => e.type === 'final', 8000, 'onFinal');
    assert.equal(finalEvent.text, '', 'a wake word without a command yields an empty final transcript');
    await waitUntil(() => asr.state === 'listening', 3000, 'back to listening');
    assert.deepEqual(events.ofType('error'), [], 'no errors expected');
    assert.equal(asr.capturing, false);
  } finally {
    await asr.stop();
  }
});

test('ordinary speech never wakes Figaro', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const neg = loadFixture('neg-weather');
  const pcm = concat([silence(300), neg.samples, silence(1500)]);
  const { asr, events } = startModule(pcm);
  try {
    await asr.start();
    await new Promise((r) => setTimeout(r, 1200));
    assert.deepEqual(events.ofType('wake'), [], 'no wake on ordinary speech');
    assert.deepEqual(events.ofType('final'), [], 'no capture on ordinary speech');
  } finally {
    await asr.stop();
  }
});

test('wake word followed by a command is transcribed without the wake word', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const clip = loadFixture('wake-with-command');
  const pcm = concat([silence(300), clip.samples, silence(2200)]);
  const { asr, events } = startModule(pcm);
  try {
    await asr.start();
    await events.waitFor((e) => e.type === 'wake', 5000, 'onWake');
    const finalEvent = await events.waitFor((e) => e.type === 'final', 8000, 'onFinal');
    assert.match(finalEvent.text, /现在几点/, `unexpected transcript: ${JSON.stringify(finalEvent.text)}`);
    assert.ok(events.ofType('vadStart').length >= 1, 'VAD must report speech start during capture');
  } finally {
    await asr.stop();
  }
});

test('onLevel is emitted at 20 Hz with sane RMS values while audio flows', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const pcm = silence(2000);
  const events = recorder();
  const config = makeConfig({ asr: { hotkey: '' } });
  const levels = [];
  const asr = createAsr({
    config,
    hotkey: false,
    source: arraySource(pcm),
    onLevel: (v) => { levels.push(v); events.push({ type: 'level', v }); },
    onError: (err) => events.push({ type: 'error', message: err.message }),
    onLog: () => {},
  });
  try {
    await asr.start();
    await new Promise((r) => setTimeout(r, 500));
    // 2000 ms of audio / 50 ms windows = 40 level events
    assert.ok(levels.length >= 38 && levels.length <= 41, `expected ~40 level events, got ${levels.length}`);
    assert.ok(levels.every((v) => v >= 0 && v <= 1), 'levels must be normalised to 0..1');
    assert.ok(levels.every((v) => v < 0.01), 'silence must read close to 0');
  } finally {
    await asr.stop();
  }
});
