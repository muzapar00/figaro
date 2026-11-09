// Streaming client for the DeepSeek /chat/completions endpoint.
//
// Speaks both the SSE wire format (`stream: true`) and a plain JSON response, so
// tests can swap in a fake `fetch` that returns either shape. Tool-call deltas
// are accumulated by index exactly as OpenAI-compatible servers send them.
import { parseSseData } from './sse.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const MAX_ERROR_BODY_CHARS = 4_000;

export class LlmRequestError extends Error {
  constructor(message, { status, body, retryable = false, cause } = {}) {
    super(message);
    this.name = 'LlmRequestError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
    this.cause = cause;
  }
}

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function normalizeToolCalls(rawCalls = []) {
  return rawCalls
    .filter((call) => call && typeof call === 'object')
    .map((call, index) => ({
      id: call.id || `call_${index}`,
      type: 'function',
      function: {
        name: call.function?.name || '',
        arguments: call.function?.arguments ?? '',
      },
    }))
    .filter((call) => call.function.name.length > 0);
}

/**
 * One model call. Streams text deltas through `onDelta`, returns the complete
 * content, tool calls, finish reason and usage for this step.
 *
 * @param {object} options
 * @param {object} options.config loadConfig() result
 * @param {Array<object>} options.messages chat messages including the system prompt
 * @param {Array<object>} [options.tools] chat tools array (OpenAI shape)
 * @param {AbortSignal} [options.signal]
 * @param {(delta: string) => void} [options.onDelta]
 * @param {Function} [options.fetchImpl]
 */
export async function streamChatCompletion({
  config,
  messages,
  tools,
  signal,
  onDelta,
  fetchImpl,
}) {
  const deepseek = config?.deepseek ?? {};
  const apiKey = deepseek.apiKey;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new LlmRequestError('deepseek apiKey is missing; set it in ~/.config/figaro/config.json', { retryable: false });
  }
  const baseUrl = (deepseek.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const model = deepseek.model || 'deepseek-flash';
  const requestTimeoutMs = Number(deepseek.requestTimeoutMs) > 0
    ? Number(deepseek.requestTimeoutMs)
    : DEFAULT_REQUEST_TIMEOUT_MS;

  const body = {
    model,
    messages,
    stream: true,
    ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
    ...(typeof deepseek.temperature === 'number' ? { temperature: deepseek.temperature } : {}),
    ...(deepseek.requestOptions && typeof deepseek.requestOptions === 'object' && !Array.isArray(deepseek.requestOptions)
      ? deepseek.requestOptions
      : {}),
  };

  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new LlmRequestError('no fetch implementation available');

  let res;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    if (signal?.aborted) throw abortError();
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new LlmRequestError(`model request timed out after ${requestTimeoutMs}ms`, { retryable: true, cause: err });
    }
    throw new LlmRequestError(`cannot reach the model endpoint: ${err?.message || err}`, { retryable: true, cause: err });
  }

  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* ignore */
    }
    const trimmed = text.slice(0, MAX_ERROR_BODY_CHARS);
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new LlmRequestError(`model endpoint returned HTTP ${res.status}: ${trimmed || '(empty body)'}`, {
      status: res.status,
      body: trimmed,
      retryable,
    });
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  // Non-streaming JSON response (some proxies ignore stream:true, and tests use it).
  if (contentType.includes('application/json')) {
    const payload = await res.json();
    if (payload?.error) {
      throw new LlmRequestError(`model error: ${JSON.stringify(payload.error).slice(0, MAX_ERROR_BODY_CHARS)}`, {
        status: res.status,
        retryable: false,
      });
    }
    const choice = payload?.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const content = typeof message.content === 'string' ? message.content : '';
    if (content.length > 0) onDelta?.(content);
    return {
      content,
      reasoningContent: message.reasoning_content ?? '',
      toolCalls: normalizeToolCalls(message.tool_calls),
      finishReason: choice.finish_reason ?? null,
      usage: payload?.usage ?? null,
    };
  }

  if (!res.body) throw new LlmRequestError('model endpoint returned an empty body', { retryable: true });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningContent = '';
  let finishReason = null;
  let usage = null;
  const toolCallsByIndex = [];
  let sawData = false;

  const handlePayload = (payload) => {
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (chunk?.error) {
      throw new LlmRequestError(`model error: ${JSON.stringify(chunk.error).slice(0, MAX_ERROR_BODY_CHARS)}`, {
        retryable: false,
      });
    }
    if (chunk?.usage) usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? choice.message ?? {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      reasoningContent += delta.reasoning_content;
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const index = Number.isInteger(part.index) ? part.index : toolCallsByIndex.length;
        if (!toolCallsByIndex[index]) {
          toolCallsByIndex[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        }
        const slot = toolCallsByIndex[index];
        if (part.id) slot.id = part.id;
        if (part.type) slot.type = part.type;
        if (part.function?.name) slot.function.name += part.function.name;
        if (part.function?.arguments) slot.function.arguments += part.function.arguments;
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { lines, remainder } = parseSseData(buffer);
      buffer = remainder;
      for (const line of lines) {
        sawData = true;
        handlePayload(line);
      }
    }
    const { lines } = parseSseData(`${buffer}\n`);
    for (const line of lines) {
      sawData = true;
      handlePayload(line);
    }
  } catch (err) {
    if (err instanceof LlmRequestError) throw err;
    if (signal?.aborted) throw abortError();
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new LlmRequestError(`model stream timed out after ${requestTimeoutMs}ms`, { retryable: true, cause: err });
    }
    throw new LlmRequestError(`model stream failed: ${err?.message || err}`, { retryable: true, cause: err });
  }

  if (!sawData) throw new LlmRequestError('model stream produced no data frames', { retryable: true });

  return {
    content,
    reasoningContent,
    toolCalls: normalizeToolCalls(toolCallsByIndex),
    finishReason,
    usage,
  };
}

export { sleep, abortError, DEFAULT_REQUEST_TIMEOUT_MS };
