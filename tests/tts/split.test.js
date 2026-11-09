import test from 'node:test';
import assert from 'node:assert/strict';
import { createSentenceSplitter, splitText } from '../../src/voice/tts/split.js';

const compact = (s) => s.replace(/\s+/g, '');

test('splits Chinese text on sentence punctuation', () => {
  const pieces = splitText('第一句。第二句！第三句？');
  assert.deepEqual(pieces, ['第一句。', '第二句！', '第三句？']);
});

test('is lossless — concatenation reproduces the input', () => {
  const text =
    '费加罗，现在是上午十点。今天气温18度，适合出去散步！你要不要一起？顺便帮我看看日程、天气和路况，然后告诉我应该几点出发。';
  const pieces = splitText(text);
  assert.equal(compact(pieces.join('')), compact(text));
  assert.ok(pieces.length >= 4);
});

test('streaming push() does not lose characters when fed one char at a time', () => {
  const text = '边想边说也是可以的。第二句话在这里！第三句呢？';
  const splitter = createSentenceSplitter();
  const pieces = [];
  for (const ch of text) pieces.push(...splitter.push(ch));
  pieces.push(...splitter.end());
  assert.equal(compact(pieces.join('')), compact(text));
  assert.deepEqual(pieces, ['边想边说也是可以的。', '第二句话在这里！', '第三句呢？']);
});

test('holds an incomplete sentence until end()', () => {
  const splitter = createSentenceSplitter();
  assert.deepEqual(splitter.push('这是半句'), []);
  assert.deepEqual(splitter.push('，还没说完'), []);
  assert.deepEqual(splitter.end(), ['这是半句，还没说完']);
});

test('splits at closing quotes after a terminator', () => {
  const pieces = splitText('他说：“你好。”然后走了。');
  assert.deepEqual(pieces, ['他说：“你好。”', '然后走了。']);
});

test('does not split decimals or version numbers', () => {
  const pieces = splitText('气温3.5度，版本v1.2，都正常。');
  assert.deepEqual(pieces, ['气温3.5度，版本v1.2，都正常。']);
});

test('breaks over-long run-on text at a hard cap without losing chars', () => {
  const text = '啊'.repeat(900); // no punctuation at all
  const pieces = splitText(text, { maxLen: 120 });
  assert.ok(pieces.length >= 7, `expected >= 7 pieces, got ${pieces.length}`);
  for (const p of pieces) assert.ok(p.length <= 140, `piece too long: ${p.length}`);
  assert.equal(compact(pieces.join('')), compact(text));
});

test('prefers clause boundaries when breaking long text', () => {
  const clause = '这是一个很长的子句，';
  const text = clause.repeat(12);
  const pieces = splitText(text, { maxLen: 100 });
  assert.equal(compact(pieces.join('')), compact(text));
  for (const p of pieces) assert.ok(p.length <= 120);
});

test('keeps English sentence endings on word boundaries', () => {
  const pieces = splitText('Hello there. This is a test! Another one? Done.');
  assert.equal(compact(pieces.join('')), compact('Hello there. This is a test! Another one? Done.'));
  assert.ok(pieces.length >= 3);
});

test('empty input yields no pieces', () => {
  assert.deepEqual(splitText(''), []);
  assert.deepEqual(splitText(null), []);
});
