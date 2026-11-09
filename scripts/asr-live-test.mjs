#!/usr/bin/env node
// Live acceptance harness: real microphone + real F5 global hotkey.
//
//   node scripts/asr-live-test.mjs --seconds=600
//
// It starts the same createAsr() the daemon uses, with config.asr.hotkey=F5 and
// the real parec microphone. Logs every callback with timestamps:
//   - hotkeyState  (bound = F5 available)
//   - WAKE (source: hotkey / kws)     -> should fire on hold >= longPressMs
//   - VAD  / PARTIAL / FINAL          -> hold F5, say a command, release
//
// Use this to manually verify: long-press F5, speak, release -> FINAL text.
// Short taps of F5 must NOT produce WAKE.

import { execSync } from 'node:child_process';

import { loadConfig } from '../src/config.js';
import { createAsr } from '../src/voice/asr/index.js';

const args = process.argv.slice(2);
const secondsArg = args.find((a) => a.startsWith('--seconds='));
const seconds = secondsArg ? Number(secondsArg.split('=')[1]) : 600;

const config = loadConfig();
console.log(`[live] node=${process.version} hotkey=${JSON.stringify(config.asr.hotkey)} longPressMs=${config.asr.longPressMs}`);
console.log(`[live] models: kws=${config.asr.kwsModelDir} stream=${config.asr.streamingModelDir} offline=${config.asr.offlineModelDir}`);

const t0 = Date.now();
const ts = () => `+${String(Date.now() - t0).padStart(6)}ms`;
let lastLevel = 0;
const wakes = [];
const finals = [];
const partis = [];
let lastPartialPrinted = '';

const asr = createAsr({
  config,
  onWake: () => { wakes.push(Date.now()); console.log(ts(), 'WAKE', `#${wakes.length}`, '(hotkey 长按 或 唤醒词)'); },
  onLevel: (v) => { lastLevel = v; },
  onPartial: (text) => {
    partis.push(text);
    if (text !== lastPartialPrinted) { lastPartialPrinted = text; console.log(ts(), 'PARTIAL', JSON.stringify(text)); }
  },
  onVadStart: () => console.log(ts(), 'VAD_START'),
  onFinal: (text) => { finals.push(text); console.log(ts(), 'FINAL', JSON.stringify(text)); },
  onError: (err) => console.log(ts(), 'ERROR', err.message, err.code ? `[${err.code}]` : ''),
  onLog: (msg) => console.log(ts(), 'LOG', msg),
});

try {
  await asr.start();
  console.log(ts(), 'READY state=', asr.state, 'hotkey=', JSON.stringify(asr.hotkeyState));
} catch (err) {
  console.log(ts(), 'START FAILED', err.message);
  process.exit(2);
}

const parecCount = () => {
  try {
    return Number(execSync('pgrep -c -f "parec --format=s16le" || true').toString().trim() || 0);
  } catch { return -1; }
};

const iv = setInterval(() => {
  console.log(ts(), 'STATUS state=', asr.state, 'capturing=', asr.capturing, 'hotkey=', JSON.stringify(asr.hotkeyState),
    'level=', lastLevel.toFixed(3), 'wakes=', wakes.length, 'finals=', finals.length, 'parec=', parecCount());
}, 10000);

await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
clearInterval(iv);
console.log(ts(), 'STOPPING…');
await asr.stop();
await new Promise((r) => setTimeout(r, 300));
console.log(ts(), 'STOPPED state=', asr.state, 'parec processes=', parecCount());
console.log('[live] summary:', JSON.stringify({
  node: process.version,
  wakes: wakes.length,
  finals,
  partialUpdates: partis.length,
  errors: undefined,
}, null, 0));
process.exit(0);
