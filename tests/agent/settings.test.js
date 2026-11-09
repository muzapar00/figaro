// docs/ipc.md §3.1 tests: config.get/config.set (masking, whitelist, atomic
// write, hot apply), mic/asr/wake/tts self-tests, service.restart, diagnostics,
// and the "unsupported" degradation when the voice modules are missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDaemon } from '../../src/daemon.js';
import { createIpcClient } from '../../src/ipc.js';
import {
  sanitizeConfig,
  flattenPatch,
  validatePatchPaths,
  deepMergeConfig,
  readConfigFile,
} from '../../src/agent/settings.js';
import { makeTestConfig, silentLogger, waitFor } from './fake-llm.js';

const SECRET = 'sk-REAL-SECRET-DO-NOT-LEAK';

function makeFakeAsr() {
  const record = {
    cbs: null,
    mic: null,
    micStop: 0,
    asrTest: null,
    wake: null,
    disarm: 0,
    runtime: [],
    appliedRuntime: null,
  };
  const factory = (options) => {
    record.cbs = options;
    record.config = options.config;
    return {
      async start() {},
      async stop() {},
      beginCapture() {},
      endCapture() {},
      get capturing() {
        return false;
      },
      get state() {
        return 'listening';
      },
      get micGainInfo() {
        return { available: true, percent: 65, rms: 0.2, peak: 0.5 };
      },
      get micInfo() {
        return { rms: 0.12, peak: 0.34 };
      },
      get modelInfo() {
        return { kws: 'models/kws', offline: 'paraformer' };
      },
      get hotkeyState() {
        return { state: 'bound', bound: true };
      },
      get muted() {
        return false;
      },
      get lastFinalMs() {
        return 123;
      },
      startMicTest(args) {
        record.mic = args;
      },
      stopMicTest() {
        record.micStop += 1;
        record.mic?.onEnd?.();
      },
      startAsrTest(args) {
        record.asrTest = args;
      },
      stopAsrTest() {
        record.asrTest?.onResult?.({ text: '你好世界', streamingText: '你好世界', ms: 180, audioMs: 1200 });
      },
      armWakeTest(args) {
        record.wake = args;
      },
      disarmWakeTest() {
        record.disarm += 1;
        // Real module: disarmWakeTest() finishes the window and emits onEnd sync.
        record.wake?.onEnd?.({ hits: 0, misses: 0, falseAlarms: 0, maxScore: 0, ms: 10 });
      },
      applyRuntimeConfig(values) {
        record.runtime.push(values);
        record.appliedRuntime = values;
        return { applied: ['asr.sensitivity', 'asr.wakeCooldownMs', 'asr.inputGainPercent'] };
      },
    };
  };
  return { factory, record };
}

function makeFakeTts() {
  const record = { created: 0, configs: [], stopped: 0, synthesized: [], played: 0 };
  const factory = (options) => {
    record.created += 1;
    record.configs.push({
      voiceId: options.config?.minimax?.voiceId,
      sink: options.config?.tts?.sink,
      model: options.config?.minimax?.model,
    });
    return {
      async speak() {},
      async flush() {},
      stop() {
        record.stopped += 1;
      },
      get speaking() {
        return false;
      },
      async synthesize(text, opts) {
        record.synthesized.push({ text, opts });
        return { pcm: Buffer.alloc(640, 3), sampleRate: 32000, durationMs: 20, sentences: 1, ms: 15, ttfbMs: 10 };
      },
      playPcm(pcm, opts) {
        record.played += 1;
        record.lastPlay = { bytes: pcm.length, opts };
        return Promise.resolve({ bytes: pcm.length, durationMs: 20, completed: true });
      },
      stats: {
        model: 'speech-2.6-turbo',
        voiceId: options.config?.minimax?.voiceId ?? 'male-qn-jingying',
        audioSink: (options.config?.tts?.sink || 'alsa_output.pci-0000_00_1f.3.analog-stereo'),
        audioSinkName: (options.config?.tts?.sink || 'alsa_output.pci-0000_00_1f.3.analog-stereo'),
        sinkStatus: 'ok',
        connected: false,
        lastFirstAudioMs: 170,
        lastRequestToFirstAudioMs: 150,
        lastSpeakingMs: 800,
      },
    };
  };
  return { factory, record };
}

