// Voiceprint gate: only wake for the enrolled speaker.
//
// Why: the wake word is an acoustic pattern, so music/TV can pronounce something
// close enough. The fix is to verify *who* said it: a CAM++ speaker-embedding
// model (sherpa-onnx, Apache-2.0) turns the wake audio into a vector, and the
// vector is compared against the profile saved by `figaro enroll-voice`.
//
// Design rules:
//  - Degrade, never break: money free, model missing or no profile => the gate
//    reports itself unavailable and the assistant keeps waking as before.
//  - Nothing leaves the machine: embeddings are computed locally and the profile
//    is a small JSON file in ~/.config/figaro (never in the repo, never logged).
//  - The gate is verified on the pre-roll (the ~1.5 s that contained the wake
//    word), so a rejected wake costs no acknowledgement and no capture.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16000;
export const DEFAULT_SPEAKER_MODEL = 'models/speaker/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';
export const DEFAULT_SPEAKER_THRESHOLD = 0.65;
export const SPEAKER_PROFILE_FILE = 'speaker-profile.json';
const MIN_VERIFY_MS = 300;

export function configDirectory() {
  return process.env.FIGARO_CONFIG_DIR || path.join(os.homedir(), '.config', 'figaro');
}

export function defaultProfilePath() {
  return path.join(configDirectory(), SPEAKER_PROFILE_FILE);
}

/** Resolve the model path: absolute paths pass through, relative ones hang off the checkout. */
export function resolveSpeakerModelPath(model, repoRoot) {
  const raw = String(model ?? DEFAULT_SPEAKER_MODEL).trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(repoRoot ?? process.cwd(), raw);
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export function averageEmbeddings(vectors) {
  const list = (vectors ?? []).filter((v) => v && v.length);
  if (list.length === 0) return null;
  const dim = list[0].length;
  const out = new Float32Array(dim);
  for (const v of list) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i += 1) out[i] += v[i];
  }
  for (let i = 0; i < dim; i += 1) out[i] /= list.length;
  return out;
}

export function loadProfile(profilePath = defaultProfilePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    if (!raw || !Array.isArray(raw.embeddings) || raw.embeddings.length === 0) return null;
    const embeddings = raw.embeddings
      .filter((v) => Array.isArray(v) && v.length > 0)
      .map((v) => Float32Array.from(v));
    if (embeddings.length === 0) return null;
    return {
      version: raw.version ?? 1,
      speaker: raw.speaker ?? 'owner',
      model: raw.model ?? null,
      dim: raw.dim ?? embeddings[0].length,
      threshold: Number.isFinite(Number(raw.threshold)) ? Number(raw.threshold) : DEFAULT_SPEAKER_THRESHOLD,
      createdAt: raw.createdAt ?? null,
      embeddings,
    };
  } catch {
    return null;
  }
}

