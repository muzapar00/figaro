// Agent loop tests with a fake model: streaming text, tool_calls → local
// execution → role:"tool" backfill → final answer, error degradation, history
// trimming and prompt assembly. No network, no microphone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAgent } from '../../src/agent/index.js';
import { defineTool } from '../../src/agent/tools/define.js';
import { buildSystemPrompt } from '../../src/agent/prompt.js';
import { parseSseData } from '../../src/agent/sse.js';
import {
  contentChunk,
  fakeFetchSequence,
  makeTestConfig,
  sseDone,
  textResponse,
  toolCallResponse,
  usageChunk,
  waitFor,
} from './fake-llm.js';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figaro-agent-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('SSE parser resumes acros chunk boundaries', () => {
  const first = parseSseData('data: {"a":1}\n\ndata: {"b"');
  assert.deepEqual(first.lines, ['{"a":1}']);
  assert.equal(first.remainder, 'data: {"b"');
  const second = parseSseData(`${first.remainder}:2}\n\ndata: [DONE]\n\n`);
  assert.deepEqual(second.lines, ['{"b":2}']);
});

test('tool loop: model calls bash, result is fed back, final answer returned', async (t) => {
  const dir = await tempDir(t);
  const marker = path.join(dir, 'tool-ran.txt');
  const fetchImpl = fakeFetchSequence([
    toolCallResponse([
      {
        id: 'call_1',
        name: 'bash',
        args: { command: `printf 'tool-ran' > ${JSON.stringify(marker)}`, description: 'Write tool marker' },
      },
    ], { preamble: '我查一下。' }),
    textResponse('查完了，现在可以用了。'),
  ]);

  const deltas = [];
  const toolEvents = [];
  const errors = [];
  const agent = createAgent({
    config: makeTestConfig(),
    fetchImpl,
    workdir: dir,
    onTextDelta: (delta) => deltas.push(delta),
    onToolEvent: (event) => toolEvents.push(event),
    onError: (err) => errors.push(err),
  });

  const result = await agent.run({ text: '写个文件再告诉我' });

  assert.equal(result.text, '我查一下。查完了，现在可以用了。');
  assert.equal(result.toolRounds, 1);
  assert.deepEqual(errors, []);
  assert.equal(deltas.join(''), '我查一下。查完了，现在可以用了。');
  assert.equal(await fs.readFile(marker, 'utf8'), 'tool-ran');

  // Two model requests: first carries the user turn, second carries the tool result.
  assert.equal(fetchImpl.calls.length, 2);
  const secondMessages = fetchImpl.calls[1].body.messages;
  const assistantCall = secondMessages.find((message) => message.role === 'assistant' && message.tool_calls);
  assert.ok(assistantCall, 'assistant tool_calls message is present');
  assert.equal(assistantCall.tool_calls[0].function.name, 'bash');
  const toolMessage = secondMessages.find((message) => message.role === 'tool');
  assert.ok(toolMessage, 'role:"tool" message is present');
  assert.equal(toolMessage.tool_call_id, 'call_1');
  assert.match(toolMessage.content, /\[exit code: 0\]/);

  assert.deepEqual(
    toolEvents.map((event) => `${event.name}:${event.status}`),
    ['bash:start', 'bash:end'],
  );
  assert.equal(toolEvents[1].ok, true);

  // History keeps the system prompt, the user turn, the assistant call and the tool result.
  const roles = agent.history.map((message) => message.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant']);
});

test('a failing tool is reported to the model instead of crashing the turn', async (t) => {
  const dir = await tempDir(t);
  const boom = defineTool({
    name: 'boom',
    description: 'Always fails (test tool).',
    parameters: {},
    async execute() {
      throw new Error('kaboom from tool');
    },
  });
  const fetchImpl = fakeFetchSequence([
    toolCallResponse([{ id: 'call_boom', name: 'boom', args: {} }]),
    textResponse('那个工具坏了，我换个办法。'),
  ]);
  const toolEvents = [];
  const agent = createAgent({
    config: makeTestConfig(),
    fetchImpl,
    workdir: dir,
    tools: [boom],
    onToolEvent: (event) => toolEvents.push(event),
  });

  const result = await agent.run({ text: '用 boom 工具试试' });
  assert.equal(result.text, '那个工具坏了，我换个办法。');
  const toolMessage = fetchImpl.calls[1].body.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /^Error: kaboom from tool/);
  assert.equal(toolEvents.at(-1).ok, false);
});