function makeFakeAck() {
  const record = { created: 0, prepared: 0 };
  const factory = (options) => {
    record.created += 1;
    record.config = options.config;
    return {
      enabled: true,
      timeoutMs: 800,
      phrases: ['我在'],
      get ready() {
        return true;
      },
      async prepare() {
        record.prepared += 1;
        return true;
      },
      play() {
        return null;
      },
      stop() {},
      close() {},
      stats: { model: 'speech-2.6-turbo', voiceId: 'male-qn-jingying', disabledReason: null, lastPhrase: null, lastPlayDurationMs: null, failures: 0 },
    };
  };
  return { factory, record };
}

async function makeContext(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figaro-settings-test-'));
  const socketPath = path.join(dir, 'sock');
  const configPath = path.join(dir, 'config.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      deepseek: { apiKey: SECRET },
      minimax: { apiKey: SECRET },
      asr: { wakeWords: ['费加罗'], sensitivity: 'low' },
      tts: { sink: '' },
    }),
    { mode: 0o600 },
  );
  const baseConfig = {
    ...makeTestConfig({ socket: socketPath }),
    asr: {
      enabled: true,
      sensitivity: 'low',
      wakeCooldownMs: 2500,
      inputGainPercent: null,
      hotkey: 'CTRL+ALT+F5',
      wakeWords: ['费加罗'],
    },
    tts: { enabled: true, sink: '', ack: { enabled: true, phrases: ['我在'], timeoutMs: 800 } },
  };
  const reloadConfigFn = async () => deepMergeConfig(baseConfig, JSON.parse(await fs.readFile(configPath, 'utf8')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, socketPath, configPath, baseConfig, reloadConfigFn };
}

const DEFAULT_SINKS = [
  { name: 'alsa_output.pci-0000_00_1f.3.analog-stereo', description: 'Built-in Audio Analog Stereo', isDefault: true },
  { name: 'alsa_output.pci-0000_01_00.1.hdmi-stereo', description: 'HDMI Audio', isDefault: false },
];

async function startSettingsDaemon(t, overrides = {}) {
  const ctx = overrides.ctx ?? (await makeContext(t));
  const asr = overrides.asr ?? makeFakeAsr();
  const tts = overrides.tts ?? makeFakeTts();
  const ack = overrides.ack ?? makeFakeAck();
  const restartRequests = [];
  const texts = [];
  const config = { ...ctx.baseConfig };
  const daemon = createDaemon({
    config,
    voice: overrides.voice ?? true,
    logger: silentLogger,
    agentFactory: () => ({
      history: [],
      reset() {},
      async run({ text }) {
        texts.push(text);
        return { text: `回声：${text}` };
      },
    }),
    asrFactory: asr.factory,
    ttsFactory: tts.factory,
    ackFactory: ack.factory,
    configPath: ctx.configPath,
    reloadConfigFn: ctx.reloadConfigFn,
    restartFn: () => restartRequests.push(Date.now()),
    listSinks: overrides.listSinks ?? (async () => DEFAULT_SINKS),
  });
  await daemon.start();
  t.after(async () => {
    await daemon.stop();
  });
  const messages = [];
  const client = createIpcClient({ socketPath: ctx.socketPath, onMessage: (message) => messages.push(message) });
  await client.connect();
  t.after(() => client.close());
  client.send({ type: 'subscribe' });
  await waitFor(() => messages.some((message) => message.type === 'state'), { label: 'initial state' });
  if (overrides.voice !== false) {
    await waitFor(() => daemon.voice.asr && daemon.voice.tts, { label: 'voice modules' });
  }
  return { daemon, client, messages, ctx, asr, tts, ack, config, restartRequests, texts };
}

async function request(client, messages, message, label) {
  const from = messages.length;
  client.send(message);
  await waitFor(
    () => messages.slice(from).some((reply) => reply.type !== 'state' && reply.type !== 'level'),
    { label: label ?? message.type, timeoutMs: 4000 },
  );
  return messages.slice(from).find((reply) => reply.type !== 'state' && reply.type !== 'level');
}

