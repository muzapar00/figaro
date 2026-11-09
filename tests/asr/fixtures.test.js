// Fixture-set integrity tests: the committed WAVs are the deterministic input
// for the wake/transcription tests, so they must be exactly as expected.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { FIXTURES, readManifest, readWav } from './helpers.js';

test('fixture manifest lists the complete tone/speaker matrix', () => {
  const manifest = readManifest();
  assert.equal(manifest.length, 20);
  const byTag = (tag) => manifest.filter((m) => m.tag === tag);
  assert.equal(byTag('wake').length, 8, '8 wake-word positives');
  assert.equal(byTag('neg').length, 7, '7 ordinary-speech negatives');
  assert.equal(byTag('cmd').length, 5, '5 capture/transcription sentences');
  for (const m of manifest) {
    assert.ok(m.text && m.voice && m.file, `incomplete manifest entry: ${JSON.stringify(m)}`);
  }
});

test('every fixture is a 16 kHz mono 16-bit WAV with the duration recorded in the manifest', (t) => {
  const manifest = readManifest();
  for (const entry of manifest) {
    const file = path.join(FIXTURES, entry.file);
    if (!fs.existsSync(file)) {
      t.diagnostic(`missing ${entry.file}`);
      assert.fail(`fixture file missing: ${entry.file} (run node scripts/gen-test-audio.mjs)`);
    }
    const wav = readWav(file);
    assert.equal(wav.sampleRate, 16000, `${entry.name}: sample rate`);
    const seconds = wav.samples.length / wav.sampleRate;
    assert.ok(seconds > 0.4 && seconds < 6, `${entry.name}: implausible duration ${seconds}`);
    assert.ok(Math.abs(seconds * 1000 - entry.durationMs) < 60, `${entry.name}: duration mismatch`);
    // Must not be digital silence (a silent TTS result would make wake tests vacuous).
    let peak = 0;
    for (const s of wav.samples) peak = Math.max(peak, Math.abs(s));
    assert.ok(peak > 0.05, `${entry.name}: peak ${peak.toFixed(3)} too quiet`);
  }
});

test('capture fixtures have a known expected transcript', () => {
  const manifest = readManifest();
  for (const entry of manifest.filter((m) => m.tag === 'cmd')) {
    assert.ok(entry.expect && entry.expect.length >= 4, `${entry.name} missing expect text`);
  }
});
