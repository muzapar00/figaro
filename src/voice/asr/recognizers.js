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
  const kind = name.includes('sense') || model.toLowerCase().includes('sense') ? 'sense-voice' : 'paraformer';
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

/**
 * Offline recogniser used for the final transcript of a captured utterance.
 * decode is ~30-80 ms for a 3 s sentence on this CPU (2 threads), so it runs
 * asynchronously to keep the daemon event loop responsive.
 *
 * @param {{dir: string, numThreads?: number}} opts
 */
export function createOfflineAsr(opts) {
  const { dir, numThreads = 2 } = opts;
  const files = locateOfflineModel(dir);
  if (!files) return null;
  const sherpa = loadSherpa();
  const modelConfig = { tokens: files.tokens, numThreads, provider: 'cpu', debug: 0 };
  if (files.kind === 'sense-voice') {
    modelConfig.senseVoice = { model: files.model, language: 'zh', useInverseTextNormalization: 1 };
  } else {
    modelConfig.paraformer = { model: files.model };
  }
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig,
    decodingMethod: 'greedy_search',
  });
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

export default { locateStreamingModel, locateOfflineModel, createStreamingAsr, createOfflineAsr };
