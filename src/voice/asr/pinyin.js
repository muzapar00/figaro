// Wake-word -> KWS keyword helpers for the Chinese pinyin KWS model
// (sherpa-onnx-kws-zipformer-wenetspeech-*).
//
// That model is a tiny zipformer transducer whose modelling units are pinyin
// "声母 + 韵母" tokens (e.g. 费加罗 => `f èi j iā l uó`). `keywords.txt` uses one
// line per keyword: `<space separated tokens> @<display text>`.
//
// This file owns:
//   - a small pinyin table for the default wake words (费加罗 / 菲加罗 / 飞加罗 / 费加)
//   - keyword line generation from `config.asr.wakeWords`
//   - homophone normalisation + wake-prefix stripping for ASR output
//
// Custom wake words whose characters are not in the table are skipped with a
// warning; users can add them to `models/kws/keywords.txt` by hand instead.

// char -> [initial, final-with-tone]  (only chars needed for the default wake words
// plus a handful that are common in wake phrases, e.g. greetings).
const PINYIN = {
  费: ['f', 'èi'],
  菲: ['f', 'ēi'],
  飞: ['f', 'ēi'],
  非: ['f', 'ēi'],
  啡: ['f', 'ēi'],
  废: ['f', 'èi'],
  加: ['j', 'iā'],
  家: ['j', 'iā'],
  佳: ['j', 'iā'],
  嘉: ['j', 'iā'],
  伽: ['j', 'iā'],
  珈: ['j', 'iā'],
  罗: ['l', 'uó'],
  洛: ['l', 'uò'],
  落: ['l', 'uò'],
  咯: ['l', 'uò'],
  啊: ['a', 'a'],
  阿: ['a', 'a'],
  小: ['x', 'iǎo'],
  爱: ['a', 'ài'],
  同: ['t', 'óng'],
  学: ['x', 'ué'],
  你: ['n', 'ǐ'],
  好: ['h', 'ǎo'],
  嗨: ['h', 'āi'],
  嘿: ['h', 'ēi'],
};

// Homophone normalisation used when matching ASR text against the wake words.
// Groups are written as "canonical:variants".
const HOMOPHONES = [
  ['费', '菲飞非啡废'],
  ['加', '家佳嘉伽珈'],
  ['罗', '洛落咯'],
];

const CANON = new Map();
for (const [canon, variants] of HOMOPHONES) {
  CANON.set(canon, canon);
  for (const ch of variants) CANON.set(ch, canon);
}

// Sentence punctuation / symbols that should not survive wake-prefix stripping.
const TRIM_CHARS = new Set([...' \t\n\r，。！？、,.!?;；:：~～…—－-"“”‘’()（）【】[]<>《》·']);

