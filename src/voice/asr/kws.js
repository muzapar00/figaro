// Keyword spotting (wake word) wrapper around sherpa-onnx KeywordSpotter.
//
// Model: sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01 (31 MB tar,
// 5 MB int8 runtime) — pinyin initial+final tokens, see pinyin.js.
//
// The spotter is fed 16 kHz mono Float32 audio; `feed()` returns a hit object
// when a keyword was just detected, otherwise null. After a hit the stream is
// reset so the next word can be spotted immediately.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSherpa } from './sherpa.js';
import { buildKeywordLines, filterKeywordsByVocab } from './pinyin.js';
import { loadEnglishLexicon, buildEnglishKeywordLines } from './english-phones.js';

const SAMPLE_RATE = 16000;

function rankModelFile(name) {
  // Prefer int8 (smaller/faster) and the newest epoch; the tar archives ship
  // both epoch-12-avg-2 and epoch-99-avg-1 variants for the KWS model.
  let score = 0;
  if (name.includes('.int8.')) score -= 1000;
  const epoch = /epoch[-_](\d+)/.exec(name);
  if (epoch) score -= Number(epoch[1]);
  return score;
}

function pickByPrefix(files, kind) {
  const candidates = files
    .filter((f) => new RegExp(`^${kind}.*\\.onnx$`).test(f))
    .sort((a, b) => rankModelFile(a) - rankModelFile(b) || a.localeCompare(b));
  return candidates[0] ?? null;
}

/**
 * Locate a KWS transducer model inside `dir` (flat directory of .onnx files).
 * @returns {{encoder: string, decoder: string, joiner: string, tokens: string, epoch: string}|null}
 */
export function locateKwsModel(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  const tokensName = files.find((f) => f === 'tokens.txt') ?? files.find((f) => /tokens.*\.txt$/.test(f));
  if (!tokensName) return null;
  const lexiconName = files.find((f) => f === 'en.phone') ?? files.find((f) => /\.phone$/.test(f));
  const encoder = pickByPrefix(files, 'encoder');
  if (!encoder) return null;
  // Sibling decoder/joiner must come from the same export (same epoch tag).
  const tag = (/-(epoch.*)$/.exec(encoder)?.[1] ?? '').replace(/\.int8\.onnx$|\.onnx$/, '');
  const want = (kind) => {
    const exact = tag ? files.find((f) => f.startsWith(`${kind}-${tag}`)) : null;
    return exact ?? pickByPrefix(files, kind);
  };
  const decoder = want('decoder');
  const joiner = want('joiner');
  if (!decoder || !joiner) return null;
  return {
    encoder: path.join(dir, encoder),
    decoder: path.join(dir, decoder),
    joiner: path.join(dir, joiner),
    tokens: path.join(dir, tokensName),
    lexicon: lexiconName ? path.join(dir, lexiconName) : null,
    epoch: tag || 'unknown',
    dir,
  };
}

/** Human-readable model name: `.figaro-model` marker, else directory name. */
export function modelDisplayName(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, '.figaro-model'), 'utf8');
    const m = /^model=(.+)$/m.exec(text);
    if (m && m[1].trim()) return m[1].trim();
  } catch { /* no marker */ }
  const base = path.basename(dir);
  return fs.existsSync(path.join(dir, 'en.phone')) ? `${base} (zh-en)` : base;
}

/** Read tokens.txt into a Set (first whitespace-separated column). */
export function loadVocab(tokensPath) {
  const set = new Set();
  const text = fs.readFileSync(tokensPath, 'utf8');
  for (const line of text.split('\n')) {
    const tok = line.trim().split(/\s+/)[0];
    if (tok) set.add(tok);
  }
  return set;
}

/**
 * Resolve the keyword list for this process.
 *
 * Priority: keyword lines generated from config.asr.wakeWords (pinyin map) ->
 * a hand-maintained `<modelDir>/keywords.txt` -> error.
 *
 * @returns {{file: string, lines: string[], skipped: string[], source: 'config'|'model-dir', cleanup: () => void}}
 */
