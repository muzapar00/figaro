// Shared helpers for tests/sfx — hermetic, no real sound card.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeTempDir(prefix = 'figaro-sfx-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A "player" that captures the PCM it is given into a file. */
export function fileSinkCommand(file) {
  return ['bash', '-c', `exec cat > ${JSON.stringify(file)}`];
}

export function trackedLogger() {
  const lines = [];
  return {
    lines,
    logger: {
      info: (...args) => lines.push(['info', ...args]),
      warn: (...args) => lines.push(['warn', ...args]),
      error: (...args) => lines.push(['error', ...args]),
    },
  };
}

/** Deterministic fake `pactl` probe result. */
export function fakeSinkProbe() {
  return {
    ok: true,
    defaultSink: 'fake-sink-analog',
    available: [
      { name: 'fake-sink-analog', driver: 'PipeWire' },
      { name: 'fake-sink-hdmi', driver: 'PipeWire' },
    ],
  };
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function readFile(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return Buffer.alloc(0);
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(cond, { timeoutMs = 3000, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return true;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await delay(intervalMs);
  }
}
