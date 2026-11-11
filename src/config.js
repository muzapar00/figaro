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
    // "none" answers directly instead of thinking first: the single biggest win
    // for spoken latency (first answer token 659ms vs 1792ms). Use "minimal" if
    // you want some deliberation back.
    reasoningEffort: 'none',
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
  // Smart home (optional): a local Home Assistant instance is the device layer;
  // the `home` tool maps spoken light commands to HA entities. Empty haUrl/haToken
  // means the tool is not registered at all, so the model never sees it.
  home: {
    haUrl: '',
    haToken: '',
    defaultRoom: '',
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
    // The user kept getting cut off mid-sentence; only give up thinking after a
    // real pause. 3000 ms is deliberate: short pauses in Chinese speech are
    // 300-800 ms, so 900 ms finalized sentences too early.
    silenceStopMs: 3000,
    maxCaptureMs: 30000,
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
    wakeGiveUpMs: 7000,
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
    // Voiceprint gate: after the keyword matches, verify that the enrolled
    // speaker said it. `figaro enroll-voice` writes ~/.config/figaro/speaker-profile.json.
    // Disabled or not enrolled => the assistant wakes exactly as before.
    speaker: {
      enabled: false,
      // CAM++ speaker-embedding model (sherpa-onnx, Apache-2.0), fetched by scripts/fetch-models.sh
      model: 'models/speaker/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
      // empty => ~/.config/figaro/speaker-profile.json
      profile: '',
      // cosine similarity threshold; measured self-similarity is ~0.85-0.95 and
      // different speakers land at ~0.2-0.45, so 0.65 leaves room for both.
      threshold: 0.65,
      // ignore wake audio quieter than this (normalized RMS)
      minRms: 0.0025,
    },
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
      // Short spoken acknowledgements, picked at random (never the same twice in
      // a row). All are punctuation-free: the TTS would turn "？" into an odd
      // rising pause.
      phrases: ['我在', '在的', '你好', '嘿', '有何贵干', '来了', '听着呢', '请讲', '久等了', '你说'],
      avoidRepeat: true,
      synthConcurrency: 3,
      // MiniMax allows 20 RPM. When pre-synthesis at startup hits the limit the
      // phrase is retried after these delays, and a limited batch gets a later
      // background pass instead of staying unavailable until a restart.
      rateLimitRetryMs: [4000, 12000],
      reviveDelayMs: 30000,
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
    // Two-stage wake verification: after the keyword spotter fires, transcribe
    // the buffer with the offline model and only wake if it really says the wake
    // word. Measured: near-homophone false wakes 2/40 -> 0/40, but every wake
    // costs ~+600ms (post-roll 300ms + inference ~200ms + first-use model load).
    // Real human speech already produced 0 false wakes, so this is opt-in.
    verifyWake: { enabled: false, timeoutMs: 1800 },
    // Bundled wake/ASR models live under the checkout's models/ directory. Set
    // modelDir to an absolute path to use a different keyword spotter bundle.
    modelDir: null,
    // After a spoken reply the assistant stays on screen this long, waiting for
    // a follow-up. 0 disables the window. Only a voice above followUpMinRms for
    // followUpMinMs re-opens the conversation, so room noise cannot do it.
    followUpWindowMs: 0,
    followUpMinRms: 0.012,
    followUpMinMs: 180,
  },
  ui: {
    socket: null, // resolved => $XDG_RUNTIME_DIR/figaro/sock
    // Overall animation scale: every part of the orb/pill/window multiplies by
    // this, so the overlay size is one setting instead of a dozen.
    scale: 1.0,
    // orb = ball while listening, pill while answering (default);
    // ball = always a ball, captions sit under it;
    // line = a thin horizontal line that reacts to the level.
    shape: 'orb',
    // auto = normal motion; off = instant state changes (no animation at all).
    motion: 'auto',
    // macOS-style window buttons in the settings window, in px.
    windowButtonSize: 16,
  },
  agent: {
    // extra system prompt lines appended to the dsh-derived prompt
    name: '费加罗',
  },
  // Local long-term memory / RAG (LightRAG, MIT, http://127.0.0.1:9621; see
  // docs/rag.md). Recall is bounded by timeoutMs and both recall/ingest degrade
  // silently when the service is down, so voice turns never depend on it.
  rag: {
    enabled: true,
    host: 'http://127.0.0.1:9621',
    apiKey: '', // '' => read LIGHTRAG_API_KEY from envFile
    envFile: '', // '' => ~/.local/share/figaro/lightrag/.env
    mode: 'mix', // mix | local | global | hybrid | naive
    timeoutMs: 1500, // recall budget (voice latency); raise for slower hosts
    autoIngest: true, // index each finished exchange in the background
  },
  sfx: {
    // Short, quiet UI sounds played next to (never over) the voice. They are
    // one-shots on the same sink as the TTS, so they never interrupt speech.
    enabled: true,
    volume: 0.35,
    events: { listenStart: true, listenEnd: true, answerDone: true, dismiss: true, error: true },
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