// ---------------------------------------------------------------- pure helpers

test('sanitizeConfig masks the api keys and leaves everything else intact', () => {
  const sanitized = sanitizeConfig({
    deepseek: { apiKey: 'real-key', model: 'deepseek-flash' },
    minimax: { apiKey: 'mm-key', voiceId: 'v' },
    asr: { sensitivity: 'low' },
  });
  assert.equal(sanitized.deepseek.apiKey, '***');
  assert.equal(sanitized.minimax.apiKey, '***');
  assert.equal(sanitized.deepseek.model, 'deepseek-flash');
  assert.deepEqual(sanitized.asr, { sensitivity: 'low' });
  assert.doesNotMatch(JSON.stringify(sanitized), /real-key|mm-key/);
});

test('patch flattening and whitelist validation', () => {
  assert.deepEqual(flattenPatch({ asr: { sensitivity: 'high' }, tts: { ack: { phrases: ['在'] } } }), [
    'asr.sensitivity',
    'tts.ack.phrases',
  ]);
  const { allowed, forbidden } = validatePatchPaths({
    asr: { sensitivity: 'high', wakeCooldownMs: 3000 },
    tts: { ack: { enabled: false } },
    deepseek: { apiKey: 'nope' },
    ui: { socket: '/tmp/x' },
  });
  // API keys became writable (write-only) for the settings app; the socket path
  // and model endpoints stay forbidden so a UI bug cannot repoint the daemon.
  assert.deepEqual(allowed.sort(), ['asr.sensitivity', 'asr.wakeCooldownMs', 'deepseek.apiKey', 'tts.ack.enabled']);
  assert.deepEqual(forbidden.sort(), ['ui.socket']);
});

test('deepMergeConfig replaces arrays/scalars and recurses into objects', () => {
  const merged = deepMergeConfig(
    { asr: { wakeWords: ['a'], hotkey: 'F5' }, tts: { ack: { enabled: true } } },
    { asr: { wakeWords: ['b', 'c'] }, tts: { ack: { enabled: false, phrases: ['x'] } } },
  );
  assert.deepEqual(merged.asr.wakeWords, ['b', 'c']);
  assert.equal(merged.asr.hotkey, 'F5');
  assert.equal(merged.tts.ack.enabled, false);
  assert.deepEqual(merged.tts.ack.phrases, ['x']);
});

test('readConfigFile returns {} for a missing file and rejects corrupt JSON', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figaro-config-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await readConfigFile(path.join(dir, 'missing.json')), {});
  const corrupt = path.join(dir, 'corrupt.json');
  await fs.writeFile(corrupt, '{ nope');
  await assert.rejects(() => readConfigFile(corrupt), /corrupt/);
});

// ---------------------------------------------------------------- config IPC

test('config.get returns the effective config with both api keys masked', async (t) => {
  const { client, messages } = await startSettingsDaemon(t);
  const reply = await request(client, messages, { type: 'config.get', id: 'cfg-1' });
  assert.equal(reply.type, 'config');
  assert.equal(reply.id, 'cfg-1');
  assert.equal(reply.config.deepseek.apiKey, '***');
  assert.equal(reply.config.minimax.apiKey, '***');
  assert.equal(reply.config.asr.sensitivity, 'low');
  assert.doesNotMatch(JSON.stringify(messages), new RegExp(SECRET));
});

test('config.set rejects non-whitelisted paths and leaves config.json untouched', async (t) => {
  const { client, messages, ctx } = await startSettingsDaemon(t);
  const before = await fs.readFile(ctx.configPath, 'utf8');
  const reply = await request(client, messages, {
    type: 'config.set',
    id: 'cfg-bad',
    patch: { deepseek: { apiKey: 'hacked' }, ui: { socket: '/tmp/evil' } },
  });
  assert.equal(reply.type, 'config');
  assert.equal(reply.ok, false);
  assert.ok(reply.forbidden.includes('ui.socket'));
  assert.ok(!reply.forbidden.includes('deepseek.apiKey'), 'api keys are writable now');
  assert.equal(await fs.readFile(ctx.configPath, 'utf8'), before, 'a forbidden path aborts the whole patch');
  assert.equal(await fs.readFile(ctx.configPath, 'utf8'), before);
  assert.doesNotMatch(JSON.stringify(messages), /hacked/);
});

