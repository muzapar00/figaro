// UI sound-effect module tests.
//
// No sound card and no real audio is used: every test injects a "player" that
// writes the PCM it would have played into a temp file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSfx,
  decodeWav,
  scaleS16,
  DEFAULT_EVENTS,
  DEFAULT_SFX_DIR,
  TARGET_RATE,
} from '../../src/voice/sfx/index.js';
import {
  makeTempDir,
  fileSinkCommand,
  fakeSinkProbe,
  trackedLogger,
  fileSize,
  readFile,
  delay,
} from './helpers.js';

const ASSET_DIR = DEFAULT_SFX_DIR;

function assetPcm(name) {
  const decoded = decodeWav(fs.readFileSync(path.join(ASSET_DIR, `${name}.wav`)));
  assert.equal(decoded.sampleRate, TARGET_RATE);
  assert.equal(decoded.channels, 1);
  return decoded.pcm;
}

function createSfxForTest(t, { sfx = {}, config = {}, files = null } = {}) {
  const dir = makeTempDir();
  const sinkFile = path.join(dir, 'played.pcm');
  const { logger, lines } = trackedLogger();
  const soundsDir = files
    ? files
    : null;
  const module_ = createSfx({
    config: {
      ...config,
      tts: { sink: '', ...(config.tts || {}) },
      sfx: { enabled: true, volume: 0.35, dir: soundsDir, ...sfx },
    },
    logger,
    sinkProbe: fakeSinkProbe,
    playerCommand: fileSinkCommand(sinkFile),
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { sfx: module_, sinkFile, lines };
}

test('names() exposes the five generated sounds and the module is enabled', (t) => {
  const { sfx } = createSfxForTest(t);
  assert.deepEqual(sfx.names(), ['answer-done', 'dismiss', 'error', 'listen-end', 'listen-start']);
  assert.equal(sfx.enabled, true);
  assert.equal(sfx.configured, true);
  assert.deepEqual(sfx.available, sfx.names());
  assert.deepEqual(
    sfx.events,
    DEFAULT_EVENTS,
  );
  assert.deepEqual(sfx.stats.sounds, sfx.names());
});

test('play() writes the scaled PCM of the right sound', async (t) => {
  const { sfx, sinkFile } = createSfxForTest(t);
  const result = await sfx.play('listen-start');
  assert.equal(result.played, true);
  assert.equal(result.name, 'listen-start');
  assert.equal(result.durationMs, 80);
  assert.ok(result.processMs >= 0);

  const expected = scaleS16(assetPcm('listen-start'), 0.35);
  const written = readFile(sinkFile);
  assert.equal(written.length, expected.length);
  assert.ok(written.equals(expected), 'played PCM must be the asset scaled by sfx.volume');
  assert.equal(sfx.stats.plays, 1);
  assert.equal(sfx.stats.failures, 0);
  assert.equal(sfx.stats.lastPlayedName, 'listen-start');
  assert.equal(sfx.stats.lastPlayedMs, 80);
  assert.ok(sfx.stats.lastPlayedAt !== null && Date.now() - sfx.stats.lastPlayedAt < 2000);
});

test('per-call volume multiplies the configured volume', async (t) => {
  const { sfx, sinkFile } = createSfxForTest(t, { sfx: { volume: 1.0 } });
  const result = await sfx.play('answer-done', { volume: 0.5 });
  assert.equal(result.played, true);
  const expected = scaleS16(assetPcm('answer-done'), 0.5);
  assert.ok(readFile(sinkFile).equals(expected));

  // peak amplitude ratio must be ~0.5 of the unscaled asset
  const written = readFile(sinkFile);
  const peakOf = (buf) => {
    let peak = 0;
    for (let i = 0; i + 1 < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
    return peak;
  };
  const assetPeak = peakOf(assetPcm('answer-done'));
  assert.ok(Math.abs(peakOf(written) / assetPeak - 0.5) < 0.02);
});

test('per-sound volume overrides from config apply', async (t) => {
  const { sfx, sinkFile } = createSfxForTest(t, { sfx: { volume: 1.0, volumes: { 'listen-start': 0.5 } } });
  await sfx.play('listen-start', { volume: 0.5 }); // 1.0 * 0.5 (config) * 0.5 (call)
  const expected = scaleS16(assetPcm('listen-start'), 0.25);
  assert.ok(readFile(sinkFile).equals(expected));
});

test('enabled:false is a silent no-op and spawns nothing', async (t) => {
  const { sfx, sinkFile } = createSfxForTest(t, { sfx: { enabled: false } });
  assert.equal(sfx.enabled, false);
  assert.equal(sfx.configured, false);
  const result = await sfx.play('listenStart');
  assert.deepEqual(result, { name: 'listenStart', played: false, reason: 'disabled' });
  assert.equal(fileSize(sinkFile), 0);
  assert.equal(sfx.stats.plays, 0);
  assert.equal(sfx.stats.failures, 0);
});

test('missing sound files fail silently and count a failure', async (t) => {
  const emptyDir = makeTempDir('figaro-sfx-empty-');
  t.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));
  const { sfx, sinkFile, lines } = createSfxForTest(t, { sfx: { dir: emptyDir } });
  assert.deepEqual(sfx.names(), []);
  assert.equal(sfx.enabled, false);

  // event name resolves to the default sound name, which is missing
  const result = await sfx.play('listenStart');
  assert.equal(result.played, false);
  assert.equal(result.reason, 'missing');
  assert.equal(sfx.stats.failures, 1);
  assert.match(sfx.stats.lastError, /missing/i);
  assert.equal(fileSize(sinkFile), 0);
  assert.ok(lines.some((l) => l[0] === 'warn' && l.join(' ').includes('missing')), JSON.stringify(lines));

  // calling again is still silent, but does not double-warn
  const before = lines.length;
  const again = await sfx.play('listenStart');
  assert.equal(again.played, false);
  assert.equal(lines.length, before, 'warn-once per problem');
});

test('unknown sound names are skipped without throwing', async (t) => {
  const { sfx, sinkFile } = createSfxForTest(t);
  const result = await sfx.play('does-not-exist');
  assert.equal(result.played, false);
  assert.equal(result.reason, 'unknown');
  assert.equal(sfx.stats.skipped, 1);
  assert.equal(sfx.stats.failures, 0);
  assert.equal(fileSize(sinkFile), 0);
});

test('events.* can disable an event or remap it to another sound', async (t) => {
  const { sfx, sinkFile } = createSfxForTest(t, {
    sfx: { events: { listenStart: false, answerDone: 'listen-start' } },
  });
  const disabled = await sfx.play('listenStart');
  assert.equal(disabled.played, false);
  assert.equal(disabled.reason, 'event-disabled');
  assert.equal(fileSize(sinkFile), 0);

  const remapped = await sfx.play('answerDone');
  assert.equal(remapped.played, true);
  assert.equal(remapped.name, 'listen-start');
  assert.ok(readFile(sinkFile).equals(scaleS16(assetPcm('listen-start'), 0.35)));
});

test('repeated plays of the same sound are throttled', async (t) => {
  const { sfx } = createSfxForTest(t, { sfx: { throttleMs: 500 } });
  const first = await sfx.play('dismiss');
  const second = await sfx.play('dismiss');
  assert.equal(first.played, true);
  assert.equal(second.played, false);
  assert.equal(second.reason, 'throttled');
  assert.equal(sfx.stats.plays, 1);
  assert.equal(sfx.stats.skipped, 1);
});

test('volume 0 / muted is a no-op (no process spawned)', async (t) => {
  const { sfx, sinkFile } = createSfxForTest(t, { sfx: { volume: 0 } });
  const result = await sfx.play('error');
  assert.equal(result.played, false);
  assert.equal(result.reason, 'muted');
  assert.equal(fileSize(sinkFile), 0);
});

test('play() never rejects: spawn failures become stats.failures', async (t) => {
  const { logger } = trackedLogger();
  const sfx = createSfx({
    config: { sfx: { enabled: true, volume: 1 }, tts: { sink: '' } },
    logger,
    sinkProbe: fakeSinkProbe,
    playerCommand: ['/nonexistent/figaro-sfx-player'],
  });
  const result = await sfx.play('listen-start');
  assert.equal(result.played, false);
  assert.equal(result.reason, 'spawn-error');
  assert.equal(sfx.stats.failures, 1);
});

test('non-zero player exit is a silent failure', async (t) => {
  const broken = createSfx({
    config: { sfx: { enabled: true, volume: 1 }, tts: { sink: '' } },
    logger: null,
    sinkProbe: fakeSinkProbe,
    playerCommand: ['bash', '-c', 'cat > /dev/null; exit 3'],
  });
  const result = await broken.play('listen-end');
  assert.equal(result.played, false);
  assert.equal(result.reason, 'player-exit');
  assert.equal(broken.stats.failures, 1);
});

test('command carries --target from tts.sink; sfx.sink overrides it', (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fromTts = createSfx({
    config: { tts: { sink: 'fake-sink-hdmi' }, sfx: { enabled: true } },
    logger: null,
    sinkProbe: fakeSinkProbe,
  });
  assert.ok(fromTts.stats.command.some((arg) => arg === '--target=fake-sink-hdmi'), JSON.stringify(fromTts.stats.command));
  assert.ok(fromTts.stats.command.some((arg) => arg === '--rate=32000'));

  const ownSink = createSfx({
    config: { tts: { sink: 'fake-sink-hdmi' }, sfx: { enabled: true, sink: 'fake-sink-analog' } },
    logger: null,
    sinkProbe: fakeSinkProbe,
  });
  assert.ok(ownSink.stats.command.includes('--target=fake-sink-analog'));

  const noSink = createSfx({
    config: { tts: { sink: '' }, sfx: { enabled: true } },
    logger: null,
    sinkProbe: fakeSinkProbe,
  });
  assert.ok(!noSink.stats.command.some((arg) => arg.startsWith('--target')));
});

test('decodeWav accepts the generated assets and rejects non-WAV data', () => {
  const asset = decodeWav(fs.readFileSync(path.join(ASSET_DIR, 'listen-start.wav')));
  assert.equal(asset.sampleRate, 32000);
  assert.equal(asset.channels, 1);
  assert.equal(asset.pcm.length, 80 * 32 * 2);

  assert.throws(() => decodeWav(Buffer.alloc(10)), /too short/);
  assert.throws(() => decodeWav(Buffer.from('not a wav file at all!......................')), /RIFF|WAVE/);

  // valid RIFF/WAVE but 8-bit PCM -> rejected with a clear message
  const bad = Buffer.alloc(44 + 8);
  bad.write('RIFF', 0);
  bad.writeUInt32LE(36 + 8, 4);
  bad.write('WAVE', 8);
  bad.write('fmt ', 12);
  bad.writeUInt32LE(16, 16);
  bad.writeUInt16LE(1, 20); // PCM
  bad.writeUInt16LE(1, 22); // mono
  bad.writeUInt32LE(32000, 24);
  bad.writeUInt32LE(32000, 28);
  bad.writeUInt16LE(1, 32);
  bad.writeUInt16LE(8, 34); // 8 bits
  bad.write('data', 36);
  bad.writeUInt32LE(8, 40);
  assert.throws(() => decodeWav(bad), /bit depth 8/);
});

test('scaleS16 clamps instead of wrapping', () => {
  const input = Buffer.alloc(8);
  input.writeInt16LE(20000, 0);
  input.writeInt16LE(-20000, 2);
  input.writeInt16LE(100, 4);
  input.writeInt16LE(0, 6);
  const out = scaleS16(input, 2.0);
  assert.equal(out.readInt16LE(0), 32767);
  assert.equal(out.readInt16LE(2), -32768);
  assert.equal(out.readInt16LE(4), 200);
  assert.equal(out.readInt16LE(6), 0);
  assert.equal(scaleS16(input, 1), input);
});

test('play() is safe when the sound directory does not exist', async (t) => {
  const { sfx, lines } = createSfxForTest(t, { sfx: { dir: '/nonexistent/figaro-sfx-dir' } });
  assert.deepEqual(sfx.names(), []);
  assert.equal(sfx.enabled, false);
  const result = await sfx.play('listenStart');
  assert.equal(result.played, false);
  assert.ok(lines.some((l) => l[0] === 'warn' && l.join(' ').includes('sound directory not found')));
});
