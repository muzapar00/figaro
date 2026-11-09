// Microphone capture-gain auto calibration + runtime level watchdog.
//
// The built-in ALC897 capture control keeps its ALSA gain across sessions; on
// this machine it can sit at 63/63 (+30 dB), which makes the KWS input clip and
// the wake word never match ("mic too hot"). We read the gain with `amixer`,
// measure the actual input and step the control into a sane range once after
// start(). Failures are warnings only — ASR must keep working on machines with
// different mixers.
//
// Also watches the long-running level: sustained clipping or a long digital
// silence produce a single human-readable onError (never a log flood).
//
// All logic is injected (`run` for amixer, `measure` for audio) so it is unit
// tested without touching the system mixer.

import { execFile } from 'node:child_process';

export const DEFAULT_CARD = 0;
export const DEFAULT_CONTROL = 'Capture';

// level thresholds are normalised RMS / peak in [0, 1] (raw s16 / 32768)
export const HOT_RMS = 0.25; // > +30 dB-ish, clearly overdriven speech
export const CLIP_PEAK = 0.9;
// Conservative: only raise when the input is essentially digital silence.
// (The obvious "RMS < 0.005 -> raise" rule oscillates: a quiet room sits at
// RMS ~0.0026 @45% gain, so it would raise the gain back to 63 and re-introduce
// clipping on speech. Ambient quiet != quiet speech.)
export const QUIET_RMS = 0.002; // ~65 raw
export const TARGET_MAX_RMS = 0.15;
export const TARGET_MIN_RMS = 0.02;

const DOWN_STEPS = [45, 38, 30, 24];
export const MIN_GAIN = 20; // never mute the microphone
const UP_STEP = 8;

/** Parse `amixer -c N sget Capture` output. Returns {gain, raw, percent} or null. */
export function parseAmixerSget(text) {
  if (!text) return null;
  const limits = /Limits:\s*Capture\s+(\d+)\s*-\s*(\d+)/.exec(text);
  const front = /Front Left:\s*Capture\s+(\d+)\s*\[(\d+)%\]/i.exec(text);
  if (!front) return null;
  const gain = Number(front[1]);
  const percent = Number(front[2]);
  return { gain, percent, limits: limits ? { min: Number(limits[1]), max: Number(limits[2]) } : null };
}

function defaultRun(command, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? (err ? err.message : '') });
    });
  });
}

/**
 * @param {object} opts
 * @param {number} [opts.card] ALSA card index for `amixer -c`
 * @param {string} [opts.control] mixer control name
 * @param {(cmd: string, args: string[]) => Promise<{ok: boolean, stdout?: string, stderr?: string}>} [opts.run]
 * @param {(msg: string) => void} [opts.onLog]
 * @param {(err: Error) => void} [opts.onError] unused directly; index.js emits errors from monitor()
 */
