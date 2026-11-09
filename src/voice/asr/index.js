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
    source,
    hotkey: hotkeyOption,
    micGain: micGainOption,
  } = opts ?? {};
  if (!config) throw new TypeError('createAsr: config is required');
  const asrCfg = config.asr ?? {};
  const root = config.paths?.root ?? REPO_ROOT;

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
  let levelSumSq = 0;
  let levelCount = 0;
  let lastAudioAt = 0;
  let tickTimer = null;
  let wakeFallbackTimer = null;
  let finalizePromise = null;
  let hotkeyStarted = false;

  const safe = (fn, ...args) => {
    try { return fn(...args); } catch (err) { /* never let user callbacks kill the loop */ }
    return undefined;
  };
  const emitError = (err) => safe(onError, asError(err));
  const log = (msg) => safe(onLog, msg);

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

  function emitLevel(samples) {
    // Emit one RMS value per 50 ms audio window (=> 20 Hz), carrying the
    // remainder across chunks so the rate is independent of the parec chunk size.
    let off = 0;
    while (off < samples.length) {
      const take = Math.min(LEVEL_WINDOW_SAMPLES - levelCount, samples.length - off);
      for (let i = 0; i < take; i++) {
        const v = samples[off + i];
        levelSumSq += v * v;
      }
      levelCount += take;
      off += take;
      if (levelCount === LEVEL_WINDOW_SAMPLES) {
        const rms = Math.sqrt(levelSumSq / LEVEL_WINDOW_SAMPLES);
        levelSumSq = 0;
        levelCount = 0;
        safe(onLevel, Math.max(0, Math.min(1, rms)));
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

  function handlePcm(samples) {
    if (!samples || samples.length === 0) return;
    if (state === 'stopped' || state === 'failed' || state === 'idle' || state === 'starting') return;
    lastAudioAt = Date.now();
    feedProbes(samples);
    monitorMicLevel(samples);
    emitLevel(samples);
    pushPreRoll(samples);
    if (state === 'listening') {
      if (!kws) return;
      let hit = null;
      try {
        hit = kws.feed(samples);
      } catch (err) {
        emitError(new Error(`KWS 解码失败：${asError(err).message}`, { cause: err }));
        return;
      }
      if (hit) handleWake(`kws:${hit.keyword}`);
    } else if (state === 'capturing' && capture) {
      try {
        capture.push(samples);
      } catch (err) {
        emitError(new Error(`采集处理失败：${asError(err).message}`, { cause: err }));
      }
    }
  }

  function handleWake(origin) {
    if (state !== 'listening') return;
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
      try {
        await ensureOfflineModel();
        result = await cap.end(why);
      } catch (err) {
        emitError(new Error(`转写失败：${asError(err).message}`, { cause: err }));
        result = { text: '', reason: why, stats: {} };
      }
      clearPreRoll();
      if (kws) { try { kws.reset(); } catch { /* ignore */ } }
      if (state !== 'stopped') state = 'listening';
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
        kws = createKws({
          modelDir: dirs.kws,
          wakeWords: asrCfg.wakeWords ?? [],
          numThreads: KWS_THREADS,
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
          `模型就绪: kws=${kws.modelFiles.epoch}(${KWS_THREADS}线程) streaming=${streaming ? `yes(${STREAM_THREADS}线程)` : 'no'} ` +
          `offline=lazy(${hasOffline ? OFFLINE_THREADS : '-'}线程) vad=${vad.kind} keywords=${kws.keywords.lines.length}`,
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
            onEnd: () => endCapture('hotkey-release'),
            onError: (err) => emitError(err),
            onLog: log,
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
      // Run calibration in the background (300-500 ms of audio is enough); it
      // never blocks start() or the audio loop.
      void calibrateMicGain();
    },

    async stop() {
      await stopInternal();
    },

    beginCapture,
    endCapture,

    // ---- diagnostics (not part of the IPC contract) ----
    get state() {
      return state;
    },
    get modelInfo() {
      const dirs = models();
      return {
        threads: { kws: KWS_THREADS, streaming: STREAM_THREADS, offline: OFFLINE_THREADS },
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
