// Streaming client for the configured LLM provider.
//
// Two wire protocols are spoken behind one call shape:
//   * OpenAI-compatible (provider deepseek / openai / custom):
//       POST {baseUrl}/chat/completions with `stream: true`, SSE frames
//       (`data: {...}`), tool calls accumulated by index. Plain JSON responses
//       are accepted too (some proxies ignore `stream`, and tests use it).
//   * Gemini native (provider gemini):
//       POST {baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse,
//       `contents`/`parts` request bodies, functionCall/functionResponse parts
//       and usageMetadata. Both are mapped onto the same
//       {content, reasoningContent, toolCalls, finishReason, usage} result so
//       the agent tool loop does not care which provider is behind it.
//
// Safety rules (v1.0): the API key is never logged, never put in an error
// message, and never forwarded to a redirect target. A custom baseUrl must be
// https, or http on loopback only (a local OpenAI-compatible server); redirects
// are followed at most to the same origin — never to "any domain".
import { resolveLlmConfig, LLM_PROVIDERS } from '../config.js';
import { parseSseData } from './sse.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const MAX_ERROR_BODY_CHARS = 4_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const SECRET_QUERY_PARAMS = ['key', 'api_key', 'apiKey', 'access_token', 'token'];

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

// --- URL / secret hygiene ----------------------------------------------------

/** Strip a `key=...`-style query value so a URL can be shown in a log or error. */
function redactUrl(value) {
  try {
    const url = new URL(String(value));
    for (const name of SECRET_QUERY_PARAMS) {
      if (url.searchParams.has(name)) url.searchParams.set(name, '***');
    }
    return url.href;
  } catch {
    return String(value ?? '');
  }
}

/** Remove an API key (or anything that looks like it) from free-form text. */
function scrubSecret(text, apiKey) {
  let out = String(text ?? '');
  if (typeof apiKey === 'string' && apiKey.length >= 4) out = out.split(apiKey).join('[redacted]');
  return out;
}

/**
 * Parse and enforce the endpoint policy: https anywhere, plain http only for a
 * loopback server. Credentials in the URL are rejected (they would end up in
 * logs and proxied requests).
 */
function parseEndpointUrl(raw, label = 'baseUrl') {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new LlmRequestError(`${label} is missing`, { retryable: false });
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new LlmRequestError(`${label} is not a valid URL: ${redactUrl(raw)}`, { retryable: false });
  }
  if (url.username || url.password) {
    throw new LlmRequestError(`${label} must not embed credentials`, { retryable: false });
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return url;
  throw new LlmRequestError(
    `${label} must be https (or http://127.0.0.1 / http://localhost for a local model server), got ${url.protocol}//${url.host}`,
    { retryable: false },
  );
}

/**
 * fetch() with a redirect policy: at most MAX_REDIRECTS hops, 307/308 only (a
 * 301/302/303 on POST would silently turn the request into a GET), and every
 * hop must keep the original origin so the Authorization header / API key is
 * never forwarded to a different host.
 */
async function fetchWithRedirectPolicy(doFetch, rawUrl, init = {}) {
  let url = parseEndpointUrl(rawUrl, 'model endpoint URL');
  const origin = url.origin;
  let requestInit = { ...init, redirect: 'manual' };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await doFetch(url.href, requestInit);
    if (!REDIRECT_STATUSES.has(res?.status)) return res;
    const location = res.headers?.get?.('location');
    if (!location) return res;
    let next;
    try {
      next = new URL(location, url);
    } catch {
      throw new LlmRequestError('model endpoint returned an invalid redirect target', { retryable: false });
    }
    if (next.origin !== origin) {
      throw new LlmRequestError(
        `model endpoint redirected to a different origin (${redactUrl(next.href)}); refusing to forward credentials there`,
        { retryable: false },
      );
    }
    if (res.status !== 307 && res.status !== 308) {
      throw new LlmRequestError(
        `model endpoint answered HTTP ${res.status} redirect to ${redactUrl(next.href)}; refusing to follow a redirect that changes POST into GET (fix llm.baseUrl)`,
        { retryable: false },
      );
    }
    parseEndpointUrl(next.href, 'redirect target');
    url = next;
    requestInit = { ...init, redirect: 'manual' };
  }
  throw new LlmRequestError('model endpoint redirected too many times', { retryable: false });
}

