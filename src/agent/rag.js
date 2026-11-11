// Long-term memory / RAG client for Figaro.
//
// The retrieval engine is NOT implemented here: it is LightRAG (MIT), running
// as a local service (see docs/rag.md). This module only speaks to its REST API:
//
//   POST /query            {query, mode, only_need_context:true} -> context text
//   POST /documents/text   {text, file_source}                  -> async ingest
//
// Design rules for a voice assistant:
//  - recall has a hard latency budget (config.rag.timeoutMs) and degrades to
//    "no memory" on timeout/error; it must never block or break a turn;
//  - ingest is fire-and-forget and never awaited by the reply path;
//  - the API key is read from config.rag.apiKey or from the LightRAG .env file
//    (mode 600) and is never logged or returned.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_HOST = 'http://127.0.0.1:9621';
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MODE = 'mix';
const MAX_CONTEXT_CHARS = 4000;
const MAX_INGEST_CHARS = 12000;
const NO_CONTEXT_RE = /\[no-context\]|no relevant context|Sorry, I'm not able to provide/i;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Where LightRAG keeps its .env (mode 600). */
export function defaultRagEnvFile() {
  return process.env.FIGARO_RAG_ENV
    || path.join(os.homedir(), '.local', 'share', 'figaro', 'lightrag', '.env');
}

/** Read LIGHTRAG_API_KEY from a .env file; returns '' when unavailable. */
export function readRagApiKey(envFile) {
  const file = envFile || defaultRagEnvFile();
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*(?:export\s+)?LIGHTRAG_API_KEY\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      return match[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch {
    /* missing file: fall through */
  }
  return '';
}

function uniqueSource() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 8);
  return `figaro-memory-${stamp}-${rand}`;
}

/**
 * @param {{ config?: object, fetchImpl?: Function, envFile?: string, logger?: object }} [options]
 */
export function createRagClient(options = {}) {
  const cfg = options.config?.rag ?? {};
  const enabled = cfg.enabled === true;
  const host = String(cfg.host || DEFAULT_HOST).replace(/\/+$/, '');
  const envFile = options.envFile || cfg.envFile || defaultRagEnvFile();
  const apiKey = String(cfg.apiKey || '').trim() || readRagApiKey(envFile);
  const timeoutMs = clampInt(cfg.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 30_000);
  const mode = ['mix', 'local', 'global', 'hybrid', 'naive'].includes(cfg.mode) ? cfg.mode : DEFAULT_MODE;
  const autoIngest = cfg.autoIngest !== false;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = {
    warn: (...args) => { try { options.logger?.warn?.(...args); } catch { /* ignore */ } },
  };
  const stats = { recalls: 0, recallHits: 0, failures: 0, ingests: 0, lastRecallMs: null, lastError: null };

  async function post(pathname, body, { timeout = timeoutMs } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation');
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-API-Key'] = apiKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeout));
    try {
      const res = await fetchImpl(`${host}${pathname}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`LightRAG HTTP ${res.status}: ${text.slice(0, 160)}`);
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  async function remember(text, { source } = {}) {
    if (!enabled) return { ok: false, trackId: null };
    const body = String(text ?? '').trim();
    if (body.length === 0) return { ok: false, trackId: null };
    try {
      const data = await post('/documents/text', {
        text: body.slice(0, MAX_INGEST_CHARS),
        file_source: source || uniqueSource(),
      }, { timeout: 15_000 });
      stats.ingests += 1;
      return { ok: true, trackId: data?.track_id ?? null };
    } catch (err) {
      stats.failures += 1;
      stats.lastError = err?.message || String(err);
      log.warn(`[rag] ingest failed: ${stats.lastError}`);
      return { ok: false, trackId: null, error: stats.lastError };
    }
  }

  async function ingestTurn({ user, assistant } = {}) {
    if (!enabled || !autoIngest) return { ok: false, trackId: null };
    const said = String(user ?? '').trim();
    const answer = String(assistant ?? '').trim();
    if (said.length === 0) return { ok: false, trackId: null };
    const text = answer.length > 0 ? `用户说：${said}\n费加罗回答：${answer}` : `用户说：${said}`;
    if (text.length < 6) return { ok: false, trackId: null };
    return remember(text);
  }

  return {
    enabled,
    host,
    mode,
    get autoIngest() { return autoIngest; },
    get stats() { return { ...stats, enabled }; },

    get queryTimeoutMs() { return timeoutMs; },

    /**
     * Retrieve related context for a spoken query.
     * Never throws; returns {context, ms, error?}.
     */
    async recall(query, { timeoutMs: budget } = {}) {
      if (!enabled) return { context: '', ms: 0 };
      const text = String(query ?? '').trim();
      if (text.length === 0) return { context: '', ms: 0 };
      stats.recalls += 1;
      const started = Date.now();
      try {
        const data = await post('/query', {
          query: text,
          mode,
          only_need_context: true,
          enable_rerank: false,
        }, { timeout: budget ?? timeoutMs });
        const raw = typeof data?.response === 'string' ? data.response.trim() : '';
        const ms = Date.now() - started;
        stats.lastRecallMs = ms;
        if (!raw || NO_CONTEXT_RE.test(raw)) return { context: '', ms };
        const context = raw.length > MAX_CONTEXT_CHARS ? `${raw.slice(0, MAX_CONTEXT_CHARS)}\n[context truncated]` : raw;
        stats.recallHits += 1;
        return { context, ms };
      } catch (err) {
        stats.failures += 1;
        stats.lastError = err?.message || String(err);
        log.warn(`[rag] recall failed: ${stats.lastError}`);
        return { context: '', ms: Date.now() - started, error: stats.lastError };
      }
    },

    remember,
    ingestTurn,

    /** Probe the server (for status/doctor); never throws. */
    async health({ timeout = 1500 } = {}) {
      if (!enabled) return { ok: false, error: 'disabled' };
      try {
        const headers = apiKey ? { 'X-API-Key': apiKey } : {};
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const res = await fetchImpl(`${host}/health`, { headers, signal: controller.signal });
          if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
          const data = await res.json();
          return { ok: true, version: data?.core_version ?? null, busy: Boolean(data?.pipeline_busy) };
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
  };
}

export default { createRagClient, readRagApiKey, defaultRagEnvFile };
