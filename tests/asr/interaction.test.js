// docs/voice-interaction.md ASR-side signals:
//   - hotkey short tap -> onTap (cancel, never starts a capture)
//   - wake give-up (wakeGiveUpMs) -> onGiveUp, no onFinal
//   - muted barge-in: VAD onset while TTS plays -> onUserSpeech (once / 1s)
//   - wakeGiveUpMs hot-change via applyRuntimeConfig
//
// Audio is injected through a manual source, the portal is a fake connection and
// the mic-gain controller is disabled, so nothing touches the real system.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAsr } from '../../src/voice/asr/index.js';
import { makeConfig, modelsAvailable, loadFixture, skipMessage, recorder, concat, silence, waitUntil } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Audio source whose start() does nothing; the test pushes PCM explicitly. */
function manualSource() {
  let emit = null;
  return {
    factory: ({ onPcm }) => {
      emit = onPcm;
      return { async start() {}, async stop() { emit = null; } };
    },
    push(samples) {
      if (!emit) throw new Error('source not started');
      for (let i = 0; i < samples.length; i += 1600) emit(samples.subarray(i, Math.min(i + 1600, samples.length)));
    },
    get ready() {
      return Boolean(emit);
    },
  };
}

/** Minimal fake portal so createAsr() can bind F9 without touching the real bus. */
function fakePortal() {
  const handlers = [];
  const emit = (iface, member, path, args) => {
    for (const h of [...handlers]) {
      if (h.iface !== iface || h.member !== member) continue;
      h.fn({ path, args });
    }
  };
  let seq = 0;
  let sessionPath = null;
  const boundShortcuts = [['figaro-talk', [
    ['description', { signature: 's', value: '按住说话' }],
    ['trigger_description', { signature: 's', value: 'F9' }],
  ]]];
  const conn = {
    uniqueName: ':1.777',
    closed: false,
    onSignal({ interface: iface, member }, fn) {
      const h = { iface, member, fn };
      handlers.push(h);
      return () => {
        const i = handlers.indexOf(h);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    async addMatch() {},
    async call(opts) {
      seq += 1;
      if (opts.member === 'Register') return [];
      if (opts.member === 'CreateSession') {
        const req = `/req/create${seq}`;
        sessionPath = `/org/freedesktop/portal/desktop/session/1_777/figaro${seq}`;
        setImmediate(() => emit('org.freedesktop.portal.Request', 'Response', req, [0, [['session_handle', { signature: 's', value: sessionPath }]]]));
        return [req];
      }
      if (opts.member === 'BindShortcuts') {
        const req = `/req/bind${seq}`;
        setImmediate(() => emit('org.freedesktop.portal.Request', 'Response', req, [0, [['shortcuts', { signature: 'a(sa{sv})', value: boundShortcuts }]]]));
        return [req];
      }
      if (opts.member === 'ListShortcuts') {
        const req = `/req/list${seq}`;
        setImmediate(() => emit('org.freedesktop.portal.Request', 'Response', req, [0, [['shortcuts', { signature: 'a(sa{sv})', value: boundShortcuts }]]]));
        return [req];
      }
      return [];
    },
    close() { this.closed = true; },
  };
  return {
    conn,
    press() {
      emit('org.freedesktop.portal.GlobalShortcuts', 'Activated', sessionPath, [sessionPath, 'figaro-talk', 1, []]);
    },
    release() {
      emit('org.freedesktop.portal.GlobalShortcuts', 'Deactivated', sessionPath, [sessionPath, 'figaro-talk', 2, []]);
    },
  };
}

function startModule({ asrOverrides = {}, events: outerEvents = null, source = null, hotkeyConnectFn = null } = {}) {
  const events = outerEvents ?? recorder();
  const config = makeConfig({ asr: { hotkey: '', ...asrOverrides } });
  const manual = source;
  const asr = createAsr({
    config,
    micGain: false,
    hotkeyConnectFn,
    source: manual ? manual.factory : undefined,
    onWake: () => events.push({ type: 'wake' }),
    onLevel: (v) => events.push({ type: 'level', v }),
    onPartial: (text) => events.push({ type: 'partial', text }),
    onFinal: (text) => events.push({ type: 'final', text }),
    onVadStart: () => events.push({ type: 'vadStart' }),
    onError: (err) => events.push({ type: 'error', message: err.message }),
    onTap: () => events.push({ type: 'tap' }),
    onGiveUp: () => events.push({ type: 'giveUp' }),
    onUserSpeech: () => events.push({ type: 'userSpeech' }),
    onLog: () => {},
  });
  return { asr, events, config };
}

test('hotkey short tap -> onTap only (no wake, no capture); long press still wakes', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const portal = fakePortal();
  const manual = manualSource();
  const { asr, events } = startModule({
    asrOverrides: { hotkey: 'F9', longPressMs: 180, wakeCaptureFallbackMs: 0, wakeCooldownMs: 0 },
    source: manual,
    hotkeyConnectFn: async () => portal.conn,
  });
  await asr.start();
  try {
    // fake portal binds immediately -> wait until the hotkey is usable
    await waitUntil(() => asr.hotkeyState?.state === 'bound', 3000, 'hotkey bound');

    // --- short tap: press 40 ms then release -> cancel, never capture ---
    portal.press();
    await sleep(40);
    portal.release();
    await sleep(150);
    assert.equal(events.ofType('tap').length, 1, 'tap callback fired once');
    assert.deepEqual(events.ofType('wake'), [], 'tap must not wake');
    assert.equal(asr.capturing, false, 'tap must not start a capture');
    assert.deepEqual(events.ofType('final'), [], 'tap must not produce a transcript');

    // --- long press: hold > longPressMs -> wake + capture ---
    portal.press();
    await sleep(320);
    assert.equal(events.ofType('wake').length, 1, 'long press wakes');
    await waitUntil(() => asr.capturing, 2000, 'capture after long press');
    portal.release();
    await sleep(100);
    assert.equal(events.ofType('tap').length, 1, 'release after a long press is not a tap');
  } finally {
    await asr.stop();
  }
});

test('wake give-up: silence after beginCapture -> onGiveUp, no onFinal', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const manual = manualSource();
  const { asr, events } = startModule({ asrOverrides: { wakeGiveUpMs: 800 }, source: manual });
  await asr.start();
  try {
    asr.beginCapture();
    assert.equal(asr.capturing, true);
    for (let i = 0; i < 6; i++) manual.push(silence(100)); // 600 ms < 800
    assert.equal(asr.capturing, true, 'must not give up before wakeGiveUpMs');
    manual.push(silence(300)); // total 900 ms > 800
    await events.waitFor((e) => e.type === 'giveUp', 3000, 'onGiveUp');
    await waitUntil(() => asr.state === 'listening', 3000, 'back to listening');
    assert.deepEqual(events.ofType('final'), [], 'give-up must not emit onFinal');
    assert.deepEqual(events.ofType('wake'), [], 'no wake involved');
  } finally {
    await asr.stop();
  }
});

