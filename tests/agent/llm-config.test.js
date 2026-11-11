// loadConfig() migration tests for the generic `llm` block.
//
// The legacy `deepseek.*` config must keep working untouched (0.x upgrade), and
// an explicit `llm.*` block must win at runtime. Environment fallbacks for
// headless/CI use are covered too. config.js resolves CONFIG_PATH at import
// time, so the temp config dir is installed before the dynamic import.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'figaro-llm-config-test-'));
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const ENV_KEYS = [
  'FIGARO_LLM_PROVIDER', 'FIGARO_LLM_BASE_URL', 'FIGARO_LLM_MODEL', 'FIGARO_LLM_API_KEY',
  'FIGARO_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY', 'FIGARO_OPENAI_API_KEY', 'OPENAI_API_KEY',
  'FIGARO_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LLM_API_KEY',
  'FIGARO_MINIMAX_API_KEY', 'MINIMAX_API_KEY',
];

for (const key of ENV_KEYS) delete process.env[key];
process.env.FIGARO_CONFIG_DIR = CONFIG_DIR;

const { loadConfig, resolveLlmConfig } = await import('../../src/config.js');

test.after(() => fs.rmSync(CONFIG_DIR, { recursive: true, force: true }));

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function withoutConfig() {
  fs.rmSync(CONFIG_PATH, { force: true });
}

test.beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  withoutConfig();
});

test('no config file: llm is derived from the built-in DeepSeek defaults', () => {
  const config = loadConfig();
  assert.equal(config.llm.provider, 'deepseek');
  assert.equal(config.llm.configured, false);
  assert.equal(config.llm.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.llm.model, 'deepseek-flash');
  assert.equal(config.llm.reasoningEffort, 'none');
  assert.equal(config.llm.temperature, 0.6);
  assert.equal(config.llm.maxToolRounds, 24);
  assert.deepEqual(config.llm.requestOptions, {});
});

test('legacy deepseek-only config: llm is derived, old keys untouched', () => {
  writeConfig({
    deepseek: {
      apiKey: 'sk-legacy-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      maxToolRounds: 7,
      maxRetries: 3,
      temperature: 0.1,
      reasoningEffort: 'minimal',
      requestTimeoutMs: 60_000,
    },
  });
  const config = loadConfig();

  assert.equal(config.llm.configured, false);
  assert.equal(config.llm.provider, 'deepseek');
  assert.equal(config.llm.apiKey, 'sk-legacy-key');
  assert.equal(config.llm.model, 'deepseek-chat');
  assert.equal(config.llm.reasoningEffort, 'minimal');
  assert.equal(config.llm.temperature, 0.1);
  assert.equal(config.llm.maxToolRounds, 7);
  assert.equal(config.llm.maxRetries, 3);
  assert.equal(config.llm.requestTimeoutMs, 60_000);
  // The legacy block still reads exactly as before for old call sites.
  assert.equal(config.deepseek.apiKey, 'sk-legacy-key');
  assert.equal(config.deepseek.model, 'deepseek-chat');
  assert.equal(config.deepseek.maxToolRounds, 7);
});

test('llm-only config: runtime fields are filled from the provider preset', () => {
  writeConfig({ llm: { provider: 'openai', apiKey: 'sk-openai-key' } });
  const config = loadConfig();

  assert.equal(config.llm.configured, true);
  assert.equal(config.llm.provider, 'openai');
  assert.equal(config.llm.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.llm.model, 'gpt-4o-mini');
  assert.equal(config.llm.apiKey, 'sk-openai-key');
  // OpenAI-compatible providers are mirrored into deepseek.* so daemon
  // health/status and the tool-loop tunables keep working without a rewrite.
  assert.equal(config.deepseek.model, 'gpt-4o-mini');
  assert.equal(config.deepseek.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.deepseek.apiKey, 'sk-openai-key');
});

test('explicit llm wins over the legacy deepseek block', () => {
  writeConfig({
    deepseek: { apiKey: 'sk-legacy', model: 'deepseek-flash' },
    llm: {
      provider: 'gemini',
      apiKey: 'AIza-key',
      model: 'gemini-2.5-pro',
      temperature: 0.9,
    },
  });
  const config = loadConfig();

  assert.equal(config.llm.provider, 'gemini');
  assert.equal(config.llm.model, 'gemini-2.5-pro');
  assert.equal(config.llm.apiKey, 'AIza-key');
  assert.equal(config.llm.temperature, 0.9);
  // A DeepSeek key must never be sent to another vendor.
  assert.notEqual(config.llm.baseUrl, 'https://api.deepseek.com');
  // Gemini is not OpenAI-compatible: its endpoint/key are not mirrored onto the
  // DeepSeek compatibility block, but the model name is (so status shows the truth).
  assert.equal(config.deepseek.model, 'gemini-2.5-pro');
  assert.equal(config.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.deepseek.apiKey, 'sk-legacy');
});