test('config.set writes config.json atomically with mode 600 and hot-applies ASR runtime settings', async (t) => {
  const { client, messages, ctx, asr, config } = await startSettingsDaemon(t);
  const reply = await request(client, messages, {
    type: 'config.set',
    id: 'cfg-asr',
    patch: { asr: { sensitivity: 'high', wakeCooldownMs: 3000, inputGainPercent: 60 } },
  });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.applied.sort(), ['asr.inputGainPercent', 'asr.sensitivity', 'asr.wakeCooldownMs']);
  assert.deepEqual(reply.restartRequired, []);

  const raw = JSON.parse(await fs.readFile(ctx.configPath, 'utf8'));
  assert.equal(raw.asr.sensitivity, 'high');
  assert.equal(raw.asr.wakeCooldownMs, 3000);
  assert.equal(raw.asr.inputGainPercent, 60);
  assert.equal(raw.deepseek.apiKey, SECRET, 'existing secrets are preserved on disk');
  const mode = (await fs.stat(ctx.configPath)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal((await fs.stat(path.dirname(ctx.configPath))).mode & 0o777, 0o700);

  assert.equal(asr.record.runtime.length, 1);
  assert.equal(asr.record.appliedRuntime.sensitivity, 'high');
  assert.equal(asr.record.appliedRuntime.wakeCooldownMs, 3000);
  assert.equal(asr.record.appliedRuntime.inputGainPercent, 60);
  assert.equal(config.asr.sensitivity, 'high');
  assert.deepEqual(reply.config.asr.sensitivity, 'high');
  assert.equal(reply.config.deepseek.apiKey, '***');
});

test('config.set recreates the TTS module for voice/sink changes and the ack cache', async (t) => {
  const { client, messages, ctx, tts, ack } = await startSettingsDaemon(t);
  const createdBefore = tts.record.created;
  const ackBefore = ack.record.created;
  const reply = await request(client, messages, {
    type: 'config.set',
    id: 'cfg-tts',
    patch: { tts: { voiceId: 'new-male-voice', sink: 'hdmi', ack: { phrases: ['在的'] } } },
  });
  assert.equal(reply.ok, true);
  assert.ok(reply.applied.includes('tts.voiceId'));
  assert.ok(reply.applied.includes('tts.sink'));
  assert.ok(reply.applied.includes('tts.ack.phrases'));
  assert.deepEqual(reply.restartRequired, []);
  assert.equal(tts.record.created, createdBefore + 1, 'TTS module recreated once');
  assert.equal(tts.record.configs.at(-1).voiceId, 'new-male-voice');
  assert.equal(tts.record.configs.at(-1).sink, 'hdmi');
  assert.equal(ack.record.created, ackBefore + 1, 'ack cache rebuilt with the new voice');

  const raw = JSON.parse(await fs.readFile(ctx.configPath, 'utf8'));
  assert.equal(raw.tts.voiceId, 'new-male-voice');
  assert.equal(raw.tts.sink, 'hdmi');
  assert.deepEqual(raw.tts.ack.phrases, ['在的']);
});

test('config.set reports restartRequired for settings that cannot be hot-applied', async (t) => {
  const { client, messages } = await startSettingsDaemon(t);
  const reply = await request(client, messages, {
    type: 'config.set',
    id: 'cfg-restart',
    patch: { asr: { wakeWords: ['费加罗', '菲加罗'], hotkey: 'CTRL+ALT+F9' } },
  });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.applied, []);
  assert.deepEqual(reply.restartRequired.sort(), ['asr.hotkey', 'asr.wakeWords']);
});

test('config.set accepts asr.enabled and marks it restartRequired (no hot enable hook)', async (t) => {
  const { client, messages, ctx } = await startSettingsDaemon(t);
  const reply = await request(client, messages, {
    type: 'config.set',
    id: 'cfg-asr-enabled',
    patch: { asr: { enabled: false } },
  });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.applied, []);
  assert.deepEqual(reply.restartRequired, ['asr.enabled']);
  // the write is persisted and visible to the next config.get / daemon start
  const raw = JSON.parse(await fs.readFile(ctx.configPath, 'utf8'));
  assert.equal(raw.asr.enabled, false);
  assert.equal(reply.config.asr.enabled, false);
  const fetched = await request(client, messages, { type: 'config.get', id: 'cfg-after-disabled' });
  assert.equal(fetched.config.asr.enabled, false);
});

