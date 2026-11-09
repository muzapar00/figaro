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

/** Accept path / file_path / file: the catalog is not consistent across tools. */
function pickPath(args) {
  for (const key of ['path', 'file_path', 'file']) {
    const value = typeof args?.[key] === 'string' ? args[key].trim() : '';
    if (value.length > 0) return value;
  }
  return '';
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
        file_path: { type: 'string', description: 'Alias for path.' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const wanted = pickPath(args);
      const target = wanted.length > 0
        ? path.resolve(wanted)
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
        // The file tools in this catalog use `file_path`, and the model naturally
        // reuses that name here; both spellings are accepted so a wording
        // difference never reads as "the image tool is broken".
        file_path: { type: 'string', description: 'Absolute path to the image file.' },
        path: { type: 'string', description: 'Alias for file_path.' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    async execute(args) {
      const wanted = pickPath(args);
      if (wanted.length === 0) throw new Error('view_image needs a file_path (absolute path to an image)');
      const file = path.resolve(wanted);
      if (!fs.existsSync(file)) throw new Error(`image not found: ${file}`);
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
