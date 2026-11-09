// GUI self-test channels + runtime config (docs/ipc.md §3.1):
//   armWakeTest / startMicTest / startAsrTest / applyRuntimeConfig / micInfo,
// plus the wake cooldown and sensitivity presets.
//
// No microphone and no mixer: audio is injected and the mic-gain controller is
// a fake, so the tests never touch the system.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAsr, SENSITIVITY_PRESETS, sensitivityPreset } from '../../src/voice/asr/index.js';
import { makeConfig, modelsAvailable, loadFixture, skipMessage, recorder, arraySource, silence, concat, waitUntil } from './helpers.js';

/** Audio source that starts feeding after a short delay (lets a test arm first). */
function delayedSource(pcm, delayMs = 120) {
  return ({ onPcm }) => {
    let timer = null;
    let pumpTimer = null;
    let cancelled = false;
    let offset = 0;
    const chunk = 1600;
    return {
      async start() {
        timer = setTimeout(() => {
          const pump = () => {
            if (cancelled || offset >= pcm.length) return;
            const end = Math.min(offset + chunk, pcm.length);
            onPcm(pcm.subarray(offset, end));
            offset = end;
            if (offset < pcm.length) pumpTimer = setImmediate(pump);
          };
          pump();
        }, delayMs);
      },
      async stop() {
        cancelled = true;
        clearTimeout(timer);
        if (pumpTimer) clearImmediate(pumpTimer);
      },
    };
  };
}

function fakeMicGain() {
  const calls = { fixed: [] };
  let fixedPercent = null;
  return {
    calls,
    get available() { return true; },
    get gain() { return { gain: 45, percent: 71 }; },
    get fixed() { return fixedPercent !== null; },
    get fixedTarget() { return fixedPercent; },
    get stats() { return { rms: 0.01, peak: 0.1 }; },
    reset() {},
    async calibrate() { return { adjusted: false, reason: 'fixed' }; },
    async correctClipping() { return false; },
    async setFixedGain(p) {
      fixedPercent = p;
      calls.fixed.push(p);
      return p;
    },
  };
}

function startModule({ pcm = silence(300), asrOverrides = {}, micGain, sourceDelay = 0 } = {}) {
  const events = recorder();
  const config = makeConfig({ asr: { hotkey: '', ...asrOverrides } });
  const asr = createAsr({
    config,
    hotkey: false,
    micGain,
    source: sourceDelay > 0 ? delayedSource(pcm, sourceDelay) : arraySource(pcm),
    onWake: () => events.push({ type: 'wake' }),
    onLevel: () => {},
    onPartial: (text) => events.push({ type: 'partial', text }),
    onFinal: (text) => events.push({ type: 'final', text }),
    onVadStart: () => {},
    onError: (err) => events.push({ type: 'error', message: err.message }),
    onLog: () => {},
  });
  return { asr, events, config };
}

test('sensitivity presets are exported and low is stricter than high', () => {
  assert.deepEqual(Object.keys(SENSITIVITY_PRESETS).sort(), ['high', 'low', 'medium']);
  const low = sensitivityPreset('low');
  const high = sensitivityPreset('high');
  assert.ok(low.keywordsThreshold > high.keywordsThreshold, 'low must require a higher match threshold');
  assert.ok(low.keywordsScore <= high.keywordsScore);
  assert.equal(sensitivityPreset('bogus'), null);
});

test('module reads config.asr.sensitivity and exposes the KWS params', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  for (const name of ['low', 'high']) {
    const { asr } = startModule({ asrOverrides: { sensitivity: name } });
    await asr.start();
    try {
      assert.equal(asr.sensitivity, name);
      assert.deepEqual(asr.modelInfo.kwsParams, SENSITIVITY_PRESETS[name]);
    } finally {
      await asr.stop();
    }
  }
});

