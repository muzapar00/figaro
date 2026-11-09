// Live "wake score" for the GUI self-test window (test.wake.arm).
//
// sherpa-onnx's KeywordSpotter does not expose a per-frame matching score (its
// result JSON only contains the keyword once it fired), so the GUI score is
// derived from the *streaming recogniser*: we compare the tail of the live
// transcript with the configured wake words (homophone-normalised) and report
// how much of a wake word has been recognised so far, 0..1.
//
//   费            -> 0.33   keyword 费加罗
//   费加            -> 0.67
//   费加罗/费家罗    -> 1.00
//
// The actual KWS hit still comes from the real spotter (that is what gates
// onHit); the score is only the GUI's live feedback.

import { normalizeWakeText } from './pinyin.js';

const CJK = /[\u3400-\u9fff]/;

export function createWakeScoreTracker(opts = {}) {
  const wakeWords = (opts.wakeWords ?? [])
    .map((w) => String(w).trim())
    .filter((w) => w && CJK.test(w));
  const words = wakeWords.map((raw) => ({ raw, norm: normalizeWakeText(raw) }));
  let last = { score: 0, keyword: '' };

  /**
   * @param {string} text streaming transcript
   * @returns {{score: number, keyword: string}}
   */
  function update(text) {
    const clean = normalizeWakeText(String(text ?? '')).replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '');
    if (!clean) {
      last = { score: 0, keyword: '' };
      return last;
    }
    let best = { score: 0, keyword: '' };
    for (const word of words) {
      const chars = [...word.norm];
      // Only look at the tail of the transcript; a wake word is said at the end
      // of the current audio (the recogniser may still revise it later).
      const tailChars = [...clean.slice(-Math.max(8, chars.length))];
      let score = 0;
      if (tailChars.join('').includes(word.norm)) {
        score = 1;
      } else {
        // longest suffix of the transcript that is a prefix of the wake word
        for (let len = Math.min(tailChars.length, chars.length); len >= 1; len--) {
          const suffix = tailChars.slice(tailChars.length - len).join('');
          if (chars.slice(0, len).join('') === suffix) {
            score = len / chars.length;
            break;
          }
        }
      }
      if (score > best.score) best = { score, keyword: word.raw };
    }
    last = best;
    return best;
  }

  return {
    get words() {
      return wakeWords.slice();
    },
    get last() {
      return last;
    },
    update,
    reset() {
      last = { score: 0, keyword: '' };
    },
  };
}

export default { createWakeScoreTracker };
