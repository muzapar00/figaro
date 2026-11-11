// Figaro's brain: a DeepSeek chat model with a local tool-calling loop.
//
// Public contract (docs/ipc.md §2.3):
//   createAgent({config, onTextDelta, onToolEvent, onState, onError})
//     -> { run({text, signal}), reset(), history }
//
// The system prompt and the tool catalog are carried over from DeepSeek Harness
// (see docs/ipc.md §6) but implemented here: no dsh package is imported.
import { buildSystemPrompt } from './prompt.js';
import { streamChatCompletion, sleep } from './llm.js';
import { createRagClient } from './rag.js';
import { createTools, defaultToolWorkdir, summarizeToolCall } from './tools/index.js';
import { buildToolRegistry } from './tools/registry.js';

const DEFAULT_MAX_TOOL_ROUNDS = 24;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_MAX_TURNS = 20;
const MAX_TOOL_RESULT_CHARS = 40_000;
const MAX_HISTORY_CHARS = 400_000;
const NETWORK_FALLBACK_TEXT = '抱歉，我这边连不上模型，稍等一下再问我一次。';
const ROUNDS_FALLBACK_TEXT = '这件事我查了好几轮还没搞定，先歇一下，换个说法再问我可以吗？';

function abortedError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * @param {object} options
 * @param {object} options.config loadConfig() result
 * @param {(delta: string) => void} [options.onTextDelta]
 * @param {(event: {name: string, status: 'start'|'end', summary?: string, durationMs?: number, ok?: boolean}) => void} [options.onToolEvent]
 * @param {(state: string) => void} [options.onState]
 * @param {(error: Error) => void} [options.onError]
 * @param {Function} [options.fetchImpl] injectable fetch (tests)
 * @param {Array<object>} [options.tools] injectable tool list (tests)
 * @param {string} [options.workdir]
 */
