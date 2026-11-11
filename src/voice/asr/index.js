// Figaro ASR module — public entry point (contract: docs/ipc.md §2.1).
//
//   createAsr({config, onWake, onLevel, onPartial, onFinal, onVadStart, onError})
//     -> { start(), stop(), beginCapture(), endCapture(), capturing }
//
// Pipeline:
//   parec (16 kHz mono S16LE) ──► KWS spotter (常驻，听「费加罗」)
//                                   │ hit
//                                   ▼
//                             onWake() ──► beginCapture()
//                                   │
//              ┌────────────────────┴───────────────────┐
//              ▼                                        ▼
//     streaming ASR -> onPartial()          VAD (silero) tracks speech
//              │                                        │
//              └──────────► silenceStopMs / maxCaptureMs ┘
//                                   │
//                          offline ASR (final, accurate)
//                                   │
//                              onFinal(text)
//
// Implemented by the "听觉" owner (figaro-ears). Extra, non-contract options are
// documented in README.md: `source`, `hotkey`, `onLog`. Extra getters `state` /
// `modelInfo` / `hotkeyState` are provided for diagnostics/tests.
//
// F5 long-press is wired internally (hotkey.js) so the daemon only has to call
// createAsr()/start()/stop(); if the portal is unavailable the module degrades to
// wake-word-only and reports a single non-fatal onError.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKws, locateKwsModel } from './kws.js';
import { createStreamingAsr, createOfflineAsrAsync, locateStreamingModel, locateOfflineModel } from './recognizers.js';
import { createVad } from './vad.js';
import { createCapture } from './capture.js';
import { createHotkey } from './hotkey.js';
import { createParecSource } from './sources.js';
import { createMicGainController } from './mic-gain.js';
import { createWakeScoreTracker } from './wake-score.js';
import { createBargeInDetector, normalizeBargeInConfig } from './barge-in.js';
import { normalizeVerifyWakeConfig, matchWakeText, POST_ROLL_MS } from './wake-verify.js';
import { createSpeakerGate } from './speaker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SAMPLE_RATE = 16000;
const LEVEL_WINDOW_SAMPLES = Math.round(SAMPLE_RATE * 0.05); // 50 ms => 20 Hz
const PRE_ROLL_MS = 1500;
const TICK_MS = 250;

// onnxruntime thread counts. Keep every session single-threaded:
//  - measured idle CPU with KWS numThreads=2 was ~212% of one core (!) because
//    ORT worker threads spin-wait between decodes of the always-on stream;
//    numThreads=1 -> ~2.7% (see README "CPU 与内存").
//  - single-thread decode is still fast: paraformer = 71-105 ms/sentence.
// Override with env vars only if you know what you are doing.
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const KWS_THREADS = intEnv('FIGARO_ASR_KWS_THREADS', 1);
const STREAM_THREADS = intEnv('FIGARO_ASR_STREAM_THREADS', 1);
const OFFLINE_THREADS = intEnv('FIGARO_ASR_OFFLINE_THREADS', 1);

/**
 * Wake sensitivity presets (measured — see README "灵敏度与误唤醒").
 * `low` is the default in config because the user was annoyed by false wakes:
 * it trades a little recall (still 8/8 on the fixture set) for far fewer wakes
 * from ordinary conversation.
 */
// Measured with the bilingual zh-en KWS model (2025-12-20 + en.phone).
// English keywords use a larger active-path budget (16) because several
// pronunciation variants compete for decoder paths (4 paths only caught ~40% of
// English voices, 16 caught 12/12). Readings with realistic 300 ms lead-in:
//   score 1.5 th 0.15 -> zh 8/8, en fixtures 3/3, en voices 12/12, Chinese-accent 8/8,
//                        English negatives 0/10, Chinese near-miss 3/40, 10 min real human 0
//   score 1.5 th 0.12 -> same recall, slightly easier
//   score 2.0 th 0.10 -> same recall (higher boost for the quietest voices)
// The three presets therefore differ mostly in keyword boost/threshold while
// keeping the measured recall; false alarms on 15+ min negatives are 0.
export const SENSITIVITY_PRESETS = {
  low: { keywordsScore: 1.5, keywordsThreshold: 0.15 },
  medium: { keywordsScore: 1.5, keywordsThreshold: 0.12 },
  high: { keywordsScore: 2.0, keywordsThreshold: 0.1 },
};

/** @returns {{keywordsScore: number, keywordsThreshold: number}|null} */
export function sensitivityPreset(name) {
  return SENSITIVITY_PRESETS[String(name ?? '').toLowerCase()] ?? null;
}

function asError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

function resolvePath(p, root) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

/**
 * @param {object} opts
 * @param {object} opts.config loadConfig() result
 * @param {() => void} [opts.onWake]
 * @param {(rms01: number) => void} [opts.onLevel]
 * @param {(text: string) => void} [opts.onPartial]
 * @param {(text: string) => void} [opts.onFinal]
 * @param {() => void} [opts.onVadStart]
 * @param {(err: Error) => void} [opts.onError]
 * @param {(msg: string) => void} [opts.onLog] verbose diagnostics (optional)
 * @param {Function} [opts.source] audio source factory override (tests: sources.createArraySource)
 * @param {boolean|object} [opts.hotkey] false disables F5, object injects a fake hotkey (tests)
 */
