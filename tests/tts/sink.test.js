// Sink selection + logging tests (hermetic: no real pactl/pw-cat needed).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTts } from '../../src/voice/tts/index.js';
import { parseShortSinks, probeAudioSinks, resolveSinkConfig } from '../../src/voice/tts/sink.js';
import {
  buildPwCatCommand,
  resolvePlayerCommand,
} from '../../src/voice/tts/player.js';
import { makeConfig, fakeSinkProbe, trackedLogger } from './helpers.js';

const SINK_LIST_TEXT =
  '56\talsa_output.pci-0000_00_1f.3.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED\n' +
  '78\talsa_output.pci-0000_01_00.1.hdmi-stereo\tPipeWire\ts32le 2ch 48000Hz\tRUNNING\n';

test('parseShortSinks parses pactl output', () => {
  const sinks = parseShortSinks(SINK_LIST_TEXT);
  assert.equal(sinks.length, 2);
  assert.equal(sinks[0].index, 56);
  assert.equal(sinks[0].name, 'alsa_output.pci-0000_00_1f.3.analog-stereo');
  assert.equal(sinks[1].name, 'alsa_output.pci-0000_01_00.1.hdmi-stereo');
  assert.equal(sinks[1].state, 'RUNNING');
  assert.deepEqual(parseShortSinks(''), []);
});

test('probeAudioSinks uses pactl and reports the default sink', () => {
  const calls = [];
  const execFileSync = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'list') return SINK_LIST_TEXT;
    if (args[0] === 'get-default-sink') return 'alsa_output.pci-0000_01_00.1.hdmi-stereo\n';
    throw new Error(`unexpected: ${args}`);
  };
  const probe = probeAudioSinks({ execFileSync });
  assert.equal(probe.ok, true);
  assert.equal(probe.defaultSink, 'alsa_output.pci-0000_01_00.1.hdmi-stereo');
  assert.equal(probe.available.length, 2);
  assert.deepEqual(calls[0], ['pactl', 'list', 'short', 'sinks']);
});

