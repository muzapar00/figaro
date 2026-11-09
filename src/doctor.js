// `figaro doctor` — one-shot health check for a Figaro installation.
//
// Every known field failure gets a check here, in the same order the user
// experiences them: is the service running at all, can we talk to it, is the
// config sane (keys masked!), are the models present, does the microphone hear
// anything, will the voice come out of the right sink, is the hotkey bound, can
// the desktop load the overlay, and is the machine healthy enough.
//
// Read-only by default. `--fix` only performs safe repairs (restart services,
// unmute the sink, chmod 600 the config); everything else is printed as a
// copy-pasteable command. Secrets are masked and never printed in full.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { CONFIG_PATH, DEFAULTS, loadConfig } from './config.js';
import { createIpcClient } from './ipc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
})();

const COMMAND_TIMEOUT_MS = 5000;
const MIC_SAMPLE_MS = 1000;
const MIC_RATE = 16000;
const NOISE_RMS_WARN = 0.02;
const CLIP_PEAK_WARN = 0.9;
const LOW_GAIN_RAW = 20; // raw ALSA units of the ALC897 Capture control
const GAIN_RAW_MAX = 63;
const DISK_WARN_BYTES = 5 * 1024 * 1024 * 1024;
const GPU_WARN_PERCENT = 85;
const OVERLAY_CPU_WARN = 60;

export const STATUS_SYMBOL = Object.freeze({ ok: '✓', warn: '!', fail: '✗', info: '·', skip: '–' });
export const STATUS_ORDER = Object.freeze(['fail', 'warn', 'info', 'ok', 'skip']);

// ------------------------------------------------------------------ helpers

/** Mask a secret as `sk-…abcd`; never returns the full value. */
export function maskSecret(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) return null;
  if (text.length <= 6) return `${text.slice(0, 1)}…${text.slice(-1)}`;
  const prefix = /^[a-zA-Z]{2,4}-/.exec(text)?.[0] ?? '';
  return `${prefix}…${text.slice(-4)}`;
}

/** Resolve a command on PATH (no shell); returns the absolute path or null. */
export function findOnPath(command, env = process.env) {
  if (!command) return null;
  if (path.isAbsolute(command)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const dir of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function parseKib(text) {
  // df -kP: Filesystem 1024-blocks Used Available Capacity Mounted
  const match = /^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+/m.exec(text ?? '');
  if (!match) return null;
  return { totalKib: Number(match[1]), usedKib: Number(match[2]), freeKib: Number(match[3]) };
}

/** Parse `amixer -c 0 sget Capture` (see src/voice/asr/mic-gain.js). */
export function parseAmixerCapture(text) {
  if (!text) return null;
  const limits = /Limits:\s*Capture\s+(\d+)\s*-\s*(\d+)/.exec(text);
  const front = /Front Left:\s*Capture\s+(\d+)\s*\[(\d+)%\]/i.exec(text);
  if (!front) return null;
  const gain = Number(front[1]);
  const percent = Number(front[2]);
  const max = limits ? Number(limits[2]) : null;
  return {
    gain,
    percent,
    max,
    min: limits ? Number(limits[1]) : null,
    on: !/\[off\]/i.test(text),
    db: (() => {
      const m = /Front Left:[^\n]*?\[([-+]?\d+(?:\.\d+)?)dB\]/.exec(text);
      return m ? Number(m[1]) : null;
    })(),
  };
}

/** Parse `pactl list short sinks` into [{name}] preserving order. */
export function parsePactlSinks(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t').map((part) => part.trim()))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({ index: parts[0], name: parts[1] }));
}

/** Resolve a configured sink the way the TTS module does: exact first, then substring. */
export function resolveSink(configured, sinks, defaultSink) {
  const wanted = String(configured ?? '').trim();
  if (wanted.length === 0) {
    return { name: defaultSink || null, source: defaultSink ? 'default' : null };
  }
  const exact = sinks.find((sink) => sink.name === wanted);
  if (exact) return { name: exact.name, source: 'config' };
  const partial = sinks.find((sink) => sink.name.includes(wanted));
  if (partial) return { name: partial.name, source: 'config-substring' };
  return { name: null, source: null };
}

/** Parse `pactl get-sink-mute` (localised: "Mute: 否" / "Mute: no" / "Mute: yes"). */
export function parsePactlMute(text) {
  const raw = String(text ?? '');
  const match = /Mute:\s*(\S+)/i.exec(raw);
  if (!match) return null;
  const token = match[1].toLowerCase();
  if (['yes', 'y', 'true', '1', '是', '开启', 'on'].includes(token)) return true;
  if (['no', 'n', 'false', '0', '否', '关闭', 'off'].includes(token)) return false;
  return null;
}

/** Read `figaro-talk=` from the KDE global shortcuts file for [figaro]. */
export function parseKdeShortcut(text, section = 'figaro', key = 'figaro-talk') {
  const lines = String(text ?? '').split('\n');
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inSection = trimmed.slice(1, -1) === section;
      continue;
    }
    if (!inSection) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    if (trimmed.slice(0, index).trim() !== key) continue;
    return trimmed.slice(index + 1).split(',')[0].trim();
  }
  return null;
}

function normalizeAccelerator(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/CTRL|CONTROL/g, 'CTRL')
    .replace(/\+F(\d+)$/, '+F$1');
}

function maskText(text) {
  // Defensive: if a secret ever ends up in a command output, mask anything that
  // looks like a long API key. The config paths never do, but errors might echo.
  return String(text ?? '')
    .replace(/\b(sk-[A-Za-z0-9_-]{6,})/g, (match) => maskSecret(match))
    .slice(0, 600);
}

function createRunner(env) {
  return function run(command, args, { timeout = COMMAND_TIMEOUT_MS, encoding = 'utf8' } = {}) {
    const started = performance.now();
    return new Promise((resolve) => {
      let child;
      try {
        child = execFile(command, args, { timeout, env, maxBuffer: 8 * 1024 * 1024, encoding }, (err, stdout, stderr) => {
          resolve({
            ok: !err,
            code: err?.code ?? 0,
            stdout: stdout ?? (encoding === 'buffer' ? Buffer.alloc(0) : ''),
            stderr: stderr ?? (err ? err.message : ''),
            ms: Math.round(performance.now() - started),
          });
        });
      } catch (err) {
        resolve({ ok: false, code: 'ENOENT', stdout: '', stderr: err.message, ms: 0 });
        return;
      }
      child?.on?.('error', () => {});
    });
  };
}