async function readErrorBody(res) {
  try {
    return String(await res.text()).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return '';
  }
}

function retryableStatus(status) {
  return status >= 500 || status === 429 || status === 408;
}

function emitDelta(onDelta, text) {
  if (typeof onDelta !== 'function' || typeof text !== 'string' || text.length === 0) return;
  try {
    onDelta(text);
  } catch {
    /* a broken consumer must not break the stream */
  }
}

// --- request assembly --------------------------------------------------------

function effectiveLlm(config) {
  const settings = resolveLlmConfig(config ?? {});
  return {
    ...settings,
    requestTimeoutMs: settings.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

function assertKnownProvider(provider) {
  if (!LLM_PROVIDERS.includes(provider)) {
    throw new LlmRequestError(
      `unsupported LLM provider "${provider}"; expected one of ${LLM_PROVIDERS.join(', ')}`,
      { retryable: false },
    );
  }
}

function assertModel(settings) {
  if (typeof settings.model !== 'string' || settings.model.trim().length === 0) {
    throw new LlmRequestError(
      `LLM model is missing for provider "${settings.provider}"; set llm.model in ~/.config/figaro/config.json`,
      { retryable: false },
    );
  }
}

function requiresApiKey(settings) {
  // Local OpenAI-compatible servers (Ollama, LM Studio, vLLM without auth) need
  // no key; hosted APIs always do.
  if (settings.provider === 'custom') return false;
  return true;
}

function assertApiKey(settings) {
  if (!requiresApiKey(settings)) return;
  if (typeof settings.apiKey !== 'string' || settings.apiKey.trim().length === 0) {
    throw new LlmRequestError(
      `LLM apiKey is missing for provider "${settings.provider}"; set llm.apiKey in ~/.config/figaro/config.json`,
      { retryable: false },
    );
  }
}

function openAiChatUrl(baseUrl) {
  const trimmed = String(baseUrl ?? '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function openAiModelsUrl(baseUrl) {
  const trimmed = String(baseUrl ?? '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) {
    return `${trimmed.slice(0, trimmed.length - '/chat/completions'.length)}/models`;
  }
  return `${trimmed}/models`;
}

/** baseUrl may be pasted with or without a version segment; accept both. */
function geminiApiRoot(baseUrl) {
  return String(baseUrl ?? '')
    .replace(/\/+$/, '')
    .replace(/\/(v1beta1|v1beta|v1)$/i, '');
}

function geminiModelName(model) {
  return String(model ?? '').trim().replace(/^models\//, '');
}

function geminiStreamUrl(baseUrl, model, apiKey) {
  const root = geminiApiRoot(baseUrl);
  const base = `${root}/v1beta/models/${encodeURIComponent(geminiModelName(model))}:streamGenerateContent?alt=sse`;
  return apiKey ? `${base}&key=${encodeURIComponent(apiKey)}` : base;
}

function geminiModelsUrl(baseUrl, apiKey) {
  const base = `${geminiApiRoot(baseUrl)}/v1beta/models?pageSize=1`;
  return apiKey ? `${base}&key=${encodeURIComponent(apiKey)}` : base;
}

function baseHeaders(settings) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
  };
  if (settings.provider !== 'gemini' && settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }
  return headers;
}

function buildOpenAiRequest(settings, messages, tools) {
  const body = {
    model: settings.model,
    messages,
    stream: true,
    ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
    ...(typeof settings.temperature === 'number' ? { temperature: settings.temperature } : {}),
    // Voice answers are spoken, so waiting ~1.2s while the model thinks first is
    // the single largest source of latency. `none` asks for the answer directly
    // (measured: first answer token 659ms instead of 1792ms); tool use still
    // works, it just skips the preamble.
    ...(typeof settings.reasoningEffort === 'string' && settings.reasoningEffort.length > 0
      ? { reasoning_effort: settings.reasoningEffort }
      : {}),
    ...(settings.requestOptions ?? {}),
  };
  return {
    url: openAiChatUrl(settings.baseUrl),
    headers: baseHeaders(settings),
    body: JSON.stringify(body),
  };
}

// --- Gemini request conversion ----------------------------------------------

function collectSystemText(messages = []) {
  const parts = [];
  for (const message of messages) {
    if (message?.role !== 'system') continue;
    const content = message.content;
    if (typeof content === 'string' && content.length > 0) parts.push(content);
    else if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === 'text' && typeof item.text === 'string' && item.text.length > 0) parts.push(item.text);
      }
    }
  }
  return parts.join('\n\n');
}

