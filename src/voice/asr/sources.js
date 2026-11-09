// Audio source for the ASR module.
//
// Production source: `parec` (PipeWire / PulseAudio) streaming raw PCM S16LE
// mono 16 kHz on stdout. The source restarts a crashed `parec` with bounded
// backoff and turns unrecoverable conditions into a single `onFatal` error
// instead of an uncaught exception.
//
// A source factory has the shape:
//   ({onPcm, onError, onFatal}) => { start(): Promise<void>, stop(): Promise<void> }
// where onPcm receives Float32Array samples in [-1, 1] @ 16 kHz.
// Tests inject `createArraySource({pcm})` / `createErrorSource(err)` through the
// `source` option of createAsr() — no microphone required.

import { spawn } from 'node:child_process';

export const SAMPLE_RATE = 16000;

function s16leToFloat32(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

function makeError(message, { cause, props } = {}) {
  const err = new Error(message);
  if (cause) err.cause = cause;
  if (props) Object.assign(err, props);
  return err;
}

/**
 * Factory: spawn parec and emit 16 kHz mono Float32 chunks.
 *
 * @param {object} [opts]
 * @param {string} [opts.command] executable (default: parec)
 * @param {string} [opts.device] PulseAudio/PipeWire source name; omitted => default source
 * @param {number} [opts.chunkMs] chunk size handed to onPcm (default 100 ms)
 * @param {number} [opts.latencyMs] parec --latency-msec (default 30)
 * @param {number} [opts.maxRestarts] consecutive restarts before giving up (default 6)
 * @param {string[]} [opts.extraArgs]
 * @param {number} [opts.startTimeoutMs] how long to wait for the first PCM chunk (default 2500)
 */
export function createParecSource(opts = {}) {
  const {
    command = 'parec',
    device,
    chunkMs = 100,
    latencyMs = 30,
    maxRestarts = 6,
    extraArgs = [],
    startTimeoutMs = 2500,
  } = opts;

  const args = ['--format=s16le', `--rate=${SAMPLE_RATE}`, '--channels=1', `--latency-msec=${latencyMs}`, '--raw'];
  if (device) args.push(`--device=${device}`);
  args.push(...extraArgs);

  const chunkBytes = Math.round((SAMPLE_RATE * chunkMs) / 1000) * 2;

  return function parecSourceFactory({ onPcm, onError = () => {}, onFatal = () => {} }) {
    if (typeof onPcm !== 'function') throw new TypeError('createParecSource: onPcm is required');

    let child = null;
    let stopping = false;
    let gotData = false;
    let restarts = 0;
    let restartTimer = null;
    let startTimer = null;
    let stableTimer = null;
    let lastStderr = '';
    let resolveStart = null;
    let rejectStart = null;
    let pending = Buffer.alloc(0);

    function flushPending() {
      while (pending.length >= chunkBytes) {
        const slice = pending.subarray(0, chunkBytes);
        pending = pending.subarray(chunkBytes);
        try {
          onPcm(s16leToFloat32(slice));
        } catch (err) {
          // A consumer bug must not kill the audio loop.
          onError(makeError(`pcm consumer failed: ${err.message}`, { cause: err, props: { code: 'PCM_CONSUMER' } }));
        }
      }
    }

    function settleStart(err) {
      if (!startTimer) return;
      clearTimeout(startTimer);
      startTimer = null;
      const resolve = resolveStart;
      const reject = rejectStart;
      resolveStart = rejectStart = null;
      if (err) reject?.(err);
      else resolve?.();
    }

    function scheduleRestart(reason) {
      if (stopping) return;
      restarts += 1;
      if (restarts > maxRestarts) {
        onFatal(makeError(`麦克风采集连续失败 ${restarts - 1} 次（${reason}）`, { props: { code: 'MIC_CRASH_LOOP' } }));
        return;
      }
      const delay = Math.min(300 * 2 ** (restarts - 1), 3000);
      onError(makeError(`parec 退出（${reason}），${delay}ms 后重启（第 ${restarts}/${maxRestarts} 次）`, {
        props: { code: 'MIC_RESTART', attempt: restarts, retryInMs: delay },
      }));
      restartTimer = setTimeout(() => {
        restartTimer = null;
        spawnChild(false);
      }, delay);
    }

    function spawnChild(isFirst) {
      if (stopping) return;
      let proc;
      try {
        proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        const e = makeError(`无法启动 ${command}: ${err.message}`, { cause: err, props: { code: 'MIC_SPAWN' } });
        if (isFirst) settleStart(e);
        onFatal(e);
        return;
      }
      child = proc;
      pending = Buffer.alloc(0);
      lastStderr = '';
      gotData = false;

      proc.stdout.on('data', (buf) => {
        if (stopping) return;
        if (!gotData) {
          gotData = true;
          settleStart(null);
          clearTimeout(stableTimer);
          stableTimer = setTimeout(() => { restarts = 0; }, 20_000);
        }
        pending = pending.length ? Buffer.concat([pending, buf]) : buf;
        flushPending();
      });

      proc.stderr.on('data', (buf) => {
        lastStderr = (lastStderr + buf.toString()).slice(-400);
      });

      proc.on('error', (err) => {
        if (child === proc) child = null;
        const e = makeError(`无法运行 ${command}: ${err.message}`, { cause: err, props: { code: 'MIC_SPAWN' } });
        if (isFirst) settleStart(e);
        onFatal(e);
      });

      proc.on('close', (code, signal) => {
        if (child === proc) child = null;
        if (stopping) {
          settleStart(null);
          return;
        }
        const line = lastStderr.trim().split('\n').pop() ?? '';
        const reason = `exit ${code ?? signal}${line ? `: ${line}` : ''}`;
        if (isFirst && !gotData) {
          // Never produced a single sample: a hard start failure, so createAsr()
          // can fail cleanly on machines without a working microphone.
          settleStart(makeError(`没有可用的麦克风（${command} ${reason}）`, {
            props: { code: 'MIC_UNAVAILABLE', stderr: lastStderr.trim() },
          }));
          return;
        }
        scheduleRestart(reason);
      });
    }

    return {
      async start() {
        if (child || stopping) return;
        const p = new Promise((resolve, reject) => {
          resolveStart = resolve;
          rejectStart = reject;
        });
        startTimer = setTimeout(() => {
          // parec can take a moment to open the device; if it is alive but has
          // not delivered samples yet, accept the start and let restart logic run.
          if (child) settleStart(null);
          else settleStart(makeError('等待麦克风启动超时', { props: { code: 'MIC_START_TIMEOUT' } }));
        }, startTimeoutMs);
        spawnChild(true);
        return p;
      },
      async stop() {
        stopping = true;
        clearTimeout(restartTimer);
        clearTimeout(startTimer);
        clearTimeout(stableTimer);
        startTimer = null;
        const proc = child;
        child = null;
        settleStart(null);
        if (!proc) return;
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(killTimer);
            resolve();
          };
          const killTimer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch { /* already gone */ }
            finish();
          }, 1200);
          proc.once('close', finish);
          try { proc.stdout?.destroy(); } catch { /* ignore */ }
          try { proc.kill('SIGTERM'); } catch { finish(); }
        });
        child = null;
      },
    };
  };
}