/** Record ~1s of the default source and return level statistics. */
function sampleMicrophone(run, env, source) {
  return new Promise((resolve) => {
    const started = performance.now();
    const device = source || '@DEFAULT_SOURCE@';
    let child;
    try {
      child = spawn('parec', [
        `--device=${device}`,
        '--format=s16le',
        `--rate=${MIC_RATE}`,
        '--channels=1',
        '--raw',
        '--latency-msec=20',
        '--process-time-msec=20',
      ], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      resolve({ ok: false, error: err?.message || String(err), rms: 0, peak: 0, bytes: 0, ms: 0 });
      return;
    }
    let bytes = 0;
    let sumSq = 0;
    let samples = 0;
    let peak = 0;
    let spawnError = null;
    let settled = false;
    const pending = [];
    const finish = (info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      for (const buf of pending) {
        for (let i = 0; i + 1 < buf.length; i += 2) {
          const value = buf.readInt16LE(i) / 32768;
          sumSq += value * value;
          samples += 1;
          peak = Math.max(peak, Math.abs(value));
        }
      }
      resolve({
        ok: !spawnError && bytes > 0,
        error: spawnError ? spawnError.message : bytes > 0 ? null : 'parec produced no audio',
        rms: samples > 0 ? Math.sqrt(sumSq / samples) : 0,
        peak,
        bytes,
        rate: MIC_RATE,
        ms: Math.round(performance.now() - started),
        ...info,
      });
    };
    const timer = setTimeout(() => finish(), MIC_SAMPLE_MS);
    child.on('error', (err) => {
      spawnError = err;
      finish();
    });
    child.stdout.on('data', (buf) => {
      bytes += buf.length;
      if (pending.reduce((sum, b) => sum + b.length, 0) < 2 * 1024 * 1024) pending.push(Buffer.from(buf));
    });
    child.on('close', () => finish());
  });
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function findFirst(directory, patterns) {
  let files;
  try {
    files = fs.readdirSync(directory);
  } catch {
    return null;
  }
  for (const pattern of patterns) {
    const hit = files.find((file) => pattern.test(file));
    if (hit) return path.join(directory, hit);
  }
  return null;
}

function resolveConfigModelDir(config, key, repoRoot) {
  const value = config?.asr?.[key] ?? DEFAULTS.asr[key];
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

// ---------------------------------------------------------------- collection

/**
 * @param {object} options
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {boolean} [options.net] run the (opt-in) network checks
 * @returns {Promise<object>} report
 */
export async function collectDoctorReport({ env = process.env, net = false } = {}) {
  const run = createRunner(env);
  const home = env.HOME || os.homedir();
  const repoRoot = env.FIGARO_DOCTOR_REPO_ROOT ? path.resolve(env.FIGARO_DOCTOR_REPO_ROOT) : REPO_ROOT;
  const configPath = env.FIGARO_CONFIG_PATH || CONFIG_PATH;
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const xdgRuntime = env.XDG_RUNTIME_DIR || path.join('/run/user', String(typeof process.getuid === 'function' ? process.getuid() : 1000));
  const groups = [];

  const group = (id, title) => {
    const entry = { id, title, checks: [] };
    groups.push(entry);
    return entry;
  };
  const add = (target, status, id, label, detail = '', extra = {}) => {
    target.checks.push({ id, status, label, detail, ...extra });
  };
  const commandFix = (command, reason = '') => ({ command, reason });
  const actionFix = (kind, data = {}, command, reason = '') => ({ kind, data, command, reason });

  let config = null;
  let configError = null;
  try {
    config = loadConfig();
  } catch (err) {
    configError = err;
    config = { ...DEFAULTS };
  }

  // ------------------------------------------------------------ 1. services
  const services = group('service', '服务');
  const figaroUnit = await run('systemctl', ['--user', 'is-active', 'figaro']);
  const uiUnit = await run('systemctl', ['--user', 'is-active', 'figaro-ui']);
  const figaroPidResult = await run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', 'figaro']);
  const uiPidResult = await run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', 'figaro-ui']);
  const figaroActive = figaroUnit.stdout.trim() === 'active';
  const uiActive = uiUnit.stdout.trim() === 'active';
  const figaroPid = Number(String(figaroPidResult.stdout ?? '').trim()) || 0;
  const uiPid = Number(String(uiPidResult.stdout ?? '').trim()) || 0;

  if (figaroActive && figaroPid > 0) {
    add(services, 'ok', 'service.daemon', `守护进程 figaro: active（PID ${figaroPid}）`);
  } else {
    const status = figaroUnit.stdout.trim() || (figaroUnit.ok ? 'inactive' : '未安装/不可用');
    add(services, 'fail', 'service.daemon', `守护进程 figaro: ${status}`, '唤醒/对话/朗读都靠它', {
      fix: actionFix('restart-daemon', {}, 'systemctl --user restart figaro', '守护进程未运行'),
    });
  }
  if (uiActive && uiPid > 0) {
    add(services, 'ok', 'service.overlay', `桌面 overlay figaro-ui: active（PID ${uiPid}）`);
  } else {
    const status = uiUnit.stdout.trim() || (uiUnit.ok ? 'inactive' : '未安装/不可用');
    add(services, 'warn', 'service.overlay', `桌面 overlay figaro-ui: ${status}`, '球体/字幕不会显示，语音仍可用', {
      fix: actionFix('restart-ui', {}, 'systemctl --user restart figaro-ui', '桌面 overlay 未运行'),
    });
  }
  const daemonProcs = (await run('pgrep', ['-af', 'bin/figaro daemon'])).stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes('figaro doctor'));
  if (daemonProcs.length <= 1) {
    add(services, 'ok', 'service.singleton', `守护进程单实例: ${daemonProcs.length === 1 ? '1 个进程' : '无残留进程（服务未运行）'}`);
  } else {
    add(services, 'fail', 'service.singleton', `发现 ${daemonProcs.length} 个 daemon 进程`, '残留实例会抢占 socket，导致新实例启动失败', {
      fix: commandFix('systemctl --user stop figaro; pkill -f "bin/figaro daemon"; systemctl --user start figaro', '清理残留 daemon 进程'),
    });
  }
  const overlayProcs = (await run('pgrep', ['-af', 'qs .*-c figaro'])).stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      const commandLine = line.replace(/^\d+\s+/, '');
      const executable = commandLine.split(/\s+/)[0] ?? '';
      // Only a real qs process with exactly `-c figaro` (not figaro-settings, and
      // not a shell whose command string happens to contain the pattern).
      return /(^|\/)qs$/.test(executable) && /-c\s+figaro(?:\s|$)/.test(commandLine) && !/figaro-settings/.test(commandLine);
    });
  // systemd also tells us whether an overlay process exists; use it as a fallback
  // so a slightly different qs command line does not produce a false "0 个进程".
  const overlayCount = Math.max(overlayProcs.length, uiPid > 0 ? 1 : 0);
  if (overlayCount > 1) {
    add(services, 'warn', 'service.overlay-singleton', `发现 ${overlayCount} 个 overlay 实例`, '会出现 "An instance of this configuration is already running" 或残留窗口', {
      fix: commandFix('pkill -f "qs .*-c figaro"; systemctl --user restart figaro-ui', '清理残留 overlay 实例'),
    });
  } else {
    add(services, 'ok', 'service.overlay-singleton', `overlay 单实例: ${overlayCount} 个进程`);
  }

  // ---------------------------------------------------------------- 2. IPC
  const ipc = group('ipc', 'IPC 通信');
  const socketPath = env.FIGARO_SOCKET || config?.ui?.socket || path.join(xdgRuntime, 'figaro', 'sock');
  const socketStat = statSafe(socketPath);
  if (!socketStat || !socketStat.isSocket()) {
    add(ipc, 'fail', 'ipc.socket', `socket 不存在: ${socketPath}`, 'CLI/overlay/设置面板都连不上 daemon', {
      fix: actionFix('restart-daemon', {}, 'systemctl --user restart figaro', 'socket 不存在'),
    });
  } else {
    add(ipc, 'ok', 'ipc.socket', `socket 存在: ${socketPath}`);
    const handshake = await new Promise((resolve) => {
      let settled = false;
      let state = null;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          client.close();
        } catch {
          /* ignore */
        }
        resolve({ ...result, state });
      };
      const client = createIpcClient({
        socketPath,
        onMessage: (message) => {
          if (message?.type === 'state' && state === null) state = message.state;
          if (message?.type === 'pong') finish({ ok: true });
        },
      });
      timer = setTimeout(() => finish({ ok: false, error: '握手超时（1500ms）' }), 1500);
      try {
        client.connect().then(() => {
          client.send({ type: 'subscribe' });
          client.send({ type: 'ping' });
        }).catch((err) => finish({ ok: false, error: err?.message || String(err) }));
      } catch (err) {
        finish({ ok: false, error: err?.message || String(err) });
      }
    });
    if (!handshake.ok) {
      add(ipc, 'fail', 'ipc.handshake', `daemon 握手失败: ${handshake.error}`, 'socket 在但 daemon 无响应（可能卡死/正在重启）', {
        fix: actionFix('restart-daemon', {}, 'systemctl --user restart figaro', 'IPC 握手失败'),
      });
    } else {
      add(ipc, 'ok', 'ipc.handshake', `daemon 握手正常${handshake.state ? `（状态 ${handshake.state}）` : ''}`);
    }
  }
  // daemon log: recent errors
  const logPath = path.join(path.dirname(socketPath), 'daemon.log');
  const logText = readFileSafe(logPath);
  if (logText) {
    const errorLines = logText.split('\n').filter((line) => /\[error\]|错误|失败/.test(line)).slice(-3);
    if (errorLines.length > 0) {
      add(ipc, 'warn', 'ipc.log', `daemon.log 最近有 ${errorLines.length} 条错误`, maskText(errorLines.at(-1)), {
        fix: commandFix('journalctl --user -u figaro -n 100 --no-pager', '查看 daemon 日志'),
      });
    } else {
      add(ipc, 'ok', 'ipc.log', `daemon.log 无最近错误`);
    }
  }

  // ------------------------------------------------------------- 3. config
  const configGroup = group('config', '配置与密钥');
  const configStat = statSafe(configPath);
  const rawConfigText = readFileSafe(configPath);
  let rawConfig = null;
  try {
    rawConfig = rawConfigText ? JSON.parse(rawConfigText) : null;
  } catch (err) {
    rawConfig = null;
    add(configGroup, 'fail', 'config.parse', `config.json 无法解析: ${err.message}`, 'daemon 启动会失败', {
      fix: commandFix(`vi ${configPath}`, '修复 JSON 语法'),
    });
  }
  if (!configStat) {
    add(configGroup, 'fail', 'config.file', `配置文件不存在: ${configPath}`, '没有 key/语音设置，daemon 无法工作', {
      fix: commandFix(`cp ${path.join(repoRoot, 'config', 'config.example.json')} ${configPath} && chmod 600 ${configPath}`, '安装配置模板'),
    });
  } else if (rawConfig) {
    add(configGroup, 'ok', 'config.file', `配置文件可解析: ${configPath}`);
    const mode = configStat.mode & 0o777;
    if (mode !== 0o600) {
      add(configGroup, 'warn', 'config.permissions', `配置文件权限 ${mode.toString(8)}（应为 600）`, '密钥可能被其他用户读取', {
        fix: actionFix('chmod-config', {}, `chmod 600 ${configPath}`, '配置文件权限不是 600'),
      });
    } else {
      add(configGroup, 'ok', 'config.permissions', '配置文件权限 600');
    }
  }
  const deepseekKey = config?.deepseek?.apiKey || env.FIGARO_DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || '';
  const minimaxKey = config?.minimax?.apiKey || env.FIGARO_MINIMAX_API_KEY || env.MINIMAX_API_KEY || '';
  if (deepseekKey) {
    add(configGroup, 'ok', 'config.deepseek-key', `DeepSeek key: ${maskSecret(deepseekKey)}`);
  } else {
    add(configGroup, 'fail', 'config.deepseek-key', 'DeepSeek key: 未配置', '大脑不可用（ask/语音问答都会失败）', {
      fix: commandFix(`$EDITOR ${configPath}   # 填写 deepseek.apiKey`, '填写 DeepSeek key'),
    });
  }
  if (minimaxKey) {
    add(configGroup, 'ok', 'config.minimax-key', `MiniMax key: ${maskSecret(minimaxKey)}`);
  } else {
    add(configGroup, 'fail', 'config.minimax-key', 'MiniMax key: 未配置', '嗓子不可用（唤醒应答/朗读失败）', {
      fix: commandFix(`$EDITOR ${configPath}   # 填写 minimax.apiKey`, '填写 MiniMax key'),
    });
  }
  const model = config?.deepseek?.model;
  const voiceId = config?.minimax?.voiceId;
  if (model && voiceId) {
    add(configGroup, 'info', 'config.tunables', `模型: ${model} · 音色: ${voiceId}`);
  } else {
    add(configGroup, 'warn', 'config.tunables', `模型/音色配置不完整（model=${model ?? '?'} voiceId=${voiceId ?? '?'}）`);
  }

  // -------------------------------------------------------------- 4. models
  const models = group('models', '本地模型');
  const kwsDir = resolveConfigModelDir(config, 'kwsModelDir', repoRoot);
  const offlineDir = resolveConfigModelDir(config, 'offlineModelDir', repoRoot);
  const streamDir = resolveConfigModelDir(config, 'streamingModelDir', repoRoot);
  const vadDir = path.join(path.dirname(kwsDir ?? path.join(repoRoot, 'models', 'kws')), 'vad');
  const kwsFiles = {
    encoder: findFirst(kwsDir, [/^encoder.*\.onnx$/]),
    decoder: findFirst(kwsDir, [/^decoder.*\.onnx$/]),
    joiner: findFirst(kwsDir, [/^joiner.*\.onnx$/]),
    tokens: kwsDir && fs.existsSync(path.join(kwsDir, 'tokens.txt')) ? path.join(kwsDir, 'tokens.txt') : null,
    phones: kwsDir && fs.existsSync(path.join(kwsDir, 'en.phone')) ? path.join(kwsDir, 'en.phone') : null,
  };
  const missingKws = Object.entries(kwsFiles).filter(([, value]) => !value).map(([key]) => key);
  if (missingKws.length === 0) {
    const bilingual = Boolean(kwsFiles.phones);
    add(models, 'ok', 'models.kws', `唤醒词模型: 完整（${bilingual ? '中英双语 zh-en' : 'legacy 中文'}）`, kwsDir);
    if (!bilingual) {
      add(models, 'warn', 'models.kws-bilingual', 'KWS 是 legacy 中文模型', '「figaro」英文唤醒不可用；建议更新为 zh-en 双语模型', {
        fix: commandFix(`cd ${repoRoot} && bash scripts/fetch-models.sh --force --only=kws`, '更新为 zh-en 双语 KWS'),
      });
    }
  } else {
    add(models, 'fail', 'models.kws', `唤醒词模型不完整: 缺 ${missingKws.join('/')}`, kwsDir ?? '(未配置)', {
      fix: commandFix(`cd ${repoRoot} && bash scripts/fetch-models.sh --only=kws`, '下载唤醒词模型'),
    });
  }
  const offlineModel = findFirst(offlineDir, [/^(model|paraformer|sensevoice).*\.onnx$/, /\.onnx$/]);
  const offlineTokens = offlineDir && fs.existsSync(path.join(offlineDir, 'tokens.txt'));
  if (offlineModel && offlineTokens) {
    add(models, 'ok', 'models.offline', `离线识别模型: 完整（${path.basename(offlineModel)}）`, offlineDir);
  } else {
    add(models, 'fail', 'models.offline', '离线识别模型缺失', offlineDir ?? '(未配置)', {
      fix: commandFix(`cd ${repoRoot} && bash scripts/fetch-models.sh --only=asr`, '下载离线 ASR 模型'),
    });
  }
  const streamOk = findFirst(streamDir, [/^encoder.*\.onnx$/]) && findFirst(streamDir, [/^decoder.*\.onnx$/]) && findFirst(streamDir, [/^joiner.*\.onnx$/]) && streamDir && fs.existsSync(path.join(streamDir, 'tokens.txt'));
  if (streamOk) {
    add(models, 'ok', 'models.streaming', '流式识别模型: 完整（实时 partial）');
  } else {
    add(models, 'warn', 'models.streaming', '流式识别模型缺失', '没有实时字幕，只影响 partial 体验', {
      fix: commandFix(`cd ${repoRoot} && bash scripts/fetch-models.sh --only=asr`, '下载流式 ASR 模型'),
    });
  }
  if (vadDir && fs.existsSync(path.join(vadDir, 'silero_vad.onnx'))) {
    add(models, 'ok', 'models.vad', 'VAD 模型: 完整（silero_vad.onnx）');
  } else {
    add(models, 'warn', 'models.vad', 'VAD 模型缺失', '断句/静音检测会退化', {
      fix: commandFix(`cd ${repoRoot} && bash scripts/fetch-models.sh --only=vad`, '下载 VAD 模型'),
    });
  }
  add(models, 'info', 'models.check', '模型自检命令: bash scripts/fetch-models.sh --check');

  // ------------------------------------------------------------ 5. microphone
  const mic = group('microphone', '麦克风');
  const defaultSource = (await run('pactl', ['get-default-source'])).stdout.trim();
  if (defaultSource) add(mic, 'info', 'mic.source', `默认输入: ${defaultSource}`);
  const amixer = await run('amixer', ['-c', '0', 'sget', 'Capture']);
  const capture = amixer.ok ? parseAmixerCapture(amixer.stdout) : null;
  if (capture) {
    const rawScale = capture.max && capture.max > 0 ? GAIN_RAW_MAX / capture.max : 1;
    const rawEquivalent = Math.round(capture.gain * rawScale);
    add(mic, 'info', 'mic.gain', `ALSA Capture: raw ${capture.gain}${capture.max ? `/${capture.max}` : ''}（${capture.percent}%${capture.db === null ? '' : `, ${capture.db}dB`}${capture.max && capture.max > GAIN_RAW_MAX ? `，≈raw ${rawEquivalent}/63` : ''}）`);
    if (!capture.on) {
      add(mic, 'fail', 'mic.switch', 'Capture 开关是关闭的', '麦克风被静音，唤醒词收不到', {
        fix: commandFix('amixer -c 0 sset Capture cap', '打开 Capture 开关'),
      });
    } else if (rawEquivalent < LOW_GAIN_RAW) {
      const setCommand = capture.max && capture.max > GAIN_RAW_MAX
        ? 'amixer -c 0 sset Capture 72%'
        : 'amixer -c 0 sset Capture 45';
      add(mic, 'warn', 'mic.gain-low', `采集增益偏低（≈raw ${rawEquivalent}/${GAIN_RAW_MAX}）`, '唤醒率会明显下降（自动校准过低的已知故障）', {
        fix: commandFix(setCommand, '把采集增益调回可用区间'),
      });
    } else if (capture.max && capture.gain >= capture.max) {
      add(mic, 'warn', 'mic.gain-high', '采集增益已拉满', '真人语音容易削波，唤醒/识别反而变差', {
        fix: commandFix('amixer -c 0 sset Capture 45', '降低采集增益'),
      });
    } else {
      add(mic, 'ok', 'mic.gain-ok', '采集增益在可用区间');
    }
    const configuredGain = config?.asr?.inputGainPercent;
    if (configuredGain !== null && configuredGain !== undefined) {
      const expected = Number(configuredGain);
      if (Number.isFinite(expected)) {
        const expectedRaw = Math.round(expected * rawScale);
        if (Math.abs(expectedRaw - capture.gain) <= Math.max(2, Math.round(3 * rawScale))) {
          add(mic, 'ok', 'mic.gain-config', `inputGainPercent=${expected} 与实际增益一致`);
        } else {
          add(mic, 'warn', 'mic.gain-config', `inputGainPercent=${expected} 与实际 raw ${capture.gain} 不一致`, '设置面板里改的增益没有生效或被人为改过', {
            fix: commandFix('figaro settings   # 麦克风 → 增益；或把 asr.inputGainPercent 设为 null 恢复自动校准', '同步固定增益'),
          });
        }
      }
    }
  } else {
    add(mic, 'warn', 'mic.gain', 'amixer 不可用，跳过 ALSA 增益检查', maskText(amixer.stderr), {
      fix: commandFix('amixer -c 0 sget Capture', '手动检查采集增益'),
    });
  }
  const sample = await sampleMicrophone(run, env, defaultSource || null);
  if (!sample.ok) {
    add(mic, 'fail', 'mic.parec', `无法从麦克风取流: ${sample.error}`, '唤醒/语音输入不可用', {
      fix: commandFix('parec --device=@DEFAULT_SOURCE@ --format=s16le --rate=16000 --channels=1 --raw | head -c 32000 > /dev/null', '验证麦克风采集'),
    });
  } else {
    add(mic, 'info', 'mic.parec', `parec 取流正常（${(sample.bytes / 2 / 16000).toFixed(2)}s，${sample.ms}ms）`);
    if (sample.rms > NOISE_RMS_WARN) {
      add(mic, 'warn', 'mic.noise', `底噪偏高: RMS ${sample.rms.toFixed(3)}（阈值 ${NOISE_RMS_WARN}）`, '底噪大会降低唤醒率/识别率', {
        fix: commandFix('figaro settings   # 麦克风 → 环境音/增益；或检查是否有风扇/音乐声', '降低底噪'),
      });
    } else {
      add(mic, 'ok', 'mic.level', `麦克风电平正常: RMS ${sample.rms.toFixed(3)} · 峰值 ${sample.peak.toFixed(3)}`);
    }
    if (sample.peak >= CLIP_PEAK_WARN) {
      add(mic, 'warn', 'mic.clip', `采集出现削波（峰值 ${sample.peak.toFixed(2)}）`, '增益过高或离麦克风太近', {
        fix: commandFix('amixer -c 0 sset Capture 38', '降低采集增益'),
      });
    }
  }

  // ------------------------------------------------------------ 6. audio out
  const audio = group('audio', '音频出口');
  const sinksResult = await run('pactl', ['list', 'short', 'sinks']);
  const sinks = parsePactlSinks(sinksResult.stdout);
  const defaultSink = (await run('pactl', ['get-default-sink'])).stdout.trim();
  if (!sinksResult.ok || sinks.length === 0) {
    add(audio, 'fail', 'audio.sinks', 'pactl 列不出音频输出设备', maskText(sinksResult.stderr), {
      fix: commandFix('pactl list short sinks', '检查 PipeWire/PulseAudio'),
    });
  } else {
    add(audio, 'info', 'audio.default', `默认输出: ${defaultSink || '(未知)'} · 共 ${sinks.length} 个 sink`);
    const configured = config?.tts?.sink ?? '';
    const resolved = resolveSink(configured, sinks, defaultSink);
    if (!resolved.name) {
      add(audio, 'fail', 'audio.sink', `tts.sink="${configured}" 不存在`, `可用: ${sinks.map((sink) => sink.name).join(', ')}`, {
        fix: commandFix('figaro settings   # 语音 → 输出设备；或修改 config.json 的 tts.sink', '选择存在的输出设备'),
      });
    } else {
      const how = resolved.source === 'default' ? '默认 sink' : resolved.source === 'config-substring' ? '按子串匹配' : 'tts.sink';
      add(audio, 'ok', 'audio.sink', `输出设备: ${resolved.name}（${how}）`);
      const muteResult = await run('pactl', ['get-sink-mute', resolved.name]);
      const muted = parsePactlMute(muteResult.stdout);
      if (muted === true) {
        add(audio, 'warn', 'audio.mute', '输出设备被静音', 'Figaro 会“说话但没声音”', {
          fix: actionFix('unmute-sink', { sink: resolved.name }, `pactl set-sink-mute ${resolved.name} 0`, '输出设备被静音'),
        });
      } else if (muted === false) {
        add(audio, 'ok', 'audio.mute', '输出设备未静音');
      }
      const volumeResult = await run('pactl', ['get-sink-volume', resolved.name]);
      const volume = /(\d+)%/.exec(volumeResult.stdout);
      if (volume) {
        const percent = Number(volume[1]);
        if (percent <= 0) {
          add(audio, 'warn', 'audio.volume', '输出音量是 0%', '会静悄悄说话', {
            fix: commandFix(`pactl set-sink-volume ${resolved.name} 50%`, '调高输出音量'),
          });
        } else {
          add(audio, 'ok', 'audio.volume', `输出音量 ${percent}%`);
        }
      }
    }
  }
  const pwCat = findOnPath('pw-cat', env);
  if (pwCat) {
    add(audio, 'ok', 'audio.player', `播放器: pw-cat（${pwCat}）`);
  } else {
    add(audio, 'fail', 'audio.player', '找不到 pw-cat（PipeWire 工具缺失）', 'TTS 无法播放', {
      fix: commandFix('sudo apt install pipewire-audio   # 或确认 /usr/bin/pw-cat 在 PATH 里', '安装 PipeWire 客户端工具'),
    });
  }

  // --------------------------------------------------------- 7. connectivity
  const netGroup = group('network', 'TTS / LLM 连通性');
  if (!net) {
    add(netGroup, 'skip', 'net.skipped', '未联网检测（加 --net 做真实请求）', '默认只检查 key 是否配置');
    add(netGroup, deepseekKey ? 'ok' : 'fail', 'net.deepseek-key', `DeepSeek key: ${deepseekKey ? '已配置' : '未配置'}`);
    add(netGroup, minimaxKey ? 'ok' : 'fail', 'net.minimax-key', `MiniMax key: ${minimaxKey ? '已配置' : '未配置'}`);
  } else {
    if (deepseekKey) {
      const started = performance.now();
      try {
        const response = await fetch(`${String(config?.deepseek?.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')}/models`, {
          headers: { Authorization: `Bearer ${deepseekKey}` },
          signal: AbortSignal.timeout(8000),
        });
        const ms = Math.round(performance.now() - started);
        if (response.ok) {
          add(netGroup, 'ok', 'net.deepseek', `DeepSeek 连通（/models ${response.status}，${ms}ms）`);
        } else {
          add(netGroup, 'fail', 'net.deepseek', `DeepSeek 请求失败 HTTP ${response.status}（${ms}ms）`, maskText(await response.text().catch(() => '')), {
            fix: commandFix(`curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $DEEPSEEK_KEY" ${config?.deepseek?.baseUrl ?? 'https://api.deepseek.com'}/models`, '检查 key/网络/余额'),
          });
        }
      } catch (err) {
        add(netGroup, 'fail', 'net.deepseek', `DeepSeek 连不上: ${maskText(err?.message || err)}`, '', {
          fix: commandFix('ping -c1 api.deepseek.com', '检查网络'),
        });
      }
    } else {
      add(netGroup, 'fail', 'net.deepseek', 'DeepSeek key: 未配置');
    }
    if (minimaxKey) {
      try {
        const { createTts } = await import('./voice/tts/index.js');
        const tts = createTts({ config });
        const started = performance.now();
        const result = await tts.synthesize('你好');
        const ms = Math.round(performance.now() - started);
        try {
          tts.close?.();
        } catch {
          /* ignore */
        }
        if (result?.pcm?.length) {
          add(netGroup, 'ok', 'net.minimax', `MiniMax 合成连通（"你好" ${result.pcm.length} bytes，${ms}ms）`);
        } else {
          add(netGroup, 'fail', 'net.minimax', 'MiniMax 合成没有返回音频', 'key 可能无效或额度用尽', {
            fix: commandFix('figaro say "测试"', '单独试听排查'),
          });
        }
      } catch (err) {
        add(netGroup, 'fail', 'net.minimax', `MiniMax 合成失败: ${maskText(err?.message || err)}`, '', {
          fix: commandFix('figaro say "测试"', '单独试听排查'),
        });
      }
    } else {
      add(netGroup, 'fail', 'net.minimax', 'MiniMax key: 未配置');
    }
  }

  // -------------------------------------------------------------- 8. hotkey
  const hotkey = group('hotkey', '热键');
  const expectedHotkey = String(config?.asr?.hotkey ?? '').trim();
  if (!expectedHotkey) {
    add(hotkey, 'warn', 'hotkey.config', '热键已禁用（asr.hotkey 为空）', '只能靠语音唤醒/设置面板');
  } else {
    add(hotkey, 'info', 'hotkey.config', `期望热键: ${expectedHotkey}（长按唤醒；短按取消）`);
    const shortcutsPath = path.join(xdgConfig, 'kglobalshortcutsrc');
    const shortcutsText = readFileSafe(shortcutsPath);
    if (shortcutsText === null) {
      add(hotkey, 'warn', 'hotkey.bound', `未找到 ${shortcutsPath}`, '热键还没通过 portal 绑定', {
        fix: commandFix('systemctl --user restart figaro   # 然后点一次 KDE 授权弹窗', '重新触发 portal 授权'),
      });
    } else {
      const bound = parseKdeShortcut(shortcutsText);
      if (bound && normalizeAccelerator(bound) === normalizeAccelerator(expectedHotkey)) {
        add(hotkey, 'ok', 'hotkey.bound', `热键已绑定: ${bound}`);
      } else if (bound) {
        add(hotkey, 'warn', 'hotkey.bound', `热键实际是 "${bound}"，期望 "${expectedHotkey}"`, '长按唤醒/短按取消可能不按预期工作', {
          fix: commandFix(`figaro settings   # 唤醒 → 热键重绑；或系统设置 → 快捷键 → Figaro`, '重绑热键'),
        });
      } else {
        add(hotkey, 'warn', 'hotkey.bound', `kglobalshortcutsrc 中没有 [figaro] figaro-talk`, 'portal 绑定未完成（或还没授权）', {
          fix: commandFix('systemctl --user restart figaro   # 然后点一次 KDE 授权弹窗', '重新触发 portal 授权'),
        });
      }
    }
  }

  // ------------------------------------------------------------- 9. desktop
  const desktop = group('desktop', '桌面能力');
  const kosShape = path.join(xdgConfig, 'quickshell', 'kos', 'Kos', 'SurfaceShape');
  if (fs.existsSync(kosShape)) {
    add(desktop, 'ok', 'desktop.kos', `KWin 液态玻璃插件: 存在（${kosShape}）`);
  } else {
    add(desktop, 'fail', 'desktop.kos', `KWin 液态玻璃插件缺失: ${kosShape}`, 'overlay 的 QML 会加载失败（球体/背景不显示）', {
      fix: commandFix(`ls ${path.join(xdgConfig, 'quickshell', 'kos', 'Kos')}   # 需要 KOS 的 SurfaceShape 组件；重装 KOS/Quickshell 配置`, '恢复 KOS 的 SurfaceShape'),
    });
  }
  const installedUiUnit = path.join(home, '.config', 'systemd', 'user', 'figaro-ui.service');
  const uiUnitPath = fs.existsSync(installedUiUnit) ? installedUiUnit : path.join(repoRoot, 'systemd', 'figaro-ui.service');
  const uiUnitText = readFileSafe(uiUnitPath);
  if (uiUnitText === null) {
    add(desktop, 'warn', 'desktop.qmlpath', `找不到 figaro-ui.service（${uiUnitPath}）`, 'overlay 未安装', {
      fix: commandFix(`cp ${path.join(repoRoot, 'systemd', 'figaro-ui.service')} ${installedUiUnit} && systemctl --user daemon-reload`, '安装 overlay unit'),
    });
  } else {
    const match = /^\s*Environment=.*QML2_IMPORT_PATH=(\S+)/m.exec(uiUnitText);
    const qmlPath = match?.[1] ?? null;
    if (qmlPath && qmlPath.includes('quickshell/kos')) {
      add(desktop, 'ok', 'desktop.qmlpath', `QML2_IMPORT_PATH 已配置: ${qmlPath}`);
    } else {
      add(desktop, 'fail', 'desktop.qmlpath', 'figaro-ui unit 缺少 QML2_IMPORT_PATH', 'Kos.SurfaceShape 导入失败 → QML 加载错误', {
        fix: commandFix(`# 在 ${uiUnitPath} 的 [Service] 里加：Environment=QML2_IMPORT_PATH=%h/.config/quickshell/kos 然后 systemctl --user daemon-reload && systemctl --user restart figaro-ui`, '补上 QML2_IMPORT_PATH'),
      });
    }
    const execMatch = /^\s*ExecStart=(\S+)/m.exec(uiUnitText);
    const execPath = execMatch?.[1]?.replace(/^%h/, home) ?? '';
    if (execPath && findOnPath(execPath, env)) {
      add(desktop, 'ok', 'desktop.qs', `Quickshell: ${execPath}`);
    } else if (findOnPath('qs', env)) {
      add(desktop, 'ok', 'desktop.qs', 'Quickshell: qs 在 PATH 中');
    } else {
      add(desktop, 'fail', 'desktop.qs', '找不到 Quickshell（qs）', 'overlay 起不来', {
        fix: commandFix(`ls ${path.join(home, '.local', 'bin', 'qs')}`, '安装 Quickshell'),
      });
    }
  }
  for (const tool of ['spectacle', 'ffmpeg']) {
    const found = findOnPath(tool, env);
    if (found) add(desktop, 'ok', `desktop.${tool}`, `截屏依赖: ${tool}（${found}）`);
    else add(desktop, 'warn', `desktop.${tool}`, `缺少 ${tool}`, '截图/录屏相关能力不可用', {
      fix: commandFix(`sudo apt install ${tool}`, `安装 ${tool}`),
    });
  }

  // ------------------------------------------------------------ 10. resources
  const resources = group('resources', '资源占用');
  const gpuResult = await run('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits']);
  if (gpuResult.ok && gpuResult.stdout.trim()) {
    const [usedText, totalText] = gpuResult.stdout.trim().split('\n')[0].split(',').map((part) => part.trim());
    const used = Number(usedText);
    const total = Number(totalText);
    if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
      const percent = Math.round((used / total) * 100);
      if (percent > GPU_WARN_PERCENT) {
        add(resources, 'warn', 'resources.gpu', `显存占用 ${percent}%（${used}/${total} MiB）`, '显存接近占满会影响 GPU 渲染（overlay 可能掉帧/黑屏）', {
          fix: commandFix('nvidia-smi', '看哪些进程占用显存'),
        });
      } else {
        add(resources, 'ok', 'resources.gpu', `显存占用 ${percent}%（${used}/${total} MiB）`);
      }
    }
  } else {
    add(resources, 'info', 'resources.gpu', '显存: 未检测（没有 nvidia-smi 或不是 N 卡）');
  }
  const overlayCpuResult = await run('ps', ['-o', '%cpu=', '-p', String(uiPid || 0)]);
  const overlayCpu = Number(String(overlayCpuResult.stdout ?? '').trim());
  if (uiPid > 0 && Number.isFinite(overlayCpu)) {
    if (overlayCpu > OVERLAY_CPU_WARN) {
      add(resources, 'warn', 'resources.overlay-cpu', `overlay CPU ${overlayCpu.toFixed(1)}%`, '超过 40% 会明显耗电/发热', {
        fix: commandFix('systemctl --user restart figaro-ui   # 或检查渲染后端/动画', '降低 overlay 开销'),
      });
    } else {
      add(resources, 'ok', 'resources.overlay-cpu', `overlay CPU ${overlayCpu.toFixed(1)}%`);
    }
  }
  const disk = await run('df', ['-kP', repoRoot]);
  const diskInfo = disk.ok ? parseKib(disk.stdout) : null;
  if (diskInfo) {
    const freeBytes = diskInfo.freeKib * 1024;
    if (freeBytes < DISK_WARN_BYTES) {
      add(resources, 'warn', 'resources.disk', `磁盘剩余 ${(freeBytes / 1024 ** 3).toFixed(1)}GB`, '模型+日志需要空间，低于 5GB 会出问题', {
        fix: commandFix('du -sh ~/.local/share/figaro* /tmp/figaro* 2>/dev/null | sort -h | tail', '清理日志/缓存'),
      });
    } else {
      add(resources, 'ok', 'resources.disk', `磁盘剩余 ${(freeBytes / 1024 ** 3).toFixed(1)}GB`);
    }
  }

  // ------------------------------------------------------------- summary
  const checks = groups.flatMap((entry) => entry.checks);
  const summary = {
    ok: checks.filter((check) => check.status === 'ok').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    info: checks.filter((check) => check.status === 'info').length,
    skip: checks.filter((check) => check.status === 'skip').length,
  };
  const suggestions = [];
  const seen = new Set();
  for (const entry of groups) {
    for (const check of entry.checks) {
      if (!check.fix) continue;
      if (check.status !== 'fail' && check.status !== 'warn') continue;
      const key = check.fix.command;
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({
        command: check.fix.command,
        reason: check.fix.reason || check.label,
        check: check.id,
      });
    }
  }
  const fixes = [];
  for (const check of checks) {
    if (check.fix?.kind && (check.status === 'fail' || check.status === 'warn')) {
      fixes.push({ kind: check.fix.kind, data: check.fix.data ?? {}, command: check.fix.command, reason: check.fix.reason, check: check.id });
    }
  }
  return {
    ok: summary.fail === 0,
    generatedAt: new Date().toISOString(),
    version: VERSION,
    host: os.hostname(),
    repoRoot,
    configPath,
    socketPath,
    summary,
    groups,
    suggestions,
    fixes,
  };
}

