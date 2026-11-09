// Pure logic tests for wake-word → pinyin keyword mapping and transcript cleanup.
// No models, no microphone: always runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  wordToTokens,
  buildKeywordLines,
  filterKeywordsByVocab,
  normalizeWakeText,
  stripWakePrefix,
} from '../../src/voice/asr/pinyin.js';
import { makeConfig } from './helpers.js';

test('wordToTokens maps the default wake words to pinyin initial+final tokens', () => {
  assert.deepEqual(wordToTokens('费加罗'), ['f', 'èi', 'j', 'iā', 'l', 'uó']);
  assert.deepEqual(wordToTokens('菲加罗'), ['f', 'ēi', 'j', 'iā', 'l', 'uó']);
  assert.deepEqual(wordToTokens('费加'), ['f', 'èi', 'j', 'iā']);
});

test('wordToTokens rejects non-Chinese wake words (pinyin KWS model cannot encode them)', () => {
  assert.equal(wordToTokens('figaro'), null);
  assert.equal(wordToTokens('费'), null); // one syllable is too short
  assert.equal(wordToTokens('费加x'), null);
});

test('buildKeywordLines generates full words + reliable short prefixes, skipping unsupported words', () => {
  const { lines, used, skipped } = buildKeywordLines(['费加罗', '菲加罗', '飞加罗', 'figaro', '费加']);
  assert.deepEqual(used, ['费加罗', '菲加罗', '飞加罗', '费加']);
  assert.deepEqual(skipped, ['figaro']);
  // full words first, then 2-char prefixes; duplicate pinyin (菲/飞) is de-duplicated
  assert.ok(lines.includes('f èi j iā l uó @费加罗'));
  assert.ok(lines.includes('f èi j iā @费加'));
  assert.ok(lines.includes('f ēi j iā l uó @菲加罗'));
  assert.ok(lines.includes('f ēi j iā @菲加'));
  assert.equal(lines.length, 4);
});

test('buildKeywordLines can disable short prefixes', () => {
  const { lines } = buildKeywordLines(['费加罗'], { shortPrefixes: false });
  assert.deepEqual(lines, ['f èi j iā l uó @费加罗']);
});

test('filterKeywordsByVocab drops keyword lines containing tokens the model does not know', () => {
  const vocab = new Set(['f', 'èi', 'j', 'iā', 'l', 'uó']);
  const all = buildKeywordLines(['费加罗', '菲加罗']).lines;
  const kept = filterKeywordsByVocab(all, vocab);
  assert.deepEqual(kept, ['f èi j iā l uó @费加罗', 'f èi j iā @费加']);
});

test('generated keywords only use tokens present in the real KWS tokens.txt (when installed)', (t) => {
  const config = makeConfig();
  const dir = path.resolve(config.paths.root, config.asr.kwsModelDir);
  const tokensPath = path.join(dir, 'tokens.txt');
  if (!fs.existsSync(tokensPath)) {
    t.skip('KWS 模型未安装（scripts/fetch-models.sh）');
    return;
  }
  const vocab = new Set(
    fs.readFileSync(tokensPath, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean),
  );
  const { lines } = buildKeywordLines(config.asr.wakeWords);
  const kept = filterKeywordsByVocab(lines, vocab);
  assert.ok(kept.length >= 4, `expected >=4 usable keyword lines, got ${kept.length}`);
  for (const line of kept) {
    assert.match(line, /^[^@]+ @\S+$/);
    for (const tok of line.slice(0, line.indexOf('@')).trim().split(/\s+/)) {
      assert.ok(vocab.has(tok), `token ${tok} missing from tokens.txt`);
    }
  }
});

test('normalizeWakeText folds ASR homophones onto the canonical wake word', () => {
  assert.equal(normalizeWakeText('费家罗'), '费加罗');
  assert.equal(normalizeWakeText('菲伽罗'), '费加罗');
  assert.equal(normalizeWakeText('飞加罗'), '费加罗');
  assert.equal(normalizeWakeText('今天天气'), '今天天气');
});

test('stripWakePrefix removes a leading wake word but leaves ordinary commands intact', () => {
  const words = ['费加罗', '菲加罗', '飞加罗', 'figaro'];
  assert.equal(stripWakePrefix('费加罗，现在几点了', words), '现在几点了');
  assert.equal(stripWakePrefix('费加罗现在几点了', words), '现在几点了');
  assert.equal(stripWakePrefix('你好费加罗', words), '');
  assert.equal(stripWakePrefix('费家罗，打开客厅的灯', words), '打开客厅的灯');
  assert.equal(stripWakePrefix('菲加罗 播放周杰伦', words), '播放周杰伦');
  assert.equal(stripWakePrefix('费加罗', words), '');
  assert.equal(stripWakePrefix('费加罗。', words), '');
  assert.equal(stripWakePrefix('', words), '');
  assert.equal(stripWakePrefix('我想听费加罗的咏叹调', words), '我想听费加罗的咏叹调');
  assert.equal(stripWakePrefix('现在几点了', words), '现在几点了');
});