export function saveProfile(profilePath, profile) {
  const dir = path.dirname(profilePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = {
    version: 1,
    speaker: profile.speaker ?? 'owner',
    model: profile.model ?? null,
    dim: profile.dim ?? profile.embeddings?.[0]?.length ?? 0,
    threshold: profile.threshold ?? DEFAULT_SPEAKER_THRESHOLD,
    createdAt: profile.createdAt ?? new Date().toISOString(),
    embeddings: (profile.embeddings ?? []).map((v) => Array.from(v).map((x) => Math.round(x * 1e6) / 1e6)),
  };
  const tmp = `${profilePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
  fs.renameSync(tmp, profilePath);
  return out;
}

function rms(pcm) {
  if (!pcm || pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

/**
 * Create a speaker-embedding extractor (sherpa-onnx CAM++), loaded lazily so a
 * missing model never crashes the assistant.
 * @param {{model?: string, repoRoot?: string, logger?: {warn?:Function, info?:Function}}} opts
 */
export function createEmbedder({ model, repoRoot, logger = {} } = {}) {
  const log = (msg) => { try { logger.info?.(msg); } catch { /* ignore */ } };
  const warn = (msg) => { try { logger.warn?.(msg); } catch { /* ignore */ } };
  const modelPath = resolveSpeakerModelPath(model, repoRoot);
  let extractor = null;
  let failure = null;
  function ensure() {
    if (extractor) return extractor;
    if (failure) return null;
    try {
      if (!modelPath || !fs.existsSync(modelPath)) throw new Error(`声纹模型不存在：${modelPath ?? '(未配置)'}`);
      const { SpeakerEmbeddingExtractor } = require('sherpa-onnx-node');
      extractor = new SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, provider: 'cpu' });
      log(`声纹模型已加载：${path.basename(modelPath)}（${extractor.dim} 维）`);
    } catch (err) {
      failure = err;
      warn(`声纹模型不可用，继续用纯唤醒词（${err?.message || err}）`);
      return null;
    }
    return extractor;
  }
  return {
    get modelPath() { return modelPath; },
    get dim() { return extractor?.dim ?? null; },
    get failure() { return failure; },
    preload() { return Boolean(ensure()); },
    /** @param {Float32Array} pcm 16 kHz mono */
    embed(pcm) {
      const ex = ensure();
      if (!ex) return null;
      if (!pcm || pcm.length < (SAMPLE_RATE * MIN_VERIFY_MS) / 1000) return null;
      const stream = ex.createStream();
      stream.acceptWaveform({ samples: pcm, sampleRate: SAMPLE_RATE });
      stream.inputFinished();
      if (!ex.isReady(stream)) return null;
      return ex.compute(stream);
    },
  };
}

function normalizeSpeakerConfig(config) {
  const raw = config?.asr?.speaker ?? {};
  return {
    enabled: raw.enabled === true,
    model: raw.model ?? DEFAULT_SPEAKER_MODEL,
    profile: raw.profile ? String(raw.profile) : '',
    threshold: Number.isFinite(Number(raw.threshold)) ? Number(raw.threshold) : DEFAULT_SPEAKER_THRESHOLD,
    minRms: Number.isFinite(Number(raw.minRms)) ? Number(raw.minRms) : 0.008,
  };
}

/**
 * Wake gate used by the ASR module.
 * @param {{config:object, logger?:object, repoRoot?:string, embedder?:object, profilePath?:string}} opts
 */
export function createSpeakerGate({ config, logger = {}, repoRoot, embedder, profilePath } = {}) {
  const conf = normalizeSpeakerConfig(config);
  const profileFile = profilePath ?? (conf.profile ? (path.isAbsolute(conf.profile) ? conf.profile : path.join(configDirectory(), conf.profile)) : defaultProfilePath());
  const emb = embedder ?? createEmbedder({ model: conf.model, repoRoot, logger });
  const log = (m) => { try { logger.info?.(m); } catch { /* ignore */ } };

  let profile = null;
  let prepared = false;
  const stats = { checked: 0, rejected: 0, accepted: 0, lastScore: null, lastRejectedAt: null };

  function load() {
    profile = loadProfile(profileFile);
    prepared = true;
    if (!conf.enabled) return;
    if (!profile) {
      log('声纹校验已启用，但还没有声纹档案：先运行 `figaro enroll-voice` 录一下你的声音（在此之前仍按唤醒词工作）');
      return;
    }
    log(`声纹档案已加载（${profile.embeddings.length} 个样本，阈值 ${conf.threshold}）`);
  }
  load();

  function reasonUnavailable() {
    if (!conf.enabled) return 'disabled';
    if (!profile) return 'not-enrolled';
    // Lazy first-use load: the daemon preloads at startup, but a direct verify()
    // must not turn a missing/broken model into "wrong speaker" rejections.
    if (!emb.failure && typeof emb.dim !== 'number') {
      try { emb.preload?.(); } catch { /* handled below via failure */ }
    }
    if (emb.failure) return 'model-missing';
    return null;
  }

  return {
    get enabled() { return conf.enabled && Boolean(profile); },
    get threshold() { return profile?.threshold ?? conf.threshold; },
    get profilePath() { return profileFile; },
    get stats() { return { ...stats }; },
    status() {
      const reason = reasonUnavailable();
      return {
        enabled: conf.enabled,
        enrolled: Boolean(profile),
        state: reason ?? 'ready',
        reason,
        threshold: profile?.threshold ?? conf.threshold,
        model: path.basename(emb.modelPath ?? ''),
        profile: path.basename(profileFile),
        samples: profile?.embeddings.length ?? 0,
        checked: stats.checked,
        rejected: stats.rejected,
        lastScore: stats.lastScore,
      };
    },
    prepare() { emb.preload(); return this.status(); },
    reload() { load(); return this.status(); },
    /**
     * Decide whether this wake audio belongs to the enrolled speaker.
     * @param {Float32Array} pcm 16 kHz mono, pre-roll containing the wake word
     * @returns {{ok:boolean, skipped?:boolean, score?:number, reason?:string}}
     */
    verify(pcm) {
      const reason = reasonUnavailable();
      if (reason) return { ok: true, skipped: true, reason };
      const level = rms(pcm);
      if (level < conf.minRms) {
        stats.checked += 1;
        stats.rejected += 1;
        stats.lastRejectedAt = Date.now();
        stats.lastScore = 0;
        return { ok: false, score: 0, reason: 'too-quiet' };
      }
      const vector = emb.embed(pcm);
      if (!vector) {
        stats.checked += 1;
        stats.rejected += 1;
        stats.lastRejectedAt = Date.now();
        return { ok: false, score: 0, reason: 'no-embedding' };
      }
      let best = -1;
      for (const enrolled of profile.embeddings) {
        const score = cosineSimilarity(vector, enrolled);
        if (score > best) best = score;
      }
      const threshold = profile?.threshold ?? conf.threshold;
      const ok = best >= threshold;
      stats.checked += 1;
      stats.lastScore = Math.round(best * 1000) / 1000;
      if (ok) stats.accepted += 1;
      else {
        stats.rejected += 1;
        stats.lastRejectedAt = Date.now();
      }
      return { ok, score: stats.lastScore, threshold };
    },
  };
}

export default { createSpeakerGate, createEmbedder, cosineSimilarity, averageEmbeddings, loadProfile, saveProfile, defaultProfilePath, resolveSpeakerModelPath };
