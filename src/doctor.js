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

/** Read /etc/os-release into a plain object; empty when unavailable. */
export function readOsRelease(env = process.env) {
  const file = env.FIGARO_OS_RELEASE || '/etc/os-release';
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;
      out[match[1]] = match[2].replace(/^"|"$/g, '');
    }
  } catch {
    /* no os-release (non-Linux or minimal container); caller falls back to os.* */
  }
  return out;
}

/**
 * Classify session/compositor from the environment only: no shelling out, so it
 * works in `figaro doctor` tests (fake env) and in CI containers with no desktop.
 */
export function detectPlatform(env = process.env) {
  const desktop = String(env.XDG_CURRENT_DESKTOP ?? '').split(':').filter(Boolean).join(':');
  const sessionType = String(env.XDG_SESSION_TYPE ?? '').toLowerCase();
  const wayland = sessionType === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
  const x11 = !wayland && (sessionType === 'x11' || Boolean(env.DISPLAY));
  const isKde = /kde|plasma/i.test(desktop)
    || String(env.KDE_FULL_SESSION ?? '') === 'true'
    || /plasma/i.test(String(env.XDG_SESSION_DESKTOP ?? ''));
  const isGnome = /gnome|unity|pantheon|cinnamon/i.test(desktop)
    || /gnome/i.test(String(env.XDG_SESSION_DESKTOP ?? ''));
  const isWlroots = /sway|hyprland|river|wayfire|labwc|niri|wlroots/i.test(desktop)
    || Boolean(env.SWAYSOCK) || Boolean(env.HYPRLAND_INSTANCE_SIGNATURE);
  // wlr-layer-shell: KWin and every wlroots compositor implement it. GNOME's
  // Mutter does not, and X11 has no layer-shell at all.
  let layerShell = false;
  let layerShellReason = '';
  if (x11) {
    layerShellReason = 'X11 没有 layer-shell';
  } else if (wayland && (isKde || isWlroots)) {
    layerShell = true;
    layerShellReason = isKde ? 'KWin' : 'wlroots';
  } else if (wayland && !isGnome) {
    layerShell = true;
    layerShellReason = 'Wayland（未识别的合成器，按 wlroots 处理）';
  } else if (isGnome) {
    layerShellReason = 'GNOME/Mutter 没有 wlr-layer-shell';
  } else {
    layerShellReason = '没有可用的 Wayland 会话信息';
  }
  return {
    desktop: desktop || String(env.XDG_SESSION_DESKTOP ?? '') || '',
    sessionType: sessionType || (wayland ? 'wayland' : (x11 ? 'x11' : '')),
    wayland,
    x11,
    isKde,
    isGnome,
    isWlroots,
    layerShell,
    layerShellReason,
    graphical: wayland || x11,
  };
}