function hasCjk(text) {
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Convert a whole wake word to pinyin KWS tokens.
 * Non-Chinese characters (e.g. latin letters) make the word unsupported: the
 * pinyin KWS model simply has no modelling units for them.
 *
 * @param {string} word
 * @returns {string[]|null} tokens, or null when the word cannot be converted
 */
export function wordToTokens(word) {
  const tokens = [];
  for (const ch of String(word)) {
    if (!hasCjk(ch)) return null;
    const pair = PINYIN[ch];
    if (!pair) return null;
    tokens.push(pair[0], pair[1]);
  }
  // The KWS transducer needs at least two syllables (4 tokens) to be reliable.
  if (tokens.length < 4) return null;
  return tokens;
}

/**
 * Build `keywords.txt` lines for the KWS model from the configured wake words.
 *
 * For every suitable wake word a "short prefix" line (first two characters) is
 * added as well: with the 3.3M wenetspeech KWS model the full 3-syllable word
 * is often only found after its beginning was already decoded successfully, so
 * the 2-syllable variant fires much more reliably on short isolated utterances
 * (measured: 3/8 vs 8/8 on TTS fixtures, see docs in README). False-alarm
 * measurements on 13+ minutes of speech/music are 0 in both cases.
 *
 * @param {string[]} wakeWords
 * @param {{shortPrefixes?: boolean}} [opts]
 * @returns {{lines: string[], used: string[], skipped: string[]}}
 */
export function buildKeywordLines(wakeWords, opts = {}) {
  const shortPrefixes = opts.shortPrefixes !== false;
  const lines = [];
  const used = [];
  const skipped = [];
  const seen = new Set();
  const push = (word, tokens, display) => {
    const key = tokens.join(' ');
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(`${key} @${display}`);
  };
  for (const raw of wakeWords ?? []) {
    const word = String(raw).trim();
    if (!word) continue;
    const tokens = wordToTokens(word);
    if (!tokens) {
      skipped.push(word);
      continue;
    }
    push(word, tokens, word);
    used.push(word);
    if (shortPrefixes && [...word].length >= 3) {
      const prefix = [...word].slice(0, 2).join('');
      const prefixTokens = wordToTokens(prefix);
      if (prefixTokens) push(prefix, prefixTokens, prefix);
    }
  }
  return { lines, used, skipped };
}

/** Keep only keyword lines whose tokens all exist in the model's tokens.txt. */
export function filterKeywordsByVocab(lines, vocab) {
  const out = [];
  for (const line of lines) {
    const at = line.indexOf('@');
    const tokenPart = at >= 0 ? line.slice(0, at) : line;
    const tokens = tokenPart.trim().split(/\s+/).filter(Boolean);
    if (tokens.length && tokens.every((t) => vocab.has(t))) out.push(line);
  }
  return out;
}

/** Normalise homophone characters so ASR output can be compared with wake words. */
export function normalizeWakeText(text) {
  let out = '';
  for (const ch of String(text ?? '')) out += CANON.get(ch) ?? ch;
  return out;
}

function trimStartIndex(text) {
  let i = 0;
  while (i < text.length && TRIM_CHARS.has(text[i])) i++;
  return i;
}

/**
 * Remove a leading wake word (plus greeting) from a transcript.
 *
 * "费加罗，现在几点了" -> "现在几点了"; "你好费加罗" -> ""; "嗯，菲加罗 打开灯" -> "打开灯".
 * Homophone ASR mistakes are tolerated: 费家罗 / 菲伽罗 / 费加罗 all strip.
 * A wake word in the middle of a sentence is NOT stripped
 * ("我想听费加罗的咏叹调" stays intact) — only a leading one (optionally behind a
 * short greeting) is treated as the wake prefix.
 *
 * @param {string} text
 * @param {string[]} wakeWords
 * @param {{maxLead?: number}} [opts]
 * @returns {string}
 */
export function stripWakePrefix(text, wakeWords, opts = {}) {
  void opts.maxLead;
  const trim = (s) => s.slice(trimStartIndex(s)).replace(/[\s，。！?、,.!?;；:：~～…]+$/u, '').trim();
  let rest = String(text ?? '').trim();
  if (!rest) return '';
  const normalized = normalizeWakeText(rest).toLowerCase();

  // Longest first so 费加罗 wins over 费加.
  const candidates = [];
  for (const raw of wakeWords ?? []) {
    const word = normalizeWakeText(String(raw).trim()).toLowerCase();
    if (!word) continue;
    candidates.push(word);
    if ([...word].length >= 3) candidates.push(word.slice(0, 2));
  }
  candidates.sort((a, b) => b.length - a.length);
  const GREETINGS = ['你好', '您好', '嘿', '嗨', '嗯', '喂', '哎', '那个', '请问'];
  const greetings = GREETINGS.map((g) => normalizeWakeText(g).toLowerCase());

  const matchAt = (pos) => {
    let best = -1;
    for (const cand of candidates) {
      if (normalized.startsWith(cand, pos)) best = Math.max(best, pos + cand.length);
    }
    return best;
  };
  let cut = matchAt(0);
  for (const g of greetings) {
    if (!normalized.startsWith(g)) continue;
    let pos = g.length;
    while (pos < normalized.length && TRIM_CHARS.has(rest[pos])) pos++;
    const matched = matchAt(pos);
    if (matched > 0) cut = Math.max(cut, matched);
  }
  if (cut < 0) return trim(rest);
  return trim(rest.slice(cut));
}

export default { wordToTokens, buildKeywordLines, filterKeywordsByVocab, normalizeWakeText, stripWakePrefix };