/**
 * Factory: feed a pre-recorded Float32Array PCM buffer as if it came from the
 * microphone. `realtime` paces chunks with setTimeout (default: as fast as
 * politely possible via setImmediate).
 *
 * @param {{pcm: Float32Array, chunkMs?: number, realtime?: boolean, onEnd?: () => void}} opts
 */
export function createArraySource(opts) {
  const { pcm, chunkMs = 100, realtime = false, onEnd = () => {} } = opts;
  const chunk = Math.round((SAMPLE_RATE * chunkMs) / 1000);

  return function arraySourceFactory({ onPcm }) {
    let cancelled = false;
    let timer = null;
    let offset = 0;

    return {
      async start() {
        const pump = () => {
          if (cancelled) return;
          if (offset >= pcm.length) {
            onEnd();
            return;
          }
          const end = Math.min(offset + chunk, pcm.length);
          const slice = pcm.subarray(offset, end);
          offset = end;
          onPcm(slice);
          if (offset >= pcm.length) {
            onEnd();
            return;
          }
          timer = realtime ? setTimeout(pump, chunkMs) : setImmediate(pump);
        };
        pump();
      },
      async stop() {
        cancelled = true;
        clearTimeout(timer);
      },
    };
  };
}

/**
 * Factory: a source that fails immediately (start() rejects) — for degraded
 * path tests (no microphone / no parec).
 */
export function createErrorSource(err) {
  return function errorSourceFactory() {
    return {
      async start() {
        throw err;
      },
      async stop() {},
    };
  };
}

export default { createParecSource, createArraySource, createErrorSource, SAMPLE_RATE };
