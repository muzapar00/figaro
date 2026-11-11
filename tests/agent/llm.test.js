// Generic LLM client tests: OpenAI-compatible SSE (DeepSeek/OpenAI/Custom) and
// Gemini native SSE, tool calls on both protocols, prompt/response conversion,
// error mapping (401/5xx/timeouts/redirects/SSRF), legacy deepseek.* config
// compatibility, key redaction and the reusable `testLlmConnection` probe.
// Everything runs against a fake fetch: no network, no real keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../../src/agent/index.js';
import { defineTool } from '../../src/agent/tools/define.js';
import { streamChatCompletion, testLlmConnection } from '../../src/agent/llm.js';
import {
  contentChunk,
  fakeFetchSequence,
  makeTestConfig,
  sseDone,
  textResponse,
} from './fake-llm.js';

const FAKE_KEY = 'sk-FAKE-llm-test-key-0123456789';
const FAKE_GEMINI_KEY = 'AIzaFAKEgeminitestkey0123456789';

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(frames, { contentType = 'text/event-stream' } = {}) {
  return new Response(frames, { status: 200, headers: { 'content-type': contentType } });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      redirect: init.redirect,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    });
    return handler(String(url), init, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Minimal effective config for a given provider, without loadConfig(). */
function llmConfig(llm = {}, extra = {}) {
  return {
    llm: {
      apiKey: FAKE_KEY,
      ...llm,
    },
    agent: { name: '费加罗' },
    ...extra,
  };
}

function geminiTextFrames(text, { finishReason = 'STOP', usage, thought } = {}) {
  const parts = [];
  if (thought) parts.push({ text: thought, thought: true });
  parts.push({ text });
  return sse({ candidates: [{ content: { role: 'model', parts }, finishReason }] })
    + sse({ candidates: [{ finishReason }], usageMetadata: usage ?? { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } })
    + 'data: [DONE]\n\n';
}

function geminiToolFrames(calls, { finishReason = 'STOP' } = {}) {
  return sse({
    candidates: [{
      content: {
        role: 'model',
        parts: calls.map((call) => ({ functionCall: { name: call.name, args: call.args ?? {} } })),
      },
      finishReason,
    }],
  }) + 'data: [DONE]\n\n';
}

// --- OpenAI-compatible protocol ---------------------------------------------

test('OpenAI SSE: deepseek legacy config streams deltas and returns usage', async () => {
  const fetchImpl = fakeFetchSequence([textResponse('你好，我是费加罗。')]);
  const config = makeTestConfig({ deepseek: { apiKey: FAKE_KEY } });
  delete config.llm;

  const deltas = [];
  const result = await streamChatCompletion({
    config,
    messages: [{ role: 'user', content: '你好' }],
    fetchImpl,
    onDelta: (delta) => deltas.push(delta),
  });

  assert.equal(result.content, '你好，我是费加罗。');
  assert.equal(deltas.join(''), '你好，我是费加罗。');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(fetchImpl.calls[0].headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(fetchImpl.calls[0].body.model, 'deepseek-flash');
  assert.equal(fetchImpl.calls[0].body.stream, true);
  // Old deepseek tunables still drive the shared request body.
  assert.equal(fetchImpl.calls[0].body.temperature, 0.6);
});

test('OpenAI provider: baseUrl from the preset, llm.* overrides win', async () => {
  const fetchImpl = fakeFetchSequence([textResponse('ok')]);
  const result = await streamChatCompletion({
    config: llmConfig({
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.2,
      reasoningEffort: 'minimal',
      requestOptions: { max_tokens: 64 },
    }),
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
  });

  assert.equal(result.content, 'ok');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(call.body.model, 'gpt-4o');
  assert.equal(call.body.temperature, 0.2);
  assert.equal(call.body.reasoning_effort, 'minimal');
  assert.equal(call.body.max_tokens, 64);
});

test('custom provider: loopback http is allowed and needs no API key', async () => {
  const fetchImpl = fakeFetchSequence([textResponse('本地模型回答。')]);
  const result = await streamChatCompletion({
    config: llmConfig({ provider: 'custom', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', apiKey: '' }),
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
  });

  assert.equal(result.content, '本地模型回答。');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(call.headers.Authorization, undefined, 'no Authorization header without a key');
});

test('custom provider: baseUrl that includes /chat/completions is not doubled', async () => {
  const fetchImpl = fakeFetchSequence([textResponse('ok')]);
  await streamChatCompletion({
    config: llmConfig({
      provider: 'custom',
      baseUrl: 'https://llm.example.com/v1/chat/completions',
      model: 'x',
      apiKey: FAKE_KEY,
    }),
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
  });
  assert.equal(fetchImpl.calls[0].url, 'https://llm.example.com/v1/chat/completions');
});

test('OpenAI tool call deltas are reassembled into complete tool_calls', async () => {
  const frames =
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"comm' } }] } }] })
    + sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"echo hi"}' } }] }, finish_reason: 'tool_calls' }] })
    + sseDone();
  const fetchImpl = fakeFetchSequence([frames]);
  const result = await streamChatCompletion({
    config: llmConfig({ provider: 'deepseek' }),
    messages: [{ role: 'user', content: 'run' }],
    fetchImpl,
  });

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'call_1');
  assert.equal(result.toolCalls[0].type, 'function');
  assert.equal(result.toolCalls[0].function.name, 'bash');
  assert.equal(result.toolCalls[0].function.arguments, '{"command":"echo hi"}');
  assert.equal(result.finishReason, 'tool_calls');
});

test('OpenAI endpoint answering plain JSON is accepted', async () => {
  const fetchImpl = recordingFetch(async () =>
    jsonResponse({
      choices: [{ message: { content: '纯 JSON 回复。' }, finish_reason: 'stop' }],
      usage: { total_tokens: 4 },
    }),
  );
  const result = await streamChatCompletion({
    config: llmConfig({ provider: 'openai' }),
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
  });
  assert.equal(result.content, '纯 JSON 回复。');
  assert.deepEqual(result.usage, { total_tokens: 4 });
});

// --- Gemini native protocol --------------------------------------------------

test('Gemini SSE: text, thought parts, usage and finishReason are mapped', async () => {
  const fetchImpl = fakeFetchSequence([
    geminiTextFrames('答案。', { thought: '先想一下' }),
  ]);
  const deltas = [];
  const result = await streamChatCompletion({
    config: llmConfig({ provider: 'gemini', apiKey: FAKE_GEMINI_KEY }),
    messages: [{ role: 'user', content: '问题' }],
    fetchImpl,
    onDelta: (delta) => deltas.push(delta),
  });

  assert.equal(result.content, '答案。');
  assert.equal(result.reasoningContent, '先想一下');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  assert.deepEqual(deltas, ['答案。']);

  const call = fetchImpl.calls[0];
  assert.equal(
    call.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'
      + `&key=${FAKE_GEMINI_KEY}`,
  );
  assert.equal(call.body.contents[0].parts[0].text, '问题');
  assert.equal(call.body.contents[0].role, 'user');
});

test('Gemini request: system prompt, tools (schema sanitised) and alt=sse', async () => {
  const fetchImpl = fakeFetchSequence([geminiTextFrames('ok')]);
  await streamChatCompletion({
    config: llmConfig({ provider: 'gemini', apiKey: FAKE_GEMINI_KEY, temperature: 0.3 }),
    messages: [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '问题' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'run a command',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              command: { type: 'string', description: 'shell command' },
              timeout: { type: 'number' },
            },
            required: ['command'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'noop',
          description: 'no arguments',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    ],
    fetchImpl,
  });

  const body = fetchImpl.calls[0].body;
  assert.deepEqual(body.systemInstruction, { parts: [{ text: '系统提示' }] });
  assert.deepEqual(body.generationConfig, { temperature: 0.3 });
  const declarations = body.tools[0].functionDeclarations;
  assert.equal(declarations.length, 2);
  assert.deepEqual(declarations[0].parameters, {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'shell command' },
      timeout: { type: 'number' },
    },
    required: ['command'],
  });
  assert.equal(declarations[0].parameters.additionalProperties, undefined);
  // A function without arguments is declared without a parameters block.
  assert.equal(declarations[1].parameters, undefined);
});

