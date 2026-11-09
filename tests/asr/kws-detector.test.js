// Wake-word (KWS) accuracy on the committed fixture set — deterministic, no mic.
//
// Positive set : 8 clips saying 费加罗 / 菲加罗 / 飞加罗 with different voices,
//                speeds and sentence positions.
// Negative set : 7 ordinary command sentences that must NOT wake Figaro.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createKws, resolveKeywordsFile } from '../../src/voice/asr/kws.js';
import { makeConfig, modelsAvailable, loadFixture, skipMessage, readManifest } from './helpers.js';

const CHUNK = 1600; // 100 ms

function feedClip(kws, { samples }) {
  const hits = [];
  for (let i = 0; i < samples.length; i += CHUNK) {
    const hit = kws.feed(samples.subarray(i, Math.min(i + CHUNK, samples.length)));
    if (hit) hits.push(hit);
  }
  // 1.5 s of silence: the keyword spotter needs trailing context to emit a hit.
  const pad = new Float32Array(16000 * 1.5);
  for (let i = 0; i < pad.length; i += CHUNK) {
    const hit = kws.feed(pad.subarray(i, Math.min(i + CHUNK, pad.length)));
    if (hit) hits.push(hit);
  }
  return hits;
}

test('KWS: 8/8 wake clips detected, 0/7 ordinary sentences trigger', (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const config = makeConfig();
  const dir = path.resolve(config.paths.root, config.asr.kwsModelDir);
  const kws = createKws({
    modelDir: dir,
    wakeWords: config.asr.wakeWords,
    numThreads: 2,
  });
  try {
    const manifest = readManifest();
    const misses = [];
    const falseAlarms = [];
    const detections = [];
    for (const entry of manifest) {
      const fixture = loadFixture(entry.name);
      const hits = feedClip(kws, fixture);
      if (entry.tag === 'wake' && hits.length === 0) misses.push(entry.name);
      if (entry.tag === 'neg' && hits.length > 0) falseAlarms.push(`${entry.name}:${hits.map((h) => h.keyword)}`);
      if (entry.tag === 'wake') detections.push({ name: entry.name, hits: hits.map((h) => h.keyword) });
    }
    t.diagnostic(`keyword lines: ${JSON.stringify(kws.keywords.lines)}`);
    t.diagnostic(`wake detections: ${JSON.stringify(detections)}`);
    assert.deepEqual(misses, [], 'all 8 wake clips must be detected');
    assert.deepEqual(falseAlarms, [], 'no ordinary sentence may trigger the wake word');
  } finally {
    kws.free();
  }
});

test('keyword resolution fails loudly when the wake words cannot be encoded', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figaro-kws-empty-'));
  try {
    assert.throws(
      () => resolveKeywordsFile({ modelDir: emptyDir, wakeWords: ['figaro', 'alexa'] }),
      /无法为唤醒词生成 KWS 关键词/,
      'unsupported wake words must raise a descriptive error instead of silently doing nothing',
    );
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});
