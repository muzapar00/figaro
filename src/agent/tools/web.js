// web_search and web_fetch for the Figaro agent.
//
// No search API key is required: web_search reads the HTML results page of a
// public search endpoint (Bing first, DuckDuckGo's HTML endpoint as a fallback)
// and parses titles, URLs and snippets. When an endpoint refuses the request the
// tool says so instead of inventing results.
//
// Schemas and descriptions are carried over from @deepseek-ai/dsh-tool-web; the
// implementation is Figaro's own.
import { defineTool } from './define.js';

const SEARCH_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 25_000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_MAX_OUTPUT_CHARS = 30_000;
const MAX_QUERIES = 4;
const MAX_SOURCES = 12;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  copy: '©',
};

/** Decode the HTML entities that show up in search results and pages. */
export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function stripHtml(text) {
  return decodeEntities(
    String(text)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' '),
  );
}

function normalizeSpace(text) {
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function htmlToText(html) {
  const withBreaks = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(withBreaks)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1].length > 0))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Bing wraps result URLs in /ck/a?…&u=a1<base64url>. Unwrap to the real target. */
function unwrapBingUrl(href) {
  const match = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(href);
  if (!match) return href;
  try {
    let encoded = match[1].replace(/-/g, '+').replace(/_/g, '/');
    while (encoded.length % 4 !== 0) encoded += '=';
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    if (/^https?:\/\//.test(decoded)) return decoded;
  } catch {
    /* keep original */
  }
  return href;
}

function parseBingResults(html) {
  const results = [];
  const blocks = String(html).split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const anchor = /<h2[^>]*>\s*<a[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!anchor) continue;
    let url = decodeEntities(anchor[1]);
    url = unwrapBingUrl(url);
    if (!/^https?:\/\//.test(url)) continue;
    const title = normalizeSpace(stripHtml(anchor[2]));
    const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    const snippet = paragraph ? normalizeSpace(stripHtml(paragraph[1])) : '';
    results.push({ url, title, snippet });
  }
  return results;
}

function parseDuckDuckGoResults(html) {
  const results = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(normalizeSpace(stripHtml(sm[1] ?? sm[2] ?? '')));
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    let url = decodeEntities(m[1]);
    if (url.startsWith('//duckduckgo.com/l/?uddg=')) {
      try {
        url = decodeURIComponent(new URL(`https:${url}`).searchParams.get('uddg') || url);
      } catch {
        /* keep */
      }
    }
    if (!/^https?:\/\//.test(url)) continue;
    results.push({ url, title: normalizeSpace(stripHtml(m[2])), snippet: snippets[results.length] ?? '' });
  }
  return results;
}

async function fetchHtml(url, { signal, timeoutMs }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(url, {
    signal: combined,
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return await res.text();
}

async function searchBing(query, { signal, timeoutMs = SEARCH_TIMEOUT_MS }) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-Hans&count=20`;
  const html = await fetchHtml(url, { signal, timeoutMs });
  return parseBingResults(html);
}

async function searchDuckDuckGo(query, { signal, timeoutMs = SEARCH_TIMEOUT_MS }) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchHtml(url, { signal, timeoutMs });
  return parseDuckDuckGoResults(html);
}

async function runQuery(query, { signal }) {
  const notes = [];
  try {
    const results = await searchBing(query, { signal });
    if (results.length > 0) return { results, notes };
    notes.push(`Bing returned no parseable results for "${query}"`);
  } catch (err) {
    notes.push(`Bing search failed: ${err?.message || err}`);
  }
  try {
    const results = await searchDuckDuckGo(query, { signal });
    if (results.length > 0) return { results, notes };
    notes.push(`DuckDuckGo returned no parseable results for "${query}"`);
  } catch (err) {
    notes.push(`DuckDuckGo search failed: ${err?.message || err}`);
  }
  return { results: [], notes };
}

export function createWebSearchTool() {
  return defineTool({
    name: 'web_search',
    description:
      'Search the web for current information. Returns an optional summary answer and a list of source URLs. ' +
      'Results are fetched from a public HTML search endpoint (Bing, DuckDuckGo fallback), so they may be ' +
      'partial or unavailable.',
    parameters: {
      queries: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: `1–${MAX_QUERIES} search queries; their results are merged.`,
      },
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    async execute(args = {}, { signal } = {}) {
      const queries = Array.isArray(args.queries)
        ? args.queries.map((q) => String(q ?? '').trim()).filter(Boolean)
        : [];
      if (queries.length === 0) throw new Error('queries must be a non-empty array of strings');
      const limited = queries.slice(0, MAX_QUERIES);
      if (queries.length > MAX_QUERIES) {
        // Best effort: cap quietly, the model already got the contract.
      }

      const seen = new Set();
      const sources = [];
      const notes = [];
      for (const query of limited) {
        if (signal?.aborted) throw new Error('tool call aborted');
        const { results, notes: queryNotes } = await runQuery(query, { signal });
        notes.push(...queryNotes);
        for (const result of results) {
          if (seen.has(result.url)) continue;
          seen.add(result.url);
          sources.push({ ...result, query });
          if (sources.length >= MAX_SOURCES) break;
        }
        if (sources.length >= MAX_SOURCES) break;
      }

      if (sources.length === 0) {
        const detail = notes.length > 0 ? `\nWhy: ${[...new Set(notes)].join('; ')}` : '';
        return `Web search returned no results for ${limited.map((q) => `"${q}"`).join(', ')}.${detail}\nIf you know a specific URL, try web_fetch on it.`;
      }

      const lines = [`Web search results for ${limited.map((q) => `"${q}"`).join(', ')} (${sources.length} source(s)):`];
      sources.forEach((source, index) => {
        lines.push(`${index + 1}. ${source.title || '(untitled)'}`);
        lines.push(`   ${source.url}`);
        if (source.snippet) lines.push(`   ${source.snippet}`);
      });
      return lines.join('\n');
    },
  });
}

async function readBodyCapped(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.length > maxBytes) {
      const room = maxBytes - bytes;
      if (room > 0) chunks.push(value.subarray(0, room));
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(value);
    bytes += value.length;
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated };
}

export function createWebFetchTool() {
  return defineTool({
    name: 'web_fetch',
    description: 'Fetch the content of a specific HTTP(S) URL and return it decoded to text.',
    parameters: {
      url: { type: 'string', required: true, description: 'The HTTP(S) URL to fetch.' },
    },
    timeoutMs: FETCH_TIMEOUT_MS,
    async execute(args = {}, { signal } = {}) {
      let parsed;
      try {
        parsed = new URL(String(args.url ?? ''));
      } catch {
        throw new Error(`invalid URL: ${args.url}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('only http(s) URLs can be fetched');
      }

      const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res;
      try {
        res = await fetch(parsed.href, {
          signal: combined,
          redirect: 'follow',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
        });
      } catch (err) {
        if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
          throw new Error(`fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${parsed.href}`);
        }
        throw new Error(`fetch failed: ${err?.message || err}`);
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const { text, truncated } = await readBodyCapped(res, FETCH_MAX_BYTES);

      let body;
      let kind;
      if (contentType.includes('html') || /^\s*</.test(text)) {
        kind = 'html';
        body = htmlToText(text);
      } else if (contentType.includes('json')) {
        kind = 'json';
        try {
          body = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          body = text;
        }
      } else if (contentType.startsWith('text/') || contentType.includes('xml') || contentType === '') {
        kind = 'text';
        body = text;
      } else {
        kind = 'binary';
        body = `[binary or unsupported content-type: ${contentType || 'unknown'}; ${text.length} bytes of text decoded]`;
      }

      let output = body;
      let wasTruncated = truncated;
      if (output.length > FETCH_MAX_OUTPUT_CHARS) {
        output = output.slice(0, FETCH_MAX_OUTPUT_CHARS);
        wasTruncated = true;
      }

      const header = [
        `url: ${res.url || parsed.href}`,
        `status: ${res.status}`,
        `content-type: ${contentType || '(none)'} (${kind})`,
        `truncated: ${wasTruncated ? 'yes' : 'no'}`,
      ].join('\n');
      return `${header}\n--- content ---\n${output || '(empty body)'}`;
    },
  });
}

export { htmlToText, parseBingResults, parseDuckDuckGoResults };
