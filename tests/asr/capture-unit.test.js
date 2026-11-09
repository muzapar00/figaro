// Deterministic unit tests for the capture state machine (no microphone, no
// real models): silence timing, VAD callback, max duration, min duration.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCapture } from '../../src/voice/asr/capture.js';

const SR = 16000;

function tone(ms, amplitude = 0.4) {
  const n = Math.round((SR * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / SR);
  return out;
}
function zeros(ms) {
  return new Float32Array(Math.round((SR * ms) / 1000));
}
function fakeVad() {
  return {
    kind: 'fake',
    windowSize: 512,
    minSilenceDurationMs: 0,
    process(win) {
      let sum = 0;
      for (let i = 0; i < win.length; i++) sum += win[i] * win[i];
      return Math.sqrt(sum / win.length) > 0.1;
    },
    reset() {},
  };
}
function fakeOffline() {
  return {
    async transcribe(pcm) {
      let sum = 0;
      for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
      const rms = pcm.length ? Math.sqrt(sum / pcm.length) : 0;
      return rms > 0.05 ? '费加罗现在几点了' : '';
    },
  };
}
function fakeStreaming(initial = '费加罗现在几点了') {
  return {
    feed() { return initial; },
    text() { return initial; },
    reset() {},
  };
}

function makeCapture(overrides = {}, hooks = {}) {
  const autoEnds = [];
  const vadStarts = [];
  const partials = [];
  const finals = [];
  const errors = [];
  const capture = createCapture({
    config: {
      asr: {
        silenceStopMs: 800,
        maxCaptureMs: 3000,
        minCaptureMs: 350,
        wakeWords: ['费加罗'],
        ...overrides,
      },
    },
    streaming: hooks.streaming ?? fakeStreaming(),
    offline: hooks.offline === null ? null : (hooks.offline ?? fakeOffline()),
    vad: hooks.vad ?? fakeVad(),
    wakeWords: ['费加罗'],
    onPartial: (t) => partials.push(t),
    onVadStart: () => vadStarts.push(Date.now()),
    onAutoEnd: (reason) => autoEnds.push(reason),
    onError: (err) => errors.push(err),
  });
  return { capture, autoEnds, vadStarts, partials, finals, errors };
}

test('capture: speech then silence beyond silenceStopMs triggers auto end', async () => {
  const { capture, autoEnds, vadStarts, partials } = makeCapture();
  capture.begin(new Float32Array(SR * 0.5)); // 500 ms pre-roll silence
  capture.push(tone(300));
  assert.equal(vadStarts.length, 1, 'onVadStart fired exactly once');
  assert.deepEqual(autoEnds, []);
  assert.ok(partials.length >= 1, 'onPartial forwarded while speaking');
  capture.push(zeros(500));
  assert.deepEqual(autoEnds, [], 'still below silenceStopMs (800 ms)');
  const res = capture.push(zeros(400));
  assert.deepEqual(res, { autoEnd: true, reason: 'silence' });
  assert.deepEqual(autoEnds, ['silence']);
  const out = await capture.end('silence');
  assert.equal(out.text, '现在几点了', 'wake prefix stripped from final transcript');
  assert.equal(out.reason, 'silence');
});

test('capture: maxCaptureMs bounds a never-ending utterance', async () => {
  const { capture, autoEnds } = makeCapture({ maxCaptureMs: 2000 });
  capture.begin(new Float32Array(0));
  let ended = null;
  for (let i = 0; i < 40 && !ended; i++) {
    const res = capture.push(tone(100));
    if (res.autoEnd) ended = res;
  }
  assert.ok(ended, 'capture must stop at maxCaptureMs');
  assert.equal(ended.reason, 'max-duration');
  assert.ok(capture.elapsedMs >= 2000 && capture.elapsedMs <= 2200, `elapsedMs=${capture.elapsedMs}`);
  assert.deepEqual(autoEnds, ['max-duration']);
});

test('capture: no speech at all gives up after wakeGiveUpMs', async () => {
  const { capture, autoEnds } = makeCapture({ silenceStopMs: 800, wakeGiveUpMs: 1500 });
  capture.begin(new Float32Array(0));
  let res = null;
  for (let i = 0; i < 30 && !res?.autoEnd; i++) res = capture.push(zeros(100));
  assert.ok(res?.autoEnd, 'silence-only capture must auto end');
  assert.equal(res.reason, 'give-up');
  assert.deepEqual(autoEnds, ['give-up']);
  const out = await capture.end('give-up');
  assert.equal(out.text, '', 'no speech -> empty transcript');
});

test('capture: give-up window defaults to 5000ms and does not clash with maxCaptureMs', async () => {
  const { capture, autoEnds } = makeCapture({ wakeGiveUpMs: 5000, maxCaptureMs: 15000, silenceStopMs: 900 });
  capture.begin(new Float32Array(0));
  let endedAt = null;
  for (let i = 0; i < 80; i++) {
    const res = capture.push(zeros(100));
    if (res.autoEnd) { endedAt = capture.stats.postMs; break; }
  }
  assert.ok(endedAt !== null, 'give-up must fire');
  assert.ok(endedAt >= 4900 && endedAt <= 5200, `give-up at ${endedAt}ms (expected ~5000)`);
  assert.deepEqual(autoEnds, ['give-up']);
});

test('capture: speech onset cancels the give-up timer', async () => {
  const { capture, autoEnds } = makeCapture({ wakeGiveUpMs: 1000, silenceStopMs: 800 });
  capture.begin(new Float32Array(0));
  let res = null;
  for (let i = 0; i < 5; i++) res = capture.push(tone(100));
  assert.ok(!res.autoEnd, 'speech onset must prevent give-up');
  // after speech, only silenceStopMs applies
  for (let i = 0; i < 10 && !res?.autoEnd; i++) res = capture.push(zeros(100));
  assert.equal(res?.reason, 'silence');
  assert.deepEqual(autoEnds, ['silence']);
});

test('capture: below minCaptureMs is discarded as empty', async () => {
  const { capture } = makeCapture({ minCaptureMs: 350 });
  capture.begin(new Float32Array(0));
  capture.push(zeros(200));
  const out = await capture.end('manual');
  assert.equal(out.text, '', 'too-short capture is discarded');
  assert.equal(out.stats.postMs, 200);
});

test('capture: falls back to streaming text when no offline model is available', async () => {
  const { capture } = makeCapture({}, { offline: null });
  capture.begin(new Float32Array(0));
  capture.push(tone(400));
  const out = await capture.end('manual');
  assert.equal(out.text, '现在几点了');
});

test('capture: offline failure degrades to streaming text without throwing', async () => {
  const errors = [];
  const capture = createCapture({
    config: { asr: { silenceStopMs: 800, maxCaptureMs: 3000, minCaptureMs: 350, wakeWords: ['费加罗'] } },
    streaming: fakeStreaming('费加罗打开客厅的灯'),
    offline: { transcribe: async () => { throw new Error('boom'); } },
    vad: fakeVad(),
    wakeWords: ['费加罗'],
    onAutoEnd: () => {},
    onError: (err) => errors.push(err.message),
  });
  capture.begin(new Float32Array(0));
  capture.push(tone(400));
  const out = await capture.end('manual');
  assert.equal(out.text, '打开客厅的灯');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /boom/);
});
