import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText } from '../../src/voice/tts/clean.js';

test('strips markdown emphasis, headings, lists', () => {
  const input = '# 标题\n**重点**内容\n- 第一项\n- 第二项\n> 引用\n普通段落';
  const out = cleanText(input);
  assert.doesNotMatch(out, /[*#>]/);
  assert.match(out, /标题/);
  assert.match(out, /重点内容/);
  assert.match(out, /第一项/);
  assert.match(out, /第二项/);
  assert.match(out, /引用/);
});

test('removes fenced code blocks but keeps the prose around them', () => {
  const input = '先看代码：\n```js\nconsole.log("hi")\n```\n然后就好了。';
  const out = cleanText(input);
  assert.doesNotMatch(out, /console\.log/);
  assert.match(out, /先看代码/);
  assert.match(out, /然后就好了/);
});

test('removes urls and keeps markdown link text', () => {
  const input = '详见 https://example.com/a?b=1 以及 [官方文档](https://platform.minimax.cn/x) 说明。';
  const out = cleanText(input);
  assert.doesNotMatch(out, /https?:\/\//);
  assert.doesNotMatch(out, /example\.com/);
  assert.match(out, /官方文档/);
  assert.match(out, /详见/);
});

test('removes emoji and pictographs', () => {
  const input = '好啊😀👍🏻 我们走吧🚀！';
  const out = cleanText(input);
  assert.equal(out, '好啊 我们走吧！');
});

test('turns a markdown table row into spoken commas', () => {
  const out = cleanText('| 项目 | 数值 |\n| --- | --- |\n| 温度 | 18度 |');
  assert.doesNotMatch(out, /\|/);
  assert.match(out, /项目，数值/);
  assert.match(out, /温度，18度/);
});

test('keeps Chinese/English mixed content and numbers for the TTS normalizer', () => {
  const out = cleanText('今天 18°C，CPU 占用 42%，OK 吗？');
  assert.match(out, /18/);
  assert.match(out, /CPU/);
  assert.match(out, /42%/);
  assert.match(out, /OK/);
});

test('removes annotation parentheses but keeps meaningful ones', () => {
  const out = cleanText('费加罗（系统级语音助手）回应了一句（注：仅供测试）你好。');
  assert.match(out, /系统级语音助手/);
  assert.doesNotMatch(out, /仅供测试/);
  assert.match(out, /你好/);
});

test('keeps empty / null inputs empty and never throws', () => {
  assert.equal(cleanText(''), '');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText('   \n  '), '');
  assert.doesNotThrow(() => cleanText({ toString: () => '对象' }));
  assert.equal(cleanText({ toString: () => '对象' }), '对象');
});

test('collapses runaway punctuation and whitespace', () => {
  const out = cleanText('你好。。。    世界！！');
  assert.equal(out, '你好。世界！');
});

test('drops lines that contain only markup', () => {
  const out = cleanText('---\n正文\n***\n# \n结尾');
  assert.match(out, /正文/);
  assert.match(out, /结尾/);
  assert.doesNotMatch(out, /[|*#>-]/);
});
