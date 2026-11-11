// `figaro doctor` must never print a real LLM key, including the 1.0 `llm.*`
// config shape (the old code only masked deepseek.apiKey / minimax.apiKey).
// Runs the real CLI in a fake HOME so no local service is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'figaro');
const SECRET = 'sk-DOCTORSECRETLLM0123456789abcdef';

const execFileAsync = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });

function createWorld(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figaro-llm-doctor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const world = {
    root,
    home: path.join(root, 'home'),
    configDir: path.join(root, 'config'),
    runtime: path.join(root, 'runtime'),
  };
  for (const dir of [world.home, world.configDir, world.runtime]) fs.mkdirSync(dir, { recursive: true });
  world.writeConfig = (config) => {
    const file = path.join(world.configDir, 'config.json');
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };
  world.env = {
    ...process.env,
    HOME: world.home,
    FIGARO_CONFIG_DIR: world.configDir,
    XDG_RUNTIME_DIR: world.runtime,
  };
  for (const key of [
    'FIGARO_LLM_API_KEY', 'FIGARO_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY',
    'FIGARO_OPENAI_API_KEY', 'OPENAI_API_KEY', 'FIGARO_GEMINI_API_KEY', 'GEMINI_API_KEY',
  ]) {
    delete world.env[key];
  }
  return world;
}

test('figaro doctor --json masks an llm-only key (openai provider)', async (t) => {
  const world = createWorld(t);
  world.writeConfig({ llm: { provider: 'openai', apiKey: SECRET, model: 'gpt-4o-mini' } });

  const result = await execFileAsync('node', [BIN, 'doctor', '--json'], { cwd: REPO_ROOT, env: world.env });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.ok(!output.includes(SECRET), 'the llm.* API key must never be printed');
  // The masked hint may show at most the last four characters.
  assert.ok(!/sk-DOCTORSECRETLLM/.test(output));
  const payload = JSON.parse(result.stdout);
  assert.equal(typeof payload.ok, 'boolean');
  assert.ok(Array.isArray(payload.groups));

  const configGroup = payload.groups.find((group) => group.id === 'config');
  assert.ok(configGroup, 'doctor config group is present');
  const keyCheck = configGroup.checks.find((check) => /key/.test(check.id));
  assert.ok(keyCheck, 'doctor reports a key check');
  assert.doesNotMatch(JSON.stringify(keyCheck), new RegExp(SECRET));
});

test('figaro doctor (human output) never prints the llm key', async (t) => {
  const world = createWorld(t);
  world.writeConfig({ llm: { provider: 'gemini', apiKey: SECRET, model: 'gemini-2.5-flash' } });

  const result = await execFileAsync('node', [BIN, 'doctor'], { cwd: REPO_ROOT, env: world.env });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.ok(!output.includes(SECRET), 'gemini key must not be printed by doctor');
});
