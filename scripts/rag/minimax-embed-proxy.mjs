#!/usr/bin/env node
/**
 * MiniMax embedding -> OpenAI-compatible proxy for LightRAG.
 *
 * LightRAG's `openai` embedding binding speaks the OpenAI /v1/embeddings
 * protocol; MiniMax's embedding endpoint is NOT OpenAI compatible
 * ({"model":"embo-01","texts":[...],"type":"db"} -> {"vectors":[[...]]}).
 *
 * This proxy sits on 127.0.0.1:9622 and translates:
 *
 *   POST /v1/embeddings  {model, input: string|string[]}
 *     -> POST https://api.minimax.cn/v1/embeddings
 *        {model:"embo-01", texts:[...], type:"db"}
 *     <- {"object":"list","data":[{"object":"embedding","index":i,"embedding":[...]}],
 *         "model":"embo-01","usage":{"prompt_tokens":n,"total_tokens":n}}
 *
 *   GET /health      -> {ok:true, ...}
 *   GET /v1/models   -> OpenAI model list
 *
 * The MiniMax API key is read from ~/.config/figaro/config.json
 * (`minimax.apiKey`, 600) at startup (and re-read if the file changes); it is
 * never written to disk here, never logged, and never echoed in an error.
 * Only Node builtins are used.
 *
 * Env overrides (all optional):
 *   FIGARO_CONFIG        config.json path (default ~/.config/figaro/config.json)
 *   RAG_EMBED_HOST       listen host   (default 127.0.0.1)
 *   RAG_EMBED_PORT       listen port   (default 9622)
 *   MINIMAX_BASE_URL     default https://api.minimax.cn
 *   MINIMAX_EMBED_MODEL  default embo-01
 *   MINIMAX_EMBED_TYPE   default db  ("db" for storage/retrieval, "query" for queries)
 *   RAG_EMBED_BATCH      max texts per upstream call (default 16)
 *   RAG_EMBED_CONCURRENCY max concurrent upstream calls (default 4)
 *   RAG_EMBED_TIMEOUT_MS upstream request timeout (default 60000)
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_PATH =
  process.env.FIGARO_CONFIG || path.join(os.homedir(), '.config', 'figaro', 'config.json');
const HOST = process.env.RAG_EMBED_HOST || '127.0.0.1';
const PORT = Number(process.env.RAG_EMBED_PORT || 9622);
const MODEL = process.env.MINIMAX_EMBED_MODEL || 'embo-01';
const EMBED_TYPE = process.env.MINIMAX_EMBED_TYPE || 'db';
const BATCH = Number(process.env.RAG_EMBED_BATCH || 16);
const CONCURRENCY = Number(process.env.RAG_EMBED_CONCURRENCY || 4);
const TIMEOUT_MS = Number(process.env.RAG_EMBED_TIMEOUT_MS || 60000);
// embo-01 accepts long inputs, but keep a hard ceiling so one pathological
// chunk cannot blow up the whole batch.
const MAX_TEXT_CHARS = 16000;

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

// ---------------------------------------------------------------------------
// config: read the key lazily, cache by mtime, never log it
// ---------------------------------------------------------------------------
let cfgCache = { mtimeMs: 0, baseUrl: 'https://api.minimax.cn', apiKey: '' };

function loadConfig() {
  const st = fs.statSync(CONFIG_PATH);
  if (st.mtimeMs === cfgCache.mtimeMs && cfgCache.apiKey) return cfgCache;
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const minimax = cfg.minimax || {};
  if (!minimax.apiKey) throw new Error('config.json: minimax.apiKey is missing');
  cfgCache = {
    mtimeMs: st.mtimeMs,
    baseUrl: (process.env.MINIMAX_BASE_URL || minimax.baseUrl || 'https://api.minimax.cn').replace(/\/+$/, ''),
    apiKey: minimax.apiKey,
  };
  log(`config loaded (key present, ${cfgCache.apiKey.length} chars), base=${cfgCache.baseUrl}`);
  return cfgCache;
}

// ---------------------------------------------------------------------------
// concurrency gate + upstream call
// ---------------------------------------------------------------------------
let inFlight = 0;
const waiters = [];

async function withSlot(fn) {
  if (inFlight >= CONCURRENCY) await new Promise((resolve) => waiters.push(resolve));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    const next = waiters.shift();
    if (next) next();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callMinimax(texts, attempt = 0) {
  const { baseUrl, apiKey } = loadConfig();
  const url = `${baseUrl}/v1/embeddings`;
  const body = JSON.stringify({ model: MODEL, texts, type: EMBED_TYPE });
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // network/timeout/abort; never include the key
    if (attempt === 0) {
      log(`upstream network error (${err.name}: ${err.message}); retrying once`);
      await sleep(400);
      return callMinimax(texts, 1);
    }
    const e = new Error(`MiniMax embedding request failed: ${err.name}: ${err.message}`);
    e.status = 502;
    e.code = 'upstream_unreachable';
    throw e;
  }

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body, handled below */
  }

  const baseResp = parsed?.base_resp;
  const upstreamOk = res.ok && (!baseResp || baseResp.status_code === 0);
  if (!upstreamOk) {
    const upstreamMsg =
      baseResp?.status_msg || parsed?.error?.message || parsed?.message || `HTTP ${res.status}`;
    const upstreamStatus = baseResp?.status_code ?? res.status;
    if (attempt === 0 && (res.status >= 500 || res.status === 429)) {
      log(`upstream ${res.status} (${upstreamMsg}); retrying once`);
      await sleep(600);
      return callMinimax(texts, 1);
    }
    const e = new Error(`MiniMax embedding error: ${upstreamMsg}`);
    // pass the upstream status through when it is a sane HTTP status
    e.status = res.ok ? 502 : res.status;
    e.code = 'upstream_error';
    e.upstreamStatus = upstreamStatus;
    throw e;
  }

  const vectors =
    parsed?.vectors || (Array.isArray(parsed?.data) ? parsed.data.map((d) => d.embedding) : null);
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    const e = new Error(
      `MiniMax embedding returned ${Array.isArray(vectors) ? vectors.length : 'no'} vectors for ${texts.length} texts`,
    );
    e.status = 502;
    e.code = 'bad_upstream_shape';
    throw e;
  }
  const tokens = Number(parsed?.total_tokens ?? parsed?.usage?.total_tokens ?? 0) || 0;
  log(
    `upstream ok: ${texts.length} texts, dim=${vectors[0]?.length ?? '?'}, ${Date.now() - started}ms` +
      (tokens ? `, tokens=${tokens}` : ''),
  );
  return { vectors, tokens };
}

