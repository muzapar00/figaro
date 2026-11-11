// Screen tools: what is on the display right now.
//
// `screenshot` captures the screen to a PNG and `view_image` turns an image
// file into something the model can actually see. They are two tools rather than
// one so the model can also look at an image it produced or found earlier, and
// so a failed capture is a normal tool error.
//
// Capture is deliberately not Spectacle-only: Figaro officially supports KDE
// Plasma Wayland, but also runs (text + voice, and the overlay on wlroots) when
// another desktop is in charge. Each backend is tried in turn, cheapest and
// least interactive first:
//
//   1. spectacle        KDE: captures through KWin, no portal dialog
//   2. grim             sway/Hyprland/wlroots: one-shot, non-interactive
//   3. portal           xdg-desktop-portal Screenshot (gdbus), Wayland-generic;
//                       some backends show a picker, and that is fine as a last
//                       resort for a human-driven desktop
//   4. gnome-screenshot GNOME fallback
//   5. scrot            X11 fallback (Quickshell itself is Wayland-only, but a
//                       text/CLI Figaro still runs under X11)
//
// The final error is a Chinese message that names every backend tried and the
// one dependency to install for the current desktop.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Images are downscaled before they are sent: full-screen PNGs are multi-MB,
// and the model does not need more than this to read a desktop.
const MAX_IMAGE_WIDTH = 1440;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

function run(command, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 400)}`));
    });
  });
}

/** Resolve a command on PATH without spawning a shell. */
function findOnPath(command) {
  if (!command) return null;
  if (path.isAbsolute(command)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
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

function imageSize(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.toString('ascii', 1, 4) === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Accept path / file_path / file: the catalog is not consistent across tools. */
function pickPath(args) {
  for (const key of ['path', 'file_path', 'file']) {
    const value = typeof args?.[key] === 'string' ? args[key].trim() : '';
    if (value.length > 0) return value;
  }
  return '';
}

function hasUsableImage(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- backends
// Each backend returns after the PNG exists at `target`, or throws with a short
// reason. The caller collects the reasons for the final Chinese error.

async function captureWithSpectacle(target) {
  await run('spectacle', ['-b', '-n', '-f', '-o', target], { timeoutMs: 25000 });
}

async function captureWithGrim(target) {
  // A single -o-less invocation captures all outputs on wlroots compositors.
  await run('grim', [target], { timeoutMs: 15000 });
}

function fileUriToPath(uri) {
  if (typeof uri !== 'string') return null;
  if (!uri.startsWith('file://')) return null;
  return decodeURIComponent(uri.slice('file://'.length));
}

/**
 * xdg-desktop-portal screenshot via gdbus.
 *
 * A portal call is a method call that returns a Request object, and the result
 * arrives later as a Response signal on that object path. gdbus cannot keep one
 * connection across two invocations, but Response is a broadcast signal, so a
 * `gdbus monitor` on the portal service sees it. We start the monitor first,
 * then make the call, then wait for the Response that carries our handle_token.
 */
async function captureWithPortal(target) {
  const gdbus = findOnPath('gdbus');
  if (!gdbus) throw new Error('gdbus 不可用（需 xdg-desktop-portal 与 GLib 工具）');
  const token = `figaro_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const parentWindow = '';
  const options = `{'handle_token': <'${token}'>, 'interactive': <false>}`;

  const monitor = spawn(gdbus, ['monitor', '--session', '--dest', 'org.freedesktop.portal.Desktop'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';
  let resolved = false;
  let timer = null;
  // Called when the request itself failed after the monitor was started: it must
  // tear the monitor and the timeout down, otherwise the timer would reject a
  // promise nobody awaits and become an unhandled rejection in the daemon.
  let abort = null;
  const result = new Promise((resolve, reject) => {
    const finish = (error, file) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      try { monitor.kill('SIGKILL'); } catch { /* ignore */ }
      if (error) reject(error);
      else resolve(file);
    };
    abort = () => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      try { monitor.kill('SIGKILL'); } catch { /* ignore */ }
    };
    timer = setTimeout(() => finish(new Error('portal 截图超时（可能有授权弹窗等待点击）')), 20000);
    monitor.on('error', (err) => finish(new Error(`gdbus monitor 失败: ${err.message}`)));
    monitor.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.includes('org.freedesktop.portal.Request.Response')) continue;
        const responseCode = /Response \(uint32 (\d+)/.exec(line)?.[1];
        if (responseCode === undefined) continue;
        const uri = /['"]uri['"]\s*:\s*<['"]([^'"]+)['"]>/.exec(line)?.[1];
        if (responseCode !== '0') {
          finish(new Error(`portal 返回失败（response=${responseCode}${uri ? '' : '，可能被用户取消或后端未实现'}）`));
          return;
        }
        const file = fileUriToPath(uri);
        if (!file) {
          finish(new Error('portal 没有返回截图文件路径'));
          return;
        }
        finish(null, file);
      }
    });
  });

  // Let the monitor subscribe before asking for the screenshot, otherwise the
  // Response can be emitted before we are listening.
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    await run(gdbus, [
      'call', '--session',
      '--dest', 'org.freedesktop.portal.Desktop',
      '--object-path', '/org/freedesktop/portal/desktop',
      '--method', 'org.freedesktop.portal.Screenshot.Screenshot',
      parentWindow, options,
    ], { timeoutMs: 15000 });
  } catch (err) {
    abort?.();
    throw new Error(`portal 不接受截图请求: ${err.message.slice(0, 200)}`);
  }

  const portalFile = await result;
  try {
    fs.copyFileSync(portalFile, target);
  } finally {
    // The portal writes into the user's Pictures directory; the tool promised a
    // path of its own, so the portal copy is removed to avoid clutter.
    try { fs.unlinkSync(portalFile); } catch { /* ignore */ }
  }
}