test('wake give-up: speaking instead of silence keeps the capture alive', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const cmd = loadFixture('cmd-time');
  const manual = manualSource();
  const { asr, events } = startModule({
    asrOverrides: { wakeGiveUpMs: 800, maxCaptureMs: 15000 },
    source: manual,
  });
  await asr.start();
  try {
    asr.beginCapture();
    manual.push(concat([silence(200), cmd.samples]));
    // speech was detected: the give-up timer must be gone, and the normal
    // silenceStopMs path finalizes the sentence instead.
    const finalEvent = await events.waitFor((e) => e.type === 'final', 6000, 'onFinal');
    assert.match(finalEvent.text, /现在几点/);
    assert.deepEqual(events.ofType('giveUp'), [], 'no give-up when the user actually spoke');
  } finally {
    await asr.stop();
  }
});

test('muted barge-in: VAD onset -> exactly one onUserSpeech per second, no wake / transcription', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const cmd = loadFixture('cmd-weather');
  const manual = manualSource();
  const { asr, events } = startModule({ source: manual, asrOverrides: { wakeCooldownMs: 0 } });
  await asr.start();
  try {
    asr.setMuted(true);
    assert.equal(asr.muted, true);
    manual.push(cmd.samples);
    await events.waitFor((e) => e.type === 'userSpeech', 3000, 'onUserSpeech');
    const levels = events.ofType('level').length;
    assert.ok(levels > 0, 'level metering keeps running while muted');
    // same burst again (still inside the 1 s cooldown) -> no second callback
    manual.push(cmd.samples);
    await sleep(150);
    assert.equal(events.ofType('userSpeech').length, 1, 'cooldown suppresses repeat');
    // after the 1 s cooldown another utterance fires again
    await sleep(1100);
    manual.push(cmd.samples);
    await events.waitFor(
      () => events.ofType('userSpeech').length === 2,
      3000,
      'second onUserSpeech after cooldown',
    );
    assert.deepEqual(events.ofType('wake'), [], 'muted: no wake word processing');
    assert.deepEqual(events.ofType('final'), [], 'muted: no transcription');
    assert.equal(asr.capturing, false, 'muted: no capture');
    asr.setMuted(false);
    assert.equal(asr.muted, false);
  } finally {
    await asr.stop();
  }
});

test('wakeGiveUpMs is hot-changeable via applyRuntimeConfig', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const manual = manualSource();
  const { asr, events } = startModule({ asrOverrides: { wakeGiveUpMs: 5000 }, source: manual });
  await asr.start();
  try {
    assert.equal(asr.wakeGiveUpMs, 5000);
    const res = asr.applyRuntimeConfig({ wakeGiveUpMs: 400 });
    assert.deepEqual(res.applied, ['wakeGiveUpMs']);
    assert.deepEqual(res.restartRequired, []);
    assert.equal(asr.wakeGiveUpMs, 400);
    asr.beginCapture();
    manual.push(silence(600)); // > hot-changed 400ms, far below the old 5000
    await events.waitFor((e) => e.type === 'giveUp', 3000, 'give-up with hot-changed window');
    assert.deepEqual(events.ofType('final'), []);
    // shortcut setter too
    asr.setWakeGiveUpMs(1200);
    assert.equal(asr.wakeGiveUpMs, 1200);
    assert.ok(asr.modelInfo.wakeGiveUpMs === 1200);
  } finally {
    await asr.stop();
  }
});

test('tap does not end an already-running capture by itself', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const portal = fakePortal();
  const manual = manualSource();
  const { asr, events } = startModule({
    asrOverrides: { hotkey: 'F9', longPressMs: 120, wakeCaptureFallbackMs: 0, wakeCooldownMs: 0, wakeGiveUpMs: 5000 },
    source: manual,
    hotkeyConnectFn: async () => portal.conn,
  });
  await asr.start();
  try {
    await waitUntil(() => asr.hotkeyState?.state === 'bound', 3000, 'hotkey bound');
    // capture is already running (e.g. the daemon started it after a UI wake)
    asr.beginCapture();
    assert.equal(asr.capturing, true);
    portal.press();
    await sleep(30);
    portal.release();
    await sleep(120);
    assert.equal(events.ofType('tap').length, 1, 'tap callback fired');
    assert.equal(asr.capturing, true, 'tap must not implicitly end the capture (daemon decides)');
    assert.deepEqual(events.ofType('final'), []);
  } finally {
    await asr.stop();
  }
});
