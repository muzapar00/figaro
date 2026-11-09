// Figaro UI sound effects ("earcons").
//
// Short, quiet confirmations that live *outside* the voice path: they never go
// through MiniMax/TTS, they play on the same PipeWire sink as the voice
// (config.tts.sink), and they can never interrupt speech — each one is its own
// tiny pw-cat process mixed by PipeWire.
//
//   const sfx = createSfx({ config, logger });
//   sfx.play('listenStart');            // event name (honours sfx.events.*)
//   sfx.play('dismiss', { volume: 0.8 }); // sound name (direct)
//   sfx.enabled; sfx.names(); sfx.stats;
//
// Design constraints (see assets/sfx/README.md for the measured levels):
//   * 65-200 ms one-shots, rendered peaks -13..-18 dBFS, default volume 0.35
//   * no piercing highs (centroid 0.4-1.1 kHz, >2 kHz energy >= -11 dB rel.)
//   * play() is async, resolves always, never throws into the daemon
//
// The playback plumbing (sink resolution, pw-cat command, PCM normalisation)
// reuses the tested helpers from ../tts — but no TTS/MiniMax client is involved.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolvePlayerCommand } from '../tts/player.js';
import { normalizePcm } from '../tts/pcm.js';
import { probeAudioSinks, resolveSinkConfig } from '../tts/sink.js';

export const TARGET_RATE = 32000;
export const DEFAULT_SFX_DIR = fileURLToPath(new URL('../../../assets/sfx/', import.meta.url));
export const DEFAULT_EVENTS = Object.freeze({
  listenStart: 'listen-start',
  listenEnd: 'listen-end',
  answerDone: 'answer-done',
  dismiss: 'dismiss',
  error: 'error',
});
export const DEFAULT_VOLUME = 0.35;

const noop = () => {};
const SILENT_LOGGER = { info: noop, warn: noop, error: noop };

function makeLogger(logger) {
  if (logger === null) return SILENT_LOGGER;
  if (logger === undefined) {
    const write = (...args) => {
      try {
        console.error('[sfx]', ...args);
      } catch {
        /* ignore */
      }
    };
    return { info: write, warn: write, error: write };
  }
  const pick = (key) => (typeof logger[key] === 'function' ? logger[key].bind(logger) : noop);
  return { info: pick('info'), warn: pick('warn'), error: pick('error') };
}

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Decode a PCM WAV file to its raw s16le payload.
 *
 * Only the format our assets use is accepted (uncompressed 16-bit PCM); anything
 * else is treated as a load failure by createSfx (silent, stats.failures++).
 *
 * @param {Buffer} buffer
 * @returns {{pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number}}
 */
export function decodeWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw new Error('not a WAV file (too short)');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF file');
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAVE file');
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      if (start + 16 > buffer.length) throw new Error('truncated fmt chunk');
      fmt = {
        format: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bits: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(start, Math.min(buffer.length, start + size));
    }
    offset = start + size + (size % 2);
  }
  if (!fmt) throw new Error('WAV file has no fmt chunk');
  if (!data) throw new Error('WAV file has no data chunk');
  if (fmt.format !== 1) throw new Error(`unsupported WAV encoding ${fmt.format} (need PCM)`);
  if (fmt.bits !== 16) throw new Error(`unsupported WAV bit depth ${fmt.bits} (need 16)`);
  if (fmt.channels < 1) throw new Error('WAV file has no channels');
  if (!(fmt.sampleRate > 0)) throw new Error('WAV file has no sample rate');
  return { pcm: data, sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits };
}

/** Scale 16-bit PCM by a linear gain, clamping to the s16 range. */
export function scaleS16(pcm, gain) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0) return Buffer.alloc(0);
  if (gain === 1) return pcm;
  const out = Buffer.alloc(pcm.length - (pcm.length % 2));
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const value = Math.round(pcm.readInt16LE(i) * gain);
    out.writeInt16LE(value > 32767 ? 32767 : value < -32768 ? -32768 : value, i);
  }
  return out;
}

