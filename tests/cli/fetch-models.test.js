// scripts/fetch-models.sh mirror/region tests.
//
// Everything runs offline against a stub `curl` on PATH, so no test downloads a
// model or depends on the network. Covered: bash syntax, region → source
// mapping (lib-mirrors.sh), CLI > env > config > auto priority, FIGARO_MIRROR
// override, --probe output (sources + URLs + fallback), --models-dir /
// FIGARO_MODELS_DIR, and that --probe/--check never write into the target dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'fetch-models.sh');
const LIB = path.join(REPO_ROOT, 'scripts', 'lib-mirrors.sh');

const execFileAsync = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error: err,
      });
    });
  });

const STUB_CURL = `#!/usr/bin/env bash
# Offline curl stub: logs the call, answers with a per-host HTTP code and, when
# STUB_FIXTURES is set, plays a real (fake-content) download for -o targets.
printf '%s\\n' "$*" >> "\${STUB_LOG:?}"
url=""; out=""; prev=""
for arg in "$@"; do
  case "$prev" in -o) out="$arg" ;; esac
  case "$arg" in http://*|https://*) url="$arg" ;; esac
  prev="$arg"
done
status="000"
case "$url" in
  *ghproxy.net*|*gh-proxy.com*|*ghfast.top*) status="\${STUB_GHPROXY:-000}" ;;
  *hf-mirror.com*) status="\${STUB_HF_MIRROR:-503}" ;;
  *huggingface.co*) status="\${STUB_HF:-200}" ;;
  *github.com*) status="\${STUB_GITHUB:-200}" ;;
  *modelscope.cn*) status="\${STUB_MODELSCOPE:-404}" ;;
  *) status="\${STUB_OTHER:-000}" ;;
esac
wanted=""; for arg in "$@"; do [[ "$arg" == *"%{http_code}"* ]] && wanted=1; done
if [[ -n "\${STUB_FIXTURES:-}" && -n "$out" ]]; then
  case "$url" in
    # Mirrors do not serve the fixtures: only official GitHub/HF do, so the
    # mirror path can be exercised as a real failure.
    https://ghproxy.net/*|https://gh-proxy.com/*|https://ghfast.top/*|https://hf-mirror.com/*) ;;
    *streaming-zipformer-zh-14M*) cp "\${STUB_FIXTURES}/stream.tar.bz2" "$out" ;;
    *paraformer-zh-2023-09-14*) cp "\${STUB_FIXTURES}/offline.tar.bz2" "$out" ;;
    *kws-zipformer-zh-en*) cp "\${STUB_FIXTURES}/kws.tar.bz2" "$out" ;;
    *silero_vad.onnx*) head -c 200000 /dev/zero > "$out" ;;
    *) status="404" ;;
  esac
fi
[[ -n "$wanted" ]] && printf '%s' "$status"
exit 0
`;

/** Build a valid .tar.bz2 with random (incompressible) files, like a real model tar. */
function buildFixtureTar(dir, top, files) {
  const src = path.join(dir, `src-${top}`);
  fs.mkdirSync(path.join(src, top), { recursive: true });
  for (const [name, size] of Object.entries(files)) {
    fs.writeFileSync(path.join(src, top, name), crypto.randomBytes(size));
  }
  const out = path.join(dir, `${top}.tar.bz2`);
  execFileSync('tar', ['-cjf', out, '-C', src, top]);
  return out;
}

