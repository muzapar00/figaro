// Atomic file writes: write a sibling temp file, fsync it, then rename over the
// target. A reader (or a crash) never observes a half-written file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * @param {string} absPath target file path (parents are created)
 * @param {string} content UTF-8 content
 * @param {{ mode?: number }} [options]
 */
export async function atomicWriteFile(absPath, content, options = {}) {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });

  let mode = options.mode;
  if (mode === undefined) {
    try {
      const existing = await fs.stat(absPath);
      if (existing.isDirectory()) throw new Error(`${absPath} is a directory`);
      mode = existing.mode & 0o777;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      mode = 0o644;
    }
  }

  const tmpPath = path.join(
    dir,
    `.${path.basename(absPath)}.figaro-tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  let handle;
  try {
    handle = await fs.open(tmpPath, 'wx', mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, absPath);
  } catch (err) {
    try {
      await handle?.close();
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
