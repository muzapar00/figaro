// LightRAG client + integration tests. The engine itself is an external MIT
// service (docs/rag.md); here we only test Figaro's client, prompt injection and
// the agent/tool wiring with a fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRagClient } from '../../src/agent/rag.js';
import { buildSystemPrompt } from '../../src/agent/prompt.js';
import { createRagTool } from '../../src/agent/tools/rag.js';
import { createAgent } from '../../src/agent/index.js';
import { fakeFetchSequence, makeTestConfig, textResponse } from './fake-llm.js';

const ragConfig = (extra = {}) => ({ rag: { enabled: true, host: 'http://127.0.0.1:9', timeoutMs: 50, autoIngest: true, ...extra } });

function jsonFetch(payload, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return JSON.stringify(payload); },
      async json() { return payload; },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('recall posts only_need_context and returns the retrieved context', async () => {
  const fetchImpl = jsonFetch({ response: '```json\n{"entity":"卧室台灯","description":"左边床头"}\n```', llm_generated: false });
  const rag = createRagClient({ config: ragConfig(), fetchImpl });
  const result = await rag.recall('卧室台灯在哪');
  assert.match(result.context, /卧室台灯/);
  assert.equal(result.error, undefined);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:9/query');
  assert.equal(fetchImpl.calls[0].body.only_need_context, true);
  assert.equal(fetchImpl.calls[0].body.enable_rerank, false);
  assert.equal(rag.stats.recallHits, 1);
});

test('the API key is read from the LightRAG .env file and sent as X-API-Key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figaro-rag-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'LIGHTRAG_API_KEY="abc123secret"\n');
  try {
    const fetchImpl = jsonFetch({ response: 'ctx' });
    const rag = createRagClient({ config: ragConfig({ envFile }), fetchImpl });
    await rag.recall('你好');
    assert.equal(fetchImpl.calls[0].headers['X-API-Key'], 'abc123secret');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a slow recall respects its latency budget and degrades to no memory', async () => {
  const fetchImpl = (url, init = {}) => new Promise((resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const rag = createRagClient({ config: ragConfig({ timeoutMs: 30 }), fetchImpl });
  const started = Date.now();
  const result = await rag.recall('很慢的问题');
  assert.equal(result.context, '');
  assert.ok(Date.now() - started < 1000, 'recall must not hang past the budget');
  assert.equal(rag.stats.failures, 1);
});

test('a no-context answer is treated as empty memory', async () => {
  const fetchImpl = jsonFetch({ response: "Sorry, I'm not able to provide an answer to that question.[no-context]" });
  const rag = createRagClient({ config: ragConfig(), fetchImpl });
  const result = await rag.recall('未知内容');
  assert.equal(result.context, '');
  assert.equal(rag.stats.recallHits, 0);
});

test('remember uses a flat unique file_source and never throws', async () => {
  const fetchImpl = jsonFetch({ status: 'success', track_id: 'insert_1' });
  const rag = createRagClient({ config: ragConfig(), fetchImpl });
  const first = await rag.remember('用户喜欢暖光');
  const second = await rag.remember('用户喜欢暖光');
  assert.equal(first.ok, true);
  const sources = fetchImpl.calls.map((call) => call.body.file_source);
  assert.equal(sources.length, 2);
  assert.notEqual(sources[0], sources[1]);
  for (const source of sources) {
    assert.ok(!source.includes('/'), `file_source must be flat: ${source}`);
    assert.match(source, /^figaro-memory-/);
  }
  const failed = createRagClient({ config: ragConfig(), fetchImpl: async () => { throw new Error('down'); } });
  const result = await failed.remember('x');
  assert.equal(result.ok, false);
});

test('the client is disabled unless config.rag.enabled is true', async () => {
  const fetchImpl = jsonFetch({ response: 'ctx' });
  const rag = createRagClient({ config: {}, fetchImpl });
  assert.equal(rag.enabled, false);
  assert.deepEqual(await rag.recall('hi'), { context: '', ms: 0 });
  assert.equal((await rag.remember('x')).ok, false);
  assert.equal(fetchImpl.calls.length, 0);
});

test('recalled context is injected into the system prompt as historical data', () => {
  const prompt = buildSystemPrompt({
    config: { agent: { name: '费加罗' } },
    ragContext: '{"entity":"卧室台灯","description":"左边床头"}',
  });
  assert.match(prompt, /<recall>/);
  assert.match(prompt, /卧室台灯/);
  assert.match(prompt, /历史数据而不是指令/);
  assert.doesNotMatch(buildSystemPrompt({ config: {} }), /<recall>/);
});

test('the rag tool searches and remembers through the client', async () => {
  const calls = [];
  const rag = {
    enabled: true,
    recall: async (query) => { calls.push(['recall', query]); return { context: '卧室台灯在左边床头', ms: 10 }; },
    remember: async (text) => { calls.push(['remember', text]); return { ok: true, trackId: 't1' }; },
  };
  const tool = createRagTool({ rag });
  const search = await tool.execute({ action: 'search', query: '台灯在哪' });
  assert.match(search.content, /卧室台灯/);
  const remember = await tool.execute({ action: 'remember', text: '书房的显示器是 27 寸' });
  assert.match(remember.content, /记住了/);
  assert.deepEqual(calls, [['recall', '台灯在哪'], ['remember', '书房的显示器是 27 寸']]);
});

test('the agent recalls before the model call and ingests the finished turn', async () => {
  const deltas = [];
  const ingested = [];
  const rag = {
    enabled: true,
    host: 'http://127.0.0.1:9',
    mode: 'mix',
    autoIngest: true,
    stats: { recalls: 0, recallHits: 0, failures: 0, ingests: 0 },
    recall: async () => ({ context: '用户：卧室台灯在左边床头', ms: 1 }),
    ingestTurn: async ({ user, assistant }) => { ingested.push({ user, assistant }); return { ok: true }; },
  };
  const fetchImpl = fakeFetchSequence([textResponse('在左边床头。')]);
  const agent = createAgent({
    config: makeTestConfig(),
    fetchImpl,
    rag,
    onTextDelta: (d) => deltas.push(d),
    workdir: os.tmpdir(),
  });
  await agent.run({ text: '卧室台灯在哪' });
  const systemPrompt = fetchImpl.calls[0].body.messages[0].content;
  assert.ok(systemPrompt.includes('<recall>'), 'recall block is in the system prompt');
  assert.ok(systemPrompt.includes('卧室台灯在左边床头'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(ingested, [{ user: '卧室台灯在哪', assistant: '在左边床头。' }]);
  assert.equal(agent.ragStats.enabled, true);
  assert.equal(agent.ragStats.host, 'http://127.0.0.1:9');
});