/** Copy-pasteable install hint for the desktop's screenshot backend. */
export function screenshotBackendHint(platform = {}) {
  if (platform.isKde) return 'sudo apt install spectacle      # 或 pacman -S spectacle';
  if (platform.isWlroots) return 'sudo apt install grim          # 或 pacman -S grim';
  if (platform.isGnome) return 'sudo apt install gnome-screenshot xdg-desktop-portal-gnome';
  if (platform.x11) return 'sudo apt install scrot         # 或 imagemagick / import';
  return 'sudo apt install xdg-desktop-portal   # 以及对应桌面后端；或 grim/spectacle';
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
  // A plain TTY/SSH shell and the systemd *service* context often did not
  // inherit the graphical-session variables (XDG_CURRENT_DESKTOP,
  // WAYLAND_DISPLAY). The user manager knows them, so merge its environment in
  // as a fallback; the real process environment always wins.
  let sessionEnv = env;
  {
    const shown = await run('systemctl', ['--user', 'show-environment']);
    if (shown.ok && shown.stdout.trim()) {
      const fromManager = {};
      for (const line of shown.stdout.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) fromManager[line.slice(0, eq)] = line.slice(eq + 1);
      }
      sessionEnv = { ...fromManager, ...env };
    }
  }
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
  // pgrep -af matches its own command line (it contains the pattern), and the
  // systemd unit's MainPID is the daemon we *want*, not a leftover. Both must be
  // excluded or the check reports a stale instance on a healthy machine.
  const daemonProcs = (await run('pgrep', ['-af', 'bin/figaro daemon'])).stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0 || line.includes('figaro doctor')) return false;
      const pid = Number(line.split(/\s+/)[0]);
      if (Number.isFinite(pid) && pid === figaroPid) return false;
      const commandLine = line.replace(/^\d+\s+/, '');
      const executable = commandLine.split(/\s+/)[0] ?? '';
      if (/(^|\/)pgrep$/.test(executable)) return false;
      return /(^|\/)node$/.test(executable) || /bin\/figaro/.test(commandLine);
    });
  if (daemonProcs.length === 0) {
    add(services, 'ok', 'service.singleton', '守护进程单实例: 无残留进程');
  } else {
    add(services, 'fail', 'service.singleton', `发现 ${daemonProcs.length} 个额外 daemon 进程`, '残留实例会抢占 socket，导致新实例启动失败', {
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
  const llm = (config?.llm && typeof config.llm === 'object')
    ? config.llm
    : { provider: 'deepseek', baseUrl: config?.deepseek?.baseUrl, model: config?.deepseek?.model, apiKey: config?.deepseek?.apiKey };
  const provider = String(llm.provider || 'deepseek');
  const providerEnvKey = {
    deepseek: ['FIGARO_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'],
    openai: ['FIGARO_OPENAI_API_KEY', 'OPENAI_API_KEY'],
    gemini: ['FIGARO_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    custom: ['FIGARO_LLM_API_KEY'],
  }[provider] ?? ['FIGARO_LLM_API_KEY'];
  const llmKey = llm.apiKey || env.FIGARO_LLM_API_KEY || providerEnvKey.map((key) => env[key]).find(Boolean) || '';
  const minimaxKey = config?.minimax?.apiKey || env.FIGARO_MINIMAX_API_KEY || env.MINIMAX_API_KEY || '';
  if (llmKey || provider === 'custom') {
    add(configGroup, 'ok', 'config.llm-key', `LLM key（${provider}）: ${llmKey ? maskSecret(llmKey) : '自定义端点无需 key'}`);
  } else {
    add(configGroup, 'fail', 'config.llm-key', `LLM key（${provider}）: 未配置`, '大脑不可用（ask/语音问答都会失败）', {
      fix: commandFix(`$EDITOR ${configPath}   # 填写 llm.apiKey（服务商：${provider}）`, '填写 LLM key'),
    });
  }
  if (minimaxKey) {
    add(configGroup, 'ok', 'config.minimax-key', `MiniMax key: ${maskSecret(minimaxKey)}`);
  } else {
    add(configGroup, 'fail', 'config.minimax-key', 'MiniMax key: 未配置', '嗓子不可用（唤醒应答/朗读失败）', {
      fix: commandFix(`$EDITOR ${configPath}   # 填写 minimax.apiKey`, '填写 MiniMax key'),
    });
  }
  const model = llm.model ?? config?.deepseek?.model;
  const voiceId = config?.minimax?.voiceId;
  if (model && voiceId) {
    add(configGroup, 'info', 'config.tunables', `模型: ${provider} / ${model} · 音色: ${voiceId}`);
  } else {
    add(configGroup, 'warn', 'config.tunables', `模型/音色配置不完整（model=${model ?? '?'} voiceId=${voiceId ?? '?'}）`);
  }

  // How this Figaro was installed decides where models and user units belong;
  // print it once so field reports are unambiguous (deb/rpm vs git checkout).
  const packagedLayout = /^\/usr\/lib(?:64)?\/figaro$/.test(repoRoot);
  add(configGroup, 'info', 'config.layout', `安装布局: ${packagedLayout ? 'deb/rpm 系统包' : '源码 checkout'}（${repoRoot}）`);

  // -------------------------------------------------------------- 4. models
  const models = group('models', '本地模型');
  const kwsDir = resolveConfigModelDir(config, 'kwsModelDir', repoRoot);
  const offlineDir = resolveConfigModelDir(config, 'offlineModelDir', repoRoot);
  const streamDir = resolveConfigModelDir(config, 'streamingModelDir', repoRoot);
  const modelsRoot = path.dirname(kwsDir ?? path.join(repoRoot, 'models', 'kws'));
  const vadDir = path.join(modelsRoot, 'vad');
  const xdgDataDir = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  // Suggestions must be runnable by the user: a deb/rpm install keeps /usr
  // read-only, so the fetch command points at a writable model root.
  const writableModelsRoot = (() => {
    for (const dir of [modelsRoot, path.join(xdgDataDir, 'figaro', 'models')]) {
      try {
        fs.accessSync(fs.existsSync(dir) ? dir : path.dirname(dir), fs.constants.W_OK);
        return dir;
      } catch {
        /* try the next candidate */
      }
    }
    return path.join(xdgDataDir, 'figaro', 'models');
  })();
  const fetchModelsFix = (only, reason) => ({
    command: `FIGARO_MODELS_DIR=${writableModelsRoot} bash ${path.join(repoRoot, 'scripts', 'fetch-models.sh')} --only=${only}`,
    reason,
  });
  const modelsRootWritable = (() => {
    try {
      fs.accessSync(modelsRoot, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();
  add(models, 'info', 'models.root', `模型根目录: ${modelsRoot}（${modelsRootWritable ? '可写' : '不可写'}）`);
  if (!modelsRootWritable) {
    add(models, 'warn', 'models.root-writable', `模型目录不可写: ${modelsRoot}`, '系统包布局下 /usr 只读；运行 figaro install-user 后把 asr.*ModelDir 指到可写目录', {
      fix: commandFix('figaro install-user', '生成可写的模型目录配置'),
    });
  }
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
        fix: fetchModelsFix('kws', '更新为 zh-en 双语 KWS（--force 可加在命令末尾）'),
      });
    }
  } else {
    add(models, 'fail', 'models.kws', `唤醒词模型不完整: 缺 ${missingKws.join('/')}`, kwsDir ?? '(未配置)', {
      fix: fetchModelsFix('kws', '下载唤醒词模型'),
    });
  }
  const offlineModel = findFirst(offlineDir, [/^(model|paraformer|sensevoice).*\.onnx$/, /\.onnx$/]);
  const offlineTokens = offlineDir && fs.existsSync(path.join(offlineDir, 'tokens.txt'));
  if (offlineModel && offlineTokens) {
    add(models, 'ok', 'models.offline', `离线识别模型: 完整（${path.basename(offlineModel)}）`, offlineDir);
  } else {
    add(models, 'fail', 'models.offline', '离线识别模型缺失', offlineDir ?? '(未配置)', {
      fix: fetchModelsFix('asr', '下载离线 ASR 模型'),
    });
  }
  const streamOk = findFirst(streamDir, [/^encoder.*\.onnx$/]) && findFirst(streamDir, [/^decoder.*\.onnx$/]) && findFirst(streamDir, [/^joiner.*\.onnx$/]) && streamDir && fs.existsSync(path.join(streamDir, 'tokens.txt'));
  if (streamOk) {
    add(models, 'ok', 'models.streaming', '流式识别模型: 完整（实时 partial）');
  } else {
    add(models, 'warn', 'models.streaming', '流式识别模型缺失', '没有实时字幕，只影响 partial 体验', {
      fix: fetchModelsFix('asr', '下载流式 ASR 模型'),
    });
  }
  if (vadDir && fs.existsSync(path.join(vadDir, 'silero_vad.onnx'))) {
    add(models, 'ok', 'models.vad', 'VAD 模型: 完整（silero_vad.onnx）');
  } else {
    add(models, 'warn', 'models.vad', 'VAD 模型缺失', '断句/静音检测会退化', {
      fix: fetchModelsFix('vad', '下载 VAD 模型'),
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
    add(netGroup, (llmKey || provider === 'custom') ? 'ok' : 'fail', 'net.llm-key', `LLM key（${provider}）: ${llmKey ? '已配置' : (provider === 'custom' ? '自定义端点' : '未配置')}`);
    add(netGroup, minimaxKey ? 'ok' : 'fail', 'net.minimax-key', `MiniMax key: ${minimaxKey ? '已配置' : '未配置'}`);
  } else {
    if (llmKey || provider === 'custom') {
      const started = performance.now();
      try {
        const { testLlmConnection } = await import('./agent/llm.js');
        const result = await testLlmConnection({ config, timeoutMs: 8000 });
        const ms = Math.round(performance.now() - started);
        if (result.ok) {
          add(netGroup, 'ok', 'net.llm', `LLM 连通（${provider} / ${result.model ?? llm.model ?? '?'}，HTTP ${result.status}，${ms}ms）`);
        } else {
          add(netGroup, 'fail', 'net.llm', `LLM 请求失败（${provider}，HTTP ${result.status ?? '?'}，${ms}ms）: ${maskText(result.message || '')}`, '', {
            fix: commandFix('figaro status   # 再检查设置里的 provider/baseUrl/model/key', '检查 LLM 配置'),
          });
        }
      } catch (err) {
        add(netGroup, 'fail', 'net.llm', `LLM 连不上（${provider}）: ${maskText(err?.message || err)}`, '', {
          fix: commandFix('figaro status', '检查网络与 LLM 配置'),
        });
      }
    } else {
      add(netGroup, 'fail', 'net.llm', `LLM key（${provider}）: 未配置`);
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
  const platform = detectPlatform(sessionEnv);
  const osRelease = readOsRelease(env);
  const osLabel = osRelease.PRETTY_NAME || `${os.type()} ${os.release()}`;
  add(desktop, 'info', 'desktop.os', `系统: ${osLabel}（${os.arch()}，内核 ${os.release()}）`);
  add(desktop, 'info', 'desktop.node', `Node.js: ${process.versions.node}（${process.execPath}）`);
  const sessionLine = `会话: ${platform.sessionType || '未知'} · 桌面: ${platform.desktop || '未知'}`;
  if (platform.x11) {
    add(desktop, 'warn', 'desktop.session', sessionLine, 'Quickshell overlay 仅支持 Wayland；X11 下语音/CLI 可用，overlay 无法显示（见 docs/platform-support.md）', {
      fix: commandFix('echo "$XDG_SESSION_TYPE $XDG_CURRENT_DESKTOP"; loginctl show-session "$XDG_SESSION_ID" -p Type 2>/dev/null', '确认会话类型；overlay 需要 Wayland'),
    });
  } else {
    add(desktop, 'info', 'desktop.session', sessionLine);
  }

  if (platform.layerShell) {
    add(desktop, 'ok', 'desktop.layer-shell', `layer-shell: 可用（${platform.layerShellReason}）`);
  } else if (platform.isGnome) {
    add(desktop, 'warn', 'desktop.layer-shell', 'GNOME Wayland: 没有 wlr-layer-shell', 'Quickshell overlay 无法显示；语音与 CLI 仍可用。替代方案见 docs/platform-support.md', {
      fix: commandFix('figaro ask "你好"   # GNOME 下用 CLI/语音；overlay 需要 KDE/sway/Hyprland', 'GNOME 无 layer-shell，overlay 不可用'),
    });
  } else if (platform.x11) {
    add(desktop, 'warn', 'desktop.layer-shell', 'X11: 没有 wlr-layer-shell', 'overlay 只在 Wayland 显示；CLI/语音不受影响', {
      fix: commandFix('figaro ask "你好"', 'X11 下使用 CLI/语音'),
    });
  } else {
    add(desktop, 'info', 'desktop.layer-shell', `layer-shell: 无法判断（${platform.layerShellReason}）`);
  }

  // Optional everywhere: Kos.SurfaceShape is KDE-only, and the overlay falls
  // back to its own translucent fill when it is missing. Never a failure.
  const kosShape = path.join(xdgConfig, 'quickshell', 'kos', 'Kos', 'SurfaceShape');
  if (fs.existsSync(kosShape)) {
    add(desktop, 'ok', 'desktop.kos', `液态玻璃（KOS SurfaceShape）: 存在（${kosShape}）`);
  } else {
    add(desktop, 'info', 'desktop.kos', `液态玻璃（KOS SurfaceShape）: 未安装（${kosShape}）`, '非必需：overlay 自动回退半透明背景；只有 KDE + KOS 才有真玻璃效果');
  }

  // Overlay unit: install-user renders a per-user unit; deb/rpm also ship a
  // machine-independent one under /usr/lib/systemd/user.
  const uiUnitCandidates = [
    path.join(home, '.config', 'systemd', 'user', 'figaro-ui.service'),
    '/usr/lib/systemd/user/figaro-ui.service',
    path.join(repoRoot, 'systemd', 'figaro-ui.service'),
    path.join(repoRoot, 'systemd', 'figaro-ui.service.in'),
  ];
  const uiUnitPath = uiUnitCandidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  const uiUnitText = uiUnitPath ? readFileSafe(uiUnitPath) : null;
  const uiUnitIsTemplate = Boolean(uiUnitText && /@QS@|@WAYLAND_DISPLAY@|@REPO@/.test(uiUnitText));
  if (!uiUnitPath || uiUnitText === null) {
    add(desktop, 'warn', 'desktop.unit', '找不到 figaro-ui.service', 'overlay 未注册为 systemd user unit', {
      fix: commandFix('figaro install-user', '安装/修复用户级 overlay unit'),
    });
    add(desktop, 'warn', 'desktop.qs', '无法从 unit 定位 Quickshell', 'overlay 起不来（语音/CLI 不受影响）', {
      fix: commandFix('figaro install-user', '重新安装 overlay unit'),
    });
  } else {
    const match = /^\s*Environment=.*QML2_IMPORT_PATH=(\S+)/m.exec(uiUnitText);
    const qmlPath = match?.[1] ?? null;
    if (qmlPath && qmlPath.includes('quickshell/kos')) {
      add(desktop, 'ok', 'desktop.qmlpath', `QML2_IMPORT_PATH 已配置: ${qmlPath}`);
    } else if (uiUnitIsTemplate) {
      add(desktop, 'info', 'desktop.qmlpath', 'figaro-ui unit 是未渲染的模板', '运行 figaro install-user 生成实际的 user unit');
    } else if (platform.isKde) {
      add(desktop, 'warn', 'desktop.qmlpath', 'figaro-ui unit 缺少 QML2_IMPORT_PATH', 'KDE 上装了 KOS 时玻璃效果需要该路径（没有 KOS 时无影响）', {
        fix: commandFix('figaro install-user', '重新渲染 overlay unit'),
      });
    } else {
      add(desktop, 'info', 'desktop.qmlpath', '非 KDE 桌面：不需要 QML2_IMPORT_PATH', 'KOS 玻璃只属于 KDE；overlay 使用半透明回退');
    }
    const execMatch = /^\s*ExecStart=(\S+)/m.exec(uiUnitText);
    const execPath = execMatch?.[1]?.replace(/^%h/, home) ?? '';
    const qsCandidates = [execPath, findOnPath('qs', env), path.join(home, '.local', 'bin', 'qs'), '/usr/bin/qs'].filter(Boolean);
    // The packaged unit starts the /usr/bin/figaro-ui launcher, which finds qs
    // itself; the launcher is not Quickshell, so look for qs separately.
    if (execPath && /figaro-ui$/.test(execPath)) {
      qsCandidates.unshift(findOnPath('qs', env), path.join(home, '.local', 'bin', 'qs'), '/usr/bin/qs');
    }
    const qsPath = qsCandidates.find((candidate) => findOnPath(candidate, env));
    if (qsPath) {
      add(desktop, 'ok', 'desktop.qs', `Quickshell: ${qsPath}`);
    } else {
      add(desktop, 'warn', 'desktop.qs', '找不到 Quickshell（qs）', platform.layerShell ? 'overlay 起不来（语音/CLI 不受影响）' : '当前桌面本来就不支持 overlay，不影响语音/CLI', {
        fix: commandFix('figaro install-user   # 或按发行版安装 quickshell / 从 AUR 安装', '安装 Quickshell'),
      });
    }
  }

  // Screenshot backends: spectacle (KDE) -> grim (wlroots) -> portal -> GNOME -> X11.
  const screenshotBackends = [];
  for (const [command, note] of [['spectacle', 'KDE'], ['grim', 'wlroots'], ['gdbus', 'portal'], ['gnome-screenshot', 'GNOME'], ['scrot', 'X11']]) {
    if (findOnPath(command, env)) screenshotBackends.push(`${command}(${note})`);
  }
  if (screenshotBackends.length > 0) {
    add(desktop, 'ok', 'desktop.screenshot', `截图后端: ${screenshotBackends.join(', ')}`);
  } else if (platform.graphical) {
    add(desktop, 'warn', 'desktop.screenshot', '没有可用的截图后端', 'screenshot 工具不可用（spectacle/grim/portal/gnome-screenshot/scrot 都没有）', {
      fix: commandFix(screenshotBackendHint(platform), '安装截图后端'),
    });
  } else {
    add(desktop, 'info', 'desktop.screenshot', '截图后端: 未检测（没有图形会话）');
  }

  const portalUnit = await run('systemctl', ['--user', 'is-active', 'xdg-desktop-portal']);
  const portalState = portalUnit.stdout.trim();
  if (portalState === 'active') {
    add(desktop, 'ok', 'desktop.portal', 'xdg-desktop-portal: active（热键/截图回退/portal 能力）');
  } else if (portalState.length === 0) {
    add(desktop, 'info', 'desktop.portal', 'xdg-desktop-portal: 状态未知（systemctl --user 未返回状态）');
  } else if (platform.graphical) {
    add(desktop, 'warn', 'desktop.portal', `xdg-desktop-portal: ${portalState}`, '全局热键与 portal 截图回退不可用', {
      fix: commandFix('systemctl --user status xdg-desktop-portal xdg-desktop-portal-kde   # 按发行版安装对应后端后重新登录', '启动 xdg-desktop-portal'),
    });
  } else {
    add(desktop, 'info', 'desktop.portal', `xdg-desktop-portal: ${portalState}`);
  }

  const pipewireSocket = path.join(xdgRuntime, 'pipewire-0');
  if (fs.existsSync(pipewireSocket)) {
    add(desktop, 'ok', 'desktop.pipewire', `PipeWire socket: ${pipewireSocket}`);
  } else {
    add(desktop, 'info', 'desktop.pipewire', `PipeWire socket 未发现（${pipewireSocket}）`, '也许由 PulseAudio 提供或服务尚未启动；音频检查见「麦克风/音频出口」组');
  }

  const ragConfig = config?.rag ?? {};
  const ragUnit = await run('systemctl', ['--user', 'is-active', 'figaro-rag']);
  const ragState = ragUnit.stdout.trim();
  if (ragConfig.enabled === false) {
    add(desktop, 'info', 'desktop.rag', '长期记忆 RAG（可选）: 已关闭');
  } else if (ragState === 'active') {
    add(desktop, 'ok', 'desktop.rag', `长期记忆 RAG（可选）: active（${ragConfig.host ?? '?'}）`);
  } else {
    add(desktop, 'info', 'desktop.rag', `长期记忆 RAG（可选）: ${ragState || '未运行'}（${ragConfig.host ?? '?'}）`, '没有它也能正常对话，只是不跨会话记忆；安装见 docs/rag.md');
  }

  const ffmpegPath = findOnPath('ffmpeg', env);
  if (ffmpegPath) {
    add(desktop, 'ok', 'desktop.ffmpeg', `view_image 依赖: ffmpeg（${ffmpegPath}）`);
  } else {
    add(desktop, 'warn', 'desktop.ffmpeg', '缺少 ffmpeg', 'view_image 无法缩放图片（screenshot 仍可用）', {
      fix: commandFix('sudo apt install ffmpeg   # 或 pacman -S ffmpeg', '安装 ffmpeg'),
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
  // Platform guidance that is not a failure but is worth copying into a
  // terminal: which desktops can show the overlay and which screenshot backend
  // is expected. Rendered in its own section, not mixed into fix suggestions.
  const platformHints = [];
  if (platform.isGnome) {
    platformHints.push({
      command: 'figaro ask "你好"',
      reason: 'GNOME Wayland 没有 wlr-layer-shell：用 CLI/语音；overlay 需要 KDE/sway/Hyprland（docs/platform-support.md）',
    });
    platformHints.push({ command: 'systemctl --user disable --now figaro-ui', reason: 'GNOME 下 overlay unit 启动会失败，建议关掉它（语音/CLI 不受影响）' });
  } else if (platform.x11) {
    platformHints.push({
      command: 'echo "$XDG_SESSION_TYPE"',
      reason: 'X11 不支持 Quickshell overlay：登录 Wayland 会话后可显示浮层，CLI/语音不受影响',
    });
  } else if (platform.wayland && !platform.isKde) {
    platformHints.push({
      command: `systemctl --user status figaro-ui`,
      reason: `非 KDE 桌面（${platform.desktop || '未知'}）：layer-shell 可用，但 KOS 玻璃回退为半透明；截图走 grim/portal`,
    });
  }
  if (platform.graphical && screenshotBackends.length === 0) {
    platformHints.push({ command: screenshotBackendHint(platform), reason: '安装一个截图后端，screenshot 工具才能工作' });
  }
  if (packagedLayout && !modelsRootWritable) {
    platformHints.push({ command: 'figaro install-user', reason: '包布局下模型目录在 /usr 只读区：生成用户级绝对路径后重新下载模型' });
  }

  return {
    ok: summary.fail === 0,
    generatedAt: new Date().toISOString(),
    version: VERSION,
    host: os.hostname(),
    platform: {
      desktop: platform.desktop,
      sessionType: platform.sessionType,
      wayland: platform.wayland,
      x11: platform.x11,
      isKde: platform.isKde,
      isGnome: platform.isGnome,
      isWlroots: platform.isWlroots,
      layerShell: platform.layerShell,
      layerShellReason: platform.layerShellReason,
    },
    os: {
      prettyName: osRelease.PRETTY_NAME ?? null,
      id: osRelease.ID ?? null,
      versionId: osRelease.VERSION_ID ?? null,
      kernel: os.release(),
      arch: os.arch(),
    },
    platformHints,
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
  if (report.platformHints?.length > 0) {
    lines.push('');
    lines.push('平台提示:');
    for (const hint of report.platformHints) {
      lines.push(`  $ ${hint.command}`);
      lines.push(`    # ${hint.reason}`);
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