test('config.set rejects a non-object patch', async (t) => {
  const { client, messages } = await startSettingsDaemon(t);
  const reply = await request(client, messages, { type: 'config.set', id: 'cfg-x', patch: 'nope' });
  assert.equal(reply.type, 'error');
  assert.equal(reply.code, 'CONFIG_BAD_PATCH');
});

// ---------------------------------------------------------------- self tests

test('test.mic.start streams 20Hz mic frames and ends with mic.end', async (t) => {
  const { client, messages, asr } = await startSettingsDaemon(t);
  client.send({ type: 'test.mic.start', id: 'mic-1', ms: 3000 });
  await waitFor(() => asr.record.mic !== null, { label: 'startMicTest called' });
  asr.record.mic.onSample({ rms: 0.2, peak: 0.6, level: 0.4 });
  asr.record.mic.onSample({ rms: 0.3, peak: 0.7, level: 0.5 });
  const frames = await waitFor(
    () => (messages.filter((message) => message.type === 'mic').length >= 2 ? messages.filter((message) => message.type === 'mic') : null),
    { label: 'mic frames' },
  );
  assert.equal(frames[0].rms, 0.2);
  assert.equal(frames[0].peak, 0.6);
  assert.equal(frames[0].level, 0.4);
  assert.equal(frames[0].id, 'mic-1');
  client.send({ type: 'test.mic.stop', id: 'mic-1' });
  const end = await waitFor(() => messages.find((message) => message.type === 'mic.end'), { label: 'mic.end' });
  assert.equal(end.id, 'mic-1');
  assert.equal(asr.record.micStop, 1);
});

test('test.asr.start forwards partials and the dual-model result', async (t) => {
  const { client, messages, asr } = await startSettingsDaemon(t);
  client.send({ type: 'test.asr.start', id: 'asr-1' });
  await waitFor(() => asr.record.asrTest !== null, { label: 'startAsrTest called' });
  asr.record.asrTest.onPartial('你好');
  const partial = await waitFor(() => messages.find((message) => message.type === 'partial' && message.text === '你好'), { label: 'asr partial' });
  assert.equal(partial.text, '你好');
  client.send({ type: 'test.asr.stop', id: 'asr-1' });
  const result = await waitFor(() => messages.find((message) => message.type === 'test.asr.result'), { label: 'asr result' });
  assert.equal(result.id, 'asr-1');
  assert.equal(result.text, '你好世界');
  assert.equal(result.streamingText, '你好世界');
  assert.equal(result.ms, 180);
  assert.equal(result.audioMs, 1200);
});

test('test.wake.arm streams scores/hits, mutes real wakes and counts them as false alarms', async (t) => {
  const { client, messages, asr } = await startSettingsDaemon(t);
  client.send({ type: 'test.wake.arm', id: 'wake-1', ms: 20000 });
  await waitFor(() => asr.record.wake !== null, { label: 'armWakeTest called' });
  assert.equal(asr.record.wake.ms, 20000);
  asr.record.wake.onScore({ score: 0.42, keyword: '费加罗' });
  const score = await waitFor(() => messages.find((message) => message.type === 'wake.score'), { label: 'wake.score' });
  assert.equal(score.score, 0.42);
  assert.equal(score.keyword, '费加罗');
  assert.equal(score.id, 'wake-1');
  asr.record.wake.onHit({ score: 0.91, latencyMs: 320 });
  const hit = await waitFor(() => messages.find((message) => message.type === 'wake.hit'), { label: 'wake.hit' });
  assert.equal(hit.score, 0.91);
  assert.equal(hit.latencyMs, 320);

  // A real wake during the test window must stay silent and count as false alarm.
  const speakingBefore = messages.filter((message) => message.type === 'state' && message.state === 'speaking').length;
  asr.record.cbs.onWake();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const speakingAfter = messages.filter((message) => message.type === 'state' && message.state === 'speaking').length;
  assert.equal(speakingAfter, speakingBefore, 'no ack/speaking during the wake test');

  asr.record.wake.onEnd({ hits: 1, misses: 0, falseAlarms: 0 });
  const end = await waitFor(() => messages.find((message) => message.type === 'test.wake.end'), { label: 'wake.end' });
  assert.equal(end.id, 'wake-1');
  assert.equal(end.hits, 1);
  assert.equal(end.misses, 0);
  assert.equal(end.falseAlarms, 1, 'the real wake was counted as a false alarm');
});