function toGeminiParts(content) {
  if (typeof content === 'string') return content.length > 0 ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
      parts.push({ text: item.text });
    } else if (item.type === 'image_url') {
      const dataUrl = item.image_url?.url;
      const match = typeof dataUrl === 'string' ? /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl) : null;
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
      // Remote image URLs would need an explicit Files API upload; dropping them
      // keeps the request valid instead of failing the whole turn.
    }
  }
  return parts;
}

function parseToolArguments(argumentsText) {
  if (argumentsText && typeof argumentsText === 'object') return argumentsText;
  if (typeof argumentsText !== 'string' || argumentsText.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { value: parsed };
  } catch {
    // Gemini wants an object here; keep the raw text so nothing is silently lost.
    return { raw: argumentsText };
  }
}

/**
 * OpenAI-shaped messages -> Gemini `contents`. System text is hoisted by
 * collectSystemText (systemInstruction); assistant tool_calls become
 * functionCall parts; role:"tool" results become functionResponse parts (the
 * function name is recovered from the earlier assistant message because Gemini
 * addresses tool results by name, not by call id).
 */
function toGeminiContents(messages = []) {
  const contents = [];
  const callNames = new Map();
  let lastWasToolResult = false;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      const parts = toGeminiParts(message.content);
      if (parts.length === 0) continue;
      contents.push({ role: 'user', parts });
      lastWasToolResult = false;
      continue;
    }
    if (message.role === 'assistant') {
      const parts = toGeminiParts(message.content);
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          const name = call?.function?.name;
          if (typeof name !== 'string' || name.length === 0) continue;
          if (call.id) callNames.set(call.id, name);
          parts.push({ functionCall: { name, args: parseToolArguments(call.function.arguments) } });
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      lastWasToolResult = false;
      continue;
    }
    if (message.role === 'tool') {
      const name = callNames.get(message.tool_call_id) || (typeof message.name === 'string' && message.name) || 'tool';
      const resultText = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      const part = { functionResponse: { name, response: { result: resultText } } };
      if (lastWasToolResult) contents[contents.length - 1].parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
      lastWasToolResult = true;
    }
  }
  return contents;
}

// Gemini accepts only an OpenAPI-subset of JSON Schema; unknown keywords make
// the whole request fail with HTTP 400. Keep the supported subset, translate
// oneOf -> anyOf, and drop `additionalProperties` (our tools always emit false,
// which Gemini does not understand).
const GEMINI_SCHEMA_KEYS = new Set([
  'type', 'format', 'description', 'enum', 'properties', 'required', 'items',
  'nullable', 'anyOf', 'maxItems', 'minItems', 'pattern', 'minimum', 'maximum',
]);