/**
 * Create the UI-sound module.
 *
 * @param {object} opts
 * @param {object} [opts.config] full daemon config (reads `config.sfx`, and
 *   `config.tts.sink` for the output device)
 * @param {{info:Function, warn:Function, error:Function}|null} [opts.logger]
 *   null = silent; omitted = `[sfx] ...` on stderr
 * @param {Function} [opts.sinkProbe] test seam: () => ({available, defaultSink, ok})
 * @param {string[]|string} [opts.playerCommand] test seam: playback command
 */
export function createSfx({ config = {}, logger, sinkProbe, playerCommand } = {}) {
  const sc = asObject(config.sfx);
  const log = makeLogger(logger);
  const configEnabled = sc.enabled !== false;
  const masterVolume = clamp01(num(sc.volume, DEFAULT_VOLUME));
  const perSoundVolume = asObject(sc.volumes);
  const throttleMs = Math.max(0, num(sc.throttleMs, 40));
  const latencyMs = Math.max(0, num(sc.latencyMs, 40));
  const soundsDir = sc.dir
    ? path.resolve(fileURLToPath(new URL('../../../', import.meta.url)), String(sc.dir))
    : DEFAULT_SFX_DIR;
  const events = { ...DEFAULT_EVENTS };
  for (const [key, value] of Object.entries(asObject(sc.events))) {
    if (value === false || value === true || typeof value === 'string') events[key] = value;
  }

  // ------------------------------------------------------------- output sink --
  const configuredSink = sc.sink !== undefined && sc.sink !== null ? String(sc.sink) : String(config.tts?.sink ?? '');
  let probe;
  try {
    probe = typeof sinkProbe === 'function' ? sinkProbe() : sinkProbe || probeAudioSinks();
  } catch (err) {
    probe = { ok: false, available: [], defaultSink: '', error: err };
  }
  const sinkInfo = resolveSinkConfig(configuredSink, probe);
  const sink = sinkInfo.target;

  // --------------------------------------------------------------- commands --
  let resolvedCommand = null;
  let commandError = null;
  try {
    const resolved = resolvePlayerCommand({
      command: sc.playerCommand || playerCommand || null,
      sink,
      sampleRate: TARGET_RATE,
      latencyMs,
    });
    resolvedCommand = resolved.command;
    if (!resolvedCommand) commandError = new Error(`no audio player found (need pw-cat or aplay)`);
  } catch (err) {
    commandError = err;
  }
  if (commandError) log.warn(`no playback command: ${commandError.message}`);

  if (sinkInfo.status === 'fallback-missing') {
    log.warn(`sink "${sinkInfo.configured}" not found; falling back to default (${sinkInfo.name})`);
  } else if (sinkInfo.status === 'ambiguous') {
    log.warn(`sink "${sinkInfo.configured}" is ambiguous; falling back to default (${sinkInfo.name})`);
  }
  log.info(sink ? `playing to ${sinkInfo.name}` : `playing to default sink (${sinkInfo.name})`);

  // ----------------------------------------------------------------- sounds --
  /** @type {Map<string, {name:string, file:string, pcm:Buffer, durationMs:number}>} */
  const sounds = new Map();
  const warned = new Set();

  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    log.warn(message);
  }

  function loadSounds() {
    let entries;
    try {
      entries = fs.readdirSync(soundsDir, { withFileTypes: true });
    } catch (err) {
      warnOnce(`dir:${soundsDir}`, `sound directory not found: ${soundsDir} (${err.message})`);
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.wav')) continue;
      const file = path.join(soundsDir, entry.name);
      const name = entry.name.replace(/\.wav$/i, '');
      try {
        const decoded = decodeWav(fs.readFileSync(file));
        const pcm = normalizePcm(decoded.pcm, {
          rate: decoded.sampleRate,
          channels: decoded.channels,
          targetRate: TARGET_RATE,
        });
        sounds.set(name, {
          name,
          file,
          pcm,
          durationMs: (pcm.length / 2 / TARGET_RATE) * 1000,
        });
      } catch (err) {
        stats.failures += 1;
        stats.lastError = `cannot load ${entry.name}: ${err.message}`;
        warnOnce(`load:${file}`, `cannot load sound ${entry.name}: ${err.message}`);
      }
    }
    if (sounds.size > 0) {
      log.info(`loaded ${sounds.size} sounds from ${soundsDir}`);
    } else {
      warnOnce('empty', `no usable .wav sounds in ${soundsDir}`);
    }
  }

  // ------------------------------------------------------------------ stats --
  const stats = {
    plays: 0,
    failures: commandError ? 1 : 0,
    skipped: 0,
    active: 0,
    lastPlayedAt: null,
    lastPlayedName: null,
    lastPlayedMs: null,
    lastProcessMs: null,
    lastError: commandError ? commandError.message : null,
  };

  loadSounds();

  const lastPlayedByName = new Map();

  function resolveSound(name) {
    if (typeof name !== 'string' || name.length === 0) return { soundName: null, reason: 'invalid-name' };
    if (sounds.has(name)) return { soundName: name };
    if (Object.prototype.hasOwnProperty.call(events, name)) {
      const mapped = events[name];
      if (mapped === false) return { soundName: null, reason: 'event-disabled' };
      if (typeof mapped === 'string') return { soundName: mapped };
      // `events.listenStart: true` keeps the default mapping if there is one,
      // otherwise camelCase falls back to kebab-case (listenEnd -> listen-end).
      const fallback = DEFAULT_EVENTS[name] || name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      return { soundName: fallback };
    }
    return { soundName: null, reason: 'unknown' };
  }

  function ok(result) {
    return Promise.resolve(result);
  }

  /**
   * Play a sound. Never throws, never rejects, never interrupts the voice.
   *
   * @param {string} name sound name ('listen-start') or event name ('listenStart')
   * @param {{volume?: number}} [opts] extra gain multiplier (0..1]
   * @returns {Promise<{name:string|null, played:boolean, reason?:string, durationMs?:number, processMs?:number}>}
   */
  function play(name, opts = {}) {
    const requested = name;
    if (!configEnabled) return ok({ name: requested, played: false, reason: 'disabled' });
    try {
      const resolved = resolveSound(requested);
      if (!resolved.soundName) {
        if (resolved.reason === 'unknown' || resolved.reason === 'invalid-name') {
          stats.skipped += 1;
          warnOnce(`unknown:${String(requested)}`, `unknown sound "${String(requested)}"`);
        }
        return ok({ name: requested, played: false, reason: resolved.reason });
      }
      const sound = sounds.get(resolved.soundName);
      if (!sound) {
        stats.failures += 1;
        stats.lastError = `sound file missing: ${resolved.soundName}`;
        warnOnce(`missing:${resolved.soundName}`, `sound file missing: ${resolved.soundName}`);
        return ok({ name: resolved.soundName, played: false, reason: 'missing' });
      }
      if (!resolvedCommand) {
        stats.failures += 1;
        stats.lastError = commandError ? commandError.message : 'no playback command';
        return ok({ name: resolved.soundName, played: false, reason: 'no-command' });
      }
      const now = Date.now();
      const lastAt = lastPlayedByName.get(resolved.soundName) || 0;
      if (throttleMs > 0 && now - lastAt < throttleMs) {
        stats.skipped += 1;
        return ok({ name: resolved.soundName, played: false, reason: 'throttled' });
      }
      lastPlayedByName.set(resolved.soundName, now);

      const multiplier =
        num(opts.volume, 1) *
        num(perSoundVolume[resolved.soundName], num(perSoundVolume[requested], 1));
      const volume = clamp01(masterVolume * multiplier);
      if (volume <= 0.0001) return ok({ name: resolved.soundName, played: false, reason: 'muted' });

      const pcm = scaleS16(sound.pcm, volume);
      return spawnPlayback(resolved.soundName, sound, pcm);
    } catch (err) {
      stats.failures += 1;
      stats.lastError = err.message;
      return ok({ name: requested, played: false, reason: 'error' });
    }
  }

  function spawnPlayback(soundName, sound, pcm) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let child;
      let settled = false;
      let stderr = '';
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        stats.active = Math.max(0, stats.active - 1);
        clearTimeout(timer);
        resolve(result);
      };
      try {
        child = spawn(resolvedCommand[0], resolvedCommand.slice(1), {
          stdio: ['pipe', 'ignore', 'pipe'],
        });
      } catch (err) {
        stats.failures += 1;
        stats.lastError = err.message;
        warnOnce('spawn', `cannot spawn player: ${err.message}`);
        finish({ name: soundName, played: false, reason: 'spawn-error' });
        return;
      }
      stats.active += 1;
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        warnOnce(`timeout:${soundName}`, `sound "${soundName}" playback timed out`);
        finish({
          name: soundName,
          played: false,
          reason: 'timeout',
          durationMs: Math.round(sound.durationMs),
          processMs: Date.now() - startedAt,
        });
      }, Math.max(1000, sound.durationMs + 1500));
      timer.unref?.();
      child.on('error', (err) => {
        stats.failures += 1;
        stats.lastError = err.message;
        warnOnce(`player:${soundName}`, `cannot play sound "${soundName}": ${err.message}`);
        finish({ name: soundName, played: false, reason: 'spawn-error' });
      });
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-500);
      });
      child.on('exit', (code, signal) => {
        const processMs = Date.now() - startedAt;
        stats.lastProcessMs = processMs;
        if (code === 0 || signal) {
          stats.plays += 1;
          stats.lastPlayedAt = startedAt;
          stats.lastPlayedName = soundName;
          stats.lastPlayedMs = Math.round(sound.durationMs);
          finish({
            name: soundName,
            played: true,
            durationMs: Math.round(sound.durationMs),
            processMs,
          });
          return;
        }
        stats.failures += 1;
        stats.lastError = `player exited ${code}${stderr ? `: ${stderr.trim().split('\n')[0]}` : ''}`;
        warnOnce(`exit:${soundName}`, `sound "${soundName}" failed: ${stats.lastError}`);
        finish({
          name: soundName,
          played: false,
          reason: 'player-exit',
          durationMs: Math.round(sound.durationMs),
          processMs,
        });
      });
      try {
        child.stdin.write(pcm);
        child.stdin.end();
      } catch (err) {
        stats.failures += 1;
        stats.lastError = err.message;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish({ name: soundName, played: false, reason: 'write-error' });
      }
    });
  }

  return {
    /** Play a sound or an event; resolves always, never rejects. */
    play,
    /** Sound names available on disk (after successful decode). */
    names() {
      return [...sounds.keys()].sort();
    },
    /** Same list as names(); kept as a property for the documented contract. */
    get available() {
      return [...sounds.keys()].sort();
    },
    /** Configured event name -> sound name (false = disabled). */
    get events() {
      return { ...events };
    },
    /** True only when sounds could actually be played. */
    get enabled() {
      return configEnabled && sounds.size > 0 && Boolean(resolvedCommand);
    },
    /** Just the config flag, for "the user turned sounds off" reporting. */
    get configured() {
      return configEnabled;
    },
    get stats() {
      return {
        ...stats,
        sounds: [...sounds.keys()].sort(),
        dir: soundsDir,
        sink,
        sinkName: sinkInfo.name,
        sinkStatus: sinkInfo.status,
        command: resolvedCommand ? [...resolvedCommand] : null,
        volume: masterVolume,
      };
    },
  };
}

export default createSfx;
