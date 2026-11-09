#!/usr/bin/env node
// Manual / acceptance harness for the F5 long-press global hotkey.
//
//   node scripts/asr-hotkey-test.mjs            # bind + listen (Ctrl-C to quit)
//   node scripts/asr-hotkey-test.mjs --seconds=600
//
// It prints the portal state. The FIRST run pops a KDE dialog asking to bind the
// shortcut to "figaro-talk"; click 允许/确定 once. After that, hold F5 >260 ms:
// you should see "LONGPRESS" then "RELEASE".
//
// This script is only a diagnostic tool; the daemon wires the same module
// through createAsr().

import { loadConfig } from '../src/config.js';
import { createHotkey } from '../src/voice/asr/hotkey.js';

const args = process.argv.slice(2);
const secondsArg = args.find((a) => a.startsWith('--seconds='));
const seconds = secondsArg ? Number(secondsArg.split('=')[1]) : 0; // 0 = forever

const config = loadConfig();
console.log('[hotkey-test] config.asr.hotkey =', JSON.stringify(config.asr.hotkey),
  ' longPressMs =', config.asr.longPressMs);

const t0 = Date.now();
const ts = () => `+${String(Date.now() - t0).padStart(6)}ms`;

const hotkey = createHotkey({
  config,
  onWake: () => console.log(ts(), 'LONGPRESS -> onWake() (唤醒 / beginCapture)'),
  onEnd: () => console.log(ts(), 'RELEASE -> onEnd() (endCapture)'),
  onError: (err) => console.log(ts(), 'ERROR', err.message),
  onLog: (msg) => console.log(ts(), 'LOG', msg),
  onState: (state) => console.log(ts(), 'STATE', state),
});

await hotkey.start();
console.log(ts(), 'start() returned; state =', hotkey.state, ' session =', hotkey.sessionPath);

function report() {
  console.log(ts(), 'state =', hotkey.state, ' bound =', hotkey.bound, ' session =', hotkey.sessionPath);
}

if (seconds > 0) {
  const iv = setInterval(report, 5000);
  setTimeout(async () => {
    clearInterval(iv);
    report();
    await hotkey.stop();
    console.log(ts(), 'stopped');
    process.exit(0);
  }, seconds * 1000);
} else {
  const iv = setInterval(report, 10000);
  process.on('SIGINT', async () => {
    clearInterval(iv);
    await hotkey.stop();
    process.exit(0);
  });
}
