// Web tool tests: HTML parsing fixtures (no network) and the URL guards.
// Live search/fetch is exercised manually during acceptance, not in the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, htmlToText, parseBingResults, parseDuckDuckGoResults, createWebFetchTool } from '../../src/agent/tools/web.js';

function bingHtml(results) {
  const blocks = results
    .map((result) => {
      const encoded = Buffer.from(result.url, 'utf8').toString('base64url');
      return `<li class="b_algo" data-id iid=SERP.1><link rel="stylesheet" href="https://r.bing.com/x.css"/>
        <h2><a href="https://www.bing.com/ck/a?!&&amp;p=abc&amp;u=a1${encoded}&amp;ntb=1" h="ID=SERP,1">${result.title}</a></h2>
        <div class="b_caption"><p class="b_lineclamp2">${result.snippet}</p></div></li>`;
    })
    .join('\n');
  return `<html><body><ol id="b_results">${blocks}</ol></body></html>`;
}

test('Bing HTML results are parsed with real URLs, titles and snippets', () => {
  const html = bingHtml([
    { url: 'https://api-docs.deepseek.com/quick_start/pricing', title: 'Pricing &amp; Fees', snippet: 'DeepSeek API pricing page &amp; details' },
    { url: 'https://example.com/page?q=1&x=2', title: 'Example', snippet: 'Snippet two' },
  ]);
  const results = parseBingResults(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://api-docs.deepseek.com/quick_start/pricing');
  assert.equal(results[0].title, 'Pricing & Fees');
  assert.match(results[0].snippet, /pricing page & details/);
  assert.equal(results[1].url, 'https://example.com/page?q=1&x=2');
});

test('Bing parser ignores non-http links and malformed blocks', () => {
  const html = `<li class="b_algo"><h2><a href="javascript:void(0)">Bad</a></h2></li>
    <li class="b_algo"><h2><a href="https://ok.example/x">Good</a></h2></li>`;
  const results = parseBingResults(html);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://ok.example/x');
});

test('DuckDuckGo HTML fallback parser works', () => {
  const html = `
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa%3Fb%3D1&amp;rut=x">Example &amp; Title</a>
    <a class="result__snippet" href="#">Snippet <b>one</b></a>`;
  const results = parseDuckDuckGoResults(html);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.org/a?b=1');
  assert.equal(results[0].title, 'Example & Title');
  assert.match(results[0].snippet, /Snippet one/);
});

test('HTML to text strips scripts/styles and keeps block structure', () => {
  const html = `<html><head><style>.x{color:red}</style><script>alert('no')</script></head>
    <body><h1>标题</h1><p>第一段 &amp; 内容</p><p>第二段<br>换行</p><script>evil()</script></body></html>`;
  const text = htmlToText(html);
  assert.match(text, /标题/);
  assert.match(text, /第一段 & 内容/);
  assert.match(text, /换行/);
  assert.doesNotMatch(text, /color:red|alert|evil/);
});

test('entities are decoded (named, decimal and hex)', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#39; &#x4e2d;'), "a & b <c> 'd' 中");
});

test('web_fetch rejects non-http URLs before any network access', async () => {
  const tool = createWebFetchTool();
  await assert.rejects(() => tool.execute({ url: 'file:///etc/passwd' }), /only http\(s\)/);
  await assert.rejects(() => tool.execute({ url: 'not-a-url' }), /invalid URL/);
  await assert.rejects(() => tool.execute({}), /invalid URL/);
});
