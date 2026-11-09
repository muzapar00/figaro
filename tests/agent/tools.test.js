// Tool-level tests: bash timeout/output, atomic edit/write, native glob/grep,
// and the model-facing schema conversion. Headless-safe (no mic, no speaker).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTools } from '../../src/agent/tools/index.js';
import { buildToolRegistry } from '../../src/agent/tools/registry.js';
import { parametersToJsonSchema } from '../../src/agent/tools/define.js';
import { compileGlob } from '../../src/agent/tools/search.js';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figaro-tools-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function registryFor(workdir) {
  const registry = buildToolRegistry(createTools({ config: { agent: { web: false } }, workdir }));
  return {
    names: registry.names(),
    async run(name, args) {
      const tool = registry.get(name);
      assert.ok(tool, `tool ${name} is registered`);
      return await tool.execute(args, {});
    },
  };
}

test('tool catalog keeps exactly the voice-relevant dsh tools', () => {
  const registry = buildToolRegistry(createTools({ config: {}, workdir: os.tmpdir() }));
  assert.deepEqual(
    registry.names().sort(),
    ['bash', 'edit', 'glob', 'grep', 'read', 'web_fetch', 'web_search', 'write'].sort(),
  );
  const bashSchema = registry.schemas.find((tool) => tool.function.name === 'bash');
  assert.equal(bashSchema.type, 'function');
  assert.equal(bashSchema.function.parameters.type, 'object');
  assert.deepEqual(bashSchema.function.parameters.required, ['description', 'command']);
  assert.match(bashSchema.function.description, /Execute a bash command/);
});

test('dsh-style parameter nodes convert to JSON Schema recursively', () => {
  const schema = parametersToJsonSchema({
    queries: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: '1–4 search queries',
    },
    nested: { type: 'object', properties: { flag: { type: 'boolean', required: true } } },
  });
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['queries']);
  assert.deepEqual(schema.properties.queries.items, { type: 'string' });
  assert.equal(schema.properties.queries.description, '1–4 search queries');
  assert.deepEqual(schema.properties.nested.properties.flag, { type: 'boolean' });
  assert.deepEqual(schema.properties.nested.required, ['flag']);
});

test('bash returns the exit code and output, and enforces its timeout', async (t) => {
  const dir = await tempDir(t);
  const tools = registryFor(dir);

  const ok = await tools.run('bash', { command: 'echo hello; echo oops >&2; exit 7', description: 'exit code test' });
  assert.match(ok, /\[exit code: 7\]/);
  assert.match(ok, /hello/);
  assert.match(ok, /oops/);

  const startedAt = Date.now();
  const timedOut = await tools.run('bash', { command: 'sleep 5', description: 'timeout test', timeoutMs: 250 });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 3000, `timeout must kill the command quickly (took ${elapsed}ms)`);
  assert.match(timedOut, /timed out after 250ms/);
  assert.match(timedOut, /\[exit code: null\]/);
});

test('bash truncates long output and reports the spill file', async (t) => {
  const dir = await tempDir(t);
  const tools = registryFor(dir);
  const output = await tools.run('bash', {
    command: 'for i in $(seq 1 4000); do echo "line-$i"; done',
    description: 'long output',
  });
  assert.match(output, /\[output truncated: command produced \d+ chars/);
  assert.match(output, /full output saved to \S+/);
  assert.ok(output.length < 20000, `truncated output stays small (was ${output.length})`);
});

test('read returns line numbers, honours offset/limit, and rejects directories', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'lines.txt');
  await fs.writeFile(file, 'alpha\nbeta\ngamma\ndelta\n', 'utf8');
  const tools = registryFor(dir);

  const all = await tools.run('read', { file_path: file });
  assert.match(all, /1\talpha/);
  assert.match(all, /4\tdelta/);

  const page = await tools.run('read', { file_path: file, offset: 2, limit: 2 });
  assert.match(page, /2\tbeta/);
  assert.match(page, /3\tgamma/);
  assert.doesNotMatch(page, /alpha/);
  assert.match(page, /showing lines 2-3 of 4/);

  await assert.rejects(() => tools.run('read', { file_path: dir }), /is a directory/);
  await assert.rejects(() => tools.run('read', { file_path: path.join(dir, 'nope.txt') }), /file not found/);
});