function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'oneOf' && Array.isArray(value)) {
      out.anyOf = value.map(sanitizeGeminiSchema).filter(Boolean);
      continue;
    }
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      const properties = {};
      for (const [name, child] of Object.entries(value)) {
        const sanitized = sanitizeGeminiSchema(child);
        if (sanitized) properties[name] = sanitized;
      }
      if (Object.keys(properties).length > 0) out.properties = properties;
      continue;
    }
    if (key === 'items') {
      const sanitized = sanitizeGeminiSchema(value);
      if (sanitized) out.items = sanitized;
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toGeminiFunctionDeclaration(tool) {
  const fn = tool?.function ?? tool;
  const name = fn?.name;
  if (typeof name !== 'string' || name.length === 0) return null;
  const parameters = sanitizeGeminiSchema(fn.parameters);
  const hasProperties = Boolean(parameters && parameters.properties && Object.keys(parameters.properties).length > 0);
  return {
    name,
    ...(typeof fn.description === 'string' && fn.description.length > 0 ? { description: fn.description } : {}),
    // A function with no arguments is best declared without `parameters`.
    ...(hasProperties ? { parameters } : {}),
  };
}

function buildGeminiRequest(settings, messages, tools) {
  const contents = toGeminiContents(messages);
  if (contents.length === 0) {
    throw new LlmRequestError('refusing to call Gemini without any conversation contents', { retryable: false });
  }
  const systemText = collectSystemText(messages);
  const declarations = Array.isArray(tools)
    ? tools.map(toGeminiFunctionDeclaration).filter(Boolean)
    : [];
  const generationConfig = {
    ...(typeof settings.temperature === 'number' ? { temperature: settings.temperature } : {}),
    // Gemini's "answer directly" switch; other effort levels are left to
    // requestOptions.generationConfig so we never guess a thinking budget.
    ...(settings.reasoningEffort === 'none' ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  };
  const body = {
    contents,
    ...(systemText.length > 0 ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    ...(declarations.length > 0
      ? { tools: [{ functionDeclarations: declarations }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }
      : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    ...(settings.requestOptions ?? {}),
  };
  return {
    url: geminiStreamUrl(settings.baseUrl, settings.model, settings.apiKey),
    headers: baseHeaders(settings),
    body: JSON.stringify(body),
  };
}

// --- response consumption ----------------------------------------------------

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

function createOpenAiAccumulator(onDelta) {
  let content = '';
  let reasoningContent = '';
  let finishReason = null;
  let usage = null;
  const toolCallsByIndex = [];

  const handle = (chunk) => {
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
      emitDelta(onDelta, delta.content);
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

  return {
    handle,
    result: () => ({
      content,
      reasoningContent,
      toolCalls: normalizeToolCalls(toolCallsByIndex),
      finishReason,
      usage,
    }),
  };
}

const GEMINI_FINISH_REASONS = Object.freeze({
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  MALFORMED_FUNCTION_CALL: 'tool_calls',
  OTHER: 'stop',
});

function mapGeminiFinishReason(reason) {
  if (typeof reason !== 'string' || reason.length === 0) return null;
  return GEMINI_FINISH_REASONS[reason] ?? reason.toLowerCase();
}

function normalizeGeminiUsage(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const prompt = Number(metadata.promptTokenCount ?? 0) || 0;
  const completion = Number(metadata.candidatesTokenCount ?? 0) || 0;
  const total = Number(metadata.totalTokenCount ?? prompt + completion) || prompt + completion;
  const cached = Number(metadata.cachedContentTokenCount ?? 0) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    ...(cached > 0 ? { cached_tokens: cached } : {}),
  };
}

function createGeminiAccumulator(onDelta) {
  let content = '';
  let reasoningContent = '';
  let finishReason = null;
  let usage = null;
  const toolCalls = [];

  const handleParts = (parts) => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string' && part.text.length > 0) {
        if (part.thought === true) {
          reasoningContent += part.text;
        } else {
          content += part.text;
          emitDelta(onDelta, part.text);
        }
        continue;
      }
      if (part.functionCall && typeof part.functionCall === 'object') {
        const name = typeof part.functionCall.name === 'string' ? part.functionCall.name : '';
        if (name.length === 0) continue;
        const args = part.functionCall.args;
        toolCalls.push({
          id: `call_${toolCalls.length}`,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(args && typeof args === 'object' ? args : {}),
          },
        });
      }
    }
  };

  const handle = (payload) => {
    if (payload?.error) {
      throw new LlmRequestError(`model error: ${JSON.stringify(payload.error).slice(0, MAX_ERROR_BODY_CHARS)}`, {
        retryable: false,
      });
    }
    if (payload?.promptFeedback?.blockReason) {
      throw new LlmRequestError(
        `Gemini blocked the request: ${payload.promptFeedback.blockReason}`,
        { retryable: false },
      );
    }
    if (payload?.usageMetadata) usage = normalizeGeminiUsage(payload.usageMetadata);
    const candidate = payload?.candidates?.[0];
    if (!candidate) return;
    if (candidate.finishReason) finishReason = candidate.finishReason;
    handleParts(candidate?.content?.parts);
  };

  return {
    handle,
    result: () => ({
      content,
      reasoningContent,
      toolCalls: normalizeToolCalls(toolCalls),
      finishReason: toolCalls.length > 0 ? 'tool_calls' : mapGeminiFinishReason(finishReason),
      usage,
    }),
  };
}

async function readSsePayloads(res, { onPayload, signal, requestTimeoutMs, timeoutMessage, apiKey }) {
  if (!res.body) throw new LlmRequestError('model endpoint returned an empty body', { retryable: true });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawData = false;

  const consume = (lines) => {
    for (const line of lines) {
      sawData = true;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
      onPayload(payload);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { lines, remainder } = parseSseData(buffer);
      buffer = remainder;
      consume(lines);
    }
    consume(parseSseData(`${buffer}\n`).lines);
  } catch (err) {
    if (err instanceof LlmRequestError) throw err;
    if (signal?.aborted) throw abortError();
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new LlmRequestError(
        timeoutMessage ?? `model stream timed out after ${requestTimeoutMs}ms`,
        { retryable: true, cause: err },
      );
    }
    throw new LlmRequestError(`model stream failed: ${scrubSecret(err?.message || err, apiKey)}`, {
      retryable: true,
      cause: err,
    });
  }

  if (!sawData) throw new LlmRequestError('model stream produced no data frames', { retryable: true });
}