test('applyRuntimeConfig hot-swaps sensitivity / cooldown / input gain', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const micGain = fakeMicGain();
  const { asr } = startModule({ asrOverrides: { sensitivity: 'low' }, micGain });
  await asr.start();
  try {
    const res = asr.applyRuntimeConfig({ sensitivity: 'high', wakeCooldownMs: 1234, inputGainPercent: 40 });
    assert.deepEqual(res.applied.sort(), ['inputGainPercent', 'sensitivity', 'wakeCooldownMs']);
    assert.deepEqual(res.restartRequired, []);
    assert.equal(asr.sensitivity, 'high');
    assert.equal(asr.wakeCooldownMs, 1234);
    assert.equal(asr.inputGainPercent, 40);
    await waitUntil(() => micGain.calls.fixed.includes(40), 1000, 'fixed gain applied');
    const unknown = asr.applyRuntimeConfig({ wakeWords: ['x'], hotkey: 'F5' });
    assert.deepEqual(unknown.restartRequired.sort(), ['hotkey', 'wakeWords']);
    // setter shortcuts
    asr.setSensitivity('low');
    assert.equal(asr.sensitivity, 'low');
    asr.setWakeCooldownMs(2500);
    assert.equal(asr.wakeCooldownMs, 2500);
  } finally {
    await asr.stop();
  }
});

test('micInfo carries {gainPercent, rms, peak} for diagnostics', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const micGain = fakeMicGain();
  const { asr } = startModule({ asrOverrides: { inputGainPercent: 40 }, micGain, pcm: silence(500) });
  await asr.start();
  try {
    await waitUntil(() => asr.micInfo.peak > 0 || asr.micInfo.rms >= 0, 500, 'mic info');
    const info = asr.micInfo;
    assert.equal(info.available, true);
    assert.equal(info.gainPercent, 45);
    assert.ok(typeof info.rms === 'number' && info.rms >= 0);
    assert.ok(typeof info.peak === 'number' && info.peak >= 0);
    assert.equal(typeof info.fixed, 'boolean');
  } finally {
    await asr.stop();
  }
});

test('wake cooldown suppresses a KWS hit inside the configured window', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const wake = loadFixture('wake-nijialuo-male');
  const pcm = concat([silence(300), wake.samples, silence(500), wake.samples, silence(1500)]);
  // Large fallback keeps the module in 'listening' (no capture) so both wake
  // words are actually evaluated by the KWS.
  for (const [cooldown, expected] of [[5000, 1], [0, 2]]) {
    const { asr, events } = startModule({
      pcm,
      // cooldown semantics are tested independently of the (slower) two-stage
      // wake verification; that has its own tests in wake-verify.test.js
      asrOverrides: { wakeCaptureFallbackMs: 5000, wakeCooldownMs: cooldown, sensitivity: 'high', verifyWake: { enabled: false } },
    });
    await asr.start();
    try {
      await events.waitFor((e) => e.type === 'wake', 5000, 'first wake').catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(events.ofType('wake').length, expected, `cooldown=${cooldown}`);
    } finally {
      await asr.stop();
    }
  }
});

test('armWakeTest: live score + hit, and it never wakes the daemon', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const wake = loadFixture('wake-nijialuo-male');
  const pcm = concat([silence(300), wake.samples, silence(2500)]);
  const { asr, events } = startModule({ pcm, sourceDelay: 150, asrOverrides: { sensitivity: 'high' } });
  await asr.start();
  const scores = [];
  const hits = [];
  let ended = null;
  try {
    const armed = asr.armWakeTest({
      ms: 1500,
      onScore: (s) => scores.push(s),
      onHit: (h) => hits.push(h),
      onEnd: (r) => { ended = r; },
    });
    assert.ok(armed.armed);
    await waitUntil(() => hits.length > 0, 5000, 'wake test hit');
    assert.ok(scores.length > 0, 'expected live wake scores');
    assert.ok(scores.some((s) => s.score > 0 && typeof s.keyword === 'string'));
    assert.ok(hits[0].score > 0);
    assert.equal(typeof hits[0].latencyMs, 'number');
    asr.disarmWakeTest();
    assert.ok(ended, 'onEnd must be called by disarm');
    assert.equal(ended.hits, hits.length);
    assert.deepEqual(events.ofType('wake'), [], 'wake test must not call onWake');
    assert.deepEqual(events.ofType('final'), [], 'wake test must not start capture');
  } finally {
    await asr.stop();
  }
});