test('probeAudioSinks never throws when pactl is missing', () => {
  const probe = probeAudioSinks({
    execFileSync: () => {
      throw Object.assign(new Error('spawn pactl ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.equal(probe.ok, false);
  assert.deepEqual(probe.available, []);
  assert.ok(probe.error);
});

test('resolveSinkConfig: empty config -> system default', () => {
  const resolved = resolveSinkConfig('', fakeSinkProbe());
  assert.equal(resolved.target, '');
  assert.equal(resolved.name, 'fake-sink-analog');
  assert.equal(resolved.status, 'default');
});

test('resolveSinkConfig: exact full sink name is used as-is', () => {
  const resolved = resolveSinkConfig('fake-sink-hdmi', fakeSinkProbe());
  assert.equal(resolved.target, 'fake-sink-hdmi');
  assert.equal(resolved.name, 'fake-sink-hdmi');
  assert.equal(resolved.status, 'configured');
});

test('resolveSinkConfig: unique substring resolves to the full name', () => {
  const resolved = resolveSinkConfig('hdmi', fakeSinkProbe());
  assert.equal(resolved.target, 'fake-sink-hdmi');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.configured, 'hdmi');
});

test('resolveSinkConfig: unknown sink falls back to default', () => {
  const resolved = resolveSinkConfig('does-not-exist', fakeSinkProbe());
  assert.equal(resolved.target, '');
  assert.equal(resolved.name, 'fake-sink-analog');
  assert.equal(resolved.status, 'fallback-missing');
  assert.deepEqual(resolved.candidates, ['fake-sink-analog', 'fake-sink-hdmi']);
});

test('resolveSinkConfig: ambiguous substring falls back to default', () => {
  const probe = {
    ok: true,
    defaultSink: 'sink-a',
    available: [{ name: 'sink-a' }, { name: 'sink-b' }],
  };
  const resolved = resolveSinkConfig('sink', probe);
  assert.equal(resolved.target, '');
  assert.equal(resolved.status, 'ambiguous');
  assert.equal(resolved.candidates.length, 2);
});

test('resolveSinkConfig: when pactl is unavailable, trust the configured name', () => {
  const resolved = resolveSinkConfig('some-hdmi-sink', { ok: false, available: [], defaultSink: '' });
  assert.equal(resolved.target, 'some-hdmi-sink');
  assert.equal(resolved.status, 'unverified');
});

test('pw-cat command carries --target only when a sink is configured', () => {
  const withSink = buildPwCatCommand({ binary: '/usr/bin/pw-cat', sink: 'fake-sink-hdmi', sampleRate: 32000 });
  assert.ok(withSink.includes('--target=fake-sink-hdmi'));
  assert.equal(withSink[withSink.length - 1], '-');
  const withoutSink = buildPwCatCommand({ binary: '/usr/bin/pw-cat', sink: '', sampleRate: 32000 });
  assert.ok(!withoutSink.some((arg) => arg.startsWith('--target')));
});

test('caller-provided player command is not rewritten but reports the target', () => {
  const resolved = resolvePlayerCommand({ command: ['bash', '-c', 'cat > /dev/null'], sink: 'fake-sink-hdmi' });
  assert.deepEqual(resolved.command, ['bash', '-c', 'cat > /dev/null']);
  assert.equal(resolved.source, 'config');
  assert.equal(resolved.target, 'fake-sink-hdmi');
});

function makeTts(configPatch = {}, opts = {}) {
  const logger = trackedLogger();
  const tts = createTts({
    config: makeConfig({ ...configPatch }),
    logger: opts.logger === undefined ? logger.logger : opts.logger,
    sinkProbe: opts.sinkProbe || fakeSinkProbe,
  });
  return { tts, lines: logger.lines };
}

test('createTts logs "playing to <default sink>" when no sink is configured', (t) => {
  const { tts, lines } = makeTts({ tts: { sink: '' } });
  t.after(() => tts.close());
  assert.equal(tts.stats.audioSink, '');
  assert.equal(tts.stats.audioSinkName, 'fake-sink-analog');
  assert.equal(tts.stats.sinkStatus, 'default');
  const info = lines.filter((l) => l[0] === 'info').map((l) => l.slice(1).join(' '));
  assert.ok(info.includes('playing to default sink (fake-sink-analog)'), JSON.stringify(lines));
});

test('createTts logs the configured sink and exposes it in stats', (t) => {
  const { tts, lines } = makeTts({ tts: { sink: 'fake-sink-hdmi' } });
  t.after(() => tts.close());
  assert.equal(tts.stats.audioSink, 'fake-sink-hdmi');
  assert.equal(tts.stats.sinkStatus, 'configured');
  assert.ok(lines.some((l) => l[0] === 'info' && l.join(' ').includes('playing to fake-sink-hdmi')));
});

test('createTts resolves a short sink alias and says so', (t) => {
  const { tts, lines } = makeTts({ tts: { sink: 'hdmi' } });
  t.after(() => tts.close());
  assert.equal(tts.stats.audioSink, 'fake-sink-hdmi');
  assert.equal(tts.stats.sinkStatus, 'resolved');
  assert.ok(
    lines.some((l) => l[0] === 'info' && l.join(' ').includes('resolved from "hdmi"')),
    JSON.stringify(lines),
  );
});

test('createTts warns exactly once and falls back when the sink is missing', (t) => {
  const { tts, lines } = makeTts({ tts: { sink: 'nope-sink' } });
  t.after(() => tts.close());
  assert.equal(tts.stats.audioSink, '');
  assert.equal(tts.stats.sinkStatus, 'fallback-missing');
  const warns = lines.filter((l) => l[0] === 'warn');
  assert.equal(warns.length, 1, JSON.stringify(lines));
  assert.match(warns[0].join(' '), /sink "nope-sink" not found/);
  assert.ok(
    lines.some((l) => l[0] === 'info' && l.join(' ').includes('playing to default sink (fake-sink-analog)')),
  );
});

test('createTts keeps the configured sink when pactl is unavailable (warn)', (t) => {
  const { tts, lines } = makeTts(
    { tts: { sink: 'hdmi-manual' } },
    { sinkProbe: () => ({ ok: false, available: [], defaultSink: '', error: new Error('pactl missing') }) },
  );
  t.after(() => tts.close());
  assert.equal(tts.stats.audioSink, 'hdmi-manual');
  assert.equal(tts.stats.sinkStatus, 'unverified');
  assert.ok(lines.some((l) => l[0] === 'warn' && l.join(' ').includes('cannot query audio sinks')));
});

test('logger:null silences the module', (t) => {
  const tts = createTts({
    config: makeConfig({ tts: { sink: 'fake-sink-hdmi' } }),
    logger: null,
    sinkProbe: fakeSinkProbe,
  });
  t.after(() => tts.close());
  assert.equal(tts.stats.audioSink, 'fake-sink-hdmi');
});