test('Gemini request: oneOf schemas become anyOf (Gemini rejects oneOf)', async () => {
  const fetchImpl = fakeFetchSequence([geminiTextFrames('ok')]);
  await streamChatCompletion({
    config: llmConfig({ provider: 'gemini', apiKey: FAKE_GEMINI_KEY }),
    messages: [{ role: 'user', content: 'q' }],
    tools: [{
      type: 'function',
      function: {
        name: 'flex',
        description: 'flex',
        parameters: {
          type: 'object',
          properties: { value: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
          required: ['value'],
        },
      },
    }],
    fetchImpl,
  });
  const declaration = fetchImpl.calls[0].body.tools[0].functionDeclarations[0];
  assert.deepEqual(declaration.parameters.properties.value, {
    anyOf: [{ type: 'string' }, { type: 'number' }],
  });
});

test('Gemini tool calls are mapped onto the existing tool_calls shape', async () => {
  const fetchImpl = fakeFetchSequence([
    geminiToolFrames([
      { name: 'bash', args: { command: 'echo hi', description: 'test' } },
      { name: 'read', args: { file_path: '/tmp/x' } },
    ]),
  ]);
  const result = await streamChatCompletion({
    config: llmConfig({ provider: 'gemini', apiKey: FAKE_GEMINI_KEY }),
    messages: [{ role: 'user', content: 'run' }],
    fetchImpl,
  });

  assert.equal(result.toolCalls.length, 2);
  assert.deepEqual(result.toolCalls.map((call) => call.function.name), ['bash', 'read']);
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { command: 'echo hi', description: 'test' });
  assert.equal(result.toolCalls[0].type, 'function');
  assert.ok(result.toolCalls[0].id.length > 0);
  assert.equal(result.finishReason, 'tool_calls');
});