test('provider=deepseek in llm still falls back to the legacy key when empty', () => {
  writeConfig({
    deepseek: { apiKey: 'sk-legacy' },
    llm: { provider: 'deepseek', model: 'deepseek-chat' },
  });
  const config = loadConfig();
  assert.equal(config.llm.provider, 'deepseek');
  assert.equal(config.llm.apiKey, 'sk-legacy');
  assert.equal(config.llm.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.llm.model, 'deepseek-chat');
});

test('an llm block with only baseUrl/model is treated as a custom OpenAI-compatible endpoint', () => {
  writeConfig({ llm: { baseUrl: 'https://llm.internal.example/v1', model: 'qwen3', apiKey: 'k' } });
  const config = loadConfig();
  assert.equal(config.llm.provider, 'custom');
  assert.equal(config.llm.baseUrl, 'https://llm.internal.example/v1');
  assert.equal(config.llm.model, 'qwen3');
});

test('a custom baseUrl that is not validated at load time is rejected only at request time', () => {
  writeConfig({ llm: { provider: 'custom', baseUrl: 'http://10.0.0.5:8000/v1', model: 'm', apiKey: 'k' } });
  const config = loadConfig();
  // loadConfig must stay usable for status/doctor even with a bad URL; the
  // network layer enforces the https/loopback policy when a request is made.
  assert.equal(config.llm.baseUrl, 'http://10.0.0.5:8000/v1');
});

test('unknown provider strings are preserved for a clear runtime error', () => {
  writeConfig({ llm: { provider: 'anthropic', apiKey: 'k' } });
  const config = loadConfig();
  assert.equal(config.llm.provider, 'anthropic');
});

test('env fallbacks: FIGARO_LLM_*, then provider-specific keys', () => {
  writeConfig({ llm: { provider: 'openai' } });
  process.env.FIGARO_LLM_API_KEY = 'sk-env-generic';
  process.env.FIGARO_LLM_MODEL = 'gpt-4o';
  process.env.FIGARO_LLM_BASE_URL = 'https://proxy.example/v1';
  let config = loadConfig();
  assert.equal(config.llm.apiKey, 'sk-env-generic');
  assert.equal(config.llm.model, 'gpt-4o');
  assert.equal(config.llm.baseUrl, 'https://proxy.example/v1');

  delete process.env.FIGARO_LLM_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-env-openai';
  config = loadConfig();
  assert.equal(config.llm.apiKey, 'sk-env-openai');
});

test('FIGARO_LLM_PROVIDER selects a provider when the file has no llm block', () => {
  writeConfig({ deepseek: { apiKey: 'sk-legacy' } });
  process.env.FIGARO_LLM_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'sk-openai-env';
  const config = loadConfig();
  assert.equal(config.llm.provider, 'openai');
  assert.equal(config.llm.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.llm.apiKey, 'sk-openai-env');
});

test('FIGARO_LLM_API_KEY wins over the key in the file (same as FIGARO_DEEPSEEK_API_KEY)', () => {
  writeConfig({ llm: { provider: 'deepseek', apiKey: 'sk-from-file' } });
  process.env.FIGARO_LLM_API_KEY = 'sk-from-env';
  const config = loadConfig();
  assert.equal(config.llm.apiKey, 'sk-from-env');
});

test('the legacy FIGARO_DEEPSEEK_API_KEY still feeds both deepseek.* and llm.*', () => {
  process.env.FIGARO_DEEPSEEK_API_KEY = 'sk-legacy-env';
  const config = loadConfig();
  assert.equal(config.deepseek.apiKey, 'sk-legacy-env');
  assert.equal(config.llm.apiKey, 'sk-legacy-env');
  assert.equal(config.llm.provider, 'deepseek');
});

test('resolveLlmConfig is pure: a hand-built config without llm derives from deepseek', () => {
  const resolved = resolveLlmConfig({
    deepseek: { apiKey: 'sk-hand', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', maxToolRounds: 2 },
  });
  assert.equal(resolved.provider, 'deepseek');
  assert.equal(resolved.configured, false);
  assert.equal(resolved.apiKey, 'sk-hand');
  assert.equal(resolved.maxToolRounds, 2);
  // Hand-built configs are the test/programmatic path: no env is consulted here.
  assert.equal(resolveLlmConfig({}).apiKey, '');
});

test('empty llm object is treated as "not configured" and keeps the legacy path', () => {
  const resolved = resolveLlmConfig({ deepseek: { apiKey: 'sk-hand' }, llm: {} });
  assert.equal(resolved.configured, false);
  assert.equal(resolved.provider, 'deepseek');
  assert.equal(resolved.apiKey, 'sk-hand');
});
