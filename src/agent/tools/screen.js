// Screen tools: what is on the display right now.
//
// `screenshot` captures the screen to a PNG (no Wayland screencopy protocol is
// needed: Spectacle is part of Plasma and talks to KWin), and `view_image`
// turns an image file into something the model can actually see. They are two
// tools rather than one so the model can also look at an image it produced or
// found earlier, and so a failed capture is a normal tool error.
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

export function createScreenshotTool() {
  return {
    name: 'screenshot',
    description:
      'Capture the current screen to an image file and return its path. Use it when the user asks about something visible '
      + 'on screen; follow up with view_image on the returned path, because the screenshot tool itself does not show you the picture.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional output path; defaults to a timestamped file in the temp directory.' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const target = typeof args?.path === 'string' && args.path.trim().length > 0
        ? path.resolve(args.path.trim())
        : path.join(os.tmpdir(), `figaro-screen-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await run('spectacle', ['-b', '-n', '-f', '-o', target]);
      if (!fs.existsSync(target) || fs.statSync(target).size === 0) {
        throw new Error('screenshot failed: no image was written (is a graphical session available?)');
      }
      const size = imageSize(target);
      const dims = size ? `${size.width}x${size.height}` : 'unknown size';
      return `screenshot saved to ${target} (${dims}, ${(fs.statSync(target).size / 1024).toFixed(0)} KiB)`;
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
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the image file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(args) {
      const file = path.resolve(String(args?.path ?? '').trim());
      if (!file || !fs.existsSync(file)) throw new Error(`image not found: ${file}`);
      const stat = fs.statSync(file);
      if (stat.size > MAX_IMAGE_BYTES) throw new Error(`image too large: ${(stat.size / 1048576).toFixed(1)} MiB`);
      const out = path.join(os.tmpdir(), `figaro-view-${Date.now()}.jpg`);
      await run('ffmpeg', [
        '-y', '-loglevel', 'error', '-i', file,
        '-vf', `scale='min(${MAX_IMAGE_WIDTH},iw)':-2`,
        '-q:v', '4', out,
      ]);
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