/** Run the safe subset of fixes (restart services / unmute / chmod config). */
export async function applyDoctorFixes(report, { env = process.env } = {}) {
  const run = createRunner(env);
  const applied = [];
  const seen = new Set();
  for (const fix of report.fixes ?? []) {
    const key = `${fix.kind}:${JSON.stringify(fix.data ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (fix.kind === 'restart-daemon') {
      const result = await run('systemctl', ['--user', 'restart', 'figaro']);
      applied.push({ kind: fix.kind, command: 'systemctl --user restart figaro', ok: result.ok });
    } else if (fix.kind === 'restart-ui') {
      const result = await run('systemctl', ['--user', 'restart', 'figaro-ui']);
      applied.push({ kind: fix.kind, command: 'systemctl --user restart figaro-ui', ok: result.ok });
    } else if (fix.kind === 'unmute-sink' && fix.data?.sink) {
      const result = await run('pactl', ['set-sink-mute', String(fix.data.sink), '0']);
      applied.push({ kind: fix.kind, command: `pactl set-sink-mute ${fix.data.sink} 0`, ok: result.ok });
    } else if (fix.kind === 'chmod-config') {
      try {
        fs.chmodSync(report.configPath, 0o600);
        applied.push({ kind: fix.kind, command: `chmod 600 ${report.configPath}`, ok: true });
      } catch (err) {
        applied.push({ kind: fix.kind, command: `chmod 600 ${report.configPath}`, ok: false, error: err.message });
      }
    }
  }
  return applied;
}

// ---------------------------------------------------------------- rendering

export function formatDoctorReport(report, { fixResults = [] } = {}) {
  const lines = [];
  lines.push(`费加罗体检  figaro doctor${report.version ? `  v${report.version}` : ''}`);
  lines.push(`时间 ${report.generatedAt} · 主机 ${report.host}`);
  lines.push('');
  report.groups.forEach((entry, index) => {
    lines.push(`[${index + 1}/${report.groups.length}] ${entry.title}`);
    for (const check of entry.checks) {
      const symbol = STATUS_SYMBOL[check.status] ?? '·';
      const detail = check.detail ? `  — ${check.detail}` : '';
      lines.push(`  ${symbol} ${check.label}${detail}`);
    }
    lines.push('');
  });
  lines.push(`汇总: ✓ ${report.summary.ok} · ! ${report.summary.warn} · ✗ ${report.summary.fail} · · ${report.summary.info} · – ${report.summary.skip}`);
  if (fixResults.length > 0) {
    lines.push('');
    lines.push('已执行修复:');
    for (const result of fixResults) {
      lines.push(`  ${result.ok ? '✓' : '✗'} ${result.command}${result.error ? `  (${result.error})` : ''}`);
    }
  }
  lines.push('');
  if (report.suggestions.length > 0) {
    lines.push('建议（复制执行）:');
    for (const suggestion of report.suggestions) {
      lines.push(`  $ ${suggestion.command}`);
      lines.push(`    # ${suggestion.reason}`);
    }
  } else if (report.ok) {
    lines.push('建议: 一切正常，无需操作。');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * CLI entry: run checks, optionally apply safe fixes, print text or JSON.
 * @returns {Promise<number>} exit code (0 = no ✗, 1 = has ✗)
 */
export async function runDoctor({ json = false, fix = false, net = false, env = process.env, stdout = process.stdout } = {}) {
  let report = await collectDoctorReport({ env, net });
  let fixResults = [];
  if (fix) {
    fixResults = await applyDoctorFixes(report, { env });
    if (fixResults.length > 0) {
      report = await collectDoctorReport({ env, net });
      report.fixesApplied = fixResults;
    }
  }
  const exitCode = report.summary.fail > 0 ? 1 : 0;
  if (json) {
    stdout.write(`${JSON.stringify({ ...report, exitCode }, null, 2)}\n`);
  } else {
    stdout.write(formatDoctorReport(report, { fixResults }));
  }
  return exitCode;
}

export default runDoctor;
