// Voiceprint gate: math, profile storage, and the degrade-safely rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createSpeakerGate,
  cosineSimilarity,
  saveProfile,
  loadProfile,
  defaultProfilePath,
} from '../../src/voice/asr/speaker.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figaro-speaker-'));
const vec = (...xs) => Float32Array.from(xs);
const quiet = () => {
  const pcm = new Float32Array(16000 * 1.2);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.sin(i / 11) * 0.05;
  return pcm;
};

test('cosineSimilarity: identical is 1, orthogonal is 0, mismatched sizes are 0', () => {
  assert.equal(cosineSimilarity(vec(1, 0), vec(1, 0)), 1);
  assert.equal(cosineSimilarity(vec(1, 0), vec(0, 1)), 0);
  assert.equal(cosineSimilarity(vec(1), vec(1, 0)), 0);
  assert.equal(cosineSimilarity(null, vec(1)), 0);
});

test('profile roundtrip keeps embeddings, threshold and dim', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'speaker-profile.json');
  saveProfile(file, {
    model: 'm.onnx',
    threshold: 0.7,
    embeddings: [vec(0.1, 0.2, 0.3), vec(0.2, 0.3, 0.4)],
  });
  const p = loadProfile(file);
  assert.equal(p.embeddings.length, 2);
  assert.equal(p.dim, 3);
  assert.equal(p.threshold, 0.7);
  assert.equal(p.model, 'm.onnx');
  assert.equal(p.speaker, 'owner');
  // file must be private (contains a biometric template)
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode & 0o077, 0, `profile mode ${mode.toString(8)} must be 0600`);
  }
});

test('disabled gate never blocks a wake', () => {
  const gate = createSpeakerGate({
    config: { asr: { speaker: { enabled: false } } },
    embedder: { preload: () => true, embed: () => vec(1, 0), modelPath: '/tmp/m', failure: null },
    profilePath: path.join(tmpDir(), 'none.json'),
  });
  const verdict = gate.verify(quiet());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.skipped, true);
  assert.equal(gate.enabled, false);
});

test('enabled but not enrolled still wakes (and says so)', () => {
  const gate = createSpeakerGate({
    config: { asr: { speaker: { enabled: true } } },
    embedder: { preload: () => true, embed: () => vec(1, 0), modelPath: '/tmp/m', failure: null },
    profilePath: path.join(tmpDir(), 'none.json'),
  });
  assert.equal(gate.verify(quiet()).skipped, true);
  assert.equal(gate.status().state, 'not-enrolled');
  assert.equal(gate.enabled, false);
});

test('enrolled gate accepts the owner and rejects another voice', () => {
  const dir = tmpDir();
  const profilePath = path.join(dir, 'profile.json');
  saveProfile(profilePath, { threshold: 0.65, embeddings: [vec(1, 0, 0), vec(0.98, 0.1, 0)] });
  const owner = createSpeakerGate({
    config: { asr: { speaker: { enabled: true } } },
    embedder: { preload: () => true, embed: () => vec(1, 0, 0), modelPath: '/tmp/m', failure: null },
    profilePath,
  });
  const a = owner.verify(quiet());
  assert.equal(a.ok, true);
  assert.ok(a.score > 0.99);
  assert.equal(owner.stats.accepted, 1);

  const other = createSpeakerGate({
    config: { asr: { speaker: { enabled: true } } },
    embedder: { preload: () => true, embed: () => vec(0, 0, 1), modelPath: '/tmp/m', failure: null },
    profilePath,
  });
  const b = other.verify(quiet());
  assert.equal(b.ok, false);
  assert.equal(other.stats.rejected, 1);
  assert.equal(other.status().state, 'ready');
});

test('too-quiet wake audio is rejected without touching the embedder', () => {
  const dir = tmpDir();
  const profilePath = path.join(dir, 'profile.json');
  saveProfile(profilePath, { threshold: 0.65, embeddings: [vec(1, 0)] });
  let embedCalls = 0;
  const gate = createSpeakerGate({
    config: { asr: { speaker: { enabled: true } } },
    embedder: { preload: () => true, embed: () => { embedCalls += 1; return vec(1, 0); }, modelPath: '/tmp/m', failure: null },
    profilePath,
  });
  const verdict = gate.verify(new Float32Array(16000));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'too-quiet');
  assert.equal(embedCalls, 0);
});

test('a missing model degrades to skipping instead of blocking wakes', () => {
  const profilePath = path.join(tmpDir(), 'profile.json');
  saveProfile(profilePath, { threshold: 0.65, embeddings: [vec(1, 0)] });
  const gate = createSpeakerGate({
    config: { asr: { speaker: { enabled: true, model: path.join(tmpDir(), 'missing.onnx') } } },
    repoRoot: tmpDir(),
    profilePath,
  });
  const verdict = gate.verify(quiet());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.skipped, true);
  assert.equal(gate.status().state, 'model-missing');
});

test('default profile lives in the figaro config directory', () => {
  const old = process.env.FIGARO_CONFIG_DIR;
  process.env.FIGARO_CONFIG_DIR = '/tmp/figaro-cfg-test';
  try {
    assert.equal(defaultProfilePath(), '/tmp/figaro-cfg-test/speaker-profile.json');
  } finally {
    if (old === undefined) delete process.env.FIGARO_CONFIG_DIR;
    else process.env.FIGARO_CONFIG_DIR = old;
  }
});