function suggestTokens(texts) {
  // MiniMax reports token usage; if it ever does not, give an estimate so the
  // OpenAI-shaped response still carries a plausible usage block.
  let chars = 0;
  for (const t of texts) chars += t.length;
  return Math.max(1, Math.ceil(chars / 4));
}

async function embedTexts(texts) {
  const out = new Array(texts.length);
  let tokens = 0;
  for (let start = 0; start < texts.length; start += BATCH) {
    const slice = texts.slice(start, start + BATCH);
    const { vectors, tokens: t } = await withSlot(() => callMinimax(slice));
    for (let i = 0; i < slice.length; i++) out[start + i] = vectors[i];
    tokens += t;
  }
  return { vectors: out, tokens: tokens || suggestTokens(texts) };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const started = Date.now();

  try {
    if (req.method === 'GET' && (route === '/health' || route === '/healthz')) {
      let configured = false;
      try {
        loadConfig();
        configured = true;
      } catch {
        configured = false;
      }
      return sendJson(res, configured ? 200 : 503, {
        ok: configured,
        service: 'minimax-embed-proxy',
        model: MODEL,
        embedType: EMBED_TYPE,
        dim: 1536,
        config: CONFIG_PATH,
        configured,
        uptimeSeconds: Math.round(process.uptime()),
      });
    }

    if (req.method === 'GET' && (route === '/v1/models' || route === '/models')) {
      return sendJson(res, 200, {
        object: 'list',
        data: [{ id: MODEL, object: 'model', owned_by: 'minimax', created: 0 }],
      });
    }

    if (req.method === 'POST' && (route === '/v1/embeddings' || route === '/embeddings')) {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        return sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
      }
      const input = payload?.input;
      const texts = typeof input === 'string' ? [input] : Array.isArray(input) ? input : null;
      if (!texts || texts.some((t) => typeof t !== 'string')) {
        return sendJson(res, 400, {
          error: { message: 'input must be a string or an array of strings', type: 'invalid_request_error' },
        });
      }
      if (texts.length === 0) {
        return sendJson(res, 400, {
          error: { message: 'input must not be empty', type: 'invalid_request_error' },
        });
      }
      const cleaned = texts.map((t) => (t.length ? t.slice(0, MAX_TEXT_CHARS) : ' '));
      const { vectors, tokens } = await embedTexts(cleaned);
      // LightRAG's openai binding asks for encoding_format:"base64" by default
      // (EMBEDDING_USE_BASE64=true) and decodes float32 from it; it also accepts
      // plain float arrays. Honour both so either setting works.
      const wantBase64 = payload?.encoding_format === 'base64';
      const response = {
        object: 'list',
        data: vectors.map((embedding, index) => ({
          object: 'embedding',
          index,
          embedding: wantBase64
            ? Buffer.from(new Float32Array(embedding).buffer).toString('base64')
            : embedding,
        })),
        model: MODEL,
        usage: { prompt_tokens: tokens, total_tokens: tokens },
      };
      return sendJson(res, 200, response);
    }

    return sendJson(res, 404, { error: { message: `not found: ${req.method} ${route}`, type: 'invalid_request_error' } });
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    const message = String(err?.message || err);
    // Errors from our own code never contain the key; upstream bodies are not
    // echoed verbatim beyond their own message field (which the API controls).
    log(`ERROR ${status}: ${message}`);
    return sendJson(res, status, {
      error: {
        message,
        type: err?.code || 'proxy_error',
        ...(err?.upstreamStatus !== undefined ? { upstream_status: err.upstreamStatus } : {}),
      },
    });
  } finally {
    if (route !== '/health' && route !== '/healthz') {
      log(`${req.method} ${route} -> ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.requestTimeout = TIMEOUT_MS + 30000;
server.headersTimeout = 15000;

server.listen(PORT, HOST, () => {
  log(`MiniMax embedding proxy listening on http://${HOST}:${PORT}`);
  log(`  POST /v1/embeddings  (OpenAI format -> MiniMax ${MODEL}, batch=${BATCH}, concurrency=${CONCURRENCY})`);
  log(`  GET  /health, GET /v1/models   config=${CONFIG_PATH}`);
  try {
    loadConfig();
  } catch (err) {
    log(`WARNING: config not loadable yet: ${err.message}`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} received, closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