export function createAgent(options = {}) {
  const config = options.config ?? {};
  const onTextDelta = options.onTextDelta;
  const onToolEvent = options.onToolEvent;
  const onState = options.onState;
  const onError = options.onError;
  const fetchImpl = options.fetchImpl;
  const workdir = options.workdir ?? defaultToolWorkdir(config);

  // Long-term memory: a standalone LightRAG service (docs/rag.md). Only created
  // when the merged config enables it, so hand-built test configs stay hermetic.
  const rag = options.rag ?? (config.rag?.enabled === true ? createRagClient({ config }) : null);
  const registry = buildToolRegistry(
    options.tools ?? createTools({ config, workdir, control: options.control, rag }),
  );
  const maxToolRounds = Number.isFinite(Number(config.deepseek?.maxToolRounds))
    ? Math.max(1, Math.floor(Number(config.deepseek?.maxToolRounds)))
    : DEFAULT_MAX_TOOL_ROUNDS;
  const maxRetries = Number.isFinite(Number(config.deepseek?.maxRetries))
    ? Math.max(0, Math.floor(Number(config.deepseek?.maxRetries)))
    : DEFAULT_MAX_RETRIES;
  const maxTurns = Number.isFinite(Number(config.agent?.maxTurns))
    ? Math.max(1, Math.floor(Number(config.agent?.maxTurns)))
    : DEFAULT_MAX_TURNS;

  let messages = [];
  let running = false;
  let turnCounter = 0;

  function refreshSystemMessage(ragContext = '') {
    const system = {
      role: 'system',
      content: buildSystemPrompt({ config, workdir, now: new Date(), ragContext }),
    };
    if (messages.length === 0) messages.push(system);
    else messages[0] = system;
  }

  /** Keep the last `maxTurns` user/assistant exchanges (tool messages ride along). */
  function trimHistory() {
    const turnStarts = [];
    for (let i = 1; i < messages.length; i += 1) {
      if (messages[i].role === 'user') turnStarts.push(i);
    }
    let dropUntil = 0;
    if (turnStarts.length > maxTurns) {
      dropUntil = turnStarts[turnStarts.length - maxTurns];
    }
    if (dropUntil > 0) messages = [messages[0], ...messages.slice(dropUntil)];

    // Character budget: drop the oldest exchanges until the payload fits.
    const approxChars = () => messages.reduce((sum, message) => {
      if (typeof message.content === 'string') return sum + message.content.length;
      if (Array.isArray(message.tool_calls)) {
        return sum + message.tool_calls.reduce((n, call) => n + (call.function?.arguments?.length ?? 0), 0);
      }
      return sum;
    }, 0);
    while (messages.length > 2 && approxChars() > MAX_HISTORY_CHARS) {
      const nextTurn = messages.findIndex((message, index) => index > 0 && message.role === 'user');
      if (nextTurn <= 0) break;
      messages = [messages[0], ...messages.slice(nextTurn)];
    }
  }

  async function callModel({ signal }) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (signal?.aborted) throw abortedError();
      try {
        return await streamChatCompletion({
          config,
          messages,
          tools: registry.schemas,
          signal,
          fetchImpl,
          onDelta: (delta) => {
            try {
              onTextDelta?.(delta);
            } catch {
              /* a broken consumer must not break the stream */
            }
          },
        });
      } catch (err) {
        lastError = err;
        if (err?.name === 'AbortError') throw err;
        if (!err?.retryable || attempt >= maxRetries || signal?.aborted) throw err;
        await sleep(400 * (attempt + 1), signal);
      }
    }
    throw lastError;
  }

  async function executeToolCall(call, { signal }) {
    const name = call?.function?.name || '(unknown)';
    const callId = call?.id || `call_${turnCounter}`;
    let args = {};
    let argsError;
    const rawArgs = call?.function?.arguments ?? '';
    if (typeof rawArgs === 'string' && rawArgs.trim().length > 0) {
      try {
        args = JSON.parse(rawArgs);
      } catch (err) {
        argsError = err;
      }
    }
    if (argsError) {
      const content = `Error: invalid JSON arguments for tool ${name}: ${argsError.message}`;
      messages.push({ role: 'tool', tool_call_id: callId, content });
      onToolEvent?.({ name, status: 'end', summary: '参数解析失败', ok: false });
      return;
    }
    if (args === null || typeof args !== 'object') args = {};

    const summary = summarizeToolCall(name, args);
    onToolEvent?.({ name, status: 'start', summary });
    const startedAt = Date.now();
    const tool = registry.get(name);
    let content;
    let imagePart = null;
    if (!tool) {
      content = `Error: unknown tool "${name}". Available tools: ${registry.names().join(', ')}`;
    } else {
      try {
        const result = await tool.execute(args, { signal });
        if (result && typeof result === 'object' && result.image) {
          // Picture-returning tools (view_image) hand the image back separately:
          // it has to travel as a user message with an image part, not as a text
          // tool result.
          imagePart = result.image;
          content = String(result.content ?? 'image');
        } else {
          content = typeof result === 'string' ? result : JSON.stringify(result);
        }
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) {
          content = 'Error: tool call aborted by the user';
        } else {
          content = `Error: ${err?.message || err}`;
        }
      }
    }
    if (content.length > MAX_TOOL_RESULT_CHARS) {
      content = `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated: tool result exceeded ${MAX_TOOL_RESULT_CHARS} chars]`;
    }
    messages.push({ role: 'tool', tool_call_id: callId, content });
    if (imagePart) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: '(image returned by the view_image tool above)' },
          {
            type: 'image_url',
            image_url: { url: `data:${imagePart.mimeType};base64,${imagePart.dataBase64}` },
          },
        ],
      });
    }
    onToolEvent?.({
      name,
      status: 'end',
      summary,
      durationMs: Date.now() - startedAt,
      ok: !content.startsWith('Error:'),
    });
  }

  /**
   * Run one conversational turn.
   * @param {{ text: string, signal?: AbortSignal }} input
   * @returns {Promise<{ text: string, usage: object|null, toolRounds: number, aborted?: boolean, error?: Error }>}
   */
  async function run({ text, signal } = {}) {
    if (typeof text !== 'string' || text.trim().length === 0) throw new Error('run({text}) requires a non-empty string');
    if (running) throw new Error('agent is already running; cancel the current turn first');
    running = true;
    turnCounter += 1;
    // Recall long-term memory with a hard latency budget; a slow or dead RAG
    // service degrades to "no memory" instead of delaying the spoken answer.
    let ragContext = '';
    if (rag) {
      try {
        const recalled = await rag.recall(text, { timeoutMs: config.rag?.timeoutMs });
        ragContext = recalled?.context ?? '';
      } catch { ragContext = ''; }
    }
    refreshSystemMessage(ragContext);
    messages.push({ role: 'user', content: text });
    const spoken = [];
    let usage = null;
    let toolRounds = 0;

    try {
      onState?.('thinking');
      while (true) {
        if (signal?.aborted) return { text: spoken.join(''), usage, toolRounds, aborted: true };
        let result;
        try {
          result = await callModel({ signal });
        } catch (err) {
          if (signal?.aborted || err?.name === 'AbortError') {
            return { text: spoken.join(''), usage, toolRounds, aborted: true };
          }
          onError?.(err);
          return { text: spoken.concat([NETWORK_FALLBACK_TEXT]).join(''), usage, toolRounds, error: err };
        }

        if (result.usage) usage = result.usage;
        if (typeof result.content === 'string' && result.content.length > 0) spoken.push(result.content);

        if (result.toolCalls.length > 0) {
          toolRounds += 1;
          if (toolRounds > maxToolRounds) {
            const note = ROUNDS_FALLBACK_TEXT;
            messages.push({ role: 'assistant', content: note });
            spoken.push(note);
            onState?.('done');
            return { text: spoken.join(''), usage, toolRounds, error: new Error(`tool round limit ${maxToolRounds} exceeded`) };
          }
          messages.push({
            role: 'assistant',
            content: result.content.length > 0 ? result.content : null,
            tool_calls: result.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.function.name, arguments: call.function.arguments },
            })),
          });
          for (const call of result.toolCalls) {
            await executeToolCall(call, { signal });
            if (signal?.aborted) {
              return { text: spoken.join(''), usage, toolRounds, aborted: true };
            }
          }
          continue;
        }

        messages.push({ role: 'assistant', content: result.content });
        onState?.('done');
        const finalText = spoken.join('');
        // Index the finished exchange in the background; never delay the reply.
        if (rag && typeof rag.ingestTurn === 'function') {
          Promise.resolve(rag.ingestTurn({ user: text, assistant: finalText })).catch(() => {});
        }
        return { text: finalText, usage, toolRounds };
      }
    } finally {
      running = false;
      trimHistory();
    }
  }

  function reset() {
    if (running) throw new Error('cannot reset while a turn is running; cancel it first');
    messages = [];
    turnCounter = 0;
    refreshSystemMessage();
  }

  refreshSystemMessage();

  return {
    run,
    reset,
    get history() {
      return messages;
    },
    get running() {
      return running;
    },
    get toolNames() {
      return registry.names();
    },
    get systemPrompt() {
      return messages[0]?.content ?? '';
    },
    get ragStats() {
      if (!rag) return null;
      try { return { enabled: rag.enabled, host: rag.host, mode: rag.mode, autoIngest: rag.autoIngest, ...rag.stats }; } catch { return null; }
    },
    workdir,
  };
}

export default createAgent;
