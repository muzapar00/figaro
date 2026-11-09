// Streaming + offline speech recognisers around sherpa-onnx.
//
// Design (see README.md):
//   - streaming transducer (models/asr-stream) -> onPartial() while the user talks
//   - offline paraformer/sense-voice (models/asr-offline) -> high-accuracy final
//     transcript when the utterance ended
// Either one can be missing; capture.js degrades to the other.

import fs from 'node:fs';
import path from 'node:path';
import { loadSherpa } from './sherpa.js';

const SAMPLE_RATE = 16000;

function rankModelFile(name) {
  let score = 0;
  if (name.includes('.int8.')) score -= 1000;
  const epoch = /epoch[-_](\d+)/.exec(name);
  if (epoch) score -= Number(epoch[1]);
  return score;
}

function pick(files, re) {
  return files.filter((f) => re.test(f)).sort((a, b) => rankModelFile(a) - rankModelFile(b) || a.localeCompare(b))[0] ?? null;
}

function hasTokens(files) {
  return files.includes('tokens.txt');
}

/** Locate a streaming transducer model directory. */
export function locateStreamingModel(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  if (!hasTokens(files)) return null;
  const encoder = pick(files, /^encoder.*\.onnx$/);
  const decoder = pick(files, /^decoder.*\.onnx$/);
  const joiner = pick(files, /^joiner.*\.onnx$/);
  if (!encoder || !decoder || !joiner) return null;
  return {
    encoder: path.join(dir, encoder),
    decoder: path.join(dir, decoder),
    joiner: path.join(dir, joiner),
    tokens: path.join(dir, 'tokens.txt'),
  };
}

/**
 * Locate an offline recognition model directory.
 * Supports Paraformer (`model.int8.onnx` + tokens.txt) and SenseVoice
 * (`model.int8.onnx` + tokens.txt in a directory whose name mentions sense-voice).
 */
export function locateOfflineModel(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  if (!hasTokens(files)) return null;
  const model = pick(files, /^(model|paraformer|sensevoice).*\.onnx$/) ?? pick(files, /\.onnx$/);
  if (!model) return null;
  const name = path.basename(dir).toLowerCase();
  // fetch-models.sh writes .figaro-model with `kind=sense-voice|paraformer`; this
  // survives directory renames (e.g. installing SenseVoice into models/asr-offline).
  let markerKind = null;
  try {
    const marker = fs.readFileSync(path.join(dir, '.figaro-model'), 'utf8');
    const m = /^kind=(.+)$/m.exec(marker);
    if (m) markerKind = m[1].trim();
  } catch { /* no marker */ }
  const kind = markerKind === 'sense-voice' || markerKind === 'paraformer'
    ? markerKind
    : (name.includes('sense') || model.toLowerCase().includes('sense') ? 'sense-voice' : 'paraformer');
  return { model: path.join(dir, model), tokens: path.join(dir, 'tokens.txt'), kind };
}

/**
 * Streaming recogniser for live partials during capture.
 * @param {{dir: string, numThreads?: number}} opts
 */
export function createStreamingAsr(opts) {
  const { dir, numThreads = 2 } = opts;
  const files = locateStreamingModel(dir);
  if (!files) return null;
  const sherpa = loadSherpa();
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    // We manage endpoints ourselves (silence timer + max capture duration).
    enableEndpoint: 0,
  });
  let stream = recognizer.createStream();
  return {
    modelFiles: files,
    feed(samples) {
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      return recognizer.getResult(stream).text;
    },
    text() {
      return recognizer.getResult(stream).text;
    },
    reset() {
      recognizer.reset(stream);
    },
    free() {
      stream = null;
    },
  };
}

function offlineConfig(files, numThreads) {
  const modelConfig = { tokens: files.tokens, numThreads, provider: 'cpu', debug: 0 };
  if (files.kind === 'sense-voice') {
    // ITN converts Chinese numerals to Arabic digits and adds punctuation.
    // Disable with FIGARO_SENSEVOICE_ITN=0 (used by the CER benchmark so the
    // transcripts are directly comparable with the ground truth).
    const itn = process.env.FIGARO_SENSEVOICE_ITN === undefined ? 1 : Number(process.env.FIGARO_SENSEVOICE_ITN);
    modelConfig.senseVoice = { model: files.model, language: 'zh', useInverseTextNormalization: itn ? 1 : 0 };
  } else {
    modelConfig.paraformer = { model: files.model };
  }
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig,
    decodingMethod: 'greedy_search',
  };
}

function wrapOffline(recognizer, files) {
  return {
    modelFiles: files,
    kind: files.kind,
    /**
     * @param {Float32Array} samples
     * @returns {Promise<string>}
     */
    async transcribe(samples) {
      if (!samples || samples.length === 0) return '';
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
      if (typeof recognizer.decodeAsync === 'function') {
        const result = await recognizer.decodeAsync(stream);
        return result?.text ?? '';
      }
      recognizer.decode(stream);
      return recognizer.getResult(stream).text ?? '';
    },
    free() {},
  };
}

/**
 * Offline recogniser used for the final transcript of a captured utterance.
 * Decode is ~70-105 ms for a 3 s sentence on one thread, so it runs async to
 * keep the daemon event loop responsive.
 *
 * @param {{dir: string, numThreads?: number}} opts
 */
export function createOfflineAsr(opts) {
  const { dir, numThreads = 1 } = opts;
  const files = locateOfflineModel(dir);
  if (!files) return null;
  const sherpa = loadSherpa();
  return wrapOffline(new sherpa.OfflineRecognizer(offlineConfig(files, numThreads)), files);
}

/**
 * Same as createOfflineAsr but creates the native session off the JS thread
 * (`OfflineRecognizer.createAsync`), so loading the 233 MB model on the first
 * wake does not block the daemon event loop.
 *
 * @param {{dir: string, numThreads?: number}} opts
 * @returns {Promise<object|null>}
 */
export async function createOfflineAsrAsync(opts) {
  const { dir, numThreads = 1 } = opts;
  const files = locateOfflineModel(dir);
  if (!files) return null;
  const sherpa = loadSherpa();
  const recognizer = await sherpa.OfflineRecognizer.createAsync(offlineConfig(files, numThreads));
  return wrapOffline(recognizer, files);
}

export default { locateStreamingModel, locateOfflineModel, createStreamingAsr, createOfflineAsr, createOfflineAsrAsync };