async function consumeOpenAiResponse(res, { onDelta, signal, requestTimeoutMs, apiKey }) {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  // Non-streaming JSON response (some proxies ignore stream:true, and tests use it).
  if (contentType.includes('application/json')) {
    const payload = await res.json();
    if (payload?.error) {
      throw new LlmRequestError(
        `model error: ${scrubSecret(JSON.stringify(payload.error).slice(0, MAX_ERROR_BODY_CHARS), apiKey)}`,
        { status: res.status, retryable: false },
      );
    }
    const choice = payload?.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const content = typeof message.content === 'string' ? message.content : '';
    emitDelta(onDelta, content);
    return {
      content,
      reasoningContent: message.reasoning_content ?? '',
      toolCalls: normalizeToolCalls(message.tool_calls),
      finishReason: choice.finish_reason ?? null,
      usage: payload?.usage ?? null,
    };
  }
  const accumulator = createOpenAiAccumulator(onDelta);
  await readSsePayloads(res, {
    onPayload: accumulator.handle,
    signal,
    requestTimeoutMs,
    timeoutMessage: `model stream timed out after ${requestTimeoutMs}ms`,
    apiKey,
  });
  return accumulator.result();
}

async function consumeGeminiResponse(res, { onDelta, signal, requestTimeoutMs, apiKey }) {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const accumulator = createGeminiAccumulator(onDelta);
  if (contentType.includes('application/json')) {
    const payload = await res.json();
    accumulator.handle(payload);
    return accumulator.result();
  }
  await readSsePayloads(res, {
    onPayload: accumulator.handle,
    signal,
    requestTimeoutMs,
    timeoutMessage: `model stream timed out after ${requestTimeoutMs}ms`,
    apiKey,
  });
  return accumulator.result();
}