test('invalid tool arguments are surfaced as an error tool result', async (t) => {
  const dir = await tempDir(t);
  const tool = defineTool({
    name: 'noop',
    description: 'Does nothing (test tool).',
    parameters: {},
    async execute() {
      return 'ok';
    },
  });
  const badArgsFrame =
    'data: ' +
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_bad', type: 'function', function: { name: 'noop', arguments: '{not json' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }) +
    '\n\n';
  const fetchImpl = fakeFetchSequence([badArgsFrame + sseDone(), textResponse('参数没发好，重试了。')]);
  const agent = createAgent({ config: makeTestConfig(), fetchImpl, workdir: dir, tools: [tool] });

  const result = await agent.run({ text: '触发坏参数' });
  assert.equal(result.text, '参数没发好，重试了。');
  const toolMessage = fetchImpl.calls[1].body.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /invalid JSON arguments/);
});

test('network failure degrades to a spoken-style apology without throwing', async (t) => {
  const dir = await tempDir(t);
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    throw new TypeError('fetch failed (simulated offline)');
  };
  const errors = [];
  const agent = createAgent({
    config: makeTestConfig(),
    fetchImpl,
    workdir: dir,
    onError: (err) => errors.push(err),
  });

  const result = await agent.run({ text: '在吗' });
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /cannot reach the model endpoint/);
  assert.match(result.text, /连不上模型/);
  assert.equal(result.aborted, undefined);
});

test('missing api key is reported to onError and does not crash', async (t) => {
  const dir = await tempDir(t);
  const config = makeTestConfig();
  config.deepseek.apiKey = '';
  const errors = [];
  const agent = createAgent({ config, fetchImpl: fakeFetchSequence([textResponse('unused')]), workdir: dir, onError: (err) => errors.push(err) });
  const result = await agent.run({ text: '你好' });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /apiKey is missing/);
  assert.match(result.text, /连不上模型|抱歉/);
});

test('maxToolRounds stops a runaway tool loop', async (t) => {
  const dir = await tempDir(t);
  const echo = defineTool({
    name: 'echo',
    description: 'Echo the input (test tool).',
    parameters: {},
    async execute() {
      return 'echo result';
    },
  });
  const loopResponse = toolCallResponse([{ id: 'call_loop', name: 'echo', args: {} }]);
  const fetchImpl = fakeFetchSequence([loopResponse]);
  const agent = createAgent({
    config: makeTestConfig({ deepseek: { maxToolRounds: 2 } }),
    fetchImpl,
    workdir: dir,
    tools: [echo],
  });

  const result = await agent.run({ text: '死循环' });
  assert.equal(result.toolRounds, 3);
  assert.match(result.text, /查了好几轮|换个说法/);
  assert.ok(fetchImpl.calls.length >= 3);
});

test('conversation context is kept across runs and reset() clears it', async (t) => {
  const dir = await tempDir(t);
  const fetchImpl = fakeFetchSequence([textResponse('第一次回答。'), textResponse('第二次回答。')]);
  const agent = createAgent({ config: makeTestConfig({ agent: { maxTurns: 20 } }), fetchImpl, workdir: dir });

  await agent.run({ text: '第一轮问题' });
  await agent.run({ text: '第二轮问题' });

  const secondCallMessages = fetchImpl.calls[1].body.messages;
  const userTexts = secondCallMessages.filter((message) => message.role === 'user').map((message) => message.content);
  assert.deepEqual(userTexts, ['第一轮问题', '第二轮问题']);
  assert.equal(secondCallMessages[0].role, 'system');

  agent.reset();
  assert.equal(agent.history.length, 1);
  assert.equal(agent.history[0].role, 'system');
});

