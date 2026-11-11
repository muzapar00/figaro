// Settings & self-test service for the daemon (docs/ipc.md §3.1, additive).
//
// The GUI (qs -c figaro-settings) and diagnostics scripts talk to the same unix
// socket as the CLI/overlay. Everything here is defensive: missing ASR/TTS
// modules, missing test hooks or a corrupt config file produce a structured
// `error` reply instead of crashing the daemon.
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { CONFIG_PATH, CONFIG_DIR } from '../config.js';
import { atomicWriteFile } from './tools/atomic-write.js';

/** Message types routed here instead of the conversation state machine. */
export const SETTINGS_MESSAGE_TYPES = Object.freeze([
  'config.get',
  'config.set',
  'test.mic.start',
  'test.mic.stop',
  'test.asr.start',
  'test.asr.stop',
  'test.wake.arm',
  'test.wake.disarm',
  'test.tts',
  'service.restart',
  'home.test',
  'diagnostics',
]);

export const SECRET_PATHS = Object.freeze(['deepseek.apiKey', 'minimax.apiKey', 'home.haToken']);

// Paths the GUI may write. Everything else is rejected so a UI bug cannot
// rewrite the API keys, socket path or model endpoints.
export const ALLOWED_CONFIG_PATHS = Object.freeze([
  'asr.enabled',
  'asr.sensitivity',
  'asr.wakeWords',
  'asr.wakeWordsEn',
  'asr.hotkey',
  'asr.wakeCooldownMs',
  'asr.inputGainPercent',
  'asr.silenceStopMs',
  'asr.bargeIn.enabled',
  'asr.bargeIn.minRms',
  'asr.bargeIn.echoFactor',
  'asr.bargeIn.minMs',
  'asr.verifyWake.enabled',
  'asr.speaker.enabled',
  'asr.speaker.threshold',
  'interaction.followUpWindowMs',
  'interaction.followUpMinRms',
  'interaction.followUpMinMs',
  'interaction.dismissPhrases',
  'interaction.cancelPhrases',
  'ui.scale',
  'ui.shape',
  'ui.motion',
  'ui.windowButtonSize',
  'sfx.enabled',
  'sfx.volume',
  'asr.modelDir',
  'deepseek.apiKey',
  'minimax.apiKey',
  'tts.sink',
  'tts.model',
  'tts.voiceId',
  'tts.speed',
  'tts.ack.enabled',
  'tts.ack.phrases',
  'tts.ack.timeoutMs',
  'home.haUrl',
  'home.haToken',
  'home.defaultRoom',
]);

export const MIC_TEST_DEFAULT_MS = 4000;
export const WAKE_TEST_DEFAULT_MS = 15000;
/** Home Assistant connectivity probe: 4 s, matches what the GUI reports. */
export const HOME_TEST_TIMEOUT_MS = 4000;
const MIC_TEST_OVERHEAD_MS = 800;
const WAKE_TEST_OVERHEAD_MS = 1200;
const WAKE_SCORE_MIN_INTERVAL_MS = 100;
const ASR_TEST_DEFAULT_MS = 8000;
const ASR_TEST_OVERHEAD_MS = 3000;
const MAX_RECENT_ERRORS = 20;
const DEFAULT_TTS_TEST_TEXT = '你好，我是费加罗。';

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Deep clone with the API keys replaced by "***". */
export function sanitizeConfig(config) {
  const copy = clone(config ?? {});
  for (const secretPath of SECRET_PATHS) {
    const parts = secretPath.split('.');
    let node = copy;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!isPlainObject(node[parts[i]])) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = '***';
  }
  return copy;
}

/** Flatten nested config patches to leaf paths: {a:{b:1}} -> ['a.b']. */
export function flattenPatch(patch, prefix = '') {
  const paths = [];
  if (!isPlainObject(patch)) return paths;
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      paths.push(...flattenPatch(value, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

/** @returns {{allowed: string[], forbidden: string[]}} */
export function validatePatchPaths(patch) {
  const allowed = [];
  const forbidden = [];
  for (const path of flattenPatch(patch)) {
    if (ALLOWED_CONFIG_PATHS.includes(path)) allowed.push(path);
    else forbidden.push(path);
  }
  return { allowed, forbidden };
}

/**
 * Value-level checks for whitelisted paths that would otherwise corrupt the
 * daemon config (the GUI already constrains them, but a direct IPC call must
 * not be able to write nonsense).
 * @returns {Array<{path: string, message: string}>}
 */
export function validatePatchValues(patch) {
  const invalid = [];
  const speaker = isPlainObject(patch?.asr) && isPlainObject(patch.asr.speaker) ? patch.asr.speaker : null;
  if (speaker && speaker.enabled !== undefined && typeof speaker.enabled !== 'boolean') {
    invalid.push({ path: 'asr.speaker.enabled', message: '声纹开关需要是 true/false' });
  }
  if (speaker && speaker.threshold !== undefined) {
    const value = Number(speaker.threshold);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      invalid.push({ path: 'asr.speaker.threshold', message: '声纹阈值需要是 0–1 之间的数字' });
    }
  }
  return invalid;
}

/** Deep merge plain objects; arrays and scalars replace. */
export function deepMergeConfig(base, patch) {
  if (!isPlainObject(patch)) return clone(patch);
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value)) out[key] = deepMergeConfig(out[key], value);
    else out[key] = clone(value);
  }
  return out;
}