export function resolveKeywordsFile({ modelDir, wakeWords, wakeWordsEn = [], vocab, tmpRoot, onLog = () => {} }) {
  const built = buildKeywordLines(wakeWords ?? []);
  const usable = vocab ? filterKeywordsByVocab(built.lines, vocab) : built.lines;

  // English keywords (bilingual model only: the archive ships en.phone)
  const files = locateKwsModel(modelDir);
  let english = { lines: [], used: [], skipped: [], missingTokens: [] };
  if (files?.lexicon && wakeWordsEn.length) {
    const lexicon = loadEnglishLexicon(files.lexicon);
    english = buildEnglishKeywordLines(wakeWordsEn, { lexicon, vocab, onLog });
  } else if (wakeWordsEn.length) {
    onLog('[kws] 当前 KWS 模型不含 en.phone（非中英双语模型），英文唤醒词已忽略');
  }

  const allLines = [...usable, ...english.lines];
  if (allLines.length) {
    const dir = tmpRoot ? tmpRoot : fs.mkdtempSync(path.join(os.tmpdir(), 'figaro-kws-'));
    const file = path.join(dir, 'keywords.txt');
    fs.writeFileSync(file, allLines.join('\n') + '\n');
    return {
      file,
      lines: allLines,
      chineseLines: usable,
      englishLines: english.lines,
      englishUsed: english.used,
      englishSkipped: english.skipped,
      missingTokens: english.missingTokens,
      skipped: built.skipped,
      source: 'config',
      cleanup: () => { if (!tmpRoot) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } },
    };
  }
  const fallback = path.join(modelDir, 'keywords.txt');
  if (fs.existsSync(fallback)) {
    const lines = fs.readFileSync(fallback, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    return {
      file: fallback,
      lines,
      chineseLines: lines,
      englishLines: [],
      englishUsed: [],
      englishSkipped: [],
      missingTokens: [],
      skipped: built.skipped,
      source: 'model-dir',
      cleanup: () => {},
    };
  }
  throw new Error(
    `无法为唤醒词生成 KWS 关键词（config.asr.wakeWords=${JSON.stringify(wakeWords)}）。` +
    `KWS 模型只支持拼音/音素建模单元；请使用中文或英文唤醒词，或手写 ${fallback}`,
  );
}

/**
 * Create the wake-word spotter.
 *
 * @param {object} opts
 * @param {string} opts.modelDir directory containing encoder/decoder/joiner .onnx + tokens.txt
 * @param {string[]} opts.wakeWords config.asr.wakeWords
 * @param {number} [opts.numThreads]
 * @param {number} [opts.keywordsScore]
 * @param {number} [opts.keywordsThreshold]
 * @param {number} [opts.maxActivePaths]
 * @param {string} [opts.tmpRoot] directory for the generated keywords.txt (tests)
 * @param {(msg: string) => void} [opts.onLog]
 */
export function createKws(opts) {
  const {
    modelDir,
    wakeWords,
    wakeWordsEn = [],
    numThreads = 2,
    keywordsScore = 1.5,
    keywordsThreshold = 0.25,
    maxActivePaths,
    tmpRoot,
    onLog = () => {},
  } = opts;

  const files = locateKwsModel(modelDir);
  if (!files) {
    throw new Error(`KWS 模型不完整：${modelDir} 里找不到 encoder/decoder/joiner(.onnx) + tokens.txt`);
  }
  const vocab = loadVocab(files.tokens);
  const keywords = resolveKeywordsFile({ modelDir, wakeWords, wakeWordsEn, vocab, tmpRoot, onLog });
  if (keywords.skipped.length) {
    onLog(`wake words skipped (no pinyin mapping for KWS model): ${keywords.skipped.join(', ')}`);
  }
  const isBilingual = files.lexicon && keywords.englishLines.length > 0;
  // Multiple English pronunciation variants compete for decoder paths; measured
  // on this machine, 4 paths only caught ~40% of English voices, 16 catches 12/12.
  const paths = maxActivePaths ?? (keywords.englishLines.length ? 16 : 4);
  const englishDisplays = new Set();
  for (const line of keywords.englishLines) {
    const at = line.indexOf('@');
    if (at >= 0) englishDisplays.add(line.slice(at + 1).trim());
  }

  const sherpa = loadSherpa();
  const spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
    maxActivePaths: paths,
    keywordsFile: keywords.file,
    keywordsScore,
    keywordsThreshold,
  });

  let stream = spotter.createStream();
  let lastHit = null;

  return {
    modelFiles: files,
    keywords,
    modelName: modelDisplayName(files.dir ?? modelDir),
    hasEnglish: Boolean(isBilingual),
    englishKeywords: [...englishDisplays],
    maxActivePaths: paths,
    /** @param {Float32Array} samples @ 16kHz */
    feed(samples) {
      let hit = null;
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      while (spotter.isReady(stream)) spotter.decode(stream);
      const result = spotter.getResult(stream);
      if (result && result.keyword) {
        const lang = englishDisplays.has(result.keyword) ? 'en' : 'zh';
        hit = { keyword: result.keyword, lang, startTime: result.start_time ?? 0 };
        lastHit = hit;
        spotter.reset(stream);
      }
      return hit;
    },
    reset() {
      spotter.reset(stream);
    },
    get lastHit() {
      return lastHit;
    },
    free() {
      keywords.cleanup();
      // Native handles are released by GC; drop our references to help.
      stream = null;
    },
  };
}

export default { createKws, locateKwsModel, loadVocab, resolveKeywordsFile };
