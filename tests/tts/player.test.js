// PCM player tests: real child processes, but sinks are files / blocking
// commands so the test suite never touches the speakers.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createPlayer, resolvePlayerCommand, rmsOfPcm } from '../../src/voice/tts/player.js';
import {
  makeTempDir,
  fileSinkCommand,
  blockingSinkCommand,
  fileSize,
  readFile,
  trackedCallbacks,
  delay,
  withTimeout,
} from './helpers.js';

function sinePcm(totalBytes, amplitude = 16000) {
  const buf = Buffer.alloc(totalBytes);
  for (let i = 0; i + 1 < totalBytes; i += 2) {
    const v = Math.round(amplitude * Math.sin((i / 2) * 0.2));
    buf.writeInt16LE(v, i);
  }
  return buf;
}

function makePlayer(opts) {
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const player = createPlayer({
    ...opts,
    onExit: (info) => {
      opts.onExit?.(info);
      resolveExit(info);
    },
  });
  player.waitExit = () => withTimeout(exitPromise, 3000, 'player exit');
  return player;
}

test('resolvePlayerCommand honours an explicit command config', () => {
  const { command, source } = resolvePlayerCommand({ command: ['my-player', '--flag', 'x'], sampleRate: 32000 });
  assert.equal(source, 'config');
  assert.deepEqual(command, ['my-player', '--flag', 'x']);
});

test('resolvePlayerCommand falls back to "none" when PATH has no player', () => {
  const prev = process.env.PATH;
  process.env.PATH = '';
  try {
    const resolved = resolvePlayerCommand({ sampleRate: 32000 });
    assert.equal(resolved.command, null);
    assert.equal(resolved.source, 'none');
  } finally {
    process.env.PATH = prev;
  }
});

test('writes PCM to a real child process and reports RMS levels', async (t) => {
  const dir = makeTempDir();
  const sink = path.join(dir, 'pcm.bin');
  const calls = trackedCallbacks();
  const player = makePlayer({
    sampleRate: 32000,
    command: fileSinkCommand(sink),
    sliceMs: 32,
    onLevel: calls.onLevel,
    onError: calls.onError,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const pcm = sinePcm(4096, 16000);
  assert.equal(player.write(pcm), true);
  player.end();
  const info = await player.waitExit();
  assert.equal(info.expected, true);
  assert.equal(fileSize(sink), pcm.length);
  assert.ok(readFile(sink).equals(pcm));

  await delay(50);
  assert.ok(calls.levels.length >= 1, 'expected at least one level callback');
  const loud = calls.levels.map((l) => l.value).filter((v) => v > 0.2);
  assert.ok(loud.length >= 1, `expected a non-trivial RMS level, got ${JSON.stringify(calls.levels)}`);
  // 16-bit sine at amplitude 16000 => RMS/32768 ~= 0.345
  assert.ok(Math.abs(loud[0] - 0.345) < 0.06, `unexpected RMS level ${loud[0]}`);
  assert.equal(calls.errors.length, 0);
  assert.equal(player.alive, false);
});

test('rmsOfPcm is 0 for silence and ~0.345 for a 0.5-scale sine', () => {
  assert.equal(rmsOfPcm(Buffer.alloc(2048)), 0);
  const rms = rmsOfPcm(sinePcm(2048, 16384));
  assert.ok(Math.abs(rms - 16384 / Math.SQRT2 / 32768) < 0.02, `rms=${rms}`);
});

test('levels are paced on a playback timeline, not at network speed', async (t) => {
  const dir = makeTempDir();
  const sink = path.join(dir, 'pcm.bin');
  const calls = trackedCallbacks();
  const player = createPlayer({
    sampleRate: 32000,
    command: fileSinkCommand(sink),
    sliceMs: 64,
    onLevel: calls.onLevel,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  player.write(sinePcm(4096));
  player.write(sinePcm(4096)); // 2 x 64ms slices written instantly
  await delay(220);
  assert.ok(calls.levels.length >= 2, `expected >= 2 paced levels, got ${calls.levels.length}`);
  const gapMs = calls.levels[1].at - calls.levels[0].at;
  assert.ok(gapMs >= 40, `levels must be spaced by playback time, got ${gapMs}ms`);
  player.kill();
});

test('kill() interrupts a blocked sink quickly and is idempotent', async (t) => {
  const calls = trackedCallbacks();
  const player = makePlayer({
    sampleRate: 32000,
    command: blockingSinkCommand(),
    sliceMs: 32,
    onLevel: calls.onLevel,
    onError: calls.onError,
  });
  t.after(() => player.kill());

  assert.equal(player.write(sinePcm(4096)), true);
  await delay(30);
  const tKill = performance.now();
  player.kill();
  const info = await player.waitExit();
  const elapsed = performance.now() - tKill;
  assert.equal(info.expected, true);
  assert.ok(info.killLatencyMs !== null && info.killLatencyMs < 200, `kill latency ${info.killLatencyMs}`);
  assert.ok(elapsed < 500, `exit after kill took ${elapsed}ms`);
  assert.equal(player.alive, false);
  assert.equal(player.write(sinePcm(16)), false);
  player.kill(); // idempotent
});

test('spawn failure is reported via onError, never thrown', async (t) => {
  const calls = trackedCallbacks();
  const player = createPlayer({
    sampleRate: 32000,
    command: ['/nonexistent/figaro-player-xyz'],
    onError: calls.onError,
  });
  t.after(() => player.kill());
  player.write(sinePcm(64)); // may return true before the async spawn error lands
  await delay(100);
  assert.ok(calls.errors.length >= 1, 'expected an onError for the failed spawn');
  assert.equal(player.alive, false);
  assert.equal(player.write(sinePcm(64)), false);
});
