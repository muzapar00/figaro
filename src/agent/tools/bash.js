// bash tool: `bash -c` in a fresh shell, bounded by a timeout, with output
// truncation and an optional spill file for the untruncated output.
//
// Behaviour mirrors @deepseek-ai/dsh-tool-bash: fresh shell per call, explicit
// workdir instead of `cd`, [exit code: N] marker, tail-truncated output with the
// full text saved when available.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineTool } from './define.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 50;
const MAX_OUTPUT_CHARS = 20_000;
const TAIL_CHARS = 6_000;
const SPILL_BYTES = 4 * 1024 * 1024; // keep at most this much output in memory
const KILL_GRACE_MS = 1_500;

const BASH_DESCRIPTION =
  'Execute a bash command (`bash -c`) and return its stdout/stderr. Each call runs in a fresh shell; ' +
  'pass `workdir` instead of using `cd`. Long output is truncated to its tail; the full output is saved ' +
  'to a file whose path is reported when available. Provide `description` before `command` in the ' +
  'arguments. Before any delete or move, verify that the resolved absolute target path is the intended ' +
  'one; never run it against a computed path you have not checked. An unset variable expands to an empty ' +
  'string, so guard variables in such paths with `${VAR:?}`.';

function clampTimeout(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.round(n), MIN_TIMEOUT_MS), max);
}

/** Kill the whole process group of a detached child; never signal our own group. */
function killGroup(child, sig) {
  if (!child || child.pid === undefined) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

/** @param {{ defaultTimeoutMs?: number, maxTimeoutMs?: number, workdir?: string, spillDir?: string }} options */
export function createBashTool(options = {}) {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = options.maxTimeoutMs ?? MAX_TIMEOUT_MS;
  const baseWorkdir = options.workdir ?? process.cwd();
  const spillDir = options.spillDir ?? path.join(os.tmpdir(), 'figaro-tool-output');

  function saveSpill(command, text) {
    try {
      fs.mkdirSync(spillDir, { recursive: true, mode: 0o700 });
      const file = path.join(
        spillDir,
        `bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`,
      );
      fs.writeFileSync(file, `# command: ${command}\n\n${text}`, 'utf8');
      return file;
    } catch {
      return undefined;
    }
  }

  function render({ command, cwd, exitCode, exitSignal, timedOut, aborted, timeoutMs, text, truncated }) {
    const parts = [`cwd: ${cwd}`];
    const flags = [];
    if (timedOut) flags.push(`timed out after ${timeoutMs}ms`);
    if (aborted) flags.push('aborted');
    parts.push(`[exit code: ${exitCode === null ? 'null' : exitCode}]${flags.length ? ` [${flags.join('] [')}]` : ''}`);
    if (exitSignal) parts.push(`[signal: ${exitSignal}]`);

    let body = text;
    if (truncated || body.length > MAX_OUTPUT_CHARS) {
      const spill = saveSpill(command, body);
      const tail = body.length > TAIL_CHARS ? body.slice(-TAIL_CHARS) : body;
      const note = [
        `[output truncated: command produced ${body.length} chars; showing the last ${tail.length} chars.`,
        spill ? `  full output saved to ${spill}]` : '  full output could not be saved]',
      ].join('\n');
      body = `${note}\n${tail}`;
    }
    parts.push('');
    parts.push(body.length > 0 ? body : '(no output)');
    return parts.join('\n');
  }

  return defineTool({
    name: 'bash',
    description: BASH_DESCRIPTION,
    parameters: {
      description: {
        type: 'string',
        required: true,
        description:
          'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). ' +
          'Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; ' +
          '"npm install" → "Install package dependencies".',
      },
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      timeoutMs: {
        type: 'number',
        description:
          'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
      },
      workdir: {
        type: 'string',
        description:
          'Working directory for this command. Defaults to the agent working directory; a relative path is resolved against it.',
      },
    },
    timeoutMs: defaultTimeoutMs,
    async execute(args = {}, { signal } = {}) {
      const command = typeof args.command === 'string' ? args.command : '';
      if (command.trim().length === 0) throw new Error('command must be a non-empty string');
      const cwd = args.workdir
        ? path.resolve(baseWorkdir, String(args.workdir))
        : baseWorkdir;
      let stat;
      try {
        stat = fs.statSync(cwd);
      } catch {
        throw new Error(`workdir does not exist: ${cwd}`);
      }
      if (!stat.isDirectory()) throw new Error(`workdir is not a directory: ${cwd}`);
      const timeoutMs = clampTimeout(args.timeoutMs, defaultTimeoutMs, maxTimeoutMs);

      return await new Promise((resolve) => {
        let settled = false;
        let timedOut = false;
        let aborted = false;
        const buffers = [];
        let keptBytes = 0;
        let droppedBytes = 0;
        let timeoutTimer;
        let killTimer;

        const finish = (payload) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutTimer);
          clearTimeout(killTimer);
          signal?.removeEventListener?.('abort', onAbort);
          resolve(render({ command, cwd, timeoutMs, ...payload }));
        };

        let child;
        try {
          child = spawn('bash', ['-c', command], {
            cwd,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, FIGARO_AGENT: '1' },
          });
        } catch (err) {
          finish({
            exitCode: null,
            exitSignal: null,
            timedOut: false,
            aborted: false,
            text: `failed to start bash: ${err?.message || err}`,
            truncated: false,
          });
          return;
        }

        const collect = (buf) => {
          if (keptBytes + buf.length <= SPILL_BYTES) {
            buffers.push(buf);
            keptBytes += buf.length;
          } else {
            droppedBytes += buf.length;
          }
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);

        const onAbort = () => {
          aborted = true;
          killGroup(child, 'SIGKILL');
        };
        if (signal?.aborted) {
          onAbort();
        } else {
          signal?.addEventListener?.('abort', onAbort, { once: true });
        }

        timeoutTimer = setTimeout(() => {
          timedOut = true;
          killGroup(child, 'SIGTERM');
          killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
          killTimer.unref?.();
        }, timeoutMs);
        timeoutTimer.unref?.();

        child.on('error', (err) => {
          finish({
            exitCode: null,
            exitSignal: null,
            timedOut,
            aborted,
            text: `failed to run bash: ${err?.message || err}`,
            truncated: false,
          });
        });
        child.on('close', (code, sig) => {
          const text = Buffer.concat(buffers).toString('utf8');
          const truncated = droppedBytes > 0;
          const suffix = droppedBytes > 0 ? `\n[${droppedBytes} bytes of output beyond the 4 MiB capture cap were dropped]` : '';
          finish({
            exitCode: typeof code === 'number' ? code : null,
            exitSignal: sig || null,
            timedOut,
            aborted,
            text: text + suffix,
            truncated,
          });
        });
      });
    },
  });
}

export const bashToolDefaults = { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_OUTPUT_CHARS };