async function captureWithGnomeScreenshot(target) {
  await run('gnome-screenshot', ['-f', target], { timeoutMs: 20000 });
}

async function captureWithScrot(target) {
  await run('scrot', ['-o', target], { timeoutMs: 20000 });
}

function desktopHint() {
  const desktop = String(process.env.XDG_CURRENT_DESKTOP ?? '').toLowerCase();
  if (/kde/.test(desktop)) return 'KDE 上请确认 spectacle 已安装（sudo apt install spectacle）';
  if (/hyprland|sway|wayfire|river|labwc|niri|wlroots/.test(desktop) || process.env.SWAYSOCK) return 'wlroots 桌面上请安装 grim（sudo apt install grim）';
  if (/gnome/.test(desktop)) return 'GNOME Wayland 上请确认 xdg-desktop-portal-gnome 与 gnome-screenshot 已安装';
  if (process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return 'X11 会话请安装 scrot 或 imagemagick';
  return 'Wayland 上请确认 xdg-desktop-portal 及对应桌面后端已安装，或安装 grim/spectacle';
}

/** Capture a screenshot using the first backend that works. */
async function captureTo(target) {
  const attempts = [
    ['spectacle', captureWithSpectacle, 'spectacle'],
    ['grim', captureWithGrim, 'grim'],
    ['portal', captureWithPortal, null],
    ['gnome-screenshot', captureWithGnomeScreenshot, 'gnome-screenshot'],
    ['scrot', captureWithScrot, 'scrot'],
  ];
  const tried = [];
  const failures = [];
  for (const [name, capture, command] of attempts) {
    if (command && !findOnPath(command)) {
      failures.push(`${name}: 未安装`);
      continue;
    }
    tried.push(name);
    try {
      await capture(target);
      if (hasUsableImage(target)) return { backend: name };
      failures.push(`${name}: 没有写出图像`);
    } catch (err) {
      failures.push(`${name}: ${String(err?.message || err).slice(0, 240)}`);
    }
    // A later backend must not be fooled by a partial file from an earlier one.
    try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
  }
  const detail = failures.map((line) => `  - ${line}`).join('\n');
  throw new Error(
    `截屏失败（已尝试: ${tried.length > 0 ? tried.join('、') : '无可用后端'}）。\n${detail}\n`
    + `修复建议: ${desktopHint()}。非 KDE 桌面说明见 docs/platform-support.md。`,
  );
}

export function createScreenshotTool() {
  return {
    name: 'screenshot',
    description:
      'Capture the current screen to an image file and return its path. Use it when the user asks about something visible '
      + 'on screen; follow up with view_image on the returned path, because the screenshot tool itself does not show you the picture.',
    // dsh-style parameter map (see define.js): a raw JSON Schema object here would
    // be converted a second time by toChatTools() and reach the model broken.
    parameters: {
      path: { type: 'string', description: 'Optional output path; defaults to a timestamped file in the temp directory.' },
      file_path: { type: 'string', description: 'Alias for path.' },
    },
    async execute(args) {
      const wanted = pickPath(args);
      const target = wanted.length > 0
        ? path.resolve(wanted)
        : path.join(os.tmpdir(), `figaro-screen-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const { backend } = await captureTo(target);
      if (!hasUsableImage(target)) {
        throw new Error('截屏失败: 后端报告成功但图像为空');
      }
      const size = imageSize(target);
      const dims = size ? `${size.width}x${size.height}` : 'unknown size';
      const backendNote = backend === 'spectacle' ? '' : ` via ${backend}`;
      return `screenshot saved to ${target} (${dims}, ${(fs.statSync(target).size / 1024).toFixed(0)} KiB${backendNote})`;
    },
  };
}

export function createViewImageTool() {
  return {
    name: 'view_image',
    description:
      'Look at an image file (screenshot or any PNG/JPEG). Returns the picture so you can describe or reason about it. '
      + 'The image is downscaled to at most 1440px wide.',
    parameters: {
      // The file tools in this catalog use `file_path`, and the model naturally
      // reuses that name here; both spellings are accepted so a wording
      // difference never reads as "the image tool is broken".
      file_path: { type: 'string', required: true, description: 'Absolute path to the image file.' },
      path: { type: 'string', description: 'Alias for file_path.' },
    },
    async execute(args) {
      const wanted = pickPath(args);
      if (wanted.length === 0) throw new Error('view_image needs a file_path (absolute path to an image)');
      const file = path.resolve(wanted);
      if (!fs.existsSync(file)) throw new Error(`image not found: ${file}`);
      const stat = fs.statSync(file);
      if (stat.size > MAX_IMAGE_BYTES) throw new Error(`image too large: ${(stat.size / 1048576).toFixed(1)} MiB`);
      const out = path.join(os.tmpdir(), `figaro-view-${Date.now()}.jpg`);
      try {
        await run('ffmpeg', [
          '-y', '-loglevel', 'error', '-i', file,
          '-vf', `scale='min(${MAX_IMAGE_WIDTH},iw)':-2`,
          '-q:v', '4', out,
        ]);
      } catch (err) {
        if (err?.code === 'ENOENT') {
          throw new Error('view_image 需要 ffmpeg（sudo apt install ffmpeg / sudo pacman -S ffmpeg）');
        }
        throw err;
      }
      const data = fs.readFileSync(out);
      try { fs.rmSync(out, { force: true }); } catch { /* ignore */ }
      const base64 = data.toString('base64');
      return {
        content: `image ${file} (${(data.length / 1024).toFixed(0)} KiB after downscale)`,
        image: { mimeType: 'image/jpeg', dataBase64: base64 },
      };
    },
  };
}
