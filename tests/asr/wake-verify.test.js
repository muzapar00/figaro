// Two-stage wake verification (task-7): a KWS hit only wakes after the buffered
// wake word is confirmed by the offline paraformer; near-miss phrases are
// rejected; failures/timeouts pass (fail open).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeVerifyWakeConfig, normalizeWakeText, matchWakeText, VERIFY_DEFAULTS, POST_ROLL_MS } from '../../src/voice/asr/wake-verify.js';
import { createAsr } from '../../src/voice/asr/index.js';
import { makeConfig, modelsAvailable, loadFixture, skipMessage, recorder, arraySource, silence, concat, waitUntil } from './helpers.js';

const ROOT = () => makeConfig().paths.root;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readWav(file) {
  const b = fs.readFileSync(file);
  let off = 12;
  let fmt = null;
  let ds = 0;
  let dl = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(body + 2) };
    if (id === 'data') { ds = body; dl = size; }
    off = body + size + (size % 2);
  }
  const n = Math.floor(dl / 2 / fmt.ch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(ds + i * 2 * fmt.ch) / 32768;
  return out;
}

function nearMiss(id) {
  const dir = path.join(ROOT(), 'models/wake-negatives');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const entry = manifest.find((m) => m.id === id);
  return readWav(path.join(dir, entry.file));
}

/** clip with 300 ms lead-in and trailing silence so the post-roll can be collected. */
function withSilence(clip, leadMs = 300, tailMs = 3500) {
  return concat([silence(leadMs), clip, silence(tailMs)]);
}

// Verification is opt-in in the shipped defaults, so these tests enable it
// explicitly; individual tests can still override (e.g. shorter timeouts).
function startModule({ pcm, asrOverrides = {}, sourceDelay = 100 } = {}) {
  const events = recorder();
  const config = makeConfig({
    asr: {
      hotkey: '',
      wakeCaptureFallbackMs: 60000,
      wakeCooldownMs: 0,
      verifyWake: { enabled: true, timeoutMs: 1800 },
      ...asrOverrides,
    },
  });
  const source = ({ onPcm }) => {
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
          if (off < pcm.length) timer = setTimeout(pump, sourceDelay);
        };
        pump();
      },
      async stop() { cancelled = true; clearTimeout(timer); },
    };
  };
  const asr = createAsr({
    config,
    hotkey: false,
    micGain: false,
    source,
    onWake: () => events.push({ type: 'wake' }),
    onLevel: () => {},
    onPartial: () => {},
    onFinal: (text) => events.push({ type: 'final', text }),
    onError: (err) => events.push({ type: 'error', message: err.message }),
    onLog: () => {},
  });
  return { asr, events };
}

// ------------------------------------------------------------------ unit
test('normalizeWakeText strips punctuation/space and lowercases', () => {
  assert.equal(normalizeWakeText('费加罗，现在几点了？'), '费加罗现在几点了');
  assert.equal(normalizeWakeText('Hey, Figaro!'), 'heyfigaro');
  assert.equal(normalizeWakeText(null), '');
});

test('wake transcript matching accepts Chinese full/short and English variants', () => {
  for (const text of ['费加罗', '费伽罗', '菲加罗', '飞加罗', '肥加罗', '你好费伽罗', '费伽罗现在几点了', '费加', '嗯，菲加']) {
    assert.equal(matchWakeText(text, { lang: 'zh' }).ok, true, text);
  }
  for (const text of ['非加强管理', '咖啡加糖', '这次非常加急要今天完成', '费用加起来一共三百块', '缴费加紧办理一下', '非法加班是不允许的', '小爱同学关灯', '']) {
    assert.equal(matchWakeText(text, { lang: 'zh' }).ok, false, text);
  }
  // English hit: known figaro-ish text matches, anything else fails open
  assert.equal(matchWakeText('figure all', { lang: 'en' }).ok, true);
  assert.equal(matchWakeText('飞哥路', { lang: 'en' }).ok, true);
  assert.equal(matchWakeText('被押了', { lang: 'en' }).ok, true);
  assert.equal(matchWakeText('被押了', { lang: 'en' }).reason, 'en-fail-open');
  assert.equal(matchWakeText('非加强管理', { lang: 'en' }).ok, true, 'English never rejected');
});

test('normalizeVerifyWakeConfig defaults and clamping', () => {
  assert.deepEqual(normalizeVerifyWakeConfig({}), { ...VERIFY_DEFAULTS });
  const c = normalizeVerifyWakeConfig({ enabled: false, timeoutMs: 50 });
  assert.equal(c.enabled, false);
  assert.equal(c.timeoutMs, 200, 'timeout clamped to >=200ms');
  assert.ok(POST_ROLL_MS >= 200 && POST_ROLL_MS <= 500);
});

