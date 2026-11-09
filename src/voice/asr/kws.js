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
    epoch: tag || 'unknown',
  };
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
export function resolveKeywordsFile({ modelDir, wakeWords, vocab, tmpRoot }) {
  const built = buildKeywordLines(wakeWords ?? []);
  const usable = vocab ? filterKeywordsByVocab(built.lines, vocab) : built.lines;
  if (usable.length) {
    const dir = tmpRoot ? tmpRoot : fs.mkdtempSync(path.join(os.tmpdir(), 'figaro-kws-'));
    const file = path.join(dir, 'keywords.txt');
    fs.writeFileSync(file, usable.join('\n') + '\n');
    return {
      file,
      lines: usable,
      skipped: built.skipped,
      source: 'config',
      cleanup: () => { if (!tmpRoot) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } },
    };
  }
  const fallback = path.join(modelDir, 'keywords.txt');
  if (fs.existsSync(fallback)) {
    const lines = fs.readFileSync(fallback, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    return { file: fallback, lines, skipped: built.skipped, source: 'model-dir', cleanup: () => {} };
  }
  throw new Error(
    `无法为唤醒词生成 KWS 关键词（config.asr.wakeWords=${JSON.stringify(wakeWords)}）。` +
    `KWS 模型只支持拼音建模单元；请使用中文唤醒词，或手写 ${fallback}`,
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
    numThreads = 2,
    keywordsScore = 1.5,
    keywordsThreshold = 0.25,
    maxActivePaths = 4,
    tmpRoot,
    onLog = () => {},
  } = opts;

  const files = locateKwsModel(modelDir);
  if (!files) {
    throw new Error(`KWS 模型不完整：${modelDir} 里找不到 encoder/decoder/joiner(.onnx) + tokens.txt`);
  }
  const vocab = loadVocab(files.tokens);
  const keywords = resolveKeywordsFile({ modelDir, wakeWords, vocab, tmpRoot });
  if (keywords.skipped.length) {
    onLog(`wake words skipped (no pinyin mapping for KWS model): ${keywords.skipped.join(', ')}`);
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
    maxActivePaths,
    keywordsFile: keywords.file,
    keywordsScore,
    keywordsThreshold,
  });

  let stream = spotter.createStream();
  let lastHit = null;

  return {
    modelFiles: files,
    keywords,
    /** @param {Float32Array} samples @ 16kHz */
    feed(samples) {
      let hit = null;
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      while (spotter.isReady(stream)) spotter.decode(stream);
      const result = spotter.getResult(stream);
      if (result && result.keyword) {
        hit = { keyword: result.keyword, startTime: result.start_time ?? 0 };
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
