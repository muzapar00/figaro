// read / write / edit tools over the local filesystem.
//
// Schemas and descriptions are carried over from @deepseek-ai/dsh-tool-fs; the
// implementation is Figaro's own (line-numbered reads, atomic writes, exact
// literal replacement).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { defineTool } from './define.js';
import { resolvePath } from './resolve.js';
import { atomicWriteFile } from './atomic-write.js';

const READ_MAX_BYTES = 8 * 1024 * 1024;
const READ_DEFAULT_LIMIT = 2000;
const READ_MAX_LIMIT = 5000;
const READ_MAX_LINE_CHARS = 2000;

function looksBinary(buffer) {
  const probe = buffer.subarray(0, 8192);
  for (let i = 0; i < probe.length; i += 1) {
    if (probe[i] === 0) return true;
  }
  return false;
}

export function createReadTool(options = {}) {
  const baseWorkdir = options.workdir ?? process.cwd();

  return defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Path to read, resolved against the agent working directory.',
      },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: {
        type: 'number',
        description: `Maximum number of lines to return. Defaults to ${READ_DEFAULT_LIMIT}.`,
      },
    },
    timeoutMs: 30_000,
    async execute(args = {}) {
      const abs = resolvePath(args.file_path ?? args.path, baseWorkdir);
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch (err) {
        if (err.code === 'ENOENT') throw new Error(`file not found: ${abs}`);
        throw new Error(`cannot stat ${abs}: ${err.message}`);
      }
      if (stat.isDirectory()) throw new Error(`${abs} is a directory, not a file`);
      if (stat.size > READ_MAX_BYTES) {
        throw new Error(
          `file is ${stat.size} bytes, larger than the ${READ_MAX_BYTES}-byte read cap; use bash (head/sed) or grep instead`,
        );
      }
      let buffer;
      try {
        buffer = await fsp.readFile(abs);
      } catch (err) {
        throw new Error(`cannot read ${abs}: ${err.message}`);
      }

      const text = buffer.toString('utf8');
      const allLines = text.split(/\r?\n/);
      if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop();

      const total = allLines.length;
      const offset = Number.isFinite(Number(args.offset)) && Number(args.offset) >= 1
        ? Math.floor(Number(args.offset))
        : 1;
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) >= 1
        ? Math.min(Math.floor(Number(args.limit)), READ_MAX_LIMIT)
        : READ_DEFAULT_LIMIT;
      const start = Math.min(offset, total + 1);
      const end = Math.min(start + limit - 1, total);
      const width = String(end).length;

      const out = [`<path>${abs}</path>`];
      if (total === 0) {
        out.push('(file is empty)');
      } else if (start > total) {
        out.push(`(offset ${offset} is past the end of the file: ${total} lines)`);
      } else {
        for (let n = start; n <= end; n += 1) {
          let line = allLines[n - 1];
          if (line.length > READ_MAX_LINE_CHARS) {
            line = `${line.slice(0, READ_MAX_LINE_CHARS)}… [line truncated at ${READ_MAX_LINE_CHARS} chars]`;
          }
          out.push(`${String(n).padStart(width, ' ')}\t${line}`);
        }
        if (end < total) {
          out.push(`[showing lines ${start}-${end} of ${total}; call read again with offset ${end + 1} to continue]`);
        }
      }
      return out.join('\n');
    },
  });
}

export function createWriteTool(options = {}) {
  const baseWorkdir = options.workdir ?? process.cwd();

  return defineTool({
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description:
          'Path to write, resolved against the agent working directory. Provide `file_path` before `content` in the arguments.',
      },
      content: { type: 'string', required: true, description: 'Full UTF-8 text content to write.' },
    },
    timeoutMs: 30_000,
    async execute(args = {}) {
      const abs = resolvePath(args.file_path ?? args.path, baseWorkdir);
      if (typeof args.content !== 'string') throw new Error('content must be a string');
      await atomicWriteFile(abs, args.content);
      const bytes = Buffer.byteLength(args.content, 'utf8');
      return `Wrote ${bytes} bytes to ${abs}.`;
    },
  });
}

export function createEditTool(options = {}) {
  const baseWorkdir = options.workdir ?? process.cwd();

  return defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description:
          'Path to edit, resolved against the agent working directory. Provide `file_path` before `old_string` and `new_string` in the arguments.',
      },
      old_string: { type: 'string', required: true, description: 'Literal text to replace.' },
      new_string: {
        type: 'string',
        required: true,
        description: 'Literal replacement text. Use an empty string to delete the match.',
      },
      replace_all: {
        type: 'boolean',
        description:
          'Replace all matches. Defaults to false; when false, old_string must appear exactly once.',
      },
    },
    timeoutMs: 30_000,
    async execute(args = {}) {
      const abs = resolvePath(args.file_path ?? args.path, baseWorkdir);
      if (typeof args.old_string !== 'string' || args.old_string.length === 0) {
        throw new Error('old_string must be a non-empty string');
      }
      if (typeof args.new_string !== 'string') throw new Error('new_string must be a string');
      if (args.old_string === args.new_string) throw new Error('old_string and new_string are identical; nothing to change');

      const before = await fsp.readFile(abs, 'utf8').catch((err) => {
        if (err.code === 'ENOENT') throw new Error(`file not found: ${abs} (create it with write instead)`);
        throw err;
      });

      const occurrences = before.split(args.old_string).length - 1;
      if (occurrences === 0) {
        throw new Error(`old_string was not found in ${abs}; read the file first and copy the exact text`);
      }
      const replaceAll = args.replace_all === true;
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `old_string appears ${occurrences} times in ${abs}; include more surrounding context to make it unique, or set replace_all to true`,
        );
      }

      const after = replaceAll
        ? before.split(args.old_string).join(args.new_string)
        : before.replace(args.old_string, args.new_string);
      await atomicWriteFile(abs, after);
      return replaceAll
        ? `The file ${abs} has been updated. All ${occurrences} occurrences were successfully replaced.`
        : `The file ${abs} has been updated successfully.`;
    },
  });
}

export { READ_MAX_BYTES };