export function createAsr(opts) {
  const {
    config,
    onWake = () => {},
    onLevel = () => {},
    onPartial = () => {},
    onFinal = () => {},
    onVadStart = () => {},
    onError = () => {},
    onLog = () => {},
    // docs/voice-interaction.md interaction signals
    onTap = () => {},
    onGiveUp = null,
    onUserSpeech = () => {},
    source,
    hotkey: hotkeyOption,
    hotkeyConnectFn,
    micGain: micGainOption,
    speakerGate: speakerGateOption,
  } = opts ?? {};
  if (!config) throw new TypeError('createAsr: config is required');
  const asrCfg = config.asr ?? {};
  const root = config.paths?.root ?? REPO_ROOT;
  // English wake words for the bilingual zh-en KWS model (default until
  // src/config.js carries asr.wakeWordsEn).
  const wakeWordsEn = Array.isArray(asrCfg.wakeWordsEn) ? asrCfg.wakeWordsEn : ['figaro', 'hey figaro'];
  // Two-stage wake verification (task-7): KWS hit -> offline paraformer confirm -> onWake.
  let verifyWake = normalizeVerifyWakeConfig(asrCfg.verifyWake ?? {});
  const verifyPostSamples = Math.round((SAMPLE_RATE * POST_ROLL_MS) / 1000);
  let verifyPending = null;
  const verifyStats = {
    accepted: 0,
    rejected: 0,
    failOpen: 0,
    selfTestAccepted: 0,
    selfTestRejected: 0,
    lastVerify: null,
  };
  let verifyFailWarned = false;

  let state = 'idle';
  let kws = null;
  let streaming = null;
  let offline = null;
  let vad = null;
  let capture = null;
  let hotkeyInst = null;
  let micGain = null;
  const probeWaiters = [];
  let offlineLoadPromise = null;
  let offlineLoadError = null;
  let mic = null;
  let preRoll = [];
  let preRollSamples = 0;
  const levelWindow = { n: 0, sumSq: 0, peak: 0 };
  let lastAudioAt = 0;
  let tickTimer = null;
  let wakeFallbackTimer = null;
  let finalizePromise = null;
  let hotkeyStarted = false;

  // ---- wake sensitivity / cooldown / runtime config (docs/ipc.md §3.1) ----
  let sensitivity = sensitivityPreset(asrCfg.sensitivity) ? String(asrCfg.sensitivity).toLowerCase() : 'high';
  let wakeCooldownMs = Math.max(0, Number(asrCfg.wakeCooldownMs ?? 2500) || 0);
  let inputGainSetting = asrCfg.inputGainPercent === undefined ? null : asrCfg.inputGainPercent;
  let lastWakeAt = 0;
  let lastRms = 0;
  let lastPeak = 0;
  let lastFinalMs = null;
  let muted = false;
  let wakeGiveUpMs = Number(asrCfg.wakeGiveUpMs ?? 5000);
  if (!Number.isFinite(wakeGiveUpMs) || wakeGiveUpMs < 0) wakeGiveUpMs = 5000;
  // (muted) barge-in detection: loudness vs the TTS echo baseline (barge-in.js)
  const bargeDetector = createBargeInDetector(asrCfg.bargeIn ?? {});
  let wakePendingUntil = 0;
  const wakeScoreTracker = createWakeScoreTracker({ wakeWords: asrCfg.wakeWords ?? [] });

  // GUI self-test state (docs/ipc.md §3.1)
  let wakeTest = null;
  let micTest = null;
  let asrTest = null;

  const safe = (fn, ...args) => {
    try { return fn(...args); } catch (err) { /* never let user callbacks kill the loop */ }
    return undefined;
  };
  const emitError = (err) => safe(onError, asError(err));
  const log = (msg) => safe(onLog, msg);
  // Voiceprint gate: the wake word is only the first half; the second half is
  // "did *you* say it". Disabled/unregistered => wake exactly as before.
  const speakerGate = speakerGateOption ?? createSpeakerGate({
    config,
    repoRoot: REPO_ROOT,
    logger: { info: log, warn: log },
  });

  const preRollMaxSamples = Math.round((SAMPLE_RATE * PRE_ROLL_MS) / 1000);

  function pushPreRoll(samples) {
    preRoll.push(samples);
    preRollSamples += samples.length;
    while (preRollSamples > preRollMaxSamples && preRoll.length > 1) {
      const dropped = preRoll.shift();
      preRollSamples -= dropped.length;
    }
    // Trim the first chunk if it is far too large (defensive).
    if (preRollSamples > preRollMaxSamples && preRoll.length === 1) {
      const only = preRoll[0];
      preRoll[0] = only.subarray(only.length - preRollMaxSamples);
      preRollSamples = preRoll[0].length;
    }
  }

  function preRollPcm() {
    const out = new Float32Array(preRollSamples);
    let off = 0;
    for (const chunk of preRoll) { out.set(chunk, off); off += chunk.length; }
    return out;
  }

  function clearPreRoll() {
    preRoll = [];
    preRollSamples = 0;
  }

  /**
   * Split the PCM stream into 50 ms windows (=> 20 Hz) and hand {rms, peak}
   * to the callback. Used for onLevel, the GUI microphone test and diagnostics.
   */
  function forEachLevelWindow(samples, cb) {
    let off = 0;
    while (off < samples.length) {
      const take = Math.min(LEVEL_WINDOW_SAMPLES - levelWindow.n, samples.length - off);
      for (let i = 0; i < take; i++) {
        const v = samples[off + i];
        levelWindow.sumSq += v * v;
        const a = Math.abs(v);
        if (a > levelWindow.peak) levelWindow.peak = a;
      }
      levelWindow.n += take;
      off += take;
      if (levelWindow.n === LEVEL_WINDOW_SAMPLES) {
        const rms = Math.sqrt(levelWindow.sumSq / LEVEL_WINDOW_SAMPLES);
        const peak = levelWindow.peak;
        levelWindow.n = 0;
        levelWindow.sumSq = 0;
        levelWindow.peak = 0;
        lastRms = rms;
        lastPeak = peak;
        cb(rms, peak);
      }
    }
  }

  function stopTick() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function startTick() {
    stopTick();
    tickTimer = setInterval(() => {
      if (state !== 'capturing') { stopTick(); return; }
      // Safety net: if the mic stream stalled (parec hung) do not leave the daemon
      // stuck in listening forever.
      if (Date.now() - lastAudioAt > 1500) {
        log('音频流中断 1.5s，结束采集');
        endCapture('audio-stall');
      }
    }, TICK_MS);
  }

  /** Resolve with {rms, peak} once `ms` of audio has been observed. */
  function measureLevel(ms) {
    return new Promise((resolve, reject) => {
      const waiter = { need: Math.max(1, Math.round(ms)), n: 0, sumSq: 0, peak: 0, resolve, reject };
      waiter.timer = setTimeout(() => {
        const idx = probeWaiters.indexOf(waiter);
        if (idx >= 0) probeWaiters.splice(idx, 1);
        reject(new Error('timeout waiting for microphone level'));
      }, Math.max(1500, ms * 4));
      probeWaiters.push(waiter);
    });
  }

  function feedProbes(samples) {
    if (!probeWaiters.length) return;
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    for (const waiter of [...probeWaiters]) {
      waiter.n += samples.length;
      waiter.sumSq += sumSq;
      if (peak > waiter.peak) waiter.peak = peak;
      if (waiter.n >= waiter.need) {
        clearTimeout(waiter.timer);
        const idx = probeWaiters.indexOf(waiter);
        if (idx >= 0) probeWaiters.splice(idx, 1);
        waiter.resolve({ rms: Math.sqrt(waiter.sumSq / waiter.n), peak: waiter.peak });
      }
    }
  }

  function chunkLevel(samples) {
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    return { rms: Math.sqrt(sumSq / samples.length), peak };
  }

  async function calibrateMicGain() {
    if (!micGain || !micGain.available) return;
    try {
      const res = await micGain.calibrate((ms) => measureLevel(ms));
      if (res?.adjusted) log(`[mic] 自动增益校正完成（${res.from}->${res.to}，${res.adjustments} 次调整）`);
    } catch (err) {
      log(`[mic] 自动增益校正跳过：${asError(err).message}`);
    }
  }

  function monitorMicLevel(samples) {
    if (!micGain) return;
    const { rms, peak } = chunkLevel(samples);
    const warning = micGain.observe(rms, peak);
    if (warning) {
      const err = new Error(warning.message);
      err.code = warning.code;
      emitError(err);
      if (warning.code === 'MIC_CLIPPING') void micGain.correctClipping().catch(() => {});
    }
  }

  // ==========================================================================
  // GUI self-test channels (docs/ipc.md §3.1) + runtime config
  // ==========================================================================

  function feedMicTest(rms, peak) {
    if (!micTest) return;
    // `level` is the display value the GUI meter uses (0..1); rms*8 makes normal
    // speech fill roughly half of the bar without clipping the widget.
    safe(micTest.onSample, { rms, peak, level: Math.max(0, Math.min(1, rms * 8)) });
  }

  function stopMicTest() {
    if (!micTest) return;
    const t = micTest;
    micTest = null;
    if (t.timer) clearTimeout(t.timer);
    safe(t.onEnd);
    log('麦克风电平测试结束');
  }

  function startMicTest({ ms = 4000, onSample, onEnd } = {}) {
    stopMicTest();
    const dur = Math.max(200, Number(ms) || 4000);
    micTest = { onSample, onEnd, timer: setTimeout(() => stopMicTest(), dur) };
    micTest.timer.unref?.();
    log(`麦克风电平测试开始（${dur}ms，20Hz）`);
    return { started: true, ms: dur };
  }

  function feedWakeTest(samples, hit) {
    const t = wakeTest;
    if (!t) return;
    let score = 0;
    let keyword = '';
    if (streaming) {
      let text = '';
      try {
        text = streaming.feed(samples) ?? '';
      } catch (err) {
        emitError(new Error(`唤醒测试流式解码失败：${asError(err).message}`, { cause: err }));
      }
      const scored = wakeScoreTracker.update(text);
      score = scored.score;
      keyword = scored.keyword;
    }
    const now = Date.now();
    if (score > 0) {
      if (!t.burstStart) t.burstStart = now;
      t.lastNonZeroAt = now;
      if (score > t.maxScore) t.maxScore = score;
      if (now - t.lastScoreAt >= 100) {
        t.lastScoreAt = now;
        safe(t.onScore, { score: Math.round(score * 100) / 100, keyword });
      }
    } else if (t.burstStart && now - (t.lastNonZeroAt ?? now) > 1200) {
      // new utterance: reset the latency reference
      t.burstStart = null;
    }
    if (hit) {
      t.hits += 1;
      const latencyMs = t.burstStart ? now - t.burstStart : 0;
      log(`唤醒测试命中：${hit.keyword}（score=${Math.max(score, t.maxScore).toFixed(2)}, ${latencyMs}ms）`);
      safe(t.onHit, { score: Math.max(score, t.maxScore), latencyMs, keyword: hit.keyword, lang: hit.lang });
      if (verifyWake.enabled && !verifyPending) startWakeVerify(hit, { selfTest: true });
    }
  }

  /** @returns {{hits:number, misses:number, falseAlarms:number, maxScore:number, ms:number}|null} */
  function finishWakeTest({ emit = true } = {}) {
    if (!wakeTest) return null;
    const t = wakeTest;
    wakeTest = null;
    if (t.timer) clearTimeout(t.timer);
    if (streaming) { try { streaming.reset(); } catch { /* ignore */ } }
    wakeScoreTracker.reset();
    const result = {
      hits: t.hits,
      misses: 0, // the module cannot know whether the user intended to wake; GUI/daemon may adjust
      falseAlarms: 0,
      maxScore: Math.round(t.maxScore * 100) / 100,
      ms: Date.now() - t.armedAt,
      verify: t.verify ?? { accepted: 0, rejected: 0, failOpen: 0, last: null },
    };
    if (emit) safe(t.onEnd, result);
    log(`唤醒测试窗口结束：hits=${result.hits} maxScore=${result.maxScore}`);
    return result;
  }

  function armWakeTest({ ms = 15000, onScore, onHit, onEnd } = {}) {
    finishWakeTest();
    const dur = Math.max(500, Number(ms) || 15000);
    if (streaming) { try { streaming.reset(); } catch { /* ignore */ } }
    wakeScoreTracker.reset();
    wakeTest = {
      armedAt: Date.now(),
      timer: setTimeout(() => finishWakeTest(), dur),
      onScore,
      onHit,
      onEnd,
      hits: 0,
      maxScore: 0,
      burstStart: null,
      lastNonZeroAt: 0,
      lastScoreAt: 0,
    };
    wakeTest.timer.unref?.();
    log(`唤醒测试窗口开始（${dur}ms）`);
    return {
      armed: true,
      endsAt: wakeTest.armedAt + dur,
      keywords: [...wakeScoreTracker.words, ...wakeWordsEn],
    };
  }

  function disarmWakeTest() {
    return finishWakeTest();
  }

  function feedAsrTest(samples) {
    const t = asrTest;
    if (!t) return;
    t.chunks.push(new Float32Array(samples));
    t.samples += samples.length;
    if (streaming) {
      try {
        const text = streaming.feed(samples);
        if (text) t.streamText = text;
      } catch (err) {
        safe(t.onError, asError(err));
      }
    }
    const now = Date.now();
    if (t.streamText && t.streamText !== t.lastPartial && now - t.lastPartialAt >= 100) {
      t.lastPartial = t.streamText;
      t.lastPartialAt = now;
      safe(t.onPartial, t.streamText);
    }
  }

  function stopAsrTest() {
    if (!asrTest) return false;
    const t = asrTest;
    asrTest = null;
    if (t.timer) clearTimeout(t.timer);
    const pcm = new Float32Array(t.samples);
    let off = 0;
    for (const chunk of t.chunks) { pcm.set(chunk, off); off += chunk.length; }
    const audioMs = Math.round((pcm.length / SAMPLE_RATE) * 1000);
    const streamingText = streaming ? (() => { try { return streaming.text() ?? ''; } catch { return t.streamText ?? ''; } })() : (t.streamText ?? '');
    void (async () => {
      let text = streamingText;
      let offlineMs = null;
      try {
        await ensureOfflineModel();
        if (offline) {
          const t0 = Date.now();
          text = await offline.transcribe(pcm);
          offlineMs = Date.now() - t0;
          lastFinalMs = offlineMs;
        }
      } catch (err) {
        safe(t.onError, asError(err));
      }
      const result = {
        text: text ?? '',
        streamingText: streamingText ?? '',
        ms: Date.now() - t.startedAt,
        audioMs,
      };
      if (offlineMs !== null) result.offlineMs = offlineMs;
      log(`ASR 测试完成：audio=${audioMs}ms offline=${offlineMs ?? '-'}ms "${result.text}"`);
      safe(t.onResult, result);
      if (streaming) { try { streaming.reset(); } catch { /* ignore */ } }
    })().catch((err) => emitError(err));
    return true;
  }

  function startAsrTest({ ms = 8000, onPartial, onResult, onError } = {}) {
    stopAsrTest();
    if (!streaming && !offline) {
      const err = new Error('ASR 测试不可用：流式/离线模型都未加载');
      err.code = 'ASR_TEST_UNAVAILABLE';
      safe(onError, err);
      return { started: false };
    }
    const dur = Math.max(500, Number(ms) || 8000);
    if (streaming) { try { streaming.reset(); } catch { /* ignore */ } }
    asrTest = {
      startedAt: Date.now(),
      timer: setTimeout(() => stopAsrTest(), dur),
      chunks: [],
      samples: 0,
      streamText: '',
      lastPartial: '',
      lastPartialAt: 0,
      onPartial,
      onResult,
      onError,
    };
    asrTest.timer.unref?.();
    log(`ASR 测试录音开始（最多 ${dur}ms）`);
    return { started: true, ms: dur };
  }

  // ---- runtime config (config.set 后热改，无需重启) ----

  function rebuildKws() {
    if (!kws) return;
    const preset = sensitivityPreset(sensitivity) ?? SENSITIVITY_PRESETS.high;
    const dirs = models();
    const next = createKws({
      modelDir: dirs.kws,
      wakeWords: asrCfg.wakeWords ?? [],
      wakeWordsEn,
      numThreads: KWS_THREADS,
      keywordsScore: preset.keywordsScore,
      keywordsThreshold: preset.keywordsThreshold,
      onLog: log,
    });
    try { kws.free(); } catch { /* ignore */ }
    kws = next;
  }

  async function setInputGainPercent(value) {
    const num = value === null || value === undefined ? null : Number(value);
    // raw ALSA capture gain (0..63; 45 is the known-good value on this machine)
    inputGainSetting = num === null || !Number.isFinite(num) ? null : Math.max(0, Math.min(63, Math.round(num)));
    if (!micGain || typeof micGain.setFixedGain !== 'function') return null;
    let applied = null;
    try {
      applied = await micGain.setFixedGain(inputGainSetting);
    } catch (err) {
      emitError(asError(err));
    }
    if (inputGainSetting === null) void calibrateMicGain();
    return applied;
  }

  /**
   * Apply hot-changeable config without restarting (docs/ipc.md §3.1).
   * @param {{sensitivity?: string, wakeCooldownMs?: number, inputGainPercent?: number|null}} patch
   * @returns {{applied: string[], restartRequired: string[]}}
   */
  function applyRuntimeConfig(patch = {}) {
    const applied = [];
    const restartRequired = [];
    for (const key of Object.keys(patch ?? {})) {
      if (key === 'sensitivity') {
        const name = String(patch.sensitivity ?? '').toLowerCase();
        if (!sensitivityPreset(name)) { restartRequired.push(key); continue; }
        sensitivity = name;
        try {
          rebuildKws();
          if (wakeTest) { try { streaming?.reset(); } catch { /* ignore */ } }
          applied.push(key);
          log(`灵敏度已热切换为 ${name}（score=${sensitivityPreset(name).keywordsScore}, threshold=${sensitivityPreset(name).keywordsThreshold}）`);
        } catch (err) {
          emitError(new Error(`切换灵敏度失败：${asError(err).message}`, { cause: err }));
          restartRequired.push(key);
        }
      } else if (key === 'wakeCooldownMs') {
        wakeCooldownMs = Math.max(0, Number(patch.wakeCooldownMs) || 0);
        applied.push(key);
        log(`唤醒冷却时间已热切换为 ${wakeCooldownMs}ms`);
      } else if (key === 'bargeIn') {
        const merged = normalizeBargeInConfig(patch.bargeIn ?? {}, bargeDetector.config);
        bargeDetector.setConfig(merged);
        applied.push(key);
        log(`[barge-in] 配置已热切换：${JSON.stringify(merged)}`);
      } else if (key === 'verifyWake') {
        verifyWake = normalizeVerifyWakeConfig(patch.verifyWake ?? {}, verifyWake);
        applied.push(key);
        log(`[wake-verify] 配置已热切换：${JSON.stringify(verifyWake)}`);
      } else if (key === 'wakeGiveUpMs') {
        const n = Number(patch.wakeGiveUpMs);
        wakeGiveUpMs = Number.isFinite(n) && n > 0 ? n : 5000;
        if (capture && typeof capture.setWakeGiveUpMs === 'function') capture.setWakeGiveUpMs(wakeGiveUpMs);
        applied.push(key);
        log(`唤醒 give-up 时间已热切换为 ${wakeGiveUpMs}ms`);
      } else if (key === 'inputGainPercent') {
        void setInputGainPercent(patch.inputGainPercent);
        applied.push(key);
      } else {
        restartRequired.push(key);
      }
    }
    return { applied, restartRequired };
  }

  function handlePcm(samples) {
    if (!samples || samples.length === 0) return;
    if (state === 'stopped' || state === 'failed' || state === 'idle' || state === 'starting') return;
    lastAudioAt = Date.now();
    feedProbes(samples);
    monitorMicLevel(samples);
    forEachLevelWindow(samples, (rms) => {
      if (micTest) feedMicTest(rms, lastPeak);
      if (muted && state === 'listening' && bargeDetector.active) {
        if (bargeDetector.process(rms)) {
          const st = bargeDetector.stats;
          log(`[barge-in] onUserSpeech（rms=${rms.toFixed(3)} > ${st.threshold.toFixed(3)}, baseline=${(st.baseline ?? 0).toFixed(3)}, phase=${st.phase}）`);
          safe(onUserSpeech);
        }
      }
      safe(onLevel, Math.max(0, Math.min(1, rms)));
    });
    // Do not let the assistant's own voice (TTS/ack) into the pre-roll: it is
    // what the voiceprint gate and capture.begin() inspect, and the assistant
    // voice measures ~0.09 cosine against the owner profile, so a wake right
    // after a reply would be rejected as "not the owner".
    if (!muted) pushPreRoll(samples);
    if (verifyPending && !verifyPending.settled) appendVerifyAudio(samples);
    if (state === 'listening' && muted) {
      // Echo suppression (TTS playing): no wake word, no capture. The barge-in
      // detector is fed from the level windows above.
      return;
    }
    if (state === 'listening') {
      if (!kws) return;
      let hit = null;
      try {
        hit = kws.feed(samples);
      } catch (err) {
        emitError(new Error(`KWS 解码失败：${asError(err).message}`, { cause: err }));
        return;
      }
      if (asrTest) {
        // GUI test recording: no normal wake handling while recording.
        feedAsrTest(samples);
      } else if (wakeTest) {
        // Self-test window: hits go to onHit only, never to daemon/onWake.
        feedWakeTest(samples, hit);
      } else if (hit && muted) {
        dumpHitAudio(hit.keyword);
        log(`监听暂停中（TTS 回声抑制），忽略命中 ${hit.keyword}`);
      } else if (hit) {
        dumpHitAudio(hit.keyword);
        const now = Date.now();
        if (now - lastWakeAt < wakeCooldownMs) {
          log(`唤醒冷却中（剩余 ${wakeCooldownMs - (now - lastWakeAt)}ms），忽略命中 ${hit.keyword}${hit.lang === 'en' ? ' (en)' : ''}`);
        } else if (verifyPending) {
          log(`[wake-verify] 校验进行中，忽略重复命中 ${hit.keyword}`);
        } else if (verifyWake.enabled) {
          startWakeVerify(hit);
        } else {
          const verdict = speakerGate.verify(preRollPcm());
          if (!verdict.ok) {
            lastWakeAt = now; // keep the cooldown: do not re-check the same music burst
            log(`声纹不符（score=${verdict.score}，阈值 ${verdict.threshold ?? speakerGate.threshold}，原因 ${verdict.reason ?? 'mismatch'}），忽略唤醒 ${hit.keyword}`);
          } else {
            lastWakeAt = now;
            if (!verdict.skipped) {
              log(`声纹通过（score=${verdict.score}），唤醒 ${hit.keyword}`);
            }
            handleWake(`kws:${hit.keyword}${hit.lang === 'en' ? '(en)' : ''}`);
          }
        }
      }
    } else if (state === 'capturing' && capture) {
      try {
        capture.push(samples);
      } catch (err) {
        emitError(new Error(`采集处理失败：${asError(err).message}`, { cause: err }));
      }
    }
  }

  /**
   * Debug aid for false-wake reports: when FIGARO_ASR_HIT_DUMP_DIR is set, every
   * KWS hit writes the pre-roll (the ~1.5 s that triggered it) to a wav file so it
   * can be inspected offline. Off by default; never affects behaviour.
   */
  let hitDumpDir = process.env.FIGARO_ASR_HIT_DUMP_DIR ?? null;
  let hitDumpSeq = 0;
  function dumpHitAudio(keyword) {
    if (!hitDumpDir) return;
    try {
      fs.mkdirSync(hitDumpDir, { recursive: true });
      const samples = preRollPcm();
      const bytes = samples.length * 2;
      const buf = Buffer.alloc(44 + bytes);
      buf.write('RIFF', 0, 'ascii');
      buf.writeUInt32LE(36 + bytes, 4);
      buf.write('WAVE', 8, 'ascii');
      buf.write('fmt ', 12, 'ascii');
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(1, 20); // PCM
      buf.writeUInt16LE(1, 22); // mono
      buf.writeUInt32LE(SAMPLE_RATE, 24);
      buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
      buf.writeUInt16LE(2, 32);
      buf.writeUInt16LE(16, 34);
      buf.write('data', 36, 'ascii');
      buf.writeUInt32LE(bytes, 40);
      for (let i = 0; i < samples.length; i++) {
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), 44 + i * 2);
      }
      const file = path.join(hitDumpDir, `hit-${String(++hitDumpSeq).padStart(4, '0')}-${Date.now()}.wav`);
      fs.writeFileSync(file, buf);
      log(`KWS 命中音频已保存：${file}（keyword=${keyword}，${(samples.length / SAMPLE_RATE).toFixed(1)}s）`);
    } catch (err) {
      log(`KWS 命中音频保存失败：${asError(err).message}`);
    }
  }

  /**
   * Pause/resume wake-word listening (docs/ipc.md §3.1 extension).
   * The daemon should mute while Figaro's own TTS is speaking: the microphone
   * hears the assistant's voice ("我是费加罗...") and would otherwise re-wake on
   * its own output — measured as the actual cause of the user's false wakes.
   * Capture/levels/self-tests keep working while muted.
   */
  /**
   * @param {boolean} value mute/unmute wake-word listening
   * @param {{phase?: 'ack'|'tts'}} [opts] 'ack' = wake acknowledgement playing
   *        (stricter barge-in threshold); omitted = auto (ack right after a wake)
   */
  function setMuted(value, opts = {}) {
    const next = Boolean(value);
    if (next !== muted) log(`唤醒监听${next ? '已暂停（回声抑制：TTS 播放中）' : '已恢复'}`);
    muted = next;
    if (next) {
      const autoPhase = Date.now() < wakePendingUntil ? 'ack' : 'tts';
      const phase = opts.phase === 'ack' || opts.phase === 'tts' ? opts.phase : autoPhase;
      const armed = bargeDetector.arm({ phase });
      if (armed) log(`[barge-in] 检测已武装（phase=${phase}）`);
    } else {
      bargeDetector.disarm();
    }
    return muted;
  }

  // ------------------------------------------------------------------ wake verify
  /**
   * KWS hit -> wait for the rest of the wake word (post-roll), then transcribe
   * the buffered pre-roll + post-roll with the offline paraformer. onWake only
   * fires when the transcript contains the wake word. Errors/timeouts pass.
   */
  /** Concatenate the buffered wake word (pre-roll + post-roll) for gating. */
  function pendingPcm(p) {
    const pcm = new Float32Array(p.base.length + p.postSamples);
    pcm.set(p.base, 0);
    let off = p.base.length;
    for (const chunk of p.post) { pcm.set(chunk, off); off += chunk.length; }
    return pcm;
  }

  function startWakeVerify(hit, { selfTest = false } = {}) {
    if (verifyPending) return null;
    const pending = {
      hit,
      selfTest,
      startedAt: Date.now(),
      base: preRollPcm(),
      post: [],
      postSamples: 0,
      settled: false,
      text: '',
      timer: null,
    };
    verifyPending = pending;
    // Load the 233 MB offline model while we collect the post-roll (first wake
    // only); it stays resident for capture finals afterwards.
    void ensureOfflineModel();
    pending.timer = setTimeout(() => {
      finishVerifyTimeout(pending);
    }, verifyWake.timeoutMs);
    pending.timer.unref?.();
    log(`[wake-verify] KWS 命中 ${hit.keyword}${hit.lang === 'en' ? '(en)' : ''}，收集 ${POST_ROLL_MS}ms 后校验…`);
    if (verifyPostSamples <= 0) runWakeVerify(pending);
    return pending;
  }

  function appendVerifyAudio(samples) {
    const p = verifyPending;
    if (!p || p.settled) return;
    p.post.push(samples);
    p.postSamples += samples.length;
    if (p.postSamples >= verifyPostSamples) runWakeVerify(p);
  }

  function finishVerifyTimeout(p) {
    if (!p || p.settled) return;
    settleWakeVerify(p, { ok: true, failOpen: true, reason: 'timeout', text: p.text });
  }

  async function runWakeVerify(p) {
    if (p.settled) return;
    let text = '';
    try {
      const rec = await ensureOfflineModel();
      if (!rec) throw new Error('offline ASR unavailable');
      const pcm = pendingPcm(p);
      const t0 = Date.now();
      text = await rec.transcribe(pcm);
      p.text = text;
      p.inferMs = Date.now() - t0;
    } catch (err) {
      if (!verifyFailWarned) {
        verifyFailWarned = true;
        log(`[wake-verify] 校验识别器不可用（${asError(err).message}），后续校验放行`);
      }
      settleWakeVerify(p, { ok: true, failOpen: true, reason: 'error', text, error: asError(err) });
      return;
    }
    const match = matchWakeText(text, { lang: p.hit.lang });
    settleWakeVerify(p, { ...match, text });
  }

  function settleWakeVerify(p, result) {
    if (!p || p.settled) return;
    p.settled = true;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    if (verifyPending === p) verifyPending = null;
    const ms = Date.now() - p.startedAt;
    const last = {
      ms,
      ok: Boolean(result.ok),
      failOpen: Boolean(result.failOpen),
      reason: result.reason,
      text: result.text ?? '',
      keyword: p.hit.keyword,
      lang: p.hit.lang,
      inferMs: p.inferMs ?? null,
      at: Date.now(),
    };
    verifyStats.lastVerify = last;
    if (p.selfTest) {
      if (result.ok) verifyStats.selfTestAccepted += 1;
      else verifyStats.selfTestRejected += 1;
      if (wakeTest) {
        wakeTest.verify = wakeTest.verify ?? { accepted: 0, rejected: 0, failOpen: 0, last: null };
        if (result.ok) wakeTest.verify.accepted += 1;
        else wakeTest.verify.rejected += 1;
        if (result.failOpen) wakeTest.verify.failOpen += 1;
        wakeTest.verify.last = last;
      }
      log(`[wake-verify] 自测校验 ${result.ok ? '通过' : '拒绝'}（${ms}ms, ${result.reason}, "${last.text}"）`);
      return;
    }
    if (result.ok) {
      // Verification only proves the words; the voiceprint gate still has to
      // prove it was the owner. These two gates used to be mutually exclusive:
      // enabling verifyWake silently bypassed the speaker gate.
      let voice = { ok: true, skipped: true };
      if (!p.selfTest && typeof speakerGate.verify === 'function') {
        voice = speakerGate.verify(pendingPcm(p));
      }
      if (!voice.ok) {
        verifyStats.rejected += 1;
        log(`声纹不符（score=${voice.score}，阈值 ${voice.threshold ?? speakerGate.threshold}，原因 ${voice.reason ?? 'mismatch'}），忽略唤醒 ${p.hit.keyword}`);
        lastWakeAt = Date.now(); // one check per cooldown window, like the no-verify path
        return;
      }
      if (result.failOpen) verifyStats.failOpen += 1;
      else verifyStats.accepted += 1;
      if (!voice.skipped) log(`[wake-verify] 声纹通过（score=${voice.score}）`);
      const kw = p.hit.keyword;
      log(`[wake-verify] 通过（${ms}ms, ${result.reason}${result.failOpen ? ', fail-open' : ''}, "${last.text}"）`);
      lastWakeAt = Date.now();
      handleWake(`kws:${kw}${p.hit.lang === 'en' ? '(en)' : ''}${result.ok && !result.failOpen ? '' : ':unverified'}`);
    } else {
      verifyStats.rejected += 1;
      log(`[wake-verify] 拒绝近音命中 ${p.hit.keyword}（${ms}ms, "${last.text}"），继续监听（不进冷却）`);
    }
  }

  function handleWake(origin) {
    if (state !== 'listening') return;
    lastWakeAt = Date.now();
    // the daemon plays its acknowledgement during wakeCaptureFallbackMs (or a
    // short default window): barge-in uses a stricter threshold there
    wakePendingUntil = Date.now() + Math.max(Number(asrCfg.wakeCaptureFallbackMs) || 0, 1500);
    log(`唤醒（${origin}）`);
    safe(onWake);
    // If the daemon does not call beginCapture() itself (or there is no daemon
    // at all, e.g. F5 handler), start capture ourselves.
    //
    // config.asr.wakeCaptureFallbackMs > 0 lets the daemon play a short ack
    // ("我在") before capture starts; the daemon then calls beginCapture() when
    // the ack finished. The timer is only a fallback so a lost ack never leaves
    // Figaro deaf.
    const fallbackMs = Number(asrCfg.wakeCaptureFallbackMs ?? 0);
    if (wakeFallbackTimer) { clearTimeout(wakeFallbackTimer); wakeFallbackTimer = null; }
    if (fallbackMs > 0) {
      log(`onWake 后等待 daemon 开始采集（兜底 ${fallbackMs}ms）`);
      wakeFallbackTimer = setTimeout(() => {
        wakeFallbackTimer = null;
        if (state === 'listening') beginCapture();
      }, fallbackMs);
      wakeFallbackTimer.unref?.();
    } else {
      queueMicrotask(() => {
        if (state === 'listening') beginCapture();
      });
    }
  }

  function handleMicFatal(err) {
    if (state === 'stopped') return;
    state = 'failed';
    stopTick();
    emitError(err);
  }

  function beginCapture() {
    if (state !== 'listening' || !capture) return;
    if (wakeFallbackTimer) { clearTimeout(wakeFallbackTimer); wakeFallbackTimer = null; }
    state = 'capturing';
    lastAudioAt = Date.now();
    if (typeof capture.setWakeGiveUpMs === 'function') capture.setWakeGiveUpMs(wakeGiveUpMs);
    capture.begin(preRollPcm());
    startTick();
    log('beginCapture');
    // Warm up the big offline model in the background while the user speaks so
    // the first final transcript is not delayed (or only slightly).
    void ensureOfflineModel();
  }

  function endCapture(why = 'manual') {
    if (state !== 'capturing' || !capture) return;
    state = 'finalizing';
    stopTick();
    const cap = capture;
    finalizePromise = (async () => {
      let result;
      const finalizeT0 = Date.now();
      try {
        await ensureOfflineModel();
        result = await cap.end(why);
        lastFinalMs = Date.now() - finalizeT0;
      } catch (err) {
        emitError(new Error(`转写失败：${asError(err).message}`, { cause: err }));
        result = { text: '', reason: why, stats: {} };
      }
      clearPreRoll();
      lastWakeAt = Date.now(); // reply TTS follows; keep KWS quiet for wakeCooldownMs
      if (kws) { try { kws.reset(); } catch { /* ignore */ } }
      if (state !== 'stopped') state = 'listening';
      if (result.reason === 'give-up' && typeof onGiveUp === 'function') {
        // Siri-style: the user woke us and said nothing -> quiet idle, no final
        // (daemon can distinguish "no speech" from "empty command").
        log('endCapture(give-up) -> onGiveUp()（唤醒后未检测到语音）');
        safe(onGiveUp);
        return;
      }
      log(`endCapture(${result.reason}) -> onFinal(${JSON.stringify(result.text)})`);
      safe(onFinal, result.text ?? '');
    })()
      .catch((err) => { emitError(err); if (state !== 'stopped') state = 'listening'; })
      .finally(() => { finalizePromise = null; });
  }

  function createCaptureFor() {
    return createCapture({
      config,
      streaming,
      offline: () => offline,
      vad,
      wakeWords: asrCfg.wakeWords ?? [],
      onPartial: (text) => safe(onPartial, text),
      onVadStart: () => safe(onVadStart),
      onAutoEnd: (reason) => {
        log(`自动结束采集（${reason}）`);
        endCapture(reason);
      },
      onError: (err) => emitError(err),
    });
  }

  async function stopInternal() {
    if (state === 'stopped') return;
    state = 'stopped';
    stopTick();
    if (wakeFallbackTimer) { clearTimeout(wakeFallbackTimer); wakeFallbackTimer = null; }
    if (wakeTest) { clearTimeout(wakeTest.timer); wakeTest = null; }
    if (micTest) { clearTimeout(micTest.timer); micTest = null; }
    if (asrTest) { clearTimeout(asrTest.timer); asrTest = null; }
    if (verifyPending) {
      if (verifyPending.timer) clearTimeout(verifyPending.timer);
      verifyPending.settled = true;
      verifyPending = null;
    }
    if (finalizePromise) { try { await finalizePromise; } catch { /* ignore */ } }
    if (hotkeyInst) {
      try { await hotkeyInst.stop(); } catch { /* ignore */ }
      hotkeyInst = null;
      hotkeyStarted = false;
    }
    if (mic) {
      try { await mic.stop(); } catch { /* ignore */ }
      mic = null;
    }
    for (const waiter of probeWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('asr stopped'));
    }
    if (capture) { try { capture.reset(); } catch { /* ignore */ } capture = null; }
    if (kws) { try { kws.free(); } catch { /* ignore */ } kws = null; }
    if (vad) { try { vad.free(); } catch { /* ignore */ } vad = null; }
    streaming = null;
    offline = null;
    offlineLoadPromise = null;
    if (micGain) { try { micGain.reset(); } catch { /* ignore */ } }
    clearPreRoll();
  }

  /**
   * Lazily load the big offline model (233 MB int8, ~0.6 s) on first wake, while
   * the user is speaking. It stays resident afterwards (sherpa-onnx has no
   * explicit session-free API); idle CPU is unaffected because all sessions are
   * single-threaded and only decode on demand.
   */
  function ensureOfflineModel() {
    if (offline) return Promise.resolve(offline);
    if (offlineLoadPromise) return offlineLoadPromise;
    const dirs = models();
    if (!locateOfflineModel(dirs.offline)) return Promise.resolve(null);
    // createOfflineAsrAsync() builds the native session on a worker thread, so the
    // daemon event loop (IPC, TTS, mic pumping) is not blocked for ~0.6 s.
    offlineLoadPromise = createOfflineAsrAsync({ dir: dirs.offline, numThreads: OFFLINE_THREADS })
      .then((asr) => {
        offline = asr;
        if (asr) log(`离线转写模型已加载（lazy, ${asr.kind}, ${OFFLINE_THREADS} 线程）`);
        return asr;
      })
      .catch((err) => {
        offlineLoadError = asError(err);
        emitError(new Error(`离线转写模型加载失败（将退化为流式结果）：${offlineLoadError.message}`, { cause: err }));
        offline = null;
        return null;
      });
    return offlineLoadPromise;
  }

  const models = () => ({
    kws: resolvePath(asrCfg.kwsModelDir ?? 'models/kws', root),
    streaming: resolvePath(asrCfg.streamingModelDir ?? 'models/asr-stream', root),
    offline: resolvePath(asrCfg.offlineModelDir ?? 'models/asr-offline', root),
    vad: path.join(path.dirname(resolvePath(asrCfg.kwsModelDir ?? 'models/kws', root)), 'vad', 'silero_vad.onnx'),
  });

  return {
    // ---- contract ----
    get capturing() {
      return state === 'capturing';
    },

    async start() {
      if (state === 'listening' || state === 'capturing' || state === 'starting') return;
      state = 'starting';
      const dirs = models();

      // Pre-flight: fail fast & cleanly when models are missing/broken.
      if (!fs.existsSync(dirs.kws)) {
        state = 'failed';
        const err = new Error(`唤醒词模型缺失：${dirs.kws}（先运行 scripts/fetch-models.sh）`);
        err.code = 'ASR_MODELS_MISSING';
        emitError(err);
        throw err;
      }
      if (!locateKwsModel(dirs.kws)) {
        state = 'failed';
        const err = new Error(`唤醒词模型不完整：${dirs.kws} 需要 encoder/decoder/joiner .onnx + tokens.txt`);
        err.code = 'ASR_KWS_INCOMPLETE';
        emitError(err);
        throw err;
      }
      const hasStreaming = Boolean(locateStreamingModel(dirs.streaming));
      const hasOffline = Boolean(locateOfflineModel(dirs.offline));
      if (!hasStreaming && !hasOffline) {
        state = 'failed';
        const err = new Error(
          `转写模型缺失：${dirs.streaming} 与 ${dirs.offline} 都不完整（先运行 scripts/fetch-models.sh）`,
        );
        err.code = 'ASR_MODELS_MISSING';
        emitError(err);
        throw err;
      }

      try {
        const preset = sensitivityPreset(sensitivity) ?? SENSITIVITY_PRESETS.high;
        kws = createKws({
          modelDir: dirs.kws,
          wakeWords: asrCfg.wakeWords ?? [],
          wakeWordsEn,
          numThreads: KWS_THREADS,
          keywordsScore: preset.keywordsScore,
          keywordsThreshold: preset.keywordsThreshold,
          onLog: log,
        });
        streaming = hasStreaming
          ? createStreamingAsr({ dir: dirs.streaming, numThreads: STREAM_THREADS })
          : null;
        // Offline model is loaded lazily on the first wake (see ensureOfflineModel).
        offline = null;
        offlineLoadPromise = null;
        vad = createVad({ modelPath: dirs.vad, numThreads: 1 });
        capture = createCaptureFor();
        log(
          `模型就绪: kws=${kws.modelName} epoch=${kws.modelFiles.epoch}(${KWS_THREADS}线程, 灵敏度=${sensitivity} score=${preset.keywordsScore} threshold=${preset.keywordsThreshold}, paths=${kws.maxActivePaths}) ` +
          `keywords=${kws.keywords.lines.length}(中文${kws.keywords.chineseLines.length}/英文${kws.keywords.englishLines.length}) ` +
          `english=${JSON.stringify(kws.englishKeywords)} ` +
          `streaming=${streaming ? `yes(${STREAM_THREADS}线程)` : 'no'} ` +
          `offline=lazy(${hasOffline ? OFFLINE_THREADS : '-'}线程) vad=${vad.kind}` +
          ` cooldown=${wakeCooldownMs}ms`,
        );
      } catch (err) {
        state = 'failed';
        const e = new Error(`加载语音模型失败：${asError(err).message}`, { cause: err });
        emitError(e);
        await stopInternal().catch(() => {});
        state = 'failed';
        throw e;
      }

      // Microphone gain auto calibration (non-fatal).
      if (micGainOption !== false) {
        micGain = micGainOption && typeof micGainOption === 'object'
          ? micGainOption
          : createMicGainController({ onLog: log });
        micGain.reset();
        if (inputGainSetting !== null && typeof micGain.setFixedGain === 'function') {
          try {
            const applied = await micGain.setFixedGain(inputGainSetting);
            log(`[mic] 固定增益 ${inputGainSetting}（raw 0-63，应用值 ${applied ?? '?'}，不自动校准）`);
          } catch (err) {
            emitError(new Error(`固定麦克风增益失败：${asError(err).message}`, { cause: err }));
          }
        }
      }

      // F5 long-press (non-fatal if the portal is unavailable).
      const hotkeyConfigured = String(asrCfg.hotkey ?? '').trim() !== '';
      const hotkeyWanted = hotkeyOption !== false && (hotkeyConfigured || (hotkeyOption && typeof hotkeyOption === 'object'));
      if (hotkeyWanted) {
        if (hotkeyOption && typeof hotkeyOption === 'object') {
          hotkeyInst = hotkeyOption;
          hotkeyStarted = false;
        } else {
          hotkeyInst = createHotkey({
            config,
            onWake: () => handleWake('hotkey'),
            onTap: () => {
              log('热键短按（tap）-> onTap（取消，不采集）');
              safe(onTap);
            },
            onEnd: () => endCapture('hotkey-release'),
            onError: (err) => emitError(err),
            onLog: log,
            connectFn: typeof hotkeyConnectFn === 'function' ? hotkeyConnectFn : undefined,
          });
        }
        try {
          await hotkeyInst.start();
          hotkeyStarted = true;
        } catch (err) {
          emitError(new Error(`F5 长按初始化失败（语音唤醒仍可用）：${asError(err).message}`, { cause: err }));
        }
      }

      // Microphone.
      const factory = typeof source === 'function'
        ? source
        : createParecSource({ device: asrCfg.device && asrCfg.device !== 'default' ? asrCfg.device : undefined });
      mic = factory({
        onPcm: (pcm) => handlePcm(pcm),
        onError: (err) => emitError(err),
        onFatal: (err) => handleMicFatal(err),
      });
      try {
        await mic.start();
      } catch (err) {
        // Clean failure: release everything and report. The daemon must still run.
        state = 'failed';
        const e = new Error(`麦克风不可用：${asError(err).message}`, { cause: err });
        e.code = 'ASR_MIC_UNAVAILABLE';
        emitError(e);
        await stopInternal().catch(() => {});
        state = 'failed';
        throw e;
      }
      lastAudioAt = Date.now();
      state = 'listening';
      log('ASR 常驻监听已启动');
      // The first speaker-gate verify otherwise loads the 28 MB ONNX model
      // synchronously inside the audio callback (~350 ms measured). Warm it
      // after the daemon has settled.
      if (!speakerGateOption && speakerGate.enabled && typeof speakerGate.prepare === 'function') {
        const warm = setTimeout(() => {
          try {
            const status = speakerGate.prepare();
            log(`声纹模型预热完成（${status?.state ?? 'ready'}）`);
          } catch (err) { log(`声纹模型预热失败：${asError(err).message}`); }
        }, 1200);
        warm.unref?.();
      }
      // Run calibration in the background (300-500 ms of audio is enough); it
      // never blocks start() or the audio loop. Pinned gain skips calibration.
      if (inputGainSetting === null) void calibrateMicGain();
    },

    async stop() {
      await stopInternal();
    },

    beginCapture,
    endCapture,

    // ---- GUI self-test / runtime config (docs/ipc.md §3.1) ----
    armWakeTest,
    disarmWakeTest,
    startMicTest,
    stopMicTest,
    startAsrTest,
    stopAsrTest,
    applyRuntimeConfig,
    setMuted,
    pauseListening: () => setMuted(true),
    resumeListening: () => setMuted(false),
    setSensitivity: (name) => applyRuntimeConfig({ sensitivity: name }),
    setWakeCooldownMs: (ms) => applyRuntimeConfig({ wakeCooldownMs: ms }),
    setWakeGiveUpMs: (ms) => applyRuntimeConfig({ wakeGiveUpMs: ms }),
    setBargeIn: (patch) => applyRuntimeConfig({ bargeIn: patch }),
    setVerifyWake: (patch) => applyRuntimeConfig({ verifyWake: patch }),
    setInputGainPercent: (value) => setInputGainPercent(value),
    get sensitivity() {
      return sensitivity;
    },
    get wakeCooldownMs() {
      return wakeCooldownMs;
    },
    get wakeGiveUpMs() {
      return wakeGiveUpMs;
    },
    get bargeIn() {
      return bargeDetector.config;
    },
    get verifyWake() {
      return { ...verifyWake };
    },
    get verifyStats() {
      return {
        accepted: verifyStats.accepted,
        rejected: verifyStats.rejected,
        failOpen: verifyStats.failOpen,
        selfTestAccepted: verifyStats.selfTestAccepted,
        selfTestRejected: verifyStats.selfTestRejected,
        lastVerify: verifyStats.lastVerify,
      };
    },
    get inputGainPercent() {
      return inputGainSetting;
    },
    /** diagnostics: {gainPercent, rms, peak} + fixed-gain info (docs/ipc.md §3.1) */
    get micInfo() {
      return {
        available: micGain ? micGain.available : false,
        gainPercent: micGain?.gain?.gain ?? null,
        percent: micGain?.gain?.percent ?? null,
        rms: lastRms,
        peak: lastPeak,
        fixed: micGain?.fixed ?? false,
        fixedPercent: micGain?.fixedTarget ?? inputGainSetting,
      };
    },
    /** duration of the last finalize step (offline transcription), ms */
    get lastFinalMs() {
      return lastFinalMs;
    },
    get muted() {
      return muted;
    },

    // ---- diagnostics (not part of the IPC contract) ----
    get state() {
      return state;
    },
    get modelInfo() {
      const dirs = models();
      return {
        threads: { kws: KWS_THREADS, streaming: STREAM_THREADS, offline: OFFLINE_THREADS },
        model: kws?.modelName ?? null,
        hasEnglish: kws?.hasEnglish ?? false,
        englishKeywords: kws?.englishKeywords ?? [],
        wakeWordsEn,
        maxActivePaths: kws?.maxActivePaths ?? null,
        sensitivity,
        kwsParams: sensitivityPreset(sensitivity),
        wakeCooldownMs,
        wakeGiveUpMs,
        verifyWake: { ...verifyWake },
        verifyStats: {
          accepted: verifyStats.accepted,
          rejected: verifyStats.rejected,
          failOpen: verifyStats.failOpen,
          selfTestAccepted: verifyStats.selfTestAccepted,
          selfTestRejected: verifyStats.selfTestRejected,
          lastVerify: verifyStats.lastVerify,
        },
        verifyPending: Boolean(verifyPending),
        speaker: speakerGate.status(),
        bargeIn: bargeDetector.config,
        bargeInStats: {
          active: bargeDetector.active,
          phase: bargeDetector.phase,
          baseline: bargeDetector.baseline,
          threshold: bargeDetector.threshold,
          fired: bargeDetector.stats.fired,
        },
        inputGainPercent: inputGainSetting,
        lastFinalMs,
        offlineLoaded: Boolean(offline),
        offlineLoadError: offlineLoadError ? offlineLoadError.message : null,
        kwsDir: dirs.kws,
        streamingDir: dirs.streaming,
        offlineDir: dirs.offline,
        vadModel: dirs.vad,
        kws: kws?.modelFiles ?? null,
        keywords: kws?.keywords?.lines ?? [],
        streaming: Boolean(streaming),
        offline: offline?.kind ?? null,
        vad: vad?.kind ?? null,
      };
    },
    get micGainInfo() {
      if (!micGain) return null;
      return { available: micGain.available, ...(micGain.gain ? { gain: micGain.gain.gain, percent: micGain.gain.percent } : {}) };
    },
    get hotkeyState() {
      return hotkeyInst ? { state: hotkeyInst.state, bound: hotkeyInst.bound, started: hotkeyStarted, session: hotkeyInst.sessionPath } : null;
    },
  };
}

export default createAsr;