test('test.tts synthesizes and plays through the shared TTS module', async (t) => {
  const { client, messages, tts } = await startSettingsDaemon(t);
  const reply = await request(client, messages, { type: 'test.tts', id: 'tts-1', text: '试听一下' });
  assert.equal(reply.type, 'test.tts.result');
  assert.equal(reply.id, 'tts-1');
  assert.equal(reply.ok, true);
  assert.equal(reply.text, '试听一下');
  assert.ok(Number.isFinite(reply.ms) && reply.ms >= 0);
  assert.equal(tts.record.synthesized.at(-1).text, '试听一下');
  assert.equal(tts.record.played, 1);
});

test('test.tts defaults to a sample sentence and reports unsupported without TTS', async (t) => {
  const { client, messages } = await startSettingsDaemon(t, { voice: false });
  const reply = await request(client, messages, { type: 'test.tts', id: 'tts-x' });
  assert.equal(reply.type, 'error');
  assert.equal(reply.code, 'unsupported');
});

test('service.restart answers ack first, then asks the supervisor to restart', async (t) => {
  const { client, messages, restartRequests } = await startSettingsDaemon(t);
  client.send({ type: 'service.restart', id: 'restart-1' });
  const ack = await waitFor(() => messages.find((message) => message.type === 'ack' && message.action === 'restart'), {
    label: 'restart ack',
  });
  assert.equal(ack.id, 'restart-1');
  await waitFor(() => restartRequests.length === 1, { label: 'restart requested', timeoutMs: 3000 });
});

test('diagnostics aggregates config path, voice health, mic and recent errors', async (t) => {
  const { client, messages, ctx } = await startSettingsDaemon(t);
  const reply = await request(client, messages, { type: 'diagnostics', id: 'diag-1' });
  assert.equal(reply.type, 'diagnostics');
  assert.equal(reply.id, 'diag-1');
  assert.equal(reply.configPath, ctx.configPath);
  assert.equal(reply.version, '0.1.0');
  assert.ok(reply.uptimeMs >= 0);
  assert.equal(reply.asr.available, true);
  assert.equal(reply.asr.sensitivity, 'low');
  assert.equal(reply.asr.muted, false);
  assert.equal(reply.tts.available, true);
  assert.equal(reply.tts.model, 'speech-2.6-turbo');
  assert.equal(reply.ack.enabled, true);
  assert.equal(reply.ack.ready, true);
  assert.equal(reply.tts.sinks.length, 2);
  assert.equal(reply.tts.sinks[0].name, 'alsa_output.pci-0000_00_1f.3.analog-stereo');
  assert.equal(reply.tts.sinks[0].description, 'Built-in Audio Analog Stereo');
  assert.equal(reply.tts.sinks[0].isDefault, true);
  assert.equal(reply.tts.sinks[0].isCurrent, true, 'current sink is marked in the picker list');
  assert.equal(reply.mic.gainPercent, 65);
  assert.ok(reply.mic.rms >= 0 && reply.mic.rms <= 1);
  assert.ok(reply.mic.peak >= 0 && reply.mic.peak <= 1);
  assert.ok(reply.latency && typeof reply.latency === 'object');
  assert.ok(Array.isArray(reply.recentErrors));
  assert.equal(typeof reply.latency.ttsFirstAudioMs, 'number');
});

