// Degraded-path tests: the daemon must keep running on machines without a
// microphone, without models, or with a broken portal bus. Every failure has to
// surface through onError and/or a rejected start() — never an uncaught throw.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createAsr } from '../../src/voice/asr/index.js';
import { createErrorSource } from '../../src/voice/asr/sources.js';
import { makeConfig, modelsAvailable, skipMessage, recorder, arraySource, silence, waitUntil } from './helpers.js';

test('missing wake-word model: start() rejects cleanly, onError fires, stop() is safe', async () => {
  const config = makeConfig({ asr: { hotkey: '', kwsModelDir: 'models/does-not-exist-kws' } });
  const errors = [];
  const asr = createAsr({
    config,
    hotkey: false,
    source: createErrorSource(new Error('should not be reached')),
    onError: (err) => errors.push(err),
    onLog: () => {},
  });
  await assert.rejects(
    () => asr.start(),
    (err) => err.code === 'ASR_MODELS_MISSING' || /唤醒词模型缺失/.test(err.message),
  );
  assert.equal(asr.state, 'failed');
  assert.ok(errors.some((e) => /唤醒词模型缺失/.test(e.message)));
  await asr.stop(); // must not throw
});

test('missing transcription models (KWS present): start() rejects cleanly', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const config = makeConfig({
    asr: {
      hotkey: '',
      streamingModelDir: 'models/does-not-exist-stream',
      offlineModelDir: 'models/does-not-exist-offline',
    },
  });
  const errors = [];
  const asr = createAsr({
    config,
    hotkey: false,
    source: createErrorSource(new Error('should not be reached')),
    onError: (err) => errors.push(err),
    onLog: () => {},
  });
  await assert.rejects(() => asr.start(), /转写模型缺失/);
  assert.equal(asr.state, 'failed');
  assert.ok(errors.some((e) => /转写模型缺失/.test(e.message)));
  await asr.stop();
});

test('microphone that cannot start: start() rejects with ASR_MIC_UNAVAILABLE', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const config = makeConfig({ asr: { hotkey: '' } });
  const errors = [];
  const asr = createAsr({
    config,
    hotkey: false,
    source: createErrorSource(new Error('no /dev/snd and no pulse server')),
    onError: (err) => errors.push(err),
    onLog: () => {},
  });
  await assert.rejects(
    () => asr.start(),
    (err) => err.code === 'ASR_MIC_UNAVAILABLE' || /麦克风不可用/.test(err.message),
  );
  assert.equal(asr.state, 'failed');
  assert.ok(errors.some((e) => /麦克风不可用/.test(e.message)));
  await assert.doesNotReject(() => asr.stop());
});

test('missing parec binary: real parec source fails through onError, no crash', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const oldPath = process.env.PATH;
  process.env.PATH = '/nonexistent-figaro-test-bin';
  const config = makeConfig({ asr: { hotkey: '' } });
  const errors = [];
  const asr = createAsr({
    config,
    hotkey: false,
    onError: (err) => errors.push(err),
    onLog: () => {},
  });
  try {
    await assert.rejects(() => asr.start(), /麦克风不可用|parec/);
    assert.equal(asr.state, 'failed');
    assert.ok(errors.length >= 1);
    assert.match(errors.map((e) => e.message).join('\n'), /parec|麦克风/);
  } finally {
    process.env.PATH = oldPath;
    await asr.stop();
  }
});

test('microphone dying mid-stream flips the module to failed and reports onError', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const config = makeConfig({ asr: { hotkey: '' } });
  const errors = [];
  const asr = createAsr({
    config,
    hotkey: false,
    onError: (err) => errors.push(err),
    onLog: () => {},
    source: ({ onPcm, onFatal }) => ({
      async start() {
        onPcm(silence(100));
        setTimeout(() => onFatal(new Error('parec 挂了（模拟）')), 20);
      },
      async stop() {},
    }),
  });
  await asr.start();
  assert.equal(asr.state, 'listening');
  await waitUntil(() => asr.state === 'failed', 2000, 'failed state after mic crash');
  assert.ok(errors.some((e) => /parec 挂了/.test(e.message)));
  await asr.stop();
});

test('portal unavailable: voice path still starts, F5 reports a non-fatal error', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const oldBus = process.env.DBUS_SESSION_BUS_ADDRESS;
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/tmp/figaro-no-such-bus-${process.pid}`;
  const config = makeConfig({ asr: { hotkey: 'F5' } });
  const errors = [];
  const events = recorder();
  const asr = createAsr({
    config,
    source: arraySource(silence(800)),
    onError: (err) => { errors.push(err); events.push({ type: 'error', message: err.message }); },
    onLog: () => {},
  });
  try {
    await asr.start(); // must resolve: voice wake word still works
    assert.equal(asr.state, 'listening');
    await events.waitFor((e) => e.type === 'error', 3000, 'hotkey error');
    assert.ok(errors.some((e) => /F5|D-Bus|总线/.test(e.message)));
    assert.equal(asr.hotkeyState.state, 'unavailable');
  } finally {
    if (oldBus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = oldBus;
    await asr.stop();
  }
});

test('hotkey disabled by config: module runs wake-word-only', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const config = makeConfig({ asr: { hotkey: '' } });
  const asr = createAsr({
    config,
    source: arraySource(silence(300)),
    onError: () => {},
    onLog: () => {},
  });
  await asr.start();
  try {
    assert.equal(asr.state, 'listening');
    assert.equal(asr.hotkeyState, null);
  } finally {
    await asr.stop();
  }
});