test('write and edit are atomic and edit refuses ambiguous matches', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.txt');
  const tools = registryFor(dir);

  await tools.run('write', { file_path: file, content: 'name=figaro\nmode=voice\nmode=voice\n' });
  assert.equal(await fs.readFile(file, 'utf8'), 'name=figaro\nmode=voice\nmode=voice\n');

  await tools.run('edit', { file_path: file, old_string: 'name=figaro', new_string: 'name=Figaro' });
  assert.equal(await fs.readFile(file, 'utf8'), 'name=Figaro\nmode=voice\nmode=voice\n');

  // Two identical matches and replace_all=false must be rejected.
  await assert.rejects(
    () => tools.run('edit', { file_path: file, old_string: 'mode=voice', new_string: 'mode=text' }),
    /appears 2 times/,
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'name=Figaro\nmode=voice\nmode=voice\n');

  await tools.run('edit', { file_path: file, old_string: 'mode=voice', new_string: 'mode=text', replace_all: true });
  assert.equal(await fs.readFile(file, 'utf8'), 'name=Figaro\nmode=text\nmode=text\n');

  await assert.rejects(
    () => tools.run('edit', { file_path: file, old_string: 'missing', new_string: 'x' }),
    /was not found/,
  );

  // Atomic write must not leave temp files behind and must preserve the mode.
  await fs.chmod(file, 0o600);
  await tools.run('edit', { file_path: file, old_string: 'Figaro', new_string: 'figaro' });
  const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('figaro-tmp'));
  assert.deepEqual(leftovers, []);
  const mode = (await fs.stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, 'atomic edit preserves the original file mode');
});

test('glob matches basenames recursively, includes hidden files, newest first', async (t) => {
  const dir = await tempDir(t);
  await fs.mkdir(path.join(dir, 'sub', 'deep'), { recursive: true });
  await fs.writeFile(path.join(dir, 'a.txt'), 'a');
  await fs.writeFile(path.join(dir, '.hidden.txt'), 'h');
  await fs.writeFile(path.join(dir, 'sub', 'b.txt'), 'b');
  await fs.writeFile(path.join(dir, 'sub', 'deep', 'c.txt'), 'c');
  await fs.writeFile(path.join(dir, 'skip.md'), 'm');
  const tools = registryFor(dir);

  const bare = await tools.run('glob', { pattern: '*.txt' });
  assert.match(bare, /a\.txt/);
  assert.match(bare, /\.hidden\.txt/);
  assert.match(bare, /sub\/b\.txt/);
  assert.match(bare, /sub\/deep\/c\.txt/);
  assert.doesNotMatch(bare, /skip\.md/);

  const anchored = await tools.run('glob', { pattern: 'sub/*.txt' });
  assert.match(anchored, /sub\/b\.txt/);
  assert.doesNotMatch(anchored, /sub\/deep\/c\.txt/);

  const none = await tools.run('glob', { pattern: '*.nope' });
  assert.match(none, /No files found/);

  assert.ok(compileGlob('*.js').test('a/b/c.js'));
  assert.ok(compileGlob('src/**/*.{js,ts}').test('src/x/y.ts'));
  assert.ok(!compileGlob('src/*.js').test('src/x/y.js'));
});

test('grep groups matches by file with line numbers and skips binaries', async (t) => {
  const dir = await tempDir(t);
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'a.js'), 'const alpha = 1;\nconst beta = 2;\nconst alpha = 3;\n');
  await fs.writeFile(path.join(dir, 'src', 'b.md'), 'alpha in markdown\n');
  await fs.writeFile(path.join(dir, 'src', 'blob.bin'), Buffer.from([0x61, 0x00, 0x62]));
  const tools = registryFor(dir);

  const all = await tools.run('grep', { pattern: 'alpha' });
  assert.match(all, /Found 3 match\(es\) in 2 file\(s\)/);
  assert.match(all, /a\.js/);
  assert.match(all, /1: const alpha = 1;/);
  assert.match(all, /b\.md/);
  assert.doesNotMatch(all, /blob\.bin/);

  const filtered = await tools.run('grep', { pattern: 'alpha', include: '*.js' });
  assert.match(filtered, /b\.js|a\.js/);
  assert.doesNotMatch(filtered, /b\.md/);

  const none = await tools.run('grep', { pattern: 'zzz-not-there' });
  assert.match(none, /No matches/);

  await assert.rejects(() => tools.run('grep', { pattern: '([unclosed' }), /invalid regular expression/);
});