export function createMicGainController(opts = {}) {
  const {
    card = DEFAULT_CARD,
    control = DEFAULT_CONTROL,
    run = defaultRun,
    onLog = () => {},
  } = opts;
  let available = true;
  let warned = false;
  let readGainValue = null;
  let adjustedFrom = null;

  // runtime watchdog state
  let windowSamples = 0;
  let windowRmsSum = 0;
  let windowClipSamples = 0;
  let silentStreakMs = 0;
  let lastWarnAt = { clipping: 0, silent: 0 };
  let warnedOnce = { clipping: false, silent: false };

  function warnOnce(err) {
    if (warned) return;
    warned = true;
    onLog(`[mic] 无法通过 amixer 读取/设置 ${control} 增益（${err.message}），跳过自动增益校正`);
  }

  async function read() {
    const res = await run('amixer', ['-c', String(card), 'sget', control]);
    if (!res.ok) { warnOnce(new Error((res.stderr || 'amixer failed').trim().split('\n').pop() ?? 'amixer failed')); available = false; return null; }
    const parsed = parseAmixerSget(res.stdout);
    if (!parsed) { warnOnce(new Error('无法解析 amixer 输出')); available = false; return null; }
    readGainValue = parsed;
    return parsed;
  }

  async function setGain(gain) {
    if (!available) return false;
    const res = await run('amixer', ['-c', String(card), 'sset', control, `${Math.round(gain)}%`]);
    if (!res.ok) { warnOnce(new Error((res.stderr || 'amixer sset failed').trim())); available = false; return false; }
    readGainValue = { ...(readGainValue ?? {}), gain, percent: gain };
    return true;
  }

  function stepDown(gain) {
    const next = DOWN_STEPS.find((g) => g < gain && g >= MIN_GAIN);
    return next ?? gain; // already at/below the lowest safe step: do not touch it
  }

  /**
   * One-shot calibration. `measure(ms)` must resolve with {rms, peak} over the
   * requested audio window (index.js collects it from the parec stream).
   *
   * @param {(ms: number) => Promise<{rms: number, peak: number}>} measure
   */
  async function calibrate(measure) {
    const cur = await read();
    if (!cur) return { adjusted: false, reason: 'unavailable' };
    let gain = cur.gain;
    const initialGain = gain;
    adjustedFrom = initialGain;
    let adjustments = 0;
    for (let i = 0; i < 3; i++) {
      let rms01;
      let peak01;
      try {
        const m = await measure(400);
        rms01 = m.rms;
        peak01 = m.peak;
      } catch {
        return { adjusted: adjustments > 0, reason: 'measure-failed' };
      }
      const before = Math.round(rms01 * 32768);
      if (peak01 > CLIP_PEAK || rms01 > HOT_RMS) {
        const next = stepDown(gain);
        if (next === gain) break;
        if (!(await setGain(next))) break;
        gain = next;
        adjustments += 1;
        // measure after the change so the log shows before -> after
        let after = null;
        try { after = await measure(300); } catch { /* keep null */ }
        const afterTxt = after ? Math.round(after.rms * 32768) : '?';
        onLog(`[mic] capture gain ${cur.gain}->${next} (RMS ${before}->${afterTxt})`);
        if (after && after.peak <= CLIP_PEAK && after.rms <= TARGET_MAX_RMS) break;
        continue;
      }
      if (rms01 < QUIET_RMS && gain < (readGainValue?.limits?.max ?? 63)) {
        const next = Math.min((readGainValue?.limits?.max ?? 63), gain + UP_STEP);
        if (!(await setGain(next))) break;
        gain = next;
        adjustments += 1;
        let after = null;
        try { after = await measure(300); } catch { /* keep null */ }
        onLog(`[mic] capture gain ${cur.gain}->${next} (RMS ${before}->${after ? Math.round(after.rms * 32768) : '?'})`);
        continue;
      }
      onLog(`[mic] capture gain ok at ${gain} (RMS ${before}, peak ${Math.round(peak01 * 32768)})`);
      break;
    }
    return { adjusted: adjustments > 0, from: adjustedFrom, to: gain, adjustments };
  }

  /**
   * Feed one audio chunk's level. Returns a warning object at most once per
   * condition (caller emits onError). Designed to be called from the PCM loop.
   */
  function observe(rms01, peak01, now = Date.now()) {
    windowSamples += 1;
    windowRmsSum += rms01;
    if (peak01 > CLIP_PEAK || rms01 > HOT_RMS) windowClipSamples += 1;
    const mean = windowRmsSum / windowSamples;
    silentStreakMs = mean < 0.001 ? silentStreakMs + 100 : 0;
    const CLIP_COOLDOWN = 300_000;
    if (windowSamples >= 50) { // roughly a 5 s window at 100 ms chunks
      const clipRatio = windowClipSamples / windowSamples;
      const clipWarn = clipRatio > 0.5 && now - lastWarnAt.clipping > CLIP_COOLDOWN;
      let result = null;
      if (clipWarn) {
        lastWarnAt.clipping = now;
        warnedOnce.clipping = true;
        result = {
          code: 'MIC_CLIPPING',
          message: `麦克风输入持续削波（${Math.round(clipRatio * 100)}% 采样过载）。建议执行 amixer -c ${card} sset ${control} 45% 后重启费加罗。`,
        };
      }
      windowSamples = 0;
      windowRmsSum = 0;
      windowClipSamples = 0;
      if (result) return result;
    }
    if (silentStreakMs >= 60_000 && now - lastWarnAt.silent > CLIP_COOLDOWN) {
      lastWarnAt.silent = now;
      silentStreakMs = 0;
      return {
        code: 'MIC_SILENT',
        message: '麦克风连续 60 秒几乎没有声音输入，请检查输入设备/增益（amixer -c 0 sget Capture）。',
      };
    }
    return null;
  }

  /**
   * Self-healing for the real-world failure mode: input keeps clipping while
   * capturing (loud room / overdriven gain). Drop one gain step, rate limited by
   * the observe() cooldown. Called from index.js when observe() returned
   * a MIC_CLIPPING warning.
   */
  async function correctClipping() {
    const cur = await read();
    if (!cur) return false;
    const next = stepDown(cur.gain);
    if (next >= cur.gain) return false;
    if (!(await setGain(next))) return false;
    onLog(`[mic] capture gain ${cur.gain}->${next} (持续削波，自动下调)`);
    return true;
  }

  return {
    get available() {
      return available;
    },
    get gain() {
      return readGainValue;
    },
    read,
    setGain,
    calibrate,
    correctClipping,
    observe,
    reset() {
      windowSamples = 0;
      windowRmsSum = 0;
      windowClipSamples = 0;
      silentStreakMs = 0;
      lastWarnAt = { clipping: 0, silent: 0 };
    },
  };
}

export default { createMicGainController, parseAmixerSget };