/** Read the raw config.json ({} when absent; throws only on corrupt JSON). */
export async function readConfigFile(configPath) {
  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('config.json is not a JSON object');
    return parsed;
  } catch (err) {
    const wrapped = new Error(`config.json is corrupt: ${err.message}`);
    wrapped.code = 'CONFIG_CORRUPT';
    throw wrapped;
  }
}

/** Write config.json atomically with mode 600 (secrets live there). */
export async function writeConfigFile(configPath, raw) {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 }).catch(() => {});
  await atomicWriteFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600).catch(() => {});
}

const execFileAsync = promisify(execFile);
const SINK_CACHE_TTL_MS = 5000;
let sinkCache = { at: 0, value: null };

/**
 * List PipeWire/PulseAudio playback sinks for the GUI device picker.
 * Never throws: returns null when pactl is unavailable or the output is not JSON.
 */
export async function listAudioSinks({ force = false } = {}) {
  const now = Date.now();
  if (!force && sinkCache.value && now - sinkCache.at < SINK_CACHE_TTL_MS) return sinkCache.value;
  try {
    const [sinksResult, defaultResult] = await Promise.all([
      execFileAsync('pactl', ['-f', 'json', 'list', 'sinks'], { timeout: 3000, maxBuffer: 1024 * 1024 }),
      execFileAsync('pactl', ['get-default-sink'], { timeout: 3000 }),
    ]);
    const raw = JSON.parse(sinksResult.stdout);
    if (!Array.isArray(raw)) return null;
    const defaultName = String(defaultResult.stdout ?? '').trim();
    const value = raw
      .filter((entry) => entry && typeof entry.name === 'string')
      .map((entry) => {
        const props = entry.properties ?? {};
        const candidates = [props['device.description'], entry.description, props['node.description'], props['device.nick']];
        let description = '';
        for (const candidate of candidates) {
          if (typeof candidate === 'string' && candidate.trim().length > 0 && candidate !== '(null)') {
            description = candidate.trim();
            break;
          }
        }
        return {
          name: entry.name,
          description: description || entry.name,
          isDefault: entry.name === defaultName,
        };
      });
    sinkCache = { at: now, value };
    return value;
  } catch (err) {
    sinkCache = { at: 0, value: null };
    void err;
    return null;
  }
}

/**
 * Normalise the Home Assistant base URL the user typed ("ha.local:8123",
 * "http://ha.local:8123/", ...) to a scheme+host+path string without a
 * trailing slash. Returns "" when it is not a usable http(s) URL.
 */
export function normalizeHaUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw)) return ''; // reject ftp:// etc.
  const withScheme = hasScheme ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname) return '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

/**
 * Probe `${haUrl}/api/` with the long-lived access token.
 * Never logs or echoes the token; the returned message is safe to display.
 * @returns {Promise<{type:'home.test', ok:boolean, status:number, message:string}>}
 */
