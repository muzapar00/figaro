// PCM playback sink for the TTS module.
//
// The synthesizer returns raw 16-bit little-endian mono PCM at 32 kHz. We pipe
// it straight into a single long-lived `pw-cat` (or `aplay`) child process:
//   - one process per speaking turn => no hard gaps between sentences
//   - the process starts lazily on the first audio byte => first word is heard
//     as soon as the first network chunk lands
//   - SIGKILL on stop() => real barge-in (the stream is torn down immediately)
//
// The player also produces *playback-paced* RMS levels: audio arrives from the
// network much faster than realtime, so levels are scheduled on a playback
// timeline instead of being emitted at network speed.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BYTES_PER_SAMPLE = 2;

function which(cmd) {
  const raw = process.env.PATH || '';
  const dirs = raw.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Build a pw-cat command line (pure, unit-testable).
 * @param {{binary?: string, sampleRate?: number, latencyMs?: number, sink?: string}} [opts]
 * @returns {string[]}
 */
export function buildPwCatCommand(opts = {}) {
  const sampleRate = opts.sampleRate || 32000;
  const latencyMs = opts.latencyMs || 40;
  const sink = (opts.sink || '').trim();
  const cmd = [
    opts.binary || 'pw-cat',
    '--playback',
    '--raw',
    '--format=s16',
    `--rate=${sampleRate}`,
    '--channels=1',
    `--latency=${latencyMs}ms`,
  ];
  if (sink) cmd.push(`--target=${sink}`);
  cmd.push('-');
  return cmd;
}

/**
 * Find a usable playback command.
 * @param {{sampleRate?: number, latencyMs?: number, command?: string|string[], sink?: string}} [opts]
 *   `sink` is a PipeWire/PulseAudio sink name; '' => system default sink.
 *   A caller-provided `command` override is used verbatim (it owns its own routing).
 * @returns {{command: string[]|null, source: string, target: string}}
 */
export function resolvePlayerCommand(opts = {}) {
  const sampleRate = opts.sampleRate || 32000;
  const latencyMs = opts.latencyMs || 40;
  const sink = (opts.sink || '').trim();
  if (opts.command) {
    const command = Array.isArray(opts.command)
      ? opts.command.map(String)
      : String(opts.command).split(/\s+/).filter(Boolean);
    if (command.length) return { command, source: 'config', target: sink };
  }
  const pwCat = which('pw-cat');
  if (pwCat) {
    return {
      source: 'pw-cat',
      target: sink,
      command: buildPwCatCommand({ binary: pwCat, sampleRate, latencyMs, sink }),
    };
  }
  const aplay = which('aplay');
  if (aplay) {
    // aplay speaks ALSA device names, not PipeWire sink names: no --target here.
    return {
      source: 'aplay',
      target: '',
      command: [aplay, '-q', '-t', 'raw', '-f', 'S16_LE', `-r${sampleRate}`, '-c1', '-'],
    };
  }
  return { command: null, source: 'none', target: '' };
}

function rmsOfPcm(buf) {
  const samples = Math.floor(buf.length / 2);
  if (samples <= 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(i * 2);
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / samples) / 32768;
  return Math.max(0, Math.min(1, rms));
}

/**
 * @param {object} opts
 * @param {number} [opts.sampleRate=32000]
 * @param {string} [opts.sink] PipeWire/PulseAudio sink name ('' = system default)
 * @param {string|string[]|null} [opts.command] override playback command
 * @param {number} [opts.latencyMs=40] requested device latency (pw-cat only)
 * @param {number} [opts.sliceMs=64] level publishing period (~15 Hz)
 * @param {(level:number)=>void} [opts.onLevel]
 * @param {(err:Error)=>void} [opts.onError]
 * @param {(info:object)=>void} [opts.onExit]
 */
export function createPlayer(opts = {}) {
  const sampleRate = opts.sampleRate || 32000;
  const sliceMs = opts.sliceMs || 64;
  const sliceSamples = Math.max(64, Math.round((sampleRate * sliceMs) / 1000));
  const sliceBytes = sliceSamples * BYTES_PER_SAMPLE;

  const { command, source, target } = resolvePlayerCommand({
    sampleRate,
    latencyMs: opts.latencyMs || 40,
    command: opts.command,
    sink: opts.sink || '',
  });

  let child = null;
  let exited = false;
  let ending = false;
  let killed = false;
  let killAt = 0;
  let writtenBytes = 0;
  let spawnError = null;
  let stderrTail = '';
  let pending = Buffer.alloc(0);
  let timeline = []; // [{at: number, rms: number}]
  let clockEnd = 0;
  let ticker = null;

  function emitLevel(level) {
    if (typeof opts.onLevel !== 'function') return;
    try {
      opts.onLevel(level);
    } catch {
      /* listener bug must not break audio */
    }
  }

  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      const now = Date.now();
      while (timeline.length > 0 && timeline[0].at <= now) {
        emitLevel(timeline.shift().rms);
      }
      if (timeline.length === 0 && (exited || ending)) {
        clearInterval(ticker);
        ticker = null;
        if (!exited) emitLevel(0);
      }
    }, 16);
    ticker.unref?.();
  }

  function enqueueLevel(rms) {
    const now = Date.now();
    const at = Math.max(now, clockEnd);
    clockEnd = at + sliceMs;
    timeline.push({ at, rms });
    ensureTicker();
  }

  function start() {
    if (child) return true;
    if (!command) {
      const err = new Error('no audio player found (need pw-cat or aplay in PATH)');
      spawnError = err;
      exited = true;
      try {
        opts.onError?.(err);
      } catch {
        /* ignore */
      }
      return false;
    }
    try {
      child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      child = null;
      spawnError = err;
      exited = true;
      try {
        opts.onError?.(err);
      } catch {
        /* ignore */
      }
      return false;
    }
    child.on('error', (err) => {
      spawnError = err;
      exited = true;
      try {
        opts.onError?.(err);
      } catch {
        /* ignore */
      }
      fireExit({ code: null, signal: null, expected: false, error: err });
    });
    child.stdin?.on('error', () => {
      /* EPIPE when the sink dies mid-stream; exit handler reports it */
    });
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    child.on('exit', (code, signal) => {
      exited = true;
      const expected = ending || killed;
      fireExit({
        code,
        signal,
        expected,
        killLatencyMs: killed && killAt ? Math.round(performance.now() - killAt) : null,
        stderr: stderrTail,
      });
    });
    return true;
  }

  let exitFired = false;
  function fireExit(info) {
    if (exitFired) return;
    exitFired = true;
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    // The sink exited normally => everything still on our timeline was played
    // (or at least handed to the device). Publish the remaining levels so the
    // UI's level stream ends in sync with the audio.
    if (!info.error) {
      while (timeline.length > 0) emitLevel(timeline.shift().rms);
    } else {
      timeline = [];
    }
    try {
      opts.onExit?.(info);
    } catch {
      /* ignore */
    }
  }

  function feed(buf) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) return true;
    if (!start()) return false;
    if (exited || !child || !child.stdin || child.stdin.destroyed) return false;
    try {
      child.stdin.write(buf);
    } catch (err) {
      spawnError = err;
      return false;
    }
    writtenBytes += buf.length;
    // build level slices from whatever is buffered
    pending = pending.length ? Buffer.concat([pending, buf]) : buf;
    while (pending.length >= sliceBytes) {
      const slice = pending.subarray(0, sliceBytes);
      pending = pending.subarray(sliceBytes);
      enqueueLevel(rmsOfPcm(slice));
    }
    return true;
  }

  return {
    source,
    command,
    target,
    sampleRate,
    /** Write PCM (16-bit LE mono). Returns false if the sink is gone. */
    write(buf) {
      return feed(buf);
    },
    /** Graceful end: close stdin; the sink exits once its buffer drains. */
    end() {
      if (!child || exited) return;
      ending = true;
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
    },
    /** Hard interrupt: SIGKILL the sink. Returns immediately. */
    kill() {
      if (!child || exited) {
        exited = true;
        return;
      }
      killed = true;
      killAt = performance.now();
      timeline = [];
      if (ticker) {
        clearInterval(ticker);
        ticker = null;
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    },
    get alive() {
      return Boolean(child) && !exited;
    },
    get writable() {
      return Boolean(child) && !exited && !ending;
    },
    get pid() {
      return child ? child.pid : null;
    },
    get writtenBytes() {
      return writtenBytes;
    },
    get spawned() {
      return Boolean(child);
    },
    get error() {
      return spawnError;
    },
    get stderr() {
      return stderrTail;
    },
  };
}

export { rmsOfPcm };
export default createPlayer;
