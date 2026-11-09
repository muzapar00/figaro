// Microphone gain auto-calibration + level watchdog tests.
// Everything is injected: no real amixer, no real microphone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMicGainController, parseAmixerSget } from '../../src/voice/asr/mic-gain.js';

const SGET = (gain) => `Simple mixer control 'Capture',0
  Capabilities: cvolume cswitch
  Capture channels: Front Left - Front Right
  Limits: Capture 0 - 63
  Front Left: Capture ${gain} [${Math.round((gain / 63) * 100)}%] [${(gain * 30) / 63}dB] [on]
  Front Right: Capture ${gain} [${Math.round((gain / 63) * 100)}%] [${(gain * 30) / 63}dB] [on]
`;

function fakeAmixer(initialGain = 63) {
  const state = { gain: initialGain, sets: [], fail: false };
  const run = async (cmd, args) => {
    if (state.fail) return { ok: false, stderr: 'amixer: Control default element not found' };
    if (args[2] === 'sget') return { ok: true, stdout: SGET(state.gain) };
    if (args[2] === 'sset') {
      // raw write (no '%') after the fix; tolerate a '%' for older expectations
      const raw = Number(String(args[4] ?? args[3]).replace('%', ''));
      state.gain = raw;
      state.sets.push(raw);
      return { ok: true, stdout: SGET(state.gain) };
    }
    return { ok: false, stderr: `unexpected: ${cmd} ${args.join(' ')}` };
  };
  return { state, run };
}

/** measure() stub: yields queued windows in order. */
function fakeMeasure(windows) {
  let i = 0;
  return async () => {
    const w = windows[Math.min(i, windows.length - 1)];
    i += 1;
    return w;
  };
}

test('parseAmixerSget understands the ALC897 Capture control format', () => {
  const parsed = parseAmixerSget(SGET(45));
  assert.equal(parsed.gain, 45);
  assert.equal(parsed.limits.max, 63);
  assert.equal(parseAmixerSget('garbage'), null);
  assert.equal(parseAmixerSget(''), null);
});

test('hot input (63) is stepped down and the log line is actionable', async () => {
  const amixer = fakeAmixer(63);
  const logs = [];
  const ctl = createMicGainController({ run: amixer.run, onLog: (m) => logs.push(m) });
  const hot = { rms: 0.17, peak: 0.98 }; // RMS ~5651 raw, exactly the reported failure
  const ok = { rms: 0.03, peak: 0.5 };
  const res = await ctl.calibrate(fakeMeasure([hot, ok]));
  assert.equal(res.adjusted, true);
  assert.equal(res.from, 63);
  assert.ok(res.to < 63);
  assert.ok(amixer.state.sets.length >= 1);
  assert.match(logs.join('\n'), /\[mic\] capture gain 63->45 \(RMS 5571->\d+\)/);
});

test('already sane gain is left untouched (idempotent)', async () => {
  const amixer = fakeAmixer(45);
  const logs = [];
  const ctl = createMicGainController({ run: amixer.run, onLog: (m) => logs.push(m) });
  const res = await ctl.calibrate(fakeMeasure([{ rms: 0.03, peak: 0.5 }]));
  assert.equal(res.adjusted, false);
  assert.deepEqual(amixer.state.sets, []);
  assert.match(logs.join('\n'), /capture gain ok at 45/);
});

test('very quiet input is raised, but never above the 63 max', async () => {
  const amixer = fakeAmixer(30);
  const logs = [];
  const ctl = createMicGainController({ run: amixer.run, onLog: (m) => logs.push(m) });
  const res = await ctl.calibrate(fakeMeasure([{ rms: 0.0004, peak: 0.01 }, { rms: 0.0004, peak: 0.01 }, { rms: 0.03, peak: 0.4 }]));
  assert.equal(res.adjusted, true);
  assert.ok(res.to <= 63);
  assert.ok(amixer.state.sets.length >= 1);
});

test('amixer unavailable: calibration warns once and never throws', async () => {
  const amixer = fakeAmixer(63);
  amixer.state.fail = true;
  const logs = [];
  const ctl = createMicGainController({ run: amixer.run, onLog: (m) => logs.push(m) });
  const res = await ctl.calibrate(fakeMeasure([{ rms: 0.1, peak: 0.5 }]));
  assert.equal(res.adjusted, false);
  assert.equal(ctl.available, false);
  assert.match(logs.join('\n'), /无法通过 amixer/);
  // subsequent calls are harmless
  assert.equal(await ctl.setGain(45), false);
});

test('runtime watchdog: sustained clipping warns once, not every window', () => {
  const warnings = [];
  const ctl = createMicGainController({ run: fakeAmixer(45).run, onLog: () => {} });
  const now = 1_000_000;
  for (let i = 0; i < 50; i++) {
    const w = ctl.observe(0.3, 0.99, now + i * 100);
    if (w) warnings.push(w);
  }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'MIC_CLIPPING');
  assert.match(warnings[0].message, /amixer -c 0 sset Capture 45%/);
  // within cooldown no repeat
  for (let i = 0; i < 50; i++) {
    const w = ctl.observe(0.3, 0.99, now + 1000 + i * 100);
    if (w) warnings.push(w);
  }
  assert.equal(warnings.length, 1);
});

test('runtime watchdog: 60 s of digital silence warns once', () => {
  const ctl = createMicGainController({ run: fakeAmixer(45).run, onLog: () => {} });
  let warnings = 0;
  let t = 0;
  for (let i = 0; i < 700; i++) { // 70 s of 100 ms chunks
    t += 100;
    const w = ctl.observe(0.0001, 0.001, 2_000_000 + t);
    if (w) { warnings += 1; assert.equal(w.code, 'MIC_SILENT'); }
  }
  assert.equal(warnings, 1);
});

test('runtime watchdog: normal levels never warn', () => {
  const ctl = createMicGainController({ run: fakeAmixer(45).run, onLog: () => {} });
  let warnings = 0;
  for (let i = 0; i < 600; i++) {
    const w = ctl.observe(0.02 + (i % 5) * 0.01, 0.3, 3_000_000 + i * 100);
    if (w) warnings += 1;
  }
  assert.equal(warnings, 0);
});

test('runtime clipping self-heals by dropping one gain step', async () => {
  const amixer = fakeAmixer(63);
  const logs = [];
  const ctl = createMicGainController({ run: amixer.run, onLog: (m) => logs.push(m) });
  const ok = await ctl.correctClipping();
  assert.equal(ok, true);
  assert.ok(amixer.state.gain < 63);
  assert.match(logs.join('\n'), /持续削波，自动下调/);
  // at the lowest sensible step it stops instead of muting the mic
  amixer.state.gain = 20;
  assert.equal(await ctl.correctClipping(), false);
});