export async function testHomeAssistant({ haUrl, haToken, timeoutMs = HOME_TEST_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const base = normalizeHaUrl(haUrl);
  if (!base) {
    return { type: 'home.test', ok: false, status: 0, message: '还差一个 Home Assistant 地址（例如 http://homeassistant.local:8123）' };
  }
  const token = String(haToken ?? '').trim();
  if (!token || token === '***') {
    return { type: 'home.test', ok: false, status: 0, message: '还没有填写长期访问令牌（home.haToken）' };
  }
  if (typeof fetchImpl !== 'function') {
    return { type: 'home.test', ok: false, status: 0, message: '当前 Node 没有内置 fetch，无法测试连接' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || HOME_TEST_TIMEOUT_MS));
  try {
    const response = await fetchImpl(`${base}/api/`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    // Do not read the body: /api/ is small and we only need the status class.
    try {
      await response.body?.cancel?.();
    } catch {
      /* ignore */
    }
    if (response.status === 200) {
      return { type: 'home.test', ok: true, status: 200, message: '已连接 Home Assistant' };
    }
    if (response.status === 401 || response.status === 403) {
      return { type: 'home.test', ok: false, status: response.status, message: '令牌无效（HTTP ' + response.status + '）' };
    }
    return { type: 'home.test', ok: false, status: response.status, message: `连不上 ${base}（HTTP ${response.status}）` };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return {
      type: 'home.test',
      ok: false,
      status: 0,
      message: aborted
        ? `连不上 ${base}（${Math.round(Number(timeoutMs) || HOME_TEST_TIMEOUT_MS)} ms 超时）`
        : `连不上 ${base}（网络错误）`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * @param {object} options
 * @param {object} options.config effective config (loadConfig() result)
 * @param {object} options.logger console-like {info,warn,error}
 * @param {object} options.context daemon hooks:
 *   getVoice() -> {asr, tts}
 *   getAck() -> wake-ack controller | null
 *   getEffectiveConfig() -> config
 *   getUptimeMs() -> number
 *   getVersion() -> string
 *   getRecentErrors() -> Array<{at, message}>
 *   getMicInfo() -> {rms, peak}   (daemon tracks the last level frames)
 *   broadcast(msg)
 *   reply(client, msg)
 *   reloadConfig() -> Promise<object>  (re-read config.json into the daemon)
 *   applyConfigPatch(patch, changedPaths) -> Promise<{applied, restartRequired, errors}>
 *   requestRestart() -> void
 *   getConfigPath() -> string
 * @param {string} [options.configPath]
 * @param {Function} [options.listSinks] test seam: async () => [{name, description, isDefault}]
 */
export function createSettingsService(options = {}) {
  const log = options.logger ?? { info() {}, warn() {}, error() {} };
  const context = options.context ?? {};
  const configPath = options.configPath ?? CONFIG_PATH;
  const listSinks = options.listSinks ?? listAudioSinks;

  let micTest = null;
  let asrTest = null;
  let wakeTest = null;
  let closed = false;

  function broadcast(message) {
    try {
      context.broadcast?.(message);
    } catch (err) {
      log.warn('settings broadcast failed:', err?.message || err);
    }
  }

  function reply(client, message) {
    try {
      client?.send?.(message);
    } catch {
      /* client went away */
    }
  }

  function sendError(client, id, code, message) {
    log.warn(`settings ${code}: ${message}`);
    reply(client, { type: 'error', ...(id !== undefined ? { id } : {}), code, message });
  }

  function voice() {
    return context.getVoice?.() ?? { asr: null, tts: null };
  }

  function messageId(message) {
    return message?.id;
  }

  function withId(id, payload) {
    return id === undefined ? payload : { ...payload, id };
  }

  // ------------------------------------------------------------- config ----

  // ---------------------------------------------------------- home assistant ----
  async function handleHomeTest(message, client) {
    const id = messageId(message);
    const effective = context.getEffectiveConfig?.() ?? options.config ?? {};
    const home = effective?.home ?? {};
    const visible = (value) => (typeof value === 'string' && value.trim().length > 0 && value.trim() !== '***' ? value.trim() : '');
    // Draft URL from the GUI wins; the token only comes from the draft when the
    // user actually typed a new one ("***" and empty mean "use the saved one").
    const haUrl = visible(message?.haUrl) || visible(home.haUrl);
    const haToken = visible(message?.haToken) || visible(home.haToken);
    const result = await testHomeAssistant({ haUrl, haToken });
    // Never log the URL or the token: just the outcome class.
    log.info(`home.test ${result.ok ? 'ok' : 'failed'}${result.status ? ` (HTTP ${result.status})` : ''}`);
    if (message?.id !== undefined) result.id = message.id;
    reply(client, result);
  }

  async function handleConfigGet(message, client) {
    const id = messageId(message);
    let effective;
    try {
      effective = await context.reloadConfig?.() ?? context.getEffectiveConfig?.() ?? options.config;
    } catch (err) {
      return sendError(client, id, 'CONFIG_READ_FAILED', `读取配置失败：${err?.message || err}`);
    }
    reply(client, withId(id, { type: 'config', config: sanitizeConfig(effective) }));
  }

  async function handleConfigSet(message, client) {
    const id = messageId(message);
    if (!isPlainObject(message.patch)) {
      return sendError(client, id, 'CONFIG_BAD_PATCH', 'config.set 需要 patch 是 JSON 对象');
    }
    const { allowed, forbidden } = validatePatchPaths(message.patch);
    const invalid = validatePatchValues(message.patch);
    if (invalid.length > 0) {
      const current = context.getEffectiveConfig?.() ?? options.config;
      reply(client, withId(id, {
        type: 'config',
        ok: false,
        invalid,
        errors: invalid.map((entry) => entry.message),
        forbidden: invalid.map((entry) => entry.path),
        config: sanitizeConfig(current),
      }));
      return;
    }
    if (forbidden.length > 0) {
      const current = context.getEffectiveConfig?.() ?? options.config;
      reply(client, withId(id, {
        type: 'config',
        ok: false,
        errors: forbidden.map((path) => `不允许修改：${path}`),
        forbidden,
        config: sanitizeConfig(current),
      }));
      return;
    }
    if (allowed.length === 0) {
      const current = context.getEffectiveConfig?.() ?? options.config;
      reply(client, withId(id, { type: 'config', ok: true, applied: [], restartRequired: [], config: sanitizeConfig(current) }));
      return;
    }

    let raw;
    try {
      raw = await readConfigFile(configPath);
    } catch (err) {
      return sendError(client, id, err.code || 'CONFIG_READ_FAILED', `读取 config.json 失败：${err.message}`);
    }
    const merged = deepMergeConfig(raw, message.patch);
    try {
      await writeConfigFile(configPath, merged);
    } catch (err) {
      return sendError(client, id, 'CONFIG_WRITE_FAILED', `写入 config.json 失败：${err?.message || err}`);
    }

    let effective;
    try {
      effective = await context.reloadConfig?.() ?? context.getEffectiveConfig?.() ?? options.config;
    } catch (err) {
      log.warn('config reload failed:', err?.message || err);
      effective = context.getEffectiveConfig?.() ?? options.config;
    }

    let applied = [];
    let restartRequired = [];
    let errors = [];
    try {
      const applyResult = await context.applyConfigPatch?.(message.patch, allowed);
      applied = applyResult?.applied ?? [];
      restartRequired = applyResult?.restartRequired ?? [];
      errors = applyResult?.errors ?? [];
    } catch (err) {
      errors.push(`热应用失败：${err?.message || err}`);
    }

    // Paths the daemon did not classify (e.g. home.*, which the daemon only
    // reads at startup) still need a restart; say so instead of "unknown".
    const classified = new Set([...applied, ...restartRequired]);
    for (const path of allowed) {
      if (!classified.has(path)) restartRequired.push(path);
    }

    reply(client, withId(id, {
      type: 'config',
      ok: true,
      applied,
      restartRequired,
      ...(errors.length > 0 ? { errors } : {}),
      config: sanitizeConfig(effective),
    }));
  }

  // ----------------------------------------------------------- mic test ----

  function endMicTest(reason = 'end') {
    const test = micTest;
    if (!test) return;
    micTest = null;
    if (test.timer) clearTimeout(test.timer);
    broadcast(withId(test.id, { type: 'mic.end', reason }));
  }

  function handleMicStart(message, client) {
    const id = messageId(message);
    if (micTest) return sendError(client, id, 'TEST_BUSY', '麦克风测试已经在进行中');
    const asr = voice().asr;
    if (!asr) return sendError(client, id, 'unsupported', 'ASR 模块不可用，无法测试麦克风');
    if (typeof asr.startMicTest !== 'function') {
      return sendError(client, id, 'unsupported', 'ASR 模块尚未提供麦克风测试接口（startMicTest）');
    }
    const ms = Math.max(200, finiteNumber(message.ms, MIC_TEST_DEFAULT_MS));
    const test = { id, timer: null };
    micTest = test;
    try {
      asr.startMicTest({
        ms,
        onSample: (sample) => {
          if (micTest !== test) return;
          const rms = clamp01(sample?.rms);
          const peak = clamp01(sample?.peak);
          const level = sample?.level === undefined ? rms : clamp01(sample.level);
          broadcast(withId(id, { type: 'mic', rms, peak, level }));
        },
        onEnd: () => endMicTest('end'),
      });
    } catch (err) {
      micTest = null;
      return sendError(client, id, 'TEST_FAILED', `启动麦克风测试失败：${err?.message || err}`);
    }
    test.timer = setTimeout(() => {
      if (micTest !== test) return;
      try {
        asr.stopMicTest?.();
      } catch {
        /* ignore */
      }
      endMicTest('timeout');
    }, ms + MIC_TEST_OVERHEAD_MS);
    test.timer.unref?.();
  }

  function handleMicStop(message, client) {
    const id = messageId(message);
    if (!micTest) {
      reply(client, withId(id, { type: 'mic.end', reason: 'not-running' }));
      return;
    }
    const asr = voice().asr;
    try {
      asr?.stopMicTest?.();
    } catch (err) {
      log.warn('stopMicTest failed:', err?.message || err);
    }
    endMicTest('stopped');
  }

  // ----------------------------------------------------------- asr test ----

  function finishAsrTest(id, payload, reason) {
    const test = asrTest;
    if (!test) return;
    asrTest = null;
    if (test.timer) clearTimeout(test.timer);
    broadcast(withId(id, {
      type: 'test.asr.result',
      text: typeof payload?.text === 'string' ? payload.text : '',
      streamingText: typeof payload?.streamingText === 'string' ? payload.streamingText : '',
      ms: finiteNumber(payload?.ms, 0),
      audioMs: finiteNumber(payload?.audioMs, 0),
      ...(reason ? { reason } : {}),
    }));
  }

  function handleAsrStart(message, client) {
    const id = messageId(message);
    if (asrTest) return sendError(client, id, 'TEST_BUSY', '转写测试已经在进行中');
    const asr = voice().asr;
    if (!asr) return sendError(client, id, 'unsupported', 'ASR 模块不可用，无法测试转写');
    if (typeof asr.startAsrTest !== 'function') {
      return sendError(client, id, 'unsupported', 'ASR 模块尚未提供转写测试接口（startAsrTest）');
    }
    const ms = Math.max(500, finiteNumber(message.ms, ASR_TEST_DEFAULT_MS));
    const test = { id, timer: null };
    asrTest = test;
    try {
      asr.startAsrTest({
        ms,
        onPartial: (text) => {
          if (asrTest !== test) return;
          broadcast({ type: 'partial', text: String(text ?? '') });
        },
        onResult: (payload) => finishAsrTest(id, payload, 'end'),
        onError: (err) => {
          if (asrTest !== test) return;
          broadcast(withId(id, { type: 'error', code: 'ASR_TEST_FAILED', message: `转写测试失败：${err?.message || err}` }));
          finishAsrTest(id, null, 'error');
        },
      });
    } catch (err) {
      asrTest = null;
      return sendError(client, id, 'TEST_FAILED', `启动转写测试失败：${err?.message || err}`);
    }
    test.timer = setTimeout(() => {
      if (asrTest !== test) return;
      try {
        asr.stopAsrTest?.();
      } catch {
        /* ignore */
      }
      finishAsrTest(id, null, 'timeout');
    }, ms + ASR_TEST_OVERHEAD_MS);
    test.timer.unref?.();
  }

  function handleAsrStop(message, client) {
    const id = messageId(message);
    if (!asrTest) {
      reply(client, withId(id, { type: 'test.asr.result', text: '', streamingText: '', ms: 0, audioMs: 0, reason: 'not-running' }));
      return;
    }
    try {
      voice().asr?.stopAsrTest?.();
    } catch (err) {
      log.warn('stopAsrTest failed:', err?.message || err);
    }
  }

  // ---------------------------------------------------------- wake test ----

  function endWakeTest(reason = 'end', provided = null) {
    const test = wakeTest;
    if (!test) return;
    wakeTest = null;
    if (test.timer) clearTimeout(test.timer);
    const hits = finiteNumber(provided?.hits, test.hits) ?? test.hits;
    const misses = finiteNumber(provided?.misses, test.misses) ?? test.misses;
    const falseAlarms = (finiteNumber(provided?.falseAlarms, 0) ?? 0) + test.falseAlarms;
    broadcast(withId(test.id, { type: 'test.wake.end', hits, misses, falseAlarms, reason }));
  }

  function handleWakeDisarm(message, client) {
    const id = messageId(message);
    if (!wakeTest) {
      reply(client, withId(id, { type: 'test.wake.end', hits: 0, misses: 0, falseAlarms: 0, reason: 'not-running' }));
      return;
    }
    const test = wakeTest;
    const asr = voice().asr;
    if (typeof asr?.disarmWakeTest === 'function') {
      try {
        asr.disarmWakeTest();
      } catch (err) {
        log.warn('disarmWakeTest failed:', err?.message || err);
      }
    }
    // The module normally emits onEnd synchronously from disarmWakeTest(); if it
    // does not (older module / missing hook), finish the window here.
    if (wakeTest === test) endWakeTest('disarmed');
  }

  function handleWakeArm(message, client) {
    const id = messageId(message);
    if (wakeTest) return sendError(client, id, 'TEST_BUSY', '唤醒测试窗口已经打开');
    const asr = voice().asr;
    if (!asr) return sendError(client, id, 'unsupported', 'ASR 模块不可用，无法测试唤醒');
    if (typeof asr.armWakeTest !== 'function') {
      return sendError(client, id, 'unsupported', 'ASR 模块尚未提供唤醒测试接口（armWakeTest）');
    }
    const ms = Math.max(1000, finiteNumber(message.ms, WAKE_TEST_DEFAULT_MS));
    const test = { id, hits: 0, misses: 0, falseAlarms: 0, timer: null, lastScoreAt: 0 };
    wakeTest = test;
    try {
      asr.armWakeTest({
        ms,
        onScore: (payload) => {
          if (wakeTest !== test) return;
          const now = Date.now();
          if (now - test.lastScoreAt < WAKE_SCORE_MIN_INTERVAL_MS) return;
          test.lastScoreAt = now;
          broadcast(withId(id, {
            type: 'wake.score',
            score: clamp01(payload?.score),
            keyword: typeof payload?.keyword === 'string' ? payload.keyword : '',
          }));
        },
        onHit: (payload) => {
          if (wakeTest !== test) return;
          test.hits += 1;
          broadcast(withId(id, {
            type: 'wake.hit',
            score: clamp01(payload?.score),
            latencyMs: finiteNumber(payload?.latencyMs, 0) ?? 0,
          }));
        },
        onEnd: (payload) => endWakeTest('end', payload),
      });
    } catch (err) {
      wakeTest = null;
      return sendError(client, id, 'TEST_FAILED', `启动唤醒测试失败：${err?.message || err}`);
    }
    test.timer = setTimeout(() => {
      if (wakeTest !== test) return;
      try {
        asr.disarmWakeTest?.();
      } catch {
        /* ignore */
      }
      endWakeTest('timeout');
    }, ms + WAKE_TEST_OVERHEAD_MS);
    test.timer.unref?.();
    // Answer with the test window parameters so the GUI can draw a countdown.
    reply(client, withId(id, { type: 'ack', test: 'wake', ms }));
  }

  // ----------------------------------------------------------- tts test ----

  async function handleTtsTest(message, client) {
    const id = messageId(message);
    const tts = voice().tts;
    if (!tts) return sendError(client, id, 'unsupported', 'TTS 模块不可用，无法试听');
    const text = typeof message.text === 'string' && message.text.trim().length > 0
      ? message.text.trim()
      : DEFAULT_TTS_TEST_TEXT;
    const voiceId = typeof message.voiceId === 'string' && message.voiceId.trim().length > 0
      ? message.voiceId.trim()
      : undefined;

    // The test tone is the only sound: stop any reply/ack that is playing.
    try {
      context.cancelSpeech?.();
    } catch {
      /* ignore */
    }

    const startedAt = performance.now();
    let synth;
    try {
      synth = await tts.synthesize(text, voiceId ? { voiceId } : {});
    } catch (err) {
      broadcast(withId(id, { type: 'test.tts.result', id, ms: Math.round(performance.now() - startedAt), ok: false, error: String(err?.message || err) }));
      return;
    }
    if (!synth || !Buffer.isBuffer(synth.pcm) || synth.pcm.length < 320) {
      broadcast(withId(id, { type: 'test.tts.result', ms: Math.round(performance.now() - startedAt), ok: false, error: 'synthesis returned no audio' }));
      return;
    }
    const writeAt = performance.now();
    let playback;
    try {
      playback = tts.playPcm(synth.pcm, { rate: synth.sampleRate });
    } catch (err) {
      broadcast(withId(id, { type: 'test.tts.result', ms: Math.round(writeAt - startedAt), ok: false, error: String(err?.message || err) }));
      return;
    }
    // "First audio" = synthesis + handing the PCM to the player. The device
    // latency (~40 ms) is on top and is what the sink-monitor measurement shows.
    const ms = Math.round(performance.now() - startedAt);
    broadcast(withId(id, {
      type: 'test.tts.result',
      ms,
      ok: true,
      text,
      ...(voiceId ? { voiceId } : {}),
      sampleRate: synth.sampleRate ?? null,
      synthMs: Math.round(writeAt - startedAt),
      ttfbMs: synth.ttfbMs ?? null,
      durationMs: synth.durationMs ?? null,
    }));
    Promise.resolve(playback).catch((err) => {
      log.warn('test.tts playback failed:', err?.message || err);
    });
  }

  // ---------------------------------------------------------- diagnostics ----

  async function collectDiagnostics(id) {
    const { asr, tts } = voice();
    const ack = context.getAck?.() ?? null;
    const ackStats = ack?.stats ?? null;
    const ttsStats = tts?.stats ?? null;
    const asrInfo = typeof asr?.modelInfo === 'object' && asr.modelInfo !== null ? asr.modelInfo : null;
    const asrMic = typeof asr?.micInfo === 'object' && asr.micInfo !== null ? asr.micInfo : null;
    const gainInfo = typeof asr?.micGainInfo === 'object' && asr.micGainInfo !== null ? asr.micGainInfo : null;
    const liveMic = context.getMicInfo?.() ?? {};
    const gainPercent = finiteNumber(
      asrMic?.gainPercent ?? asrMic?.percent ?? gainInfo?.percent ?? gainInfo?.gain?.percent,
      null,
    );
    const config = context.getEffectiveConfig?.() ?? options.config ?? {};

    const currentSinkName = ttsStats?.audioSinkName || ttsStats?.audioSink || config.tts?.sink || '';
    let sinks = null;
    try {
      const listed = await listSinks();
      if (Array.isArray(listed) && listed.length > 0) {
        sinks = listed.map((sink) => ({
          name: String(sink.name),
          description: String(sink.description ?? ''),
          isDefault: Boolean(sink.isDefault),
          isCurrent: Boolean(currentSinkName) && sink.name === currentSinkName,
        }));
        // The configured/resolved sink may be a substring match not present in the
        // raw list; still offer it to the GUI so the dropdown can show the truth.
        if (currentSinkName && !sinks.some((sink) => sink.name === currentSinkName)) {
          sinks.push({ name: currentSinkName, description: '(current)', isDefault: false, isCurrent: true });
        }
      }
    } catch (err) {
      log.warn('sink enumeration failed:', err?.message || err);
      sinks = null;
    }

    const maskKey = (value) => {
      const key = typeof value === 'string' ? value.trim() : '';
      if (key.length === 0) return null;
      // Never expose more than the last four characters, and only as a hint.
      return key.length <= 8 ? '已配置' : `…${key.slice(-4)}`;
    };

    return withId(id, {
      type: 'diagnostics',
      keys: {
        deepseek: { configured: Boolean(config.deepseek?.apiKey), hint: maskKey(config.deepseek?.apiKey) },
        minimax: { configured: Boolean(config.minimax?.apiKey), hint: maskKey(config.minimax?.apiKey) },
      },
      configPath,
      version: context.getVersion?.() ?? null,
      uptimeMs: context.getUptimeMs?.() ?? 0,
      state: context.getState?.() ?? null,
      // Interaction settings are daemon-owned (not just a config echo): the
      // follow-up window and dismissal phrases are re-derivable at runtime, so
      // the GUI and `figaro status` can show what is actually in force.
      interaction: {
        followUpWindowMs: finiteNumber(config.interaction?.followUpWindowMs, 0),
        followUpMinRms: finiteNumber(config.interaction?.followUpMinRms, null),
        followUpMinMs: finiteNumber(config.interaction?.followUpMinMs, null),
        dismissPhrases: Array.isArray(config.interaction?.dismissPhrases) ? config.interaction.dismissPhrases.map(String) : [],
        cancelPhrases: Array.isArray(config.interaction?.cancelPhrases) ? config.interaction.cancelPhrases.map(String) : [],
      },
      asr: {
        available: Boolean(asr),
        state: typeof asr?.state === 'string' ? asr.state : null,
        capturing: Boolean(asr?.capturing),
        sensitivity: asr?.sensitivity ?? config.asr?.sensitivity ?? null,
        wakeCooldownMs: finiteNumber(asr?.wakeCooldownMs, finiteNumber(config.asr?.wakeCooldownMs, null)),
        inputGainPercent: asr?.inputGainPercent !== undefined ? asr.inputGainPercent : (config.asr?.inputGainPercent ?? null),
        hotkey: config.asr?.hotkey ?? '',
        hotkeyState: typeof asr?.hotkeyState === 'object' && asr.hotkeyState !== null ? asr.hotkeyState : null,
        muted: typeof asr?.muted === 'boolean' ? asr.muted : null,
        // Voiceprint gate state (disabled / not-enrolled / ready / model-missing)
        // and how many non-owner wakes it already filtered.
        speaker: asrInfo?.speaker ?? null,
        modelInfo: asrInfo,
        lastFinalMs: finiteNumber(asr?.lastFinalMs, null),
      },
      tts: {
        available: Boolean(tts),
        model: ttsStats?.model ?? config.minimax?.model ?? null,
        voiceId: ttsStats?.voiceId ?? config.minimax?.voiceId ?? null,
        sink: ttsStats?.audioSink ?? config.tts?.sink ?? '',
        sinkName: ttsStats?.audioSinkName ?? null,
        sinkStatus: ttsStats?.sinkStatus ?? null,
        // Candidate output devices for the GUI picker (omitted when pactl fails).
        ...(sinks ? { sinks } : {}),
        speaking: Boolean(tts?.speaking),
        connected: Boolean(ttsStats?.connected),
      },
      ack: ack
        ? {
            enabled: Boolean(ack.enabled),
            ready: Boolean(ack.ready),
            timeoutMs: ack.timeoutMs,
            phrases: ack.phrases,
            model: ackStats?.model ?? null,
            voiceId: ackStats?.voiceId ?? null,
            lastPhrase: ackStats?.lastPhrase ?? null,
            lastPlayDurationMs: ackStats?.lastPlayDurationMs ?? null,
            failures: ackStats?.failures ?? 0,
            reason: ackStats?.disabledReason ?? null,
          }
        : { enabled: false, ready: false, reason: 'not initialised' },
      mic: {
        gainPercent,
        rms: clamp01(liveMic?.rms ?? asrMic?.rms ?? 0),
        peak: clamp01(liveMic?.peak ?? asrMic?.peak ?? 0),
        fixed: Boolean(asrMic?.fixed),
      },
      latency: {
        ttsFirstAudioMs: finiteNumber(ttsStats?.lastFirstAudioMs, null),
        ttsRequestToFirstAudioMs: finiteNumber(ttsStats?.lastRequestToFirstAudioMs, null),
        ttsLastSpeakingMs: finiteNumber(ttsStats?.lastSpeakingMs, null),
        ackLastPlayDurationMs: finiteNumber(ackStats?.lastPlayDurationMs, null),
        ackLastFirstWriteMs: finiteNumber(ackStats?.lastFirstWriteMs, null),
        asrLastFinalMs: finiteNumber(asr?.lastFinalMs, null),
      },
      recentErrors: (context.getRecentErrors?.() ?? []).slice(-5),
      tests: {
        mic: Boolean(micTest),
        asr: Boolean(asrTest),
        wake: Boolean(wakeTest),
      },
    });
  }

  // ------------------------------------------------------------ dispatch ----

  async function handle(message, client) {
    const id = messageId(message);
    switch (message.type) {
      case 'config.get':
        await handleConfigGet(message, client);
        return;
      case 'config.set':
        await handleConfigSet(message, client);
        return;
      case 'test.mic.start':
        handleMicStart(message, client);
        return;
      case 'test.mic.stop':
        handleMicStop(message, client);
        return;
      case 'test.asr.start':
        handleAsrStart(message, client);
        return;
      case 'test.asr.stop':
        handleAsrStop(message, client);
        return;
      case 'test.wake.arm':
        handleWakeArm(message, client);
        return;
      case 'test.wake.disarm':
        handleWakeDisarm(message, client);
        return;
      case 'test.tts':
        await handleTtsTest(message, client);
        return;
      case 'home.test':
        await handleHomeTest(message, client);
        return;
      case 'service.restart': {
        const via = context.describeRestart?.() ?? 'unknown';
        reply(client, withId(id, { type: 'ack', action: 'restart', via }));
        log.info(`service.restart requested (${via})`);
        context.requestRestart?.();
        return;
      }
      case 'diagnostics':
        reply(client, await collectDiagnostics(id));
        return;
      default:
        sendError(client, id, 'unsupported', `未知设置消息：${message.type}`);
    }
  }

  return {
    handle,
    /** True while the wake self-test window is open (real wakes must stay silent). */
    isWakeTestActive: () => wakeTest !== null,
    isAnyTestActive: () => micTest !== null || asrTest !== null || wakeTest !== null,
    /** Called by the daemon when a real wake happens during a test; never acks. */
    noteRealWake() {
      if (wakeTest) {
        wakeTest.falseAlarms += 1;
        return true;
      }
      return false;
    },
    close() {
      closed = true;
      const asr = voice().asr;
      try {
        if (micTest) asr?.stopMicTest?.();
      } catch {
        /* ignore */
      }
      try {
        if (asrTest) asr?.stopAsrTest?.();
      } catch {
        /* ignore */
      }
      try {
        if (wakeTest) asr?.disarmWakeTest?.();
      } catch {
        /* ignore */
      }
      for (const test of [micTest, asrTest, wakeTest]) {
        if (test?.timer) clearTimeout(test.timer);
      }
      micTest = null;
      asrTest = null;
      wakeTest = null;
      void closed;
    },
    get micTestActive() {
      return micTest !== null;
    },
    get asrTestActive() {
      return asrTest !== null;
    },
    get wakeTestActive() {
      return wakeTest !== null;
    },
  };
}

export { CONFIG_PATH, CONFIG_DIR, MAX_RECENT_ERRORS };
