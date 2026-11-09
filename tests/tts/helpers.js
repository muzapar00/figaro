// Shared helpers for tests/tts/*.test.js
//
// Everything here is local-only: a temp dir, a file sink that plays the role of
// pw-cat, and a config factory pointing at the fake MiniMax server.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeTempDir(prefix = 'figaro-tts-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A "player" that captures PCM bytes to a file instead of making noise. */
export function fileSinkCommand(file) {
  return ['bash', '-c', `exec cat > ${JSON.stringify(file)}`];
}

/** A "player" that blocks forever, for interrupt/kill tests. */
export function blockingSinkCommand() {
  return ['bash', '-c', 'exec sleep 600'];
}

export function makeConfig({
  wsUrl,
  apiKey = 'test-api-key',
  model = 'speech-2.6-turbo',
  voiceId = 'male-qn-jingying',
  playerCommand = null,
  tts = {},
  minimax = {},
} = {}) {
  return {
    minimax: {
      wsUrl,
      apiKey,
      model,
      voiceId,
      speed: 1,
      volume: 1,
      pitch: 0,
      sampleRate: 32000,
      format: 'pcm',
      endpointTimeoutMs: 3000,
      ...minimax,
    },
    tts: {
      enabled: true,
      maxInFlight: 3,
      maxBufferChars: 220,
      minSentencesBeforeStart: 1,
      playbackTailMs: 20,
      playerKeepAliveMs: 50,
      playerLatencyMs: 10,
      playerCommand,
      levelSliceMs: 32,
      wsIdleCloseMs: 60000,
      requestTimeoutMs: 4000,
      maxReconnects: 1,
      ...tts,
    },
  };
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export async function waitForFileSize(file, minBytes, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const size = fileSize(file);
    if (size >= minBytes) return size;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${file} >= ${minBytes} bytes (now ${size})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function readFile(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return Buffer.alloc(0);
  }
}

export function trackedCallbacks() {
  const levels = [];
  const states = [];
  const errors = [];
  return {
    levels,
    states,
    errors,
    onLevel: (v) => levels.push({ at: Date.now(), value: v }),
    onState: (s) => states.push({ at: Date.now(), state: s }),
    onError: (e) => errors.push(e),
  };
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout(promise, ms, label = 'promise') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label} after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