function createWorld(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figaro-fetch-models-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const world = {
    root,
    home: path.join(root, 'home'),
    configDir: path.join(root, 'config'),
    stubDir: path.join(root, 'stub'),
    modelsDir: path.join(root, 'models'),
    modelsDirFlag: path.join(root, 'models-from-flag'),
    stubLog: path.join(root, 'curl.log'),
  };
  for (const dir of [world.home, world.configDir, world.stubDir]) fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(world.stubDir, 'curl');
  fs.writeFileSync(stub, STUB_CURL, { mode: 0o755 });
  world.writeConfig = (config) =>
    fs.writeFileSync(path.join(world.configDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  world.curlCalls = () =>
    fs.existsSync(world.stubLog)
      ? fs.readFileSync(world.stubLog, 'utf8').split('\n').filter(Boolean)
      : [];
  world.resetCurlLog = () => fs.rmSync(world.stubLog, { force: true });
  return world;
}

function scriptEnv(world, extra = {}) {
  const env = {
    ...process.env,
    HOME: world.home,
    FIGARO_CONFIG_DIR: world.configDir,
    XDG_RUNTIME_DIR: path.join(world.root, 'runtime'),
    PATH: `${world.stubDir}${path.delimiter}${process.env.PATH}`,
    STUB_LOG: world.stubLog,
    LC_ALL: 'C',
    LANG: 'C',
    TZ: 'UTC',
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('FIGARO_') && key !== 'FIGARO_CONFIG_DIR') delete env[key];
  }
  delete env.FIGARO_FETCH_KWS_LEGACY;
  return { ...env, ...extra };
}

function runScript(world, args, extraEnv = {}) {
  return execFileAsync('bash', [SCRIPT, ...args], { env: scriptEnv(world, extraEnv), cwd: REPO_ROOT });
}

function runLib(world, snippet, extraEnv = {}) {
  return execFileAsync('bash', ['-c', `source "${LIB}"\n${snippet}`], {
    env: scriptEnv(world, extraEnv),
    cwd: REPO_ROOT,
  });
}

test('both shell scripts pass bash -n', async () => {
  for (const file of [SCRIPT, LIB]) {
    const result = await execFileAsync('bash', ['-n', file]);
    assert.equal(result.code, 0, `${file} must parse: ${result.stderr}`);
  }
});

test('region → source chain mapping (mainland/hmt/overseas)', async (t) => {
  const world = createWorld(t);
  const mainland = await runLib(world, 'mirrors_region_chain mainland');
  assert.equal(mainland.stdout.trim(), 'modelscope\nhf-mirror\nghproxy\ngithub\nhf');
  for (const region of ['hmt', 'overseas']) {
    const chain = await runLib(world, `mirrors_region_chain ${region}`);
    assert.equal(chain.stdout.trim(), 'github\nhf\nmodelscope\nhf-mirror', region);
  }
  const invalid = await runLib(world, 'mirrors_region_chain mars; echo "rc=$?"');
  assert.match(invalid.stdout, /rc=1/);
});

test('FIGARO_MIRROR override pins a source first and keeps the fallback chain', async (t) => {
  const world = createWorld(t);
  const hf = await runLib(world, 'mirrors_chain mainland hf');
  assert.deepEqual(hf.stdout.trim().split('\n'), ['hf', 'modelscope', 'hf-mirror', 'ghproxy', 'github']);
  const github = await runLib(world, 'mirrors_chain hmt github');
  assert.deepEqual(github.stdout.trim().split('\n'), ['github', 'hf', 'modelscope', 'hf-mirror']);
  const bad = await runLib(world, 'mirrors_chain mainland nope; echo "rc=$?"');
  assert.match(bad.stdout, /rc=1/);
});

test('auto region is guessed from locale/timezone only (no network)', async (t) => {
  const world = createWorld(t);
  const cases = [
    ['zh_CN.UTF-8', 'UTC', 'mainland'],
    ['zh_TW.UTF-8', 'UTC', 'hmt'],
    ['zh_HK.UTF-8', 'UTC', 'hmt'],
    ['en_US.UTF-8', 'America/New_York', 'overseas'],
    ['C', 'Asia/Shanghai', 'mainland'],
    ['C', 'Asia/Hong_Kong', 'hmt'],
    ['C', 'UTC', 'overseas'],
  ];
  for (const [locale, tz, expected] of cases) {
    const result = await runLib(world, 'mirrors_guess_region "$LOCALE" "$TZ"', {
      LOCALE: locale,
      TZ: tz,
    });
    assert.equal(result.stdout.trim(), expected, `${locale}/${tz}`);
  }
});

test('region priority is CLI > env > config > auto', async (t) => {
  const world = createWorld(t);
  const priority = await runLib(
    world,
    'printf "%s\\n" "$(mirrors_resolve_region mainland hmt overseas)" '
      + '"$(mirrors_resolve_region "" hmt overseas)" '
      + '"$(mirrors_resolve_region "" "" overseas)" '
      + '"$(mirrors_resolve_region "" "" "")"',
  );
  assert.deepEqual(priority.stdout.trim().split('\n'), ['mainland', 'hmt', 'overseas', 'auto']);
});

test('--probe prints region, source order, per-artifact URLs and does not write', async (t) => {
  const world = createWorld(t);
  world.writeConfig({ models: { region: 'mainland' } });
  const result = await runScript(world, ['--probe', `--models-dir=${world.modelsDirFlag}`]);
  const out = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.code, 0, out);
  assert.match(out, /地区: mainland/);
  assert.match(out, /源顺序: modelscope > hf-mirror > ghproxy > github > hf/);
  assert.match(out, /probe 模型目录: .*models-from-flag/);
  // Every artifact is listed with a concrete URL + HTTP check.
  for (const artifact of ['kws', 'asr-stream', 'asr-offline', 'asr-sensevoice', 'vad', 'speaker']) {
    assert.match(out, new RegExp(`\\b${artifact}\\b`), `artifact ${artifact} missing from probe`);
  }
  assert.match(out, /github\s+200\/OK/);
  assert.match(out, /将使用 github/);
  // ModelScope has no mirror for these models: shown as not-applicable, not silently skipped.
  assert.match(out, /modelscope\s+不适用/);
  // The probe must not create the target directory or download anything.
  assert.equal(fs.existsSync(world.modelsDirFlag), false, 'probe must not create the models dir');
  assert.ok(world.curlCalls().length > 0, 'probe must HEAD-check the sources');
  for (const call of world.curlCalls()) {
    assert.match(call, /-r 0-255/, 'probe must only read a small range, not download models');
  }
});