test('history is trimmed to the configured number of turns', async (t) => {
  const dir = await tempDir(t);
  const fetchImpl = fakeFetchSequence([textResponse('好。')]);
  const agent = createAgent({ config: makeTestConfig({ agent: { maxTurns: 3 } }), fetchImpl, workdir: dir });
  for (let i = 0; i < 6; i += 1) await agent.run({ text: `问题${i}` });
  const userTurns = agent.history.filter((message) => message.role === 'user');
  assert.equal(userTurns.length, 3);
  assert.deepEqual(userTurns.map((message) => message.content), ['问题3', '问题4', '问题5']);
});

test('system prompt keeps the dsh identity and tool guidance, rewritten for voice', () => {
  const prompt = buildSystemPrompt({ config: makeTestConfig(), workdir: '/tmp' });
  assert.match(prompt, /^You are an AI agent powered by DeepSeek Harness\./);
  assert.match(prompt, /费加罗/);
  assert.match(prompt, /Check the \[exit code: N\] marker on every bash result/);
  assert.match(prompt, /Use the read tool — not shell commands like cat/);
  assert.match(prompt, /Use the glob tool — not shell find/);
  assert.match(prompt, /Use the grep tool — not shell grep or rg/);
  assert.match(prompt, /untrusted data/);
  // Voice rewrite: spoken style, no markdown, and deliberately one short
  // sentence by default (the user asked for terse replies).
  assert.match(prompt, /Default to ONE sentence/);
  assert.match(prompt, /Never use markdown/);
  assert.match(prompt, /Do not claim to have done something you have not done/);
  // Runtime context is fresh per call.
  assert.match(prompt, /当前时间：/);
  assert.doesNotMatch(prompt, /test-key-not-real/);
});

test('a slow consumer of onTextDelta cannot break the model stream', async (t) => {
  const dir = await tempDir(t);
  const fetchImpl = fakeFetchSequence([textResponse('好的。')]);
  const agent = createAgent({
    config: makeTestConfig(),
    fetchImpl,
    workdir: dir,
    onTextDelta: () => {
      throw new Error('consumer blew up');
    },
  });
  const result = await agent.run({ text: '测试' });
  assert.equal(result.text, '好的。');
});

test('streaming works when the endpoint returns plain JSON instead of SSE', async (t) => {
  const dir = await tempDir(t);
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '纯 JSON 回复。' }, finish_reason: 'stop' }],
        usage: { total_tokens: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const agent = createAgent({ config: makeTestConfig(), fetchImpl, workdir: dir });
  const result = await agent.run({ text: '你好' });
  assert.equal(result.text, '纯 JSON 回复。');
  assert.deepEqual(result.usage, { total_tokens: 4 });
});

test('tool call deltas split across chunks are reassembled', async (t) => {
  const dir = await tempDir(t);
  const firstCallPart = `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_split', type: 'function', function: { name: 'bash', arguments: '{"command":"ec' } },
          ],
        },
      },
    ],
  })}\n\n`;
  const secondCallPart = `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: 'ho split-ok","description":"split test"}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
  })}\n\n`;
  const fetchImpl = fakeFetchSequence([firstCallPart + secondCallPart + sseDone(), textResponse('拼好了。')]);
  const agent = createAgent({ config: makeTestConfig(), fetchImpl, workdir: dir });
  const result = await agent.run({ text: '测试分片' });
  assert.equal(result.text, '拼好了。');
  const toolMessage = fetchImpl.calls[1].body.messages.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /split-ok/);
});