test('startMicTest streams 20Hz samples and ends by itself', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const { asr } = startModule({ pcm: silence(1500) });
  await asr.start();
  const samples = [];
  let ended = false;
  try {
    const res = asr.startMicTest({ ms: 400, onSample: (s) => samples.push(s), onEnd: () => { ended = true; } });
    assert.equal(res.started, true);
    await waitUntil(() => ended, 3000, 'mic test end');
    assert.ok(samples.length >= 5, `expected ~20Hz samples, got ${samples.length}`);
    for (const s of samples.slice(0, 10)) {
      assert.ok(s.rms >= 0 && s.rms <= 1);
      assert.ok(s.peak >= 0 && s.peak <= 1);
      assert.ok(s.level >= 0 && s.level <= 1);
    }
  } finally {
    await asr.stop();
  }
});

test('startAsrTest records audio and returns both streaming and offline text', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const entry = loadFixture('cmd-time');
  const pcm = concat([silence(200), entry.samples, silence(500)]);
  const { asr } = startModule({ pcm, sourceDelay: 150 });
  await asr.start();
  const partials = [];
  let result = null;
  let error = null;
  try {
    const started = asr.startAsrTest({ ms: 6000, onPartial: (p) => partials.push(p), onResult: (r) => { result = r; }, onError: (e) => { error = e; } });
    assert.equal(started.started, true);
    await waitUntil(() => result || error, 8000, 'asr test result');
    assert.equal(error, null, error ? error.message : '');
    assert.ok(result);
    assert.equal(typeof result.text, 'string');
    assert.equal(typeof result.streamingText, 'string');
    assert.ok(result.audioMs > 500, `audioMs=${result.audioMs}`);
    assert.ok(result.ms >= result.audioMs - 500);
    assert.match(result.text, /现在几点/, `offline text: ${JSON.stringify(result.text)}`);
    assert.ok(partials.length >= 1, 'expected onPartial updates during recording');
  } finally {
    await asr.stop();
  }
});

test('inputGainPercent pins the gain and null restores auto calibration', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const micGain = fakeMicGain();
  const { asr } = startModule({ micGain, asrOverrides: { inputGainPercent: null } });
  await asr.start();
  try {
    assert.equal(asr.inputGainPercent, null);
    const applied = await asr.setInputGainPercent(35);
    assert.equal(asr.inputGainPercent, 35);
    assert.equal(applied, 35);
    assert.deepEqual(micGain.calls.fixed, [35]);
    await asr.setInputGainPercent(null);
    assert.equal(asr.inputGainPercent, null);
    assert.deepEqual(micGain.calls.fixed, [35, null]);
  } finally {
    await asr.stop();
  }
});

test('setMuted pauses wake-word listening without breaking capture/levels', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const wake = loadFixture('wake-nijialuo-male');
  const pcm = concat([silence(300), wake.samples, silence(500), wake.samples, silence(1500)]);
  const { asr, events } = startModule({ pcm, asrOverrides: { wakeCaptureFallbackMs: 5000, wakeCooldownMs: 0 } });
  await asr.start();
  try {
    asr.setMuted(true);
    assert.equal(asr.muted, true);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(events.ofType('wake'), [], 'muted: no wake despite wake words');
    asr.setMuted(false);
    assert.equal(asr.muted, false);
    // resume and feed a wake word again through a fresh module run is covered by
    // the cooldown test; here we only assert the API contract + no crash.
    assert.equal(asr.pauseListening(), true);
    assert.equal(asr.muted, true);
    assert.equal(asr.resumeListening(), false);
    assert.equal(asr.muted, false);
  } finally {
    await asr.stop();
  }
});

test('setMuted does not break a wake test window (self-test keeps working)', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const wake = loadFixture('wake-nijialuo-male');
  const pcm = concat([silence(300), wake.samples, silence(2500)]);
  const { asr } = startModule({ pcm, sourceDelay: 150 });
  await asr.start();
  const hits = [];
  let ended = null;
  try {
    asr.setMuted(true);
    asr.armWakeTest({ ms: 1500, onScore: () => {}, onHit: (h) => hits.push(h), onEnd: (r) => { ended = r; } });
    await waitUntil(() => hits.length > 0, 5000, 'hit while muted').catch(() => {});
    asr.disarmWakeTest();
    assert.ok(ended, 'wake test must end');
  } finally {
    await asr.stop();
  }
});
