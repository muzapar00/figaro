// Bilingual wake words: 「费加罗」 (Chinese pinyin tokens) and "figaro" (English
// CMU phone tokens) on the sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20 model.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadEnglishLexicon, buildEnglishKeywordLines, PRONUNCIATION_VARIANTS } from '../../src/voice/asr/english-phones.js';
import { createKws, locateKwsModel, resolveKeywordsFile } from '../../src/voice/asr/kws.js';
import { createAsr, SENSITIVITY_PRESETS } from '../../src/voice/asr/index.js';
import { makeConfig, modelsAvailable, loadFixture, skipMessage, recorder, arraySource, silence, concat, waitUntil } from './helpers.js';

const CH = 1600;

function feedClip(kws, samples) {
  // Real microphone audio always has some lead-in before the word; give the
  // spotter the same context (300 ms) as the live pipeline does.
  const lead = new Float32Array(16000 * 0.3);
  for (let i = 0; i < lead.length; i += CH) kws.feed(lead.subarray(i, Math.min(i + CH, lead.length)));
  const hits = [];
  for (let i = 0; i < samples.length; i += CH) {
    const hit = kws.feed(samples.subarray(i, Math.min(i + CH, samples.length)));
    if (hit) hits.push(hit);
  }
  const pad = new Float32Array(16000 * 1.8);
  for (let i = 0; i < pad.length; i += CH) {
    const hit = kws.feed(pad.subarray(i, Math.min(i + CH, pad.length)));
    if (hit) hits.push(hit);
  }
  return hits;
}

test('English lexicon lookup (CMU en.phone) is case-insensitive', (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const config = makeConfig();
  const dir = path.resolve(config.paths.root, config.asr.kwsModelDir);
  const files = locateKwsModel(dir);
  if (!files?.lexicon) { t.skip('当前 KWS 模型不含 en.phone'); return; }
  const lexicon = loadEnglishLexicon(files.lexicon);
  assert.deepEqual(lexicon.get('FIGARO'), ['F', 'IH1', 'G', 'ER0', 'OW2']);
  assert.deepEqual(lexicon.get('HEY'), ['HH', 'EY1']);
  assert.equal(lexicon.get('XYZQWE'), undefined);
});

