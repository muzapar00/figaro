// Audio output device (PipeWire/PulseAudio sink) selection.
//
// The machine may have several sinks (e.g. front-panel analog jack that is
// auto-muted, and an HDMI monitor speaker that is actually audible in the
// room). We never rely on the *system* default sink: `config.tts.sink` names the
// sink the assistant should talk to. Resolution happens once at module start:
//
//   ""                       -> let pw-cat use the system default sink
//   "<full sink name>"       -> use it as-is
//   "<unique substring>"     -> e.g. "hdmi" resolves to the HDMI sink
//   unknown / ambiguous      -> warn once, fall back to the system default
//
// We validate against `pactl list short sinks` because pw-cat itself does NOT
// fail on a bogus --target (measured: exit code 0), so checking beforehand is
// the only reliable fallback path.

import { execFileSync as nodeExecFileSync } from 'node:child_process';

export const SINK_PROBE_TIMEOUT_MS = 2000;

/**
 * Parse `pactl list short sinks` output.
 * Lines look like: `78\talsa_output.pci-0000_01_00.1.hdmi-stereo\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED`
 * @param {string} text
 * @returns {{index:number|null, name:string, driver:string, state:string}[]}
 */
export function parseShortSinks(text) {
  if (!text) return [];
  const sinks = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\t+/);
    const index = Number(parts[0]);
    const name = (parts[1] || '').trim();
    if (!name) continue;
    sinks.push({
      index: Number.isInteger(index) ? index : null,
      name,
      driver: (parts[2] || '').trim(),
      state: (parts[4] || '').trim(),
    });
  }
  return sinks;
}

/**
 * Query the current audio sinks. Never throws.
 * @param {{execFileSync?: Function}} [deps]
 * @returns {{available: {name:string}[], defaultSink: string, ok: boolean, error?: Error}}
 */
export function probeAudioSinks(deps = {}) {
  const execFileSync = deps.execFileSync || nodeExecFileSync;
  try {
    const listText = execFileSync('pactl', ['list', 'short', 'sinks'], {
      encoding: 'utf8',
      timeout: deps.timeoutMs || SINK_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const available = parseShortSinks(String(listText));
    let defaultSink = '';
    try {
      defaultSink = String(
        execFileSync('pactl', ['get-default-sink'], {
          encoding: 'utf8',
          timeout: deps.timeoutMs || SINK_PROBE_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ).trim();
    } catch {
      /* not fatal: some pactl builds lack get-default-sink */
    }
    if (!defaultSink && available.length > 0) defaultSink = available[0].name;
    return { available, defaultSink, ok: available.length > 0 };
  } catch (err) {
    return { available: [], defaultSink: '', ok: false, error: err };
  }
}

/**
 * Decide which `pw-cat --target` value to use.
 *
 * @param {string|undefined|null} configured `config.tts.sink`
 * @param {{available?: {name:string}[], defaultSink?: string, ok?: boolean, error?: Error}} probe
 * @returns {{target: string, name: string, status: 'default'|'configured'|'resolved'|'fallback-missing'|'ambiguous'|'unverified', configured: string, candidates?: string[]}}
 *   `target` is what goes to pw-cat ('' => system default). `name` is for logs.
 */
export function resolveSinkConfig(configured, probe = {}) {
  const wanted = typeof configured === 'string' ? configured.trim() : '';
  const available = Array.isArray(probe.available) ? probe.available : [];
  const names = available.map((s) => (typeof s === 'string' ? s : s && s.name)).filter(Boolean);
  const defaultSink = probe.defaultSink || names[0] || '';
  const defaultName = defaultSink || '(system default)';

  if (!wanted) {
    return { target: '', name: defaultName, status: 'default', configured: '' };
  }

  if (probe.ok === false) {
    // Cannot verify (pactl missing / server down). Trust the user's config:
    // pw-cat will fall back to the default sink on its own if it is wrong.
    return { target: wanted, name: wanted, status: 'unverified', configured: wanted };
  }

  if (names.includes(wanted)) {
    return { target: wanted, name: wanted, status: 'configured', configured: wanted };
  }

  const needle = wanted.toLowerCase();
  const matches = names.filter((name) => name.toLowerCase().includes(needle));
  if (matches.length === 1) {
    return { target: matches[0], name: matches[0], status: 'resolved', configured: wanted };
  }
  if (matches.length > 1) {
    return {
      target: '',
      name: defaultName,
      status: 'ambiguous',
      configured: wanted,
      candidates: matches,
    };
  }
  return {
    target: '',
    name: defaultName,
    status: 'fallback-missing',
    configured: wanted,
    candidates: names,
  };
}

/**
 * Convenience wrapper: probe the system, then resolve the config value.
 * @param {string|undefined|null} configured
 * @param {{execFileSync?: Function}} [deps]
 */
export function resolveSinkForConfig(configured, deps = {}) {
  return resolveSinkConfig(configured, probeAudioSinks(deps));
}

export default resolveSinkForConfig;
