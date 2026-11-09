// Native glob and grep, no shell involved.
//
// Patterns use ripgrep-style globs (`**`, `*`, `?`, `{a,b}`, `[abc]`). glob
// walks the tree itself, so hidden and ignored files are included (matching the
// dsh tool description); results are sorted by modification time, newest first.
// grep walks a directory (or reads a single file) and returns matching lines
// with line numbers, grouped by file, skipping binaries and huge files.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from './define.js';
import { resolvePath, displayPath } from './resolve.js';

const GLOB_MAX_RESULTS = 100;
const GLOB_CANDIDATE_CAP = 5000;
const GLOB_SCAN_CAP = 200_000;
const GREP_MAX_MATCHES = 250;
const GREP_MAX_LINE_CHARS = 300;
const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 20_000;
const GREP_SKIP_DIRS = new Set(['node_modules', '.git']);

function escapeRegExpChar(ch) {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Compile a ripgrep-style glob into a RegExp over posix-relative paths. */
export function compileGlob(pattern) {
  let p = String(pattern ?? '').trim();
  if (p.length === 0) throw new Error('pattern must be a non-empty string');
  p = p.replace(/^\.\//, '').replace(/^\/+/, '');
  // A pattern with no "/" matches the basename at any depth.
  if (!p.includes('/')) p = `**/${p}`;

  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        i += 1;
        if (p[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      const close = p.indexOf('}', i + 1);
      if (close > i) {
        const alts = p.slice(i + 1, close).split(',').map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = close;
      } else {
        re += '\\{';
      }
    } else if (ch === '[') {
      const close = p.indexOf(']', i + 1);
      if (close > i) {
        re += p.slice(i, close + 1);
        i = close;
      } else {
        re += '\\[';
      }
    } else {
      re += escapeRegExpChar(ch);
    }
  }
  return new RegExp(`^${re}$`);
}

function abortedError() {
  const err = new Error('tool call aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Depth-first file walk. Yields absolute file paths; symlinked files are
 * resolved with stat so a symlink loop cannot recurse.
 */
async function* walkFiles(root, { signal, deadline, includeHidden = true, skipDirs = GREP_SKIP_DIRS, scanCap = GLOB_SCAN_CAP } = {}) {
  const stack = [root];
  let scanned = 0;
  while (stack.length > 0) {
    if (signal?.aborted) throw abortedError();
    if (deadline !== undefined && Date.now() > deadline) throw new Error('search timed out');
    const dir = stack.pop();
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      scanned += 1;
      if (scanned > scanCap) return;
      const name = dirent.name;
      if (!includeHidden && name.startsWith('.')) continue;
      const abs = path.join(dir, name);
      if (dirent.isDirectory()) {
        if (skipDirs?.has(name)) continue;
        stack.push(abs);
      } else if (dirent.isFile()) {
        yield abs;
      } else if (dirent.isSymbolicLink()) {
        try {
          const target = await fsp.stat(abs);
          if (target.isFile()) yield abs;
        } catch {
          /* dangling symlink */
        }
      }
    }
  }
}

/** @param {{ workdir?: string }} options */
export function createGlobTool(options = {}) {
  const baseWorkdir = options.workdir ?? process.cwd();

  return defineTool({
    name: 'glob',
    description:
      'Find files, not directories, whose paths match a glob pattern, including hidden and ignored files. ' +
      `Returns up to ${GLOB_MAX_RESULTS} paths in modification-time order; a larger result keeps the first paths ` +
      'and reports where the complete list was saved.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description:
          'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). A pattern with no "/" ' +
          'matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to ' +
          'anchor the depth.',
      },
      path: {
        type: 'string',
        description:
          'Directory to search in. Defaults to the agent working directory; a relative path resolves against it.',
      },
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    async execute(args = {}, { signal } = {}) {
      const root = args.path ? resolvePath(args.path, baseWorkdir) : baseWorkdir;
      const matcher = compileGlob(args.pattern);
      const deadline = Date.now() + SEARCH_TIMEOUT_MS;
      const candidates = [];
      let scanTruncated = false;
      try {
        for await (const abs of walkFiles(root, { signal, deadline, includeHidden: true, skipDirs: null })) {
          const rel = path.relative(root, abs).split(path.sep).join('/');
          if (matcher.test(rel)) {
            candidates.push({ abs, rel });
            if (candidates.length >= GLOB_CANDIDATE_CAP) {
              scanTruncated = true;
              break;
            }
          }
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        if (/timed out/.test(err?.message || '')) throw new Error('glob timed out after 20s; narrow the path or pattern');
        throw err;
      }

      const statted = await Promise.all(
        candidates.map(async (entry) => {
          try {
            const st = await fsp.stat(entry.abs);
            return { ...entry, mtimeMs: st.mtimeMs };
          } catch {
            return null;
          }
        }),
      );
      const files = statted.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
      const shown = files.slice(0, GLOB_MAX_RESULTS);

      if (shown.length === 0) return `No files found under ${root} matching "${args.pattern}".`;
      const lines = [`Found ${files.length}${scanTruncated ? '+' : ''} file(s) under ${root} matching "${args.pattern}" (newest first):`];
      for (const file of shown) lines.push(file.rel);
      if (files.length > shown.length) {
        lines.push(`[showing the ${GLOB_MAX_RESULTS} newest of ${files.length} matches; narrow the pattern for more precision]`);
      }
      if (scanTruncated) {
        lines.push(`[scan stopped after ${GLOB_CANDIDATE_CAP} matches; narrow the path or pattern]`);
      }
      return lines.join('\n');
    },
  });
}

function looksBinary(buffer) {
  const probe = buffer.subarray(0, 8192);
  for (let i = 0; i < probe.length; i += 1) if (probe[i] === 0) return true;
  return false;
}

/** @param {{ workdir?: string }} options */
export function createGrepTool(options = {}) {
  const baseWorkdir = options.workdir ?? process.cwd();

  return defineTool({
    name: 'grep',
    description:
      'Search file contents with a regular expression (JavaScript/ripgrep-ish syntax). Returns matching lines ' +
      `with line numbers, grouped by file. Returns up to ${GREP_MAX_MATCHES} matches; a larger result reports how ` +
      'many were omitted.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression to search for.' },
      path: {
        type: 'string',
        description:
          'File or directory to search. Defaults to the agent working directory; a relative path resolves against it.',
      },
      include: {
        type: 'string',
        description:
          'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.',
      },
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    async execute(args = {}, { signal } = {}) {
      const target = args.path ? resolvePath(args.path, baseWorkdir) : baseWorkdir;
      let regex;
      try {
        regex = new RegExp(String(args.pattern ?? ''));
      } catch (err) {
        throw new Error(`invalid regular expression: ${err.message}`);
      }
      const include = args.include ? compileGlob(args.include) : null;
      const deadline = Date.now() + SEARCH_TIMEOUT_MS;
      const matches = [];
      let timedOut = false;
      let skippedBig = 0;
      let scannedFiles = 0;

      const searchFile = async (abs) => {
        const rel = displayPath(abs, baseWorkdir);
        if (include !== null) {
          const relToRoot = path.relative(
            fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target),
            abs,
          ).split(path.sep).join('/');
          const relToWorkdir = path.relative(baseWorkdir, abs).split(path.sep).join('/');
          if (!include.test(relToRoot) && !include.test(relToWorkdir) && !include.test(path.basename(abs))) return;
        }
        let stat;
        try {
          stat = await fsp.stat(abs);
        } catch {
          return;
        }
        if (!stat.isFile()) return;
        if (stat.size > GREP_MAX_FILE_BYTES) {
          skippedBig += 1;
          return;
        }
        scannedFiles += 1;
        let buffer;
        try {
          buffer = await fsp.readFile(abs);
        } catch {
          return;
        }
        if (looksBinary(buffer)) return;
        const lines = buffer.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (signal?.aborted) throw abortedError();
          if (matches.length >= GREP_MAX_MATCHES) return;
          if (Date.now() > deadline) {
            timedOut = true;
            return;
          }
          const line = lines[i];
          if (line.length > 8000) continue;
          if (regex.test(line)) {
            const preview = line.length > GREP_MAX_LINE_CHARS
              ? `${line.slice(0, GREP_MAX_LINE_CHARS)}…`
              : line;
            matches.push({ path: rel, lineNumber: i + 1, line: preview });
          }
        }
      };

      let targetStat;
      try {
        targetStat = await fsp.stat(target);
      } catch {
        throw new Error(`path not found: ${target}`);
      }
      if (targetStat.isFile()) {
        await searchFile(target);
      } else if (targetStat.isDirectory()) {
        try {
          for await (const abs of walkFiles(target, {
            signal,
            deadline,
            includeHidden: false,
            skipDirs: GREP_SKIP_DIRS,
          })) {
            if (matches.length >= GREP_MAX_MATCHES) break;
            await searchFile(abs);
            if (timedOut) break;
          }
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          if (/timed out/.test(err?.message || '')) timedOut = true;
          else throw err;
        }
      } else {
        throw new Error(`path is neither a file nor a directory: ${target}`);
      }

      if (matches.length === 0) {
        const notes = [`No matches for /${args.pattern}/ under ${displayPath(target, baseWorkdir)}.`];
        if (timedOut) notes.push('[search timed out before finishing]');
        if (skippedBig > 0) notes.push(`[${skippedBig} file(s) larger than 2 MiB were skipped]`);
        return notes.join('\n');
      }

      const byFile = new Map();
      for (const match of matches) {
        if (!byFile.has(match.path)) byFile.set(match.path, []);
        byFile.get(match.path).push(match);
      }
      const lines = [
        `Found ${matches.length}${timedOut ? '+' : ''} match(es) in ${byFile.size} file(s) for /${args.pattern}/ under ${displayPath(target, baseWorkdir)} (${scannedFiles} file(s) searched):`,
      ];
      for (const [file, fileMatches] of byFile) {
        lines.push(file);
        for (const match of fileMatches) lines.push(`  ${match.lineNumber}: ${match.line}`);
      }
      if (timedOut) lines.push('[search timed out; results may be incomplete]');
      if (skippedBig > 0) lines.push(`[${skippedBig} file(s) larger than 2 MiB were skipped]`);
      return lines.join('\n');
    },
  });
}

export { GLOB_MAX_RESULTS, GREP_MAX_MATCHES };
