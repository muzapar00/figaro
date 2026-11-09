// End-to-end transcription of capture-mode audio through createAsr():
// push-to-talk (beginCapture) -> VAD -> streaming partials -> offline final text.
// Deterministic fixtures, no microphone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAsr } from '../../src/voice/asr/index.js';
import {
  makeConfig, modelsAvailable, loadFixture, skipMessage, recorder, arraySource,
  silence, concat,
} from './helpers.js';

/** Run one push-to-talk utterance through a fresh module instance. */
async function transcribe(entry) {
  const pcm = concat([silence(400), entry.samples, silence(2500)]);
  const events = recorder();
  const config = makeConfig({ asr: { hotkey: '' } });
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
  await asr.start();
  asr.beginCapture();
  try {
    const finalEvent = await events.waitFor((e) => e.type === 'final', 10000, 'onFinal');
    return { text: finalEvent.text, events, asr };
  } finally {
    await asr.stop();
  }
}

test('final transcripts of 5 command sentences match the expected text', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const names = ['cmd-time', 'cmd-weather', 'cmd-light', 'cmd-music', 'cmd-volume'];
  const results = [];
  for (const name of names) {
    const entry = loadFixture(name);
    const { text, events } = await transcribe(entry);
    results.push({ name, expected: entry.expect, got: text });
    assert.equal(text, entry.expect, `${name}: transcript mismatch`);
    assert.ok(events.ofType('vadStart').length >= 1, `${name}: onVadStart missing`);
    assert.deepEqual(events.ofType('error'), [], `${name}: unexpected errors`);
  }
  t.diagnostic(`transcripts: ${JSON.stringify(results, null, 0)}`);
});

test('streaming partials are emitted while a sentence is captured', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const entry = loadFixture('cmd-weather');
  const { events } = await transcribe(entry);
  const partials = events.ofType('partial').map((e) => e.text);
  assert.ok(partials.length >= 1, 'expected at least one onPartial update');
  assert.ok(partials.every((p) => typeof p === 'string' && p.length > 0));
  assert.ok(partials.at(-1).length > 0);
});