test('Gemini: tool loop feeds functionResponse back with the function name', async () => {
  const responses = [
    geminiToolFrames([{ name: 'ping', args: { target: 'x' } }]),
    geminiTextFrames('pong 已完成。'),
  ];
  const fetchImpl = recordingFetch(async () => sseResponse(responses.shift()));
  const ping = defineTool({
    name: 'ping',
    description: 'ping tool',
    parameters: { target: { type: 'string' } },
    async execute() {
      return 'pong';
    },
  });
  const agent = createAgent({
    config: llmConfig(
      { provider: 'gemini', apiKey: FAKE_GEMINI_KEY, maxToolRounds: 4 },
      { agent: { name: '费加罗' }, deepseek: { maxToolRounds: 4, maxRetries: 0 } },
    ),
    fetchImpl,
    tools: [ping],
  });

  const result = await agent.run({ text: 'ping 一下' });
  assert.equal(result.text, 'pong 已完成。');
  assert.equal(result.toolRounds, 1);

  const secondContents = fetchImpl.calls[1].body.contents;
  const functionCall = secondContents.find((entry) => entry.parts?.some((part) => part.functionCall));
  assert.equal(functionCall.role, 'model');
  assert.equal(functionCall.parts[0].functionCall.name, 'ping');
  const functionResponse = secondContents.find((entry) => entry.parts?.some((part) => part.functionResponse));
  assert.equal(functionResponse.role, 'user');
  assert.equal(functionResponse.parts[0].functionResponse.name, 'ping');
  assert.match(functionResponse.parts[0].functionResponse.response.result, /pong/);
});

