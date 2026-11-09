// Path resolution shared by the filesystem tools.
import path from 'node:path';

/**
 * Resolve a user/model supplied path against the agent working directory.
 * Absolute paths pass through. The result is not yet validated to exist.
 */
export function resolvePath(filePath, workdir) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('file_path must be a non-empty string');
  }
  const raw = filePath.trim();
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(workdir, raw);
}

/** Display a path relative to the working directory when that is shorter. */
export function displayPath(absPath, workdir) {
  const rel = path.relative(workdir, absPath);
  if (rel === '') return '.';
  return rel.startsWith('..') ? absPath : rel;
}

export function requireString(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}
