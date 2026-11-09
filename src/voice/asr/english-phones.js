// English wake-word support for the bilingual KWS model
// (sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20).
//
// The model's vocabulary mixes Chinese pinyin tokens (f / èi / iā …) and CMU
// English phone tokens (F / IH1 / G / ER0 / OW2 …). The archive ships `en.phone`
// (CMU pronouncing dictionary) so English keywords can be built without the
// sherpa-onnx CLI:  FIGARO  ->  F IH1 G ER0 OW2  ->  `F IH1 G ER0 OW2 @FIGARO`.
//
// "figaro" is an Italian name spoken differently by different voices (fi-GAIR-oh,
// fi-GAR-oh, fee-GAR-oh…). The lexicon has one pronunciation; measured on this
// machine that single pronunciation only caught a fraction of TTS voices, so we
// add a small curated list of plausible phone sequences (validated against the
// model's tokens.txt) for the default English wake words. Unknown words without
// a lexicon entry are skipped with a warning — nothing is invented.
//
// Display text must not contain spaces (the KWS format uses `@` + display with
// spaces as separators); multi-word phrases are joined with `_` (HEY_FIGARO).

import fs from 'node:fs';

/**
 * Curated pronunciation variants for the default English wake words.
 * Keys are the display forms (uppercase, spaces -> underscore).
 */
export const PRONUNCIATION_VARIANTS = {
  FIGARO: [
    ['F', 'IH1', 'G', 'ER0', 'OW2'], // CMU: fi-GAIR-oh
    ['F', 'IH0', 'G', 'AA1', 'R', 'OW0'], // fi-GAR-oh
    ['F', 'IH1', 'G', 'AA1', 'R', 'OW0'],
    ['F', 'IY1', 'G', 'AA1', 'R', 'OW0'], // fee-GAR-oh (Italian-ish)
    ['F', 'AY1', 'G', 'AA1', 'R', 'OW0'],
    ['F', 'IH1', 'G', 'AA1', 'R', 'OW2'],
  ],
  HEY_FIGARO: [
    ['HH', 'EY1', 'F', 'IH0', 'G', 'AA1', 'R', 'OW0'],
    ['HH', 'EY1', 'F', 'IY1', 'G', 'AA1', 'R', 'OW0'],
    ['HH', 'EY1', 'F', 'IH1', 'G', 'AA1', 'R', 'OW0'],
  ],
};

/**
 * Load a CMU-style pronunciation lexicon (`WORD PH1 PH2 …` per line).
 * @param {string} file path to en.phone
 * @returns {Map<string, string[]>} uppercase word -> phone tokens
 */
export function loadEnglishLexicon(file) {
  const map = new Map();
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const word = parts[0].toUpperCase();
    if (!map.has(word)) map.set(word, parts.slice(1));
  }
  return map;
}

function displayFor(words) {
  return words.join('_').toUpperCase();
}

/**
 * Build `keywords.txt` lines for English wake words.
 *
 * @param {string[]} wakeWordsEn e.g. ['figaro', 'hey figaro']
 * @param {object} opts
 * @param {Map<string, string[]>} opts.lexicon
 * @param {Set<string>} [opts.vocab] model tokens (variant phone strings are filtered)
 * @param {(msg: string) => void} [opts.onLog]
 * @returns {{lines: string[], used: string[], skipped: string[], missingTokens: string[]}}
 */
export function buildEnglishKeywordLines(wakeWordsEn, opts) {
  const { lexicon, vocab = null, onLog = () => {} } = opts ?? {};
  const lines = [];
  const used = [];
  const skipped = [];
  const missingTokens = [];
  const seen = new Set();

  const push = (phones, display) => {
    const seq = phones.map((p) => p.toUpperCase());
    const key = seq.join(' ');
    if (seen.has(key)) return;
    const missing = vocab ? seq.filter((t) => !vocab.has(t)) : [];
    if (missing.length) {
      missingTokens.push(`${display}:${missing.join(',')}`);
      return;
    }
    seen.add(key);
    lines.push(`${seq.join(' ')} @${display}`);
  };

  for (const raw of wakeWordsEn ?? []) {
    const phrase = String(raw).trim();
    if (!phrase) continue;
    const words = phrase.split(/\s+/);
    const display = displayFor(words);
    const variants = PRONUNCIATION_VARIANTS[display];
    if (variants) {
      used.push(phrase);
      for (const phones of variants) push(phones, display);
      continue;
    }
    // Generic path: concatenate the CMU phones of every word.
    const phones = [];
    let missing = null;
    for (const word of words) {
      const entry = lexicon.get(word.toUpperCase());
      if (!entry) { missing = word; break; }
      phones.push(...entry);
    }
    if (missing) {
      skipped.push(phrase);
      onLog(`[kws] 英文唤醒词 "${phrase}" 在 en.phone 中找不到 "${missing}"，已跳过`);
      continue;
    }
    used.push(phrase);
    push(phones, display);
  }
  return { lines, used, skipped, missingTokens };
}

export default { loadEnglishLexicon, buildEnglishKeywordLines, PRONUNCIATION_VARIANTS };