test('Gemini endpoint answering plain JSON is accepted (non-streaming proxy)', async () => {
  const fetchImpl = recordingFetch(async () =>
    jsonResponse({
      candidates: [{
        content: { role: 'model', parts: [{ text: 'JSON 版回答。' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 4, totalTokenCount: 6 },
    }),
  );
  const result = await streamChatCompletion({
    config: llmConfig({ provider: 'gemini', apiKey: FAKE_GEMINI_KEY }),
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
  });
  assert.equal(result.content, 'JSON 版回答。');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.total_tokens, 6);
});

test('Gemini blocks (promptFeedback) surface as non-retryable errors', async () => {
  const fetchImpl = fakeFetchSequence([
    sse({ promptFeedback: { blockReason: 'SAFETY' } }),
  ]);
  await assert.rejects(
    streamChatCompletion({
      config: llmConfig({ provider: 'gemini', apiKey: FAKE_GEMINI_KEY }),
      messages: [{ role: 'user', content: 'bad' }],
      fetchImpl,
    }),
    (err) => {
      assert.match(err.message, /blocked the request: SAFETY/);
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

// --- errors, timeouts, retries, security ------------------------------------

test('HTTP 401 is a non-retryable error and never echoes the key', async () => {
  const fetchImpl = recordingFetch(async () =>
    new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_KEY}` } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await assert.rejects(
    streamChatCompletion({
      config: llmConfig({ provider: 'openai' }),
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    }),
    (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.retryable, false);
      assert.match(err.message, /HTTP 401/);
      assert.ok(!err.message.includes(FAKE_KEY), 'API key must be scrubbed from error text');
      return true;
    },
  );
});

test('HTTP 5xx and 429 are retryable; 403 is not', async () => {
  for (const [status, retryable] of [[500, true], [503, true], [429, true], [403, false]]) {
    const fetchImpl = recordingFetch(async () =>
      new Response('upstream error', { status, headers: { 'content-type': 'text/plain' } }),
    );
    await assert.rejects(
      streamChatCompletion({
        config: llmConfig({ provider: 'openai' }),
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl,
      }),
      (err) => {
        assert.equal(err.status, status);
        assert.equal(err.retryable, retryable, `status ${status}`);
        return true;
      },
    );
  }
});

test('a request timeout is reported as retryable', async () => {
  const fetchImpl = (url, init = {}) => new Promise((resolve, reject) => {
    const signal = init.signal;
    if (!signal) return reject(new Error('no signal passed to fetch'));
    const fail = () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      reject(err);
    };
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });

  await assert.rejects(
    streamChatCompletion({
      config: llmConfig({ provider: 'openai', requestTimeoutMs: 25 }),
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    }),
    (err) => {
      assert.match(err.message, /timed out after 25ms/);
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test('network failure is retryable and the message is scrubbed', async () => {
  const fetchImpl = async () => {
    throw new TypeError(`connect ECONNREFUSED (key=${FAKE_KEY})`);
  };
  await assert.rejects(
    streamChatCompletion({
      config: llmConfig({ provider: 'custom', baseUrl: 'https://llm.example.com/v1', model: 'x' }),
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    }),
    (err) => {
      assert.equal(err.retryable, true);
      assert.ok(!err.message.includes(FAKE_KEY));
      return true;
    },
  );
});

test('the agent retries retryable failures up to maxRetries', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response('temporary upstream failure', { status: 500, headers: { 'content-type': 'text/plain' } });
    }
    return sseResponse(textResponse('第二次就成功了。'));
  };
  const agent = createAgent({
    config: makeTestConfig({ deepseek: { apiKey: FAKE_KEY, maxRetries: 2 } }),
    fetchImpl,
    workdir: process.cwd(),
  });
  const result = await agent.run({ text: '你好' });
  assert.equal(attempts, 2);
  assert.equal(result.text, '第二次就成功了。');
});

test('http baseUrl is only allowed on loopback (SSRF guard)', async () => {
  for (const baseUrl of ['http://192.168.1.10:8000/v1', 'http://example.com/v1', 'ftp://example.com/v1']) {
    let called = 0;
    const fetchImpl = async () => {
      called += 1;
      return sseResponse(textResponse('should not happen'));
    };
    await assert.rejects(
      streamChatCompletion({
        config: llmConfig({ provider: 'custom', baseUrl, model: 'x' }),
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl,
      }),
      /must be https|not a valid URL/,
      `baseUrl ${baseUrl} must be rejected`,
    );
    assert.equal(called, 0, 'no request may leave the process for a rejected baseUrl');
  }
});

test('redirects to a different origin are refused without leaking the key', async () => {
  const fetchImpl = recordingFetch(async () =>
    new Response(null, { status: 307, headers: { location: 'https://evil.example/steal' } }),
  );
  await assert.rejects(
    streamChatCompletion({
      config: llmConfig({ provider: 'openai' }),
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    }),
    (err) => {
      assert.match(err.message, /different origin/);
      assert.ok(!err.message.includes(FAKE_KEY));
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 1, 'the redirect target must never be fetched');
});

test('same-origin 307 redirects are followed (POST body preserved)', async () => {
  const responses = [
    new Response(null, { status: 307, headers: { location: '/chat/completions' } }),
    sseResponse(textResponse('重定向后成功。')),
  ];
  const fetchImpl = recordingFetch(async () => responses.shift());
  const result = await streamChatCompletion({
    config: llmConfig({ provider: 'openai' }),
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
  });
  assert.equal(result.content, '重定向后成功。');
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].url, 'https://api.openai.com/chat/completions');
});

test('301/302 on POST are not followed (POST would become GET)', async () => {
  const fetchImpl = recordingFetch(async () =>
    new Response(null, { status: 302, headers: { location: '/moved' } }),
  );
  await assert.rejects(
    streamChatCompletion({
      config: llmConfig({ provider: 'openai' }),
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    }),
    /changes POST into GET/,
  );
});

test('unknown provider is rejected with a clear message', async () => {
  await assert.rejects(
    streamChatCompletion({
      config: llmConfig({ provider: 'anthropic' }),
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: async () => sseResponse(textResponse('nope')),
    }),
    /unsupported LLM provider "anthropic"/,
  );
});

test('missing llm model or key is reported without touching the network', async () => {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    return sseResponse(textResponse('nope'));
  };
  await assert.rejects(
    streamChatCompletion({
      config: llmConfig({ provider: 'custom', baseUrl: 'http://127.0.0.1:8080/v1', model: '', apiKey: '' }),
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    }),
    /LLM model is missing/,
  );
  // Load the model from the preset but still no key.
  await assert.rejects(
    streamChatCompletion({
      config: { llm: { provider: 'openai', apiKey: '' } },
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    }),
    /apiKey is missing/,
  );
  assert.equal(called, 0);
});

// --- connectivity probe (settings GUI `llm.test`) ----------------------------

test('testLlmConnection: OpenAI-compatible /models probe succeeds', async () => {
  const fetchImpl = recordingFetch(async () => jsonResponse({ data: [{ id: 'gpt-4o-mini' }] }));
  const result = await testLlmConnection({
    config: { llm: { provider: 'openai', apiKey: FAKE_KEY } },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.provider, 'openai');
  assert.match(result.message, /连接成功/);
  assert.equal(fetchImpl.calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(fetchImpl.calls[0].headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
});

test('testLlmConnection: Gemini uses the native models list endpoint', async () => {
  const fetchImpl = recordingFetch(async () => jsonResponse({ models: [{ name: 'models/gemini-2.5-flash' }] }));
  const result = await testLlmConnection({
    config: { llm: { provider: 'gemini', apiKey: FAKE_GEMINI_KEY } },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(
    fetchImpl.calls[0].url,
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${FAKE_GEMINI_KEY}`,
  );
  assert.ok(!result.baseUrl.includes(FAKE_GEMINI_KEY));
});

test('testLlmConnection: a saved config can be probed with draft values first', async () => {
  const fetchImpl = recordingFetch(async () => jsonResponse({ data: [] }));
  const saved = { llm: { provider: 'deepseek', apiKey: 'sk-saved-deepseek', model: 'deepseek-flash' } };
  const result = await testLlmConnection({
    config: saved,
    llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-draft-openai' },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'openai');
  assert.equal(fetchImpl.calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer sk-draft-openai');
  // The saved config object is not mutated by the draft.
  assert.equal(saved.llm.provider, 'deepseek');
});

test('testLlmConnection: switching provider in the draft drops the old endpoint', async () => {
  const fetchImpl = recordingFetch(async () => jsonResponse({ data: [] }));
  await testLlmConnection({
    config: { llm: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-old' } },
    llm: { provider: 'openai', apiKey: 'sk-draft' },
    fetchImpl,
  });
  assert.equal(fetchImpl.calls[0].url, 'https://api.openai.com/v1/models');
});

test('testLlmConnection: 401 gives a friendly failure and never leaks the key', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: `Incorrect API key: ${FAKE_KEY}` } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  const result = await testLlmConnection({
    config: { llm: { provider: 'openai', apiKey: FAKE_KEY } },
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.message, /API key 无效或权限不足/);
  assert.ok(!result.message.includes(FAKE_KEY));
});

test('testLlmConnection: custom /models 404 means reachable, not broken', async () => {
  const fetchImpl = async () => new Response('not found', { status: 404 });
  const result = await testLlmConnection({
    config: { llm: { provider: 'custom', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local', apiKey: '' } },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 404);
  assert.match(result.message, /服务可达/);
});

test('testLlmConnection: missing key, bad URL and timeout fail cleanly', async () => {
  const missingKey = await testLlmConnection({
    config: { llm: { provider: 'deepseek', apiKey: '' } },
    fetchImpl: async () => jsonResponse({ data: [] }),
  });
  assert.equal(missingKey.ok, false);
  assert.match(missingKey.message, /API key 未配置/);

  const badUrl = await testLlmConnection({
    config: { llm: { provider: 'custom', baseUrl: 'http://example.com/v1', model: 'x' } },
    fetchImpl: async () => jsonResponse({ data: [] }),
  });
  assert.equal(badUrl.ok, false);
  assert.match(badUrl.message, /must be https/);

  const timeout = await testLlmConnection({
    config: { llm: { provider: 'openai', apiKey: FAKE_KEY } },
    fetchImpl: async () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    },
  });
  assert.equal(timeout.ok, false);
  assert.match(timeout.message, /连接超时/);
});

test('the Gemini key never appears in request error text', async () => {
  const fetchImpl = async () =>
    new Response(`bad request for key ${FAKE_GEMINI_KEY}`, { status: 400, headers: { 'content-type': 'text/plain' } });
  await assert.rejects(
    streamChatCompletion({
      config: llmConfig({ provider: 'gemini', apiKey: FAKE_GEMINI_KEY }),
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    }),
    (err) => {
      assert.ok(!err.message.includes(FAKE_GEMINI_KEY));
      assert.ok(!String(err.body).includes(FAKE_GEMINI_KEY));
      return true;
    },
  );
});