test('--probe falls back when the preferred mirror fails', async (t) => {
  const world = createWorld(t);
  world.writeConfig({ models: { region: 'mainland' } });
  // hf-mirror down, ghproxy down, GitHub reachable: asr-stream must fall back to github.
  const result = await runScript(world, ['--probe', `--models-dir=${world.modelsDir}`], {
    STUB_HF_MIRROR: '503',
    STUB_GHPROXY: '000',
    STUB_GITHUB: '200',
  });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 0, out);
  assert.match(out, /asr-stream.*hf-mirror\s+503\/FAIL/);
  assert.match(out, /asr-stream.*hf-mirror 失败|自动 fallback|503\/FAIL/);
  assert.match(out, /asr-stream → 将使用 github/);
});

test('--probe reports failure when no source is reachable', async (t) => {
  const world = createWorld(t);
  world.writeConfig({ models: { region: 'mainland' } });
  const result = await runScript(world, ['--probe', '--only=vad', `--models-dir=${world.modelsDir}`], {
    STUB_GITHUB: '000',
    STUB_GHPROXY: '000',
    STUB_OTHER: '000',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /没有可用源/);
});

test('region can be overridden by env and CLI', async (t) => {
  const world = createWorld(t);
  world.writeConfig({ models: { region: 'mainland' } });

  const fromConfig = await runScript(world, ['--probe', '--only=kws', `--models-dir=${world.modelsDir}`]);
  assert.match(fromConfig.stderr, /地区: mainland/);

  const fromEnv = await runScript(world, ['--probe', '--only=kws', `--models-dir=${world.modelsDir}`], {
    FIGARO_REGION: 'hmt',
    STUB_GITHUB: '200',
  });
  assert.match(fromEnv.stderr, /地区: hmt/);
  assert.match(fromEnv.stderr, /源顺序: github > hf > modelscope > hf-mirror/);

  const fromCli = await runScript(world, ['--probe', '--only=kws', '--region=overseas', `--models-dir=${world.modelsDir}`], {
    FIGARO_REGION: 'hmt',
    STUB_GITHUB: '200',
  });
  assert.match(fromCli.stderr, /地区: overseas/);
});

test('auto region prints how it guessed and says it can be overridden', async (t) => {
  const world = createWorld(t);
  const result = await runScript(world, ['--probe', '--only=kws', `--models-dir=${world.modelsDir}`], {
    LANG: 'zh_TW.UTF-8',
    LC_ALL: 'zh_TW.UTF-8',
    TZ: 'Asia/Taipei',
    STUB_GITHUB: '200',
  });
  assert.match(result.stderr, /地区: hmt/);
  assert.match(result.stderr, /auto（依据 locale\/时区猜，可用 --region 覆盖）/);
});

test('--mirror overrides the region source order', async (t) => {
  const world = createWorld(t);
  world.writeConfig({ models: { region: 'mainland' } });
  const result = await runScript(world, ['--probe', '--only=asr', '--mirror=hf', `--models-dir=${world.modelsDir}`], {
    STUB_HF: '200',
  });
  assert.match(result.stderr, /源顺序: hf > modelscope > hf-mirror > ghproxy > github/);
  assert.match(result.stderr, /源覆盖: hf/);
  assert.match(result.stdout, /https:\/\/huggingface\.co\//);
  assert.match(result.stderr, /将使用 hf/);
});

test('invalid values are rejected with a clear message', async (t) => {
  const world = createWorld(t);
  const badRegion = await runScript(world, ['--region=mars', '--probe']);
  assert.notEqual(badRegion.code, 0);
  assert.match(badRegion.stderr, /--region 只支持 mainland\|hmt\|overseas\|auto/);

  const badMirror = await runScript(world, ['--mirror=nope', '--probe']);
  assert.notEqual(badMirror.code, 0);
  assert.match(badMirror.stderr, /FIGARO_MIRROR\/--mirror 只支持/);

  const badOnly = await runScript(world, ['--only=nope', '--probe']);
  assert.notEqual(badOnly.code, 0);
  assert.match(badOnly.stderr, /--only 只支持/);
});

test('--models-dir and FIGARO_MODELS_DIR choose the target directory', async (t) => {
  const world = createWorld(t);
  const viaFlag = await runScript(world, ['--check', `--models-dir=${world.modelsDirFlag}`]);
  assert.match(`${viaFlag.stdout}\n${viaFlag.stderr}`, /模型目录: .*models-from-flag/);
  assert.equal(viaFlag.code, 1, 'empty models dir reports missing models');

  const viaEnv = await runScript(world, ['--check'], { FIGARO_MODELS_DIR: world.modelsDir });
  assert.match(`${viaEnv.stdout}\n${viaEnv.stderr}`, /模型目录: .*\/models/);
  assert.match(`${viaEnv.stderr}`, /模型目录（最终）:/);
});

test('download path: tar source installs kws/asr-stream/asr-offline offline', async (t) => {
  const world = createWorld(t);
  const fixtures = path.join(world.root, 'fixtures');
  fs.mkdirSync(fixtures, { recursive: true });
  buildFixtureTar(fixtures, 'stream', {
    'encoder-epoch-99-avg-1.int8.onnx': 5_100_000,
    'decoder-epoch-99-avg-1.int8.onnx': 600_000,
    'joiner-epoch-99-avg-1.int8.onnx': 600_000,
    'tokens.txt': 2_000,
  });
  buildFixtureTar(fixtures, 'offline', { 'model.int8.onnx': 10_100_000, 'tokens.txt': 2_000 });
  buildFixtureTar(fixtures, 'kws', {
    'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx': 1_100_000,
    'decoder-epoch-13-avg-2-chunk-16-left-64.onnx': 60_000,
    'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx': 30_000,
    'tokens.txt': 200,
    'en.phone': 150_000,
  });

  const result = await runScript(world, ['--region=hmt', '--only=asr', `--models-dir=${world.modelsDir}`], {
    STUB_HF: '000',
    STUB_GITHUB: '200',
    STUB_GHPROXY: '000',
    STUB_FIXTURES: fixtures,
  });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 0, out);
  // hmt prefers official GitHub: both ASR artifacts must install from the tar fallback path.
  assert.match(out, /asr-stream 安装完成（来源: github）/);
  assert.match(out, /asr-offline 安装完成（paraformer zh int8；来源: github）/);
  assert.equal(fs.existsSync(path.join(world.modelsDir, 'asr-stream', 'encoder-epoch-99-avg-1.int8.onnx')), true);
  assert.equal(fs.existsSync(path.join(world.modelsDir, 'asr-offline', 'model.int8.onnx')), true);
  const stamp = fs.readFileSync(path.join(world.modelsDir, 'asr-stream', '.figaro-model'), 'utf8');
  assert.match(stamp, /artifact=github/);
  assert.match(out, /模型目录（最终）: .*models/);
});

test('download path: kws tar installs both wake lexicons (zh + en)', async (t) => {
  const world = createWorld(t);
  const fixtures = path.join(world.root, 'fixtures');
  fs.mkdirSync(fixtures, { recursive: true });
  buildFixtureTar(fixtures, 'kws', {
    'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx': 1_100_000,
    'decoder-epoch-13-avg-2-chunk-16-left-64.onnx': 60_000,
    'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx': 30_000,
    'tokens.txt': 200,
    'en.phone': 150_000,
  });

  const result = await runScript(world, ['--region=hmt', '--only=kws', `--models-dir=${world.modelsDir}`], {
    STUB_GITHUB: '200',
    STUB_HF: '000',
    STUB_GHPROXY: '000',
    STUB_FIXTURES: fixtures,
  });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 0, out);
  assert.match(out, /kws\(zh-en\) 安装完成（来源: github）/);
  const kwsDir = path.join(world.modelsDir, 'kws');
  for (const file of ['tokens.txt', 'en.phone', 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx']) {
    assert.equal(fs.existsSync(path.join(kwsDir, file)), true, `${file} missing`);
  }
  const stamp = fs.readFileSync(path.join(kwsDir, '.figaro-model'), 'utf8');
  assert.match(stamp, /artifact=github/);
  assert.match(stamp, /kind=kws-zh-en/);
});

test('download path: single-file source installs vad and mirrors fallback', async (t) => {
  const world = createWorld(t);
  // hf-mirror (preferred on mainland for file mirrors) is not applicable to vad:
  // ghproxy fails, so the installer must fall back to official github.
  const fixtures = path.join(world.root, 'fixtures');
  fs.mkdirSync(fixtures, { recursive: true });
  const result = await runScript(world, ['--region=mainland', '--only=vad', `--models-dir=${world.modelsDir}`], {
    STUB_HF_MIRROR: '000',
    STUB_GITHUB: '200',
    STUB_GHPROXY: '000',
    STUB_FIXTURES: fixtures,
  });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 0, out);
  assert.match(out, /源 ghproxy 失败，自动 fallback 到下一个源/);
  assert.match(out, /vad 安装完成（来源: github）/);
  assert.equal(fs.existsSync(path.join(world.modelsDir, 'vad', 'silero_vad.onnx')), true);
  assert.equal(fs.statSync(path.join(world.modelsDir, 'vad', 'silero_vad.onnx')).size, 200000);
});

test('--only=all is accepted and probes every artifact', async (t) => {
  const world = createWorld(t);
  const result = await runScript(world, ['--probe', '--only=all', `--models-dir=${world.modelsDir}`], {
    STUB_GITHUB: '200',
    STUB_HF_MIRROR: '200',
  });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.code, 0, out);
  for (const artifact of ['kws', 'asr-stream', 'asr-offline', 'vad', 'speaker']) {
    assert.match(out, new RegExp(`\\[probe\\] ${artifact} →`), `artifact ${artifact} not probed`);
  }
});

test('--check never touches the network', async (t) => {
  const world = createWorld(t);
  const result = await runScript(world, ['--check', `--models-dir=${world.modelsDir}`]);
  assert.equal(result.code, 1, 'no models installed yet');
  assert.match(result.stdout, /MISSING/);
  assert.match(result.stderr, /缺少模型/);
  assert.equal(world.curlCalls().length, 0, '--check must not call curl');
});