/**
 * One model call. Streams text deltas through `onDelta`, returns the complete
 * content, tool calls, finish reason and usage for this step.
 *
 * @param {object} options
 * @param {object} options.config loadConfig() result (or a hand-built equivalent)
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
  const settings = effectiveLlm(config);
  const { provider, apiKey, requestTimeoutMs } = settings;
  assertKnownProvider(provider);
  assertModel(settings);
  assertApiKey(settings);

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new LlmRequestError('no fetch implementation available');

  const mode = provider === 'gemini' ? 'gemini' : 'openai';
  const request = mode === 'gemini'
    ? buildGeminiRequest(settings, messages ?? [], tools)
    : buildOpenAiRequest(settings, messages ?? [], tools);

  // AbortSignal.timeout() uses an unref'd timer: if the fetch implementation
  // never settles and nothing else keeps the loop alive, the process can exit
  // before the timeout fires. Use our own ref'd timer so a hung request always
  // produces the documented "timed out" error.
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => {
    try { timeoutController.abort(new DOMException('request timeout', 'TimeoutError')); } catch { /* ignore */ }
  }, Math.max(1, requestTimeoutMs));
  const combined = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

  let res;
  try {
    res = await fetchWithRedirectPolicy(doFetch, request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: combined,
    });
  } catch (err) {
    clearTimeout(timeoutTimer);
    if (signal?.aborted) throw abortError();
    if (err instanceof LlmRequestError) throw err;
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new LlmRequestError(`model request timed out after ${requestTimeoutMs}ms`, {
        retryable: true,
        cause: err,
      });
    }
    throw new LlmRequestError(`cannot reach the model endpoint: ${scrubSecret(err?.message || err, apiKey)}`, {
      retryable: true,
      cause: err,
    });
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (!res.ok) {
    const rawBody = await readErrorBody(res);
    const body = scrubSecret(rawBody, apiKey);
    throw new LlmRequestError(
      `model endpoint returned HTTP ${res.status}${body ? `: ${body}` : ' (empty body)'}`,
      { status: res.status, body, retryable: retryableStatus(res.status) },
    );
  }

  if (mode === 'gemini') {
    return consumeGeminiResponse(res, { onDelta, signal, requestTimeoutMs, apiKey });
  }
  return consumeOpenAiResponse(res, { onDelta, signal, requestTimeoutMs, apiKey });
}

// --- reusable connectivity probe (settings GUI `llm.test`) -------------------

function applyLlmDraft(config, draft) {
  const base = config && typeof config === 'object' ? config : {};
  if (!draft || typeof draft !== 'object') return base;
  const baseLlm = base.llm && typeof base.llm === 'object' ? base.llm : {};
  const clean = {};
  for (const key of [
    'provider', 'baseUrl', 'model', 'apiKey', 'reasoningEffort', 'temperature',
    'maxToolRounds', 'maxRetries', 'requestTimeoutMs', 'requestOptions',
  ]) {
    const value = draft[key];
    if (value !== undefined && value !== null && value !== '') clean[key] = value;
  }
  const merged = { ...baseLlm, ...clean };
  // Switching provider invalidates the saved endpoint defaults unless the draft
  // resends them; otherwise probing OpenAI would reuse the DeepSeek baseUrl.
  if (clean.provider && clean.provider !== baseLlm.provider) {
    if (clean.baseUrl === undefined) delete merged.baseUrl;
    if (clean.model === undefined) delete merged.model;
    if (clean.apiKey === undefined) delete merged.apiKey;
  }
  return { ...base, llm: merged };
}

function providerErrorMessage(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const message = payload.error?.message ?? payload.message ?? payload.error?.status;
  return typeof message === 'string' ? message.slice(0, 300) : '';
}

/**
 * Check that the configured provider + endpoint + key actually answer, without
 * running a whole turn. Used by the settings GUI (`llm.test`, draft values may
 * be overlaid on top of the saved config) and safe to call directly.
 *
 * @param {object} [options]
 * @param {object} [options.config] effective config (loadConfig() result)
 * @param {object|null} [options.llm] draft `llm` fields that override the saved ones
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: boolean, provider: string, baseUrl: string, model: string,
 *   status: number|null, message: string, latencyMs: number}>}
 */
