// Sentence splitting for streaming TTS.
//
// The daemon feeds text incrementally ("边想边说"), so we need an *appendable*
// splitter: push() partial text, get back only complete sentences; end() flushes
// whatever is left. Piece boundaries must be lossless — concatenating every
// returned piece must reproduce the input (modulo whitespace trimming).

const CJK_STRONG = new Set(['。', '！', '？', '；', '…']);
const ASCII_STRONG = new Set(['!', '?', ';']);
const SOFT = new Set(['，', ',', '、', '：', ':', ' ']);
const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', ']', '】', '》', '〉', '"', "'", '…', '。', '！', '？', '!', '?', '；', ';']);

export const DEFAULT_MAX_SENTENCE_CHARS = 220;
export const DEFAULT_SOFT_LIMIT_CHARS = 90;

function isAsciiDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isAsciiAlpha(ch) {
  return /[A-Za-z]/.test(ch);
}

/**
 * Create an appendable sentence splitter.
 *
 * @param {{maxLen?: number, softLimit?: number, minAsciiLen?: number}} [opts]
 * @returns {{push(text: string): string[], end(): string[], pending(): string}}
 */
export function createSentenceSplitter(opts = {}) {
  const maxLen = Math.max(20, opts.maxLen || DEFAULT_MAX_SENTENCE_CHARS);
  const softLimit = Math.max(20, Math.min(opts.softLimit || DEFAULT_SOFT_LIMIT_CHARS, maxLen));
  const minAsciiLen = opts.minAsciiLen || 4;
  let buf = '';

  /** Find the end index (exclusive) of the first complete sentence starting at pos. */
  function findCut(pos) {
    for (let i = pos; i < buf.length; i++) {
      const ch = buf[i];
      const atEnd = i + 1 >= buf.length;

      if (ch === '\n') {
        return i + 1;
      }

      if (CJK_STRONG.has(ch)) {
        let j = i + 1;
        // swallow repeated terminators ("……", "！？") and closing quotes/brackets
        while (j < buf.length) {
          const c = buf[j];
          if (CJK_STRONG.has(c) || ASCII_STRONG.has(c) || c === '.' || CLOSERS.has(c)) {
            j++;
            continue;
          }
          break;
        }
        return j;
      }

      if (ASCII_STRONG.has(ch)) {
        // Cut only on a word boundary to avoid "C++"? ("!"/"?" rarely inside words)
        if (atEnd || /[\s"')»”’\]】]/.test(buf[i + 1])) {
          let j = i + 1;
          while (j < buf.length) {
            const c = buf[j];
            if (ASCII_STRONG.has(c) || c === '.' || CJK_STRONG.has(c) || CLOSERS.has(c)) {
              j++;
              continue;
            }
            break;
          }
          return j;
        }
        continue;
      }

      if (ch === '.') {
        const prev = i > pos ? buf[i - 1] : '';
        const next = buf[i + 1] || '';
        // sentence-final dot: preceded by a word char, followed by space/EOL/quote
        if (!atEnd && prev && !isAsciiDigit(prev) && (next === ' ' || next === '\t' || next === '\n' || CLOSERS.has(next))) {
          if (i - pos >= minAsciiLen) {
            let j = i + 1;
            while (j < buf.length && (buf[j] === '.' || CLOSERS.has(buf[j]))) j++;
            return j;
          }
        }
        continue;
      }

      // soft boundary: only used to break over-long run-on clauses
      if (SOFT.has(ch) && i - pos >= softLimit) {
        let j = i + 1;
        while (j < buf.length && SOFT.has(buf[j])) j++;
        return j;
      }

      // hard cap: force a break inside a paragraph with no punctuation
      if (i - pos + 1 >= maxLen) {
        const lo = pos + Math.floor(maxLen / 3);
        for (let j = i - 1; j > lo; j--) {
          if (SOFT.has(buf[j])) {
            let k = j + 1;
            while (k < buf.length && SOFT.has(buf[k])) k++;
            return k;
          }
        }
        // don't slice a surrogate pair in half
        const high = buf.charCodeAt(i);
        if (high >= 0xd800 && high <= 0xdbff) return i;
        return i + 1;
      }
    }
    return -1;
  }

  function drain(isFinal) {
    const out = [];
    while (buf.length > 0) {
      const cut = findCut(0);
      if (cut === -1) break;
      const piece = buf.slice(0, cut).trim();
      if (piece) out.push(piece);
      buf = buf.slice(cut);
    }
    if (isFinal) {
      const rest = buf.trim();
      if (rest) out.push(rest);
      buf = '';
    }
    return out;
  }

  return {
    /** Feed more (possibly incomplete) text; returns complete sentences. */
    push(text) {
      if (!text) return [];
      buf += String(text);
      return drain(false);
    },
    /** No more text: flush the remainder as final sentence(s). */
    end() {
      return drain(true);
    },
    /** Text buffered but not emitted yet (mostly for diagnostics/tests). */
    pending() {
      return buf;
    },
  };
}

/**
 * Split an already-complete string into sentences.
 * @param {string} text
 * @param {{maxLen?: number, softLimit?: number}} [opts]
 * @returns {string[]}
 */
export function splitText(text, opts = {}) {
  if (!text) return [];
  const splitter = createSentenceSplitter(opts);
  return [...splitter.push(String(text)), ...splitter.end()];
}

export default splitText;
