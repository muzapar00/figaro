// Figaro configuration loader.
// Single source of truth for tunables shared by the daemon, voice modules and UI bridge.
// Owned by the Lead: do not change the exported shape without asking.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR =
  process.env.FIGARO_CONFIG_DIR || path.join(os.homedir(), '.config', 'figaro');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const DEFAULTS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    // Optional extra request body fields (e.g. effort level).
    requestOptions: {},
    maxToolRounds: 24,
    temperature: 0.6,
  },
  minimax: {
    baseUrl: 'https://api.minimax.cn',
    wsUrl: 'wss://api.minimax.cn/ws/v1/t2a_v2',
    model: 'speech-2.6-turbo',
    voiceId: 'male-qn-jingying',
    speed: 1.0,
    volume: 1.0,
    pitch: 0,
    sampleRate: 32000,
    format: 'pcm',
    endpointTimeoutMs: 8000,
  },
  asr: {
    // wake phrase list, matched against normalized Chinese text
    wakeWords: ['费加罗', '菲加罗', '飞加罗', 'figaro', '费加'],
    // sherpa-onnx streaming / offline model dirs (filled by model fetch script)
    kwsModelDir: 'models/kws',
    streamingModelDir: 'models/asr-stream',
    offlineModelDir: 'models/asr-offline',
    device: 'default',
    // push-to-talk / capture behaviour
    silenceStopMs: 900,
    maxCaptureMs: 15000,
    minCaptureMs: 350,
    // Push-to-talk key (XDG GlobalShortcuts portal); empty => disabled.
    // Not F5: that is refresh in every browser and IDE, and a global grab on it
    // fights the applications.
    hotkey: 'F9',
    // When > 0, the ASR waits this long for the daemon to start capture after a
    // wake (the daemon plays its acknowledgement first), then starts it anyway.
    wakeCaptureFallbackMs: 0,
    // How hard the wake word has to match. "low" trades a little hit rate for
    // far fewer false wakes; the user was being woken by ordinary conversation.
    sensitivity: 'low',
    // Minimum gap between two wakes, so a burst of similar sounds cannot
    // trigger the assistant repeatedly.
    wakeCooldownMs: 2500,
    // null = let the module calibrate the ALSA capture gain; a number pins it.
    inputGainPercent: null,
    // Waking and then saying nothing for this long exits quietly.
    wakeGiveUpMs: 5000,
    // Barge-in (talking over the assistant) needs a deliberate voice, not any
    // noise: the level has to be clearly above what the microphone hears from
    // Figaro's own speaker output, and it has to last.
    bargeIn: {
      enabled: true,
      // Absolute floor on normalized RMS (0..1).
      minRms: 0.09,
      // ...and this many times the echo level measured while TTS is playing.
      echoFactor: 2.5,
      // How long the voice has to hold above the threshold.
      minMs: 500,
    },
    longPressMs: 260,
  },
  tts: {
    enabled: true,
    // Audio output device for Figaro's voice. "" = system default sink;
    // a full sink name or a unique substring (e.g. "hdmi") also works.
    sink: "",
    // Short acknowledgement spoken right after a wake, so the user immediately
    // knows they were heard. Cached at daemon start to keep it under ~300 ms.
    ack: {
      enabled: true,
      phrases: ['我在', '在的', '请指示'],
      timeoutMs: 800,
    },
    // start speaking after this many sentences are buffered (1 => lowest latency)
    minSentencesBeforeStart: 1,
    maxBufferChars: 220,
    bargeIn: true,
  },
  interaction: {
    // Saying any of these instead of a question cancels the turn (cuts audio).
    cancelPhrases: ['取消', '算了', '别说了', '停下', '停止', '不用了', '退出'],
    // "Stand down": finish whatever is being said, then leave without waiting
    // for a follow-up.
    dismissPhrases: ['退下', '退下吧', '先退下', '你可以退下了', '可以退下了', '休息吧', '没事了', '结束吧', '关了'],
    // After a spoken reply the assistant stays on screen this long, waiting for
    // a follow-up. 0 disables the window. Only a voice above followUpMinRms for
    // followUpMinMs re-opens the conversation, so room noise cannot do it.
    followUpWindowMs: 0,
    followUpMinRms: 0.012,
    followUpMinMs: 180,
  },
  ui: {
    socket: null, // resolved => $XDG_RUNTIME_DIR/figaro/sock
  },
  agent: {
    // extra system prompt lines appended to the dsh-derived prompt
    name: '费加罗',
  },
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`cannot read ${CONFIG_PATH}: ${err.message}`);
  }
}

export function loadConfig() {
  const cfg = deepMerge(DEFAULTS, loadConfigFile());
  // Secrets may also come from the environment (preferred for CI/headless use).
  cfg.deepseek.apiKey =
    process.env.FIGARO_DEEPSEEK_API_KEY || cfg.deepseek.apiKey || process.env.DEEPSEEK_API_KEY || '';
  cfg.minimax.apiKey =
    process.env.FIGARO_MINIMAX_API_KEY || cfg.minimax.apiKey || process.env.MINIMAX_API_KEY || '';
  cfg.ui.socket =
    cfg.ui.socket ||
    process.env.FIGARO_SOCKET ||
    path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'figaro', 'sock');
  cfg.paths = {
    configDir: CONFIG_DIR,
    root: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
  };
  return cfg;
}

export default loadConfig;