export async function testLlmConnection({
  config = {},
  llm = null,
  fetchImpl,
  timeoutMs = 8000,
  signal,
} = {}) {
  const startedAt = Date.now();
  const finish = (result) => ({
    ok: false,
    status: null,
    message: '',
    provider: '',
    baseUrl: '',
    model: '',
    ...result,
    latencyMs: Date.now() - startedAt,
  });

  let settings;
  try {
    settings = effectiveLlm(applyLlmDraft(config, llm));
    assertKnownProvider(settings.provider);
    assertModel(settings);
  } catch (err) {
    return finish({
      provider: llm?.provider ?? config?.llm?.provider ?? '',
      baseUrl: '',
      model: llm?.model ?? config?.llm?.model ?? '',
      message: err?.message || String(err),
    });
  }

  const { provider, model, apiKey } = settings;
  let probeUrl;
  try {
    probeUrl = provider === 'gemini'
      ? geminiModelsUrl(settings.baseUrl, apiKey)
      : openAiModelsUrl(settings.baseUrl);
    parseEndpointUrl(probeUrl, 'model endpoint URL');
  } catch (err) {
    return finish({
      provider,
      baseUrl: settings.baseUrl,
      model,
      message: err?.message || String(err),
    });
  }

  if (requiresApiKey(settings) && apiKey.trim().length === 0) {
    return finish({
      provider,
      baseUrl: settings.baseUrl,
      model,
      message: `API key 未配置（llm.apiKey，provider ${provider}）`,
    });
  }

  const headers = provider === 'gemini'
    ? { Accept: 'application/json' }
    : { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return finish({ provider, baseUrl: settings.baseUrl, model, message: '当前环境没有 fetch，无法测试连接' });
  }
  const timeoutSignal = AbortSignal.timeout(Math.max(500, Math.min(Number(timeoutMs) || 8000, 60_000)));
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let res;
  try {
    res = await fetchWithRedirectPolicy(doFetch, probeUrl, {
      method: 'GET',
      headers,
      signal: combined,
    });
  } catch (err) {
    if (err instanceof LlmRequestError) {
      return finish({ provider, baseUrl: settings.baseUrl, model, message: scrubSecret(err.message, apiKey) });
    }
    if (signal?.aborted) {
      return finish({ provider, baseUrl: settings.baseUrl, model, message: '测试已取消' });
    }
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return finish({
      provider,
      baseUrl: settings.baseUrl,
      model,
      message: timedOut
        ? `连接超时（${Math.round((Date.now() - startedAt) / 100) / 10}s）`
        : `无法连接模型服务：${scrubSecret(err?.message || err, apiKey)}`,
    });
  }

  const rawBody = await readErrorBody(res);
  const bodyText = scrubSecret(rawBody, apiKey);
  let detail = '';
  try {
    detail = providerErrorMessage(JSON.parse(bodyText)) ;
  } catch {
    /* not JSON */
  }
  const suffix = detail ? `：${detail}` : '';

  if (res.ok) {
    return finish({
      ok: true,
      provider,
      baseUrl: settings.baseUrl,
      model,
      status: res.status,
      message: `连接成功（${provider} / ${model}）`,
    });
  }
  if (res.status === 401 || res.status === 403) {
    return finish({
      provider,
      baseUrl: settings.baseUrl,
      model,
      status: res.status,
      message: `API key 无效或权限不足（HTTP ${res.status}）${suffix}`,
    });
  }
  if (res.status === 404) {
    if (provider === 'custom') {
      return finish({
        ok: true,
        provider,
        baseUrl: settings.baseUrl,
        model,
        status: res.status,
        message: '服务可达，但未提供模型列表接口（HTTP 404，本地服务常见，通常仍可使用）',
      });
    }
    return finish({
      provider,
      baseUrl: settings.baseUrl,
      model,
      status: res.status,
      message: `接口路径不存在（HTTP 404），检查 llm.baseUrl 是否包含正确路径${suffix}`,
    });
  }
  if (res.status === 429) {
    return finish({
      provider,
      baseUrl: settings.baseUrl,
      model,
      status: res.status,
      message: `请求被限流（HTTP 429），稍后再试${suffix}`,
    });
  }
  if (res.status >= 500) {
    return finish({
      provider,
      baseUrl: settings.baseUrl,
      model,
      status: res.status,
      message: `模型服务端错误（HTTP ${res.status}）${suffix}`,
    });
  }
  return finish({
    provider,
    baseUrl: settings.baseUrl,
    model,
    status: res.status,
    message: `连接失败（HTTP ${res.status}）${suffix}`,
  });
}

export { sleep, abortError, DEFAULT_REQUEST_TIMEOUT_MS };