test('mic / asr / wake tests report unsupported when ASR hooks are missing', async (t) => {
  const asr = {
    factory: () => ({
      async start() {},
      async stop() {},
      beginCapture() {},
      endCapture() {},
      get capturing() {
        return false;
      },
    }),
  };
  const { client, messages } = await startSettingsDaemon(t, { asr });
  const mic = await request(client, messages, { type: 'test.mic.start', id: 'x' });
  assert.equal(mic.type, 'error');
  assert.equal(mic.code, 'unsupported');
  const asrReply = await request(client, messages, { type: 'test.asr.start', id: 'y' });
  assert.equal(asrReply.code, 'unsupported');
  const wake = await request(client, messages, { type: 'test.wake.arm', id: 'z' });
  assert.equal(wake.code, 'unsupported');
});

test('settings messages work without voice modules at all (text-only daemon)', async (t) => {
  const { client, messages, ctx } = await startSettingsDaemon(t, { voice: false });
  const reply = await request(client, messages, { type: 'config.get', id: 'cfg-notts' });
  assert.equal(reply.type, 'config');
  assert.equal(reply.config.deepseek.apiKey, '***');
  assert.equal(reply.configPath, undefined);
  const diagnostics = await request(client, messages, { type: 'diagnostics', id: 'd' });
  assert.equal(diagnostics.type, 'diagnostics');
  assert.equal(diagnostics.configPath, ctx.configPath);
  assert.equal(diagnostics.asr.available, false);
  assert.equal(diagnostics.tts.available, false);
  const ttsReply = await request(client, messages, { type: 'test.tts', id: 't' });
  assert.equal(ttsReply.code, 'unsupported');
});

test('test.wake.disarm ends an armed wake-test window through the ASR hook', async (t) => {
  const { client, messages, asr } = await startSettingsDaemon(t);
  client.send({ type: 'test.wake.arm', id: 'wake-disarm-1', ms: 20000 });
  await waitFor(() => asr.record.wake !== null, { label: 'armed wake test' });
  // a hit so the end payload carries a real count
  asr.record.wake.onHit({ score: 0.8, latencyMs: 200 });
  client.send({ type: 'test.wake.disarm', id: 'wake-disarm-1' });
  const end = await waitFor(() => messages.find((message) => message.type === 'test.wake.end'), { label: 'wake.end' });
  assert.equal(end.id, 'wake-disarm-1');
  assert.equal(end.hits, 0, 'module-provided counts win; our onHit was not double counted in this path');
  assert.equal(end.misses, 0);
  assert.equal(end.falseAlarms, 0);
  assert.equal(asr.record.disarm, 1);
  // disarming again reports not-running instead of throwing
  client.send({ type: 'test.wake.disarm', id: 'wake-disarm-2' });
  const again = await waitFor(
    () => messages.find((message) => message.type === 'test.wake.end' && message.id === 'wake-disarm-2'),
    { label: 'second wake.end' },
  );
  assert.equal(again.reason, 'not-running');
});

test('test.wake.disarm still ends the window when the ASR module has no disarm hook', async (t) => {
  const asrFactory = () => ({
    async start() {},
    async stop() {},
    beginCapture() {},
    endCapture() {},
    get capturing() {
      return false;
    },
    armWakeTest() {
      /* no disarmWakeTest hook on purpose */
    },
  });
  const { client, messages } = await startSettingsDaemon(t, {
    asr: { factory: asrFactory, record: {} },
  });
  client.send({ type: 'test.wake.arm', id: 'wake-nohook', ms: 20000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  client.send({ type: 'test.wake.disarm', id: 'wake-nohook' });
  const end = await waitFor(() => messages.find((message) => message.type === 'test.wake.end'), { label: 'wake.end' });
  assert.equal(end.id, 'wake-nohook');
  assert.equal(end.reason, 'disarmed');
  assert.equal(end.hits, 0);
});

test('diagnostics omits the sink list when enumeration fails (GUI has a manual fallback)', async (t) => {
  const { client, messages } = await startSettingsDaemon(t, {
    listSinks: async () => {
      throw new Error('pactl not available');
    },
  });
  const reply = await request(client, messages, { type: 'diagnostics', id: 'diag-nosinks' });
  assert.equal(reply.type, 'diagnostics');
  assert.equal(reply.tts.sinks, undefined);
  assert.equal(typeof reply.tts.sink, 'string');
});
