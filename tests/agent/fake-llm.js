// Test helpers: an injectable `fetch` that replays canned SSE bodies for the
// DeepSeek chat endpoint, plus small async utilities.

export function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function contentChunk(text, finishReason = null) {
  return sseEvent({ choices: [{ delta: { content: text }, finish_reason: finishReason }] });
}

export function toolCallChunk(toolCalls, finishReason = null) {
  return sseEvent({
    choices: [
      {
        delta: {
          tool_calls: toolCalls.map((call, index) => ({
            index,
            id: call.id ?? `call_${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
          })),
        },
        finish_reason: finishReason,
      },
    ],
  });
}

export function usageChunk(usage) {
  return sseEvent({ choices: [], usage });
}

export function sseDone() {
  return 'data: [DONE]\n\n';
}

/**
 * Build a fetch implementation that returns the given SSE bodies in order.
 * The last body is reused once the queue is exhausted.
 */
export function fakeFetchSequence(responses) {
  const queue = [...responses];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url,
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(url, init);
    return new Response(String(next), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

export function toolCallResponse(calls, { preamble = '', finishReason = 'tool_calls' } = {}) {
  return (
    (preamble ? contentChunk(preamble) : '') +
    toolCallChunk(calls, finishReason) +
    usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) +
    sseDone()
  );
}

export function textResponse(text, { finishReason = 'stop' } = {}) {
  return (
    contentChunk(text, finishReason) +
    usageChunk({ prompt_tokens: 20, completion_tokens: text.length, total_tokens: 20 + text.length }) +
    sseDone()
  );
}

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export const silentLogger = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

/** Test config with every irrelevant knob pinned; no real key needed with a fake fetch. */
export function makeTestConfig(overrides = {}) {
  return {
    deepseek: {
      apiKey: 'test-key-not-real',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      temperature: 0.6,
      maxToolRounds: 4,
      maxRetries: 0,
      ...overrides.deepseek,
    },
    agent: { name: '费加罗', ...overrides.agent },
    asr: { enabled: false, ...overrides.asr },
    tts: { enabled: false, ...overrides.tts },
    ui: { socket: overrides.socket ?? '/tmp/figaro-test-unused.sock' },
  };
}
