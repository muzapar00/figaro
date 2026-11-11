// Wiring for the smart-home tool: it must stay invisible until Home Assistant is
// configured, its schema must be valid, and its token must be a secret path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools, TOOL_NAMES } from '../../src/agent/tools/index.js';
import { toChatTools, summarizeToolCall } from '../../src/agent/tools/define.js';
import { SECRET_PATHS, sanitizeConfig } from '../../src/agent/settings.js';

const baseConfig = (overrides = {}) => ({ agent: { web: false }, ...overrides });

test('home tool is not registered until Home Assistant is configured', () => {
  const names = createTools({ config: baseConfig(), workdir: os.tmpdir() }).map((t) => t.name);
  assert.ok(!names.includes('home'), 'unconfigured home tool must not reach the model');
  assert.ok(TOOL_NAMES.includes('home'), 'home is part of the catalog for docs/doctor');
});

test('home tool is registered when haUrl and haToken are set', () => {
  const tools = createTools({
    config: baseConfig({ home: { haUrl: 'http://127.0.0.1:8123', haToken: 'x'.repeat(20) } }),
    workdir: os.tmpdir(),
  });
  const home = tools.find((t) => t.name === 'home');
  assert.ok(home, 'home tool is registered');
  const schema = toChatTools([home])[0].function.parameters;
  assert.equal(schema.type, 'object');
  assert.ok(schema.properties.action, 'action parameter is exposed');
  assert.deepEqual(schema.properties.action.enum, ['list', 'state', 'on', 'off', 'brightness', 'color_temp']);
  assert.ok(schema.required.includes('action'));
  assert.ok(schema.properties.device, 'device parameter is exposed');
});

test('agent.tools can exclude the home tool even when configured', () => {
  const tools = createTools({
    config: baseConfig({
      home: { haUrl: 'http://127.0.0.1:8123', haToken: 'x'.repeat(20) },
      agent: { web: false, tools: ['bash'] },
    }),
    workdir: os.tmpdir(),
  });
  assert.deepEqual(tools.map((t) => t.name), ['bash']);
});

test('every tool schema has a real properties map (no double-converted schema)', () => {
  const tools = createTools({ config: baseConfig(), workdir: os.tmpdir() });
  for (const schema of toChatTools(tools)) {
    const params = schema.function.parameters;
    assert.equal(params.type, 'object', `${schema.function.name} parameters must be an object`);
    assert.ok(params.properties && typeof params.properties === 'object', `${schema.function.name} must expose properties`);
    assert.equal(params.properties.type, undefined, `${schema.function.name} leaked the raw JSON Schema "type" key`);
    assert.equal(params.properties.properties, undefined, `${schema.function.name} leaked the raw "properties" key`);
  }
});

test('summarizeToolCall describes home calls for the overlay', () => {
  assert.equal(summarizeToolCall('home', { action: 'on', device: '台灯' }), 'on 台灯');
  assert.equal(summarizeToolCall('home', { action: 'brightness', device: '台灯', value: 30 }), 'brightness 台灯 30%');
  assert.equal(summarizeToolCall('home', { action: 'list' }), 'list');
});

test('home.haToken is redacted in GUI-visible config and is a secret path', () => {
  assert.ok(SECRET_PATHS.includes('home.haToken'));
  const sanitized = sanitizeConfig({ home: { haUrl: 'http://127.0.0.1:8123', haToken: 'super-secret-token', defaultRoom: '卧室' } });
  assert.equal(sanitized.home.haToken, '***');
  assert.equal(sanitized.home.haUrl, 'http://127.0.0.1:8123');
});

test('the system prompt tells the model to only claim confirmed light changes', () => {
  const prompt = fs.readFileSync(path.join(process.cwd(), 'src/agent/prompt.js'), 'utf8');
  assert.match(prompt, /home tool/);
  assert.match(prompt, /Only say a light changed after the tool confirms it/);
});