test('English keyword lines use phone tokens, underscore display and curated variants', (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const config = makeConfig();
  const dir = path.resolve(config.paths.root, config.asr.kwsModelDir);
  const files = locateKwsModel(dir);
  if (!files?.lexicon) { t.skip('当前 KWS 模型不含 en.phone'); return; }
  const lexicon = loadEnglishLexicon(files.lexicon);
  const vocab = new Set(fs.readFileSync(files.tokens, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
  const built = buildEnglishKeywordLines(['figaro', 'hey figaro', 'notawordinlexicon123'], { lexicon, vocab });
  assert.deepEqual(built.used, ['figaro', 'hey figaro']);
  assert.deepEqual(built.skipped, ['notawordinlexicon123']);
  assert.ok(built.lines.some((l) => l === 'F IH1 G ER0 OW2 @FIGARO'), 'CMU pronunciation present');
  assert.equal(built.lines.filter((l) => l.endsWith('@FIGARO')).length, PRONUNCIATION_VARIANTS.FIGARO.length);
  assert.ok(built.lines.some((l) => l.endsWith('@HEY_FIGARO')));
  for (const line of built.lines) {
    assert.match(line, /^[A-Z0-9 ]+ @[A-Z_]+$/);
    assert.ok(!line.includes('@HEY FIGARO'), 'display must not contain spaces');
  }
});

test('bilingual keywords file merges Chinese + English lines', (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const config = makeConfig();
  const dir = path.resolve(config.paths.root, config.asr.kwsModelDir);
  const files = locateKwsModel(dir);
  if (!files?.lexicon) { t.skip('当前 KWS 模型不含 en.phone'); return; }
  const vocab = new Set(fs.readFileSync(files.tokens, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
  const kw = resolveKeywordsFile({
    modelDir: dir,
    wakeWords: ['费加罗', '菲加罗', '飞加罗', 'figaro', '费加'],
    wakeWordsEn: ['figaro', 'hey figaro'],
    vocab,
  });
  assert.ok(kw.chineseLines.length >= 4);
  assert.ok(kw.englishLines.length >= 9);
  assert.equal(kw.lines.length, kw.chineseLines.length + kw.englishLines.length);
  assert.ok(kw.lines.some((l) => l.startsWith('f èi j iā l uó @')));
  assert.ok(kw.lines.some((l) => l.endsWith('@FIGARO')));
});

test('KWS detects all 3 English wake fixtures and none of the 2 English negatives', (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const config = makeConfig();
  const dir = path.resolve(config.paths.root, config.asr.kwsModelDir);
  const preset = SENSITIVITY_PRESETS[config.asr.sensitivity] ?? SENSITIVITY_PRESETS.high;
  const kws = createKws({
    modelDir: dir,
    wakeWords: config.asr.wakeWords ?? [],
    wakeWordsEn: ['figaro', 'hey figaro'],
    numThreads: 2,
    keywordsScore: preset.keywordsScore,
    keywordsThreshold: preset.keywordsThreshold,
  });
  try {
    assert.ok(kws.hasEnglish, 'bilingual model + english wake words');
    assert.deepEqual(kws.englishKeywords.sort(), ['FIGARO', 'HEY_FIGARO']);
    const positives = ['wake-en-figaro-man', 'wake-en-figaro-woman', 'wake-en-hey-figaro'];
    for (const name of positives) {
      const hits = feedClip(kws, loadFixture(name).samples);
      assert.ok(hits.length > 0, `${name} must be detected`);
      assert.equal(hits[0].lang, 'en');
      assert.ok(['FIGARO', 'HEY_FIGARO'].includes(hits[0].keyword), hits[0].keyword);
    }
    for (const name of ['neg-en-weather', 'neg-en-music']) {
      assert.deepEqual(feedClip(kws, loadFixture(name).samples), [], `${name} must not wake`);
    }
  } finally {
    kws.free();
  }
});

test('KWS still detects all 8 Chinese wake fixtures (no regression)', (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const config = makeConfig();
  const dir = path.resolve(config.paths.root, config.asr.kwsModelDir);
  const preset = SENSITIVITY_PRESETS[config.asr.sensitivity] ?? SENSITIVITY_PRESETS.high;
  const kws = createKws({
    modelDir: dir,
    wakeWords: config.asr.wakeWords ?? [],
    wakeWordsEn: ['figaro'],
    numThreads: 2,
    keywordsScore: preset.keywordsScore,
    keywordsThreshold: preset.keywordsThreshold,
  });
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(config.paths.root, 'tests/asr/fixtures/manifest.json'), 'utf8'));
    const misses = [];
    for (const entry of manifest.filter((m) => m.tag === 'wake')) {
      const hits = feedClip(kws, loadFixture(entry.name).samples);
      if (!hits.length) misses.push(entry.name);
      else assert.equal(hits[0].lang, 'zh');
    }
    assert.deepEqual(misses, [], 'all Chinese wake fixtures must still be detected');
  } finally {
    kws.free();
  }
});

test('createAsr exposes bilingual model info and wakes on an English fixture', async (t) => {
  if (!modelsAvailable()) { skipMessage(t); return; }
  const clip = loadFixture('wake-en-figaro-man');
  const pcm = concat([silence(300), clip.samples, silence(2500)]);
  const events = recorder();
  const config = makeConfig({ asr: { sensitivity: 'low' } });
  const asr = createAsr({
    config,
    hotkey: false,
    micGain: false,
    source: arraySource(pcm),
    onWake: () => events.push({ type: 'wake' }),
    onLevel: () => {},
    onPartial: () => {},
    onFinal: (text) => events.push({ type: 'final', text }),
    onError: (err) => events.push({ type: 'error', message: err.message }),
    onLog: () => {},
  });
  await asr.start();
  try {
    const info = asr.modelInfo;
    assert.match(info.model, /zh-en/, `model name should mention zh-en: ${info.model}`);
    assert.equal(info.hasEnglish, true);
    assert.deepEqual(info.englishKeywords.sort(), ['FIGARO', 'HEY_FIGARO']);
    assert.deepEqual(info.wakeWordsEn, ['figaro', 'hey figaro']);
    assert.ok(info.maxActivePaths >= 16);
    await events.waitFor((e) => e.type === 'wake', 5000, 'English wake word');
    await waitUntil(() => asr.capturing, 2000, 'capture after English wake');
    const armed = asr.armWakeTest({ ms: 500, onScore: () => {}, onHit: () => {} });
    assert.ok(armed.keywords.includes('figaro'));
    assert.ok(armed.keywords.some((k) => /^[\u3400-\u9fff]/.test(k)), 'Chinese wake words still listed');
    asr.disarmWakeTest();
  } finally {
    await asr.stop();
  }
});

test('sensitivity presets kept bilingual thresholds (low stricter than high)', () => {
  assert.ok(SENSITIVITY_PRESETS.low.keywordsThreshold > SENSITIVITY_PRESETS.high.keywordsThreshold);
  assert.ok(SENSITIVITY_PRESETS.low.keywordsScore <= SENSITIVITY_PRESETS.high.keywordsScore);
});
