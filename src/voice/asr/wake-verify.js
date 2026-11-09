// Two-stage wake verification: after a KWS hit, transcribe the buffered wake
// word with the (lazy-loaded) offline paraformer and only then fire onWake.
//
// Motivation: the two-character Chinese prefix「费加/菲加」is what gives the KWS
// its recall (full word only: 3/8, with prefix: 8/8), but it also hits ordinary
// near-miss phrases ("非加强管理", "咖啡加糖"). A second, slower ASR pass over
// the buffered 1.2–1.6 s containing the wake word rejects those before any ack.
//
// Matching rules (measured on this machine):
//   Chinese  = one of 费/菲/飞/肥 + 加/伽/佳/家/嘉 + 罗/萝/落/洛/逻/锣  anywhere,
//              or the transcript *ends* with 费加/菲加/飞加/肥加 (short wake word).
//              The offline model writes「费伽罗」or「费加罗」— both covered.
//   English  = "figaro"-ish tokens (fig, figure, figural, figetto …) or a
//              Chinese-phonetic rendering (飞哥路 / 飞盖路 …). The Chinese offline
//              model transcribes English very inconsistently ("figure all",
//              "被押了", "回家喽"), so English hits FAIL OPEN: they are never
//              rejected (English KWS false alarms measured 0, and a miss is worse
//              than a false wake for the user). The check still records what the
//              text looked like for diagnostics.
//
// Robustness: any error, missing offline model or timeout => fail open (wake).
// The verify window is buffered: `pre-roll` (the 1.5 s before the KWS hit) plus
// `postRollMs` (~300 ms after the hit, enough for the last syllable「罗」).

export const VERIFY_DEFAULTS = Object.freeze({
  enabled: true,
  timeoutMs: 1800,
});

/** How much audio to collect after the KWS hit (the wake word usually finishes
 *  ~250–350 ms after the hit point, which fires on「费加」). */
export const POST_ROLL_MS = 300;

const ZH_INITIAL = new Set(['费', '菲', '飞', '肥', '废']);
const ZH_MIDDLE = new Set(['加', '伽', '佳', '家', '嘉', '珈', '枷']);
const ZH_FINAL = new Set(['罗', '萝', '落', '洛', '逻', '锣', '猡', '咯', '啰', '裸']);
const ZH_SHORT = ['费加', '菲加', '飞加', '肥加'];
const EN_FIGARO_RE = /fig(?:a|u|e|h|g|o|t|r|i)/;
const ZH_PHONETIC_EN_RE = /(?:费|菲|飞|肥)(?:哥|盖|加|伽|佳|家|格)(?:路|罗|落|洛|喽)/;

export function normalizeVerifyWakeConfig(patch = {}, base = VERIFY_DEFAULTS) {
  const src = patch && typeof patch === 'object' ? patch : {};
  const timeoutMs = Number(src.timeoutMs);
  return {
    enabled: src.enabled === undefined ? base.enabled !== false : Boolean(src.enabled),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(200, Math.min(10000, timeoutMs)) : base.timeoutMs,
  };
}

/** Normalize ASR text for wake-word matching. */
export function normalizeWakeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s,，。.!！?？;；:：、'"“”‘’()（）\[\]【】<>《》~～\-—_]/g, '');
}

/**
 * Does the recognized text contain the wake word?
 * @param {string} text offline ASR transcript
 * @param {{lang?: 'zh'|'en'}} [opts] KWS hit language
 * @returns {{ok: boolean, reason: string}}
 */
export function matchWakeText(text, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'zh';
  const s = normalizeWakeText(text);
  if (!s) return { ok: false, reason: 'empty' };
  for (let i = 0; i + 2 < s.length; i++) {
    if (ZH_INITIAL.has(s[i]) && ZH_MIDDLE.has(s[i + 1]) && ZH_FINAL.has(s[i + 2])) {
      return { ok: true, reason: 'zh-full' };
    }
  }
  for (const short of ZH_SHORT) {
    if (s.endsWith(short)) return { ok: true, reason: 'zh-short' };
  }
  if (s.includes('figaro') || EN_FIGARO_RE.test(s) || ZH_PHONETIC_EN_RE.test(s)) {
    return { ok: true, reason: 'en-matched' };
  }
  if (lang === 'en') {
    // Chinese offline ASR is too unreliable on English to reject safely.
    return { ok: true, reason: 'en-fail-open' };
  }
  return { ok: false, reason: 'no-wake-word' };
}

export default { VERIFY_DEFAULTS, POST_ROLL_MS, normalizeVerifyWakeConfig, normalizeWakeText, matchWakeText };