// ------------------------------------------------------------- module level
test('near-miss phrase rejected by verification (no wake, no capture, no cooldown)', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const pcm = withSilence(nearMiss('neg29')); // KWS hits 菲加 on「咖啡加糖」
  const { asr, events } = startModule({ pcm });
  await asr.start();
  try {
    await sleep(3500);
    assert.deepEqual(events.ofType('wake'), [], 'near-miss must not wake');
    assert.equal(asr.capturing, false);
    assert.deepEqual(events.ofType('final'), []);
    const stats = asr.modelInfo.verifyStats;
    assert.ok(stats.rejected >= 1, `expected rejected verify, got ${JSON.stringify(stats)}`);
    assert.equal(stats.lastVerify.ok, false);
    assert.match(stats.lastVerify.text, /咖啡|加糖/);
  } finally {
    await asr.stop();
  }
});

test('Chinese wake word still wakes after verification (accepted + latency recorded)', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const clip = loadFixture('wake-nijialuo-male');
  const pcm = withSilence(clip.samples);
  const { asr, events } = startModule({ pcm });
  await asr.start();
  try {
    await events.waitFor((e) => e.type === 'wake', 8000, 'verified Chinese wake');
    const stats = asr.modelInfo.verifyStats;
    assert.ok(stats.accepted >= 1);
    const last = stats.lastVerify;
    assert.equal(last.ok, true);
    assert.match(last.text, /费|菲|飞/);
    assert.ok(last.ms >= POST_ROLL_MS, 'verification waited for the post-roll');
    assert.equal(asr.modelInfo.verifyWake.enabled, true);
  } finally {
    await asr.stop();
  }
});

test('English wake word wakes after verification (never rejected)', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const clip = loadFixture('wake-en-figaro-man');
  const pcm = withSilence(clip.samples);
  const { asr, events } = startModule({ pcm });
  await asr.start();
  try {
    await events.waitFor((e) => e.type === 'wake', 8000, 'English wake with verification');
    assert.ok(asr.modelInfo.verifyStats.failOpen + asr.modelInfo.verifyStats.accepted >= 1);
  } finally {
    await asr.stop();
  }
});

test('verification fails open on timeout (wake is never lost)', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const clip = loadFixture('wake-nijialuo-male');
  const pcm = withSilence(clip.samples);
  // First verification must load the offline model (~0.6 s) => 250 ms timeout fires.
  const { asr, events } = startModule({ pcm, asrOverrides: { verifyWake: { enabled: true, timeoutMs: 250 } } });
  await asr.start();
  try {
    await events.waitFor((e) => e.type === 'wake', 8000, 'fail-open wake after timeout');
    const stats = asr.modelInfo.verifyStats;
    assert.ok(stats.failOpen >= 1, JSON.stringify(stats));
    assert.equal(stats.lastVerify.reason, 'timeout');
  } finally {
    await asr.stop();
  }
});

test('verifyWake can be hot-disabled via applyRuntimeConfig', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const { asr } = startModule({ pcm: new Float32Array(0) });
  // start() requires a source that emits nothing: fine, we only touch config.
  await asr.start();
  try {
    assert.equal(asr.verifyWake.enabled, true);
    const res = asr.applyRuntimeConfig({ verifyWake: { enabled: false } });
    assert.deepEqual(res.applied, ['verifyWake']);
    assert.equal(asr.verifyWake.enabled, false);
    assert.equal(asr.modelInfo.verifyWake.enabled, false);
    asr.setVerifyWake({ enabled: true, timeoutMs: 2000 });
    assert.equal(asr.verifyWake.enabled, true);
    assert.equal(asr.verifyWake.timeoutMs, 2000);
    assert.ok('lastVerify' in asr.modelInfo.verifyStats);
  } finally {
    await asr.stop();
  }
});

test('armWakeTest reports verification results in onEnd', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const clip = loadFixture('wake-nijialuo-male');
  const pcm = withSilence(clip.samples);
  const events = recorder();
  const config = makeConfig({
    asr: { hotkey: '', wakeCaptureFallbackMs: 60000, wakeCooldownMs: 0, verifyWake: { enabled: true, timeoutMs: 1800 } },
  });
  const asr = createAsr({
    config,
    hotkey: false,
    micGain: false,
    source: ({ onPcm }) => {
      let off = 0;
      let cancelled = false;
      let timer = null;
      return {
        async start() {
          const pump = () => {
            if (cancelled || off >= pcm.length) return;
            const end = Math.min(off + 1600, pcm.length);
            onPcm(pcm.subarray(off, end));
            off = end;
            if (off < pcm.length) timer = setTimeout(pump, 100);
          };
          pump();
        },
        async stop() { cancelled = true; clearTimeout(timer); },
      };
    },
    onWake: () => events.push({ type: 'wake' }),
    onLevel: () => {},
    onPartial: () => {},
    onFinal: () => {},
    onError: (err) => events.push({ type: 'error', message: err.message }),
    onLog: () => {},
  });
  await asr.start();
  try {
    const armed = asr.armWakeTest({ ms: 5000, onEnd: (res) => events.push({ type: 'wakeTestEnd', result: res }) });
    assert.ok(armed.keywords.length > 0);
    await events.waitFor((e) => e.type === 'wakeTestEnd', 8000, 'wake test end');
    const res = events.ofType('wakeTestEnd')[0].result;
    assert.ok(res.verify, 'onEnd carries verification summary');
    assert.ok(res.verify.accepted + res.verify.rejected + res.verify.failOpen >= 1, JSON.stringify(res.verify));
  } finally {
    await asr.stop();
  }
});
