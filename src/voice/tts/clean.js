// Text cleanup for speech synthesis.
//
// MiniMax TTS happily reads whatever you send it, including "**" and "https://…",
// which sounds terrible. The daemon hands us raw LLM output (markdown, URLs,
// code blocks, emoji), so everything passes through cleanText() before the
// sentence splitter.
//
// Design rules:
//  - never drop *spoken content*; only drop markup / non-speech noise
//  - keep Chinese/English mixed text intact
//  - leave number & unit reading to MiniMax ("text_normalization_mode":"basic")
//  - never throw: a bad input must not kill the voice path

const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const SURROGATE_PAIR_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

// Emoji / pictographs / flags / keycaps / skin-tone modifiers / variation selectors.
const EMOJI_RE = new RegExp(
  [
    '\\p{Regional_Indicator}{2}',
    '[#*0-9]\\uFE0F?\\u20E3',
    '\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?)*',
    '\\p{Emoji_Modifier}',
    '[\\uFE0F\\uFE0E]',
  ].join('|'),
  'gu',
);

const HTML_TAG_RE = /<\/?[a-zA-Z][^<>]{0,300}>/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const FENCED_CODE_RE = /(```|~~~)[\s\S]*?\1/g;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const AUTOLINK_RE = /<((?:https?|ftp):\/\/[^>\s]+)>/g;
const URL_RE = /(?:(?:https?|ftp):\/\/|www\.)[^\s，。！？；：、）】」』》"'<>]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Parenthetical annotations that should not be read aloud. We deliberately do
// NOT strip every parenthesis: "费加罗（系统级语音助手）" is real content.
const ANNOTATION_PAREN_RE = new RegExp(
  [
    '（(?:注|备注|註|图|圖|见图|見圖|见上|略|笑|掌声|掌声|音效|背景音|停顿|等待|此处|待补)[^）]{0,60}）',
    '[(（](?:注|备注|图|见图|略|笑|掌声|音效|背景音|停顿|ps|PS|P\\.S\\.)[^)）]{0,60}[)）]',
    '[(（]\\s*[)）]',
  ].join('|'),
  'g',
);

function stripEmoji(text) {
  return text.replace(EMOJI_RE, '');
}

function stripUrls(text) {
  return text
    .replace(AUTOLINK_RE, ' ')
    .replace(IMAGE_RE, ' ')
    .replace(LINK_RE, '$1')
    .replace(URL_RE, ' ')
    .replace(EMAIL_RE, ' ');
}

/** Turn markdown tables into spoken rows: "| a | b |" -> "a，b". */
function normalizeTables(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.includes('|')) {
      out.push(line);
      continue;
    }
    // separator row: | --- | :---: |
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')) {
      out.push('');
      continue;
    }
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    out.push(cells.length ? cells.join('，') : '');
  }
  return out.join('\n');
}

function stripMarkdown(text) {
  let s = text;
  s = s.replace(FENCED_CODE_RE, ' ');
  s = s.replace(HTML_COMMENT_RE, ' ');
  s = s.replace(HTML_TAG_RE, ' ');
  s = s.replace(IMAGE_RE, ' ');
  s = s.replace(LINK_RE, '$1');
  s = normalizeTables(s);
  // headings / blockquotes / list markers / rules
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '');
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  s = s.replace(/^[ \t]{0,3}(?:[-*+•·]|\d{1,3}[.)、])[ \t]+/gm, '');
  s = s.replace(/^[ \t]{0,3}(?:-[ \t]*){3,}$/gm, '');
  s = s.replace(/^[ \t]{0,3}(?:\*[ \t]*){3,}$/gm, '');
  s = s.replace(/^[ \t]{0,3}(?:_[ \t]*){3,}$/gm, '');
  // emphasis / inline code / strikethrough
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/\*([^*\n]+)\*/g, '$1');
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1$2');
  s = s.replace(/`([^`]*)`/g, '$1');
  return s;
}

function collapseWhitespaceAndPunctuation(text) {
  let s = text;
  s = s.replace(ZERO_WIDTH_RE, '');
  s = s.replace(SURROGATE_PAIR_RE, (m) => m); // no-op, keeps surrogate pairs intact
  // tabs -> space, collapse runs of spaces, keep at most one newline
  s = s.replace(/[ \t\u00A0\u3000]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{2,}/g, '\n');
  // no spaces around CJK punctuation (markdown tables etc. leave them behind)
  s = s.replace(/([，。！？；：、…）】」』》])[ \t]+/g, '$1');
  s = s.replace(/[ \t]+([，。！？；：、…（【「『《])/g, '$1');
  // runaway punctuation that reads as stutter
  s = s.replace(/[。]{2,}/g, '。');
  s = s.replace(/[，]{2,}/g, '，');
  s = s.replace(/[、]{2,}/g, '、');
  s = s.replace(/[！!]{2,}/g, '！');
  s = s.replace(/[？?]{2,}/g, '？');
  // strip leftover markdown chars that survived (lone symbols at line edges)
  s = s.replace(/^[ \t]*[#>|*~`-]+[ \t]*/gm, '');
  // no leading/trailing connectives
  s = s.replace(/(^|\n)[，。；：、,.!?！？;: \t]+/g, '$1');
  return s;
}

/**
 * Clean a chunk of text for speech synthesis.
 * @param {string} input
 * @param {{maxChars?: number}} [opts]
 * @returns {string}
 */
export function cleanText(input, opts = {}) {
  if (input === null || input === undefined) return '';
  let s = typeof input === 'string' ? input : String(input);
  try {
    s = s.replace(/\r\n?/g, '\n');
    s = stripMarkdown(s);
    s = stripUrls(s);
    s = s.replace(ANNOTATION_PAREN_RE, ' ');
    s = stripEmoji(s);
    s = collapseWhitespaceAndPunctuation(s);
    // collapse empty lines, trim per line, drop blank lines
    s = s
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^[\s.,!?，。！？；：、]+$/.test(line))
      .join('\n');
    s = s.trim();
    if (!s) return '';
    const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 4000;
    if (s.length > maxChars) s = s.slice(0, maxChars);
    return s;
  } catch {
    // Never let cleanup kill the voice path; worst case speak the raw text.
    return String(input).trim().slice(0, opts.maxChars || 4000);
  }
}

export { stripEmoji, stripUrls, stripMarkdown };
export default cleanText;
