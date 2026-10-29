import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPdf } from '../../services/workspace/resources.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pythonPath = join(repository, '.desktop/runtime/python/python.exe');
const unavailable = process.platform !== 'win32' || !existsSync(pythonPath)
  ? 'Requires the prepared isolated Windows Python runtime (npm run desktop:prepare)'
  : false;

test('source and build Python resolve PATH defaults and independent executable overrides', () => {
  const inspect = `const source = await import('./services/workspace/resources.mjs');
    const build = await import('./electron/prepare-python.mjs');
    console.log(JSON.stringify({ source: source.defaultPython, build: build.buildPython }));`;
  const clean = { ...process.env };
  delete clean.CONTINUOUS_READER_PYTHON;
  delete clean.CONTINUOUS_READER_BUILD_PYTHON;
  delete clean.CONTINUOUS_READER_BUILD_RUNTIME;
  const read = (env) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', inspect], {
      cwd: repository, env, encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    return JSON.parse(result.stdout.trim());
  };
  const command = process.platform === 'win32' ? 'python' : 'python3';
  assert.deepEqual(read(clean), { source: command, build: command });
  assert.deepEqual(read({ ...clean, CONTINUOUS_READER_PYTHON: 'source-python', CONTINUOUS_READER_BUILD_PYTHON: 'build-python' }), {
    source: 'source-python', build: 'build-python',
  });
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'reader-python-source-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(root.startsWith(join(tmpdir(), 'reader-python-source-')));
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, "源码 helper's directory");
  await mkdir(source);
  for (const name of ['resources.mjs', 'errors.mjs', 'immutable-objects.mjs']) {
    await copyFile(join(repository, 'services/workspace', name), join(source, name));
  }
  return { root, source, run: (await import(pathToFileURL(join(source, 'resources.mjs')).href)).runPdf };
}

test('isolated Python uses current helper siblings and reloads edits without trusting environment paths', { skip: unavailable }, async (t) => {
  const { root, source, run } = await fixture(t);
  const poison = join(root, 'untrusted-python-path');
  await mkdir(poison);
  await writeFile(join(poison, 'environment_only.py'), 'VALUE = "must not load"\n');
  await writeFile(join(poison, 'pdf_regions.py'), 'VALUE = "wrong environment"\n');
  const previous = process.env.PYTHONPATH;
  process.env.PYTHONPATH = poison;
  t.after(() => { if (previous === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = previous; });
  const helper = `import importlib.util, json, sys, pdf_regions
request = json.load(sys.stdin)
print(json.dumps({'ok': True, 'result': {
    'value': pdf_regions.VALUE, 'module': pdf_regions.__file__,
    'isolated': sys.flags.isolated, 'ignoreEnvironment': sys.flags.ignore_environment,
    'environmentModule': importlib.util.find_spec('environment_only') is not None,
    'siteLoaded': 'site' in sys.modules, 'argv': sys.argv, 'request': request,
    'helperVersion': 1
}}, ensure_ascii=False))
`;
  await writeFile(join(source, 'pdf.py'), helper);
  await writeFile(join(source, 'pdf_regions.py'), 'VALUE = "current repo sibling"\n');
  const request = { text: '当前源码 ✓' };
  const first = await run(request, { pythonPath });
  assert.equal(first.value, 'current repo sibling');
  assert.equal(resolve(first.module), join(source, 'pdf_regions.py'));
  assert.equal(first.isolated, 1);
  assert.equal(first.ignoreEnvironment, 1);
  assert.equal(first.environmentModule, false);
  assert.equal(first.siteLoaded, false);
  assert.deepEqual(first.argv, [join(source, 'pdf.py')]);
  assert.deepEqual(first.request, request);
  await writeFile(join(source, 'pdf_regions.py'), 'VALUE = "changed source sibling"\n');
  await writeFile(join(source, 'pdf.py'), helper.replace("'helperVersion': 1", "'helperVersion': 2"));
  const second = await run(request, { pythonPath });
  assert.equal(second.value, 'changed source sibling');
  assert.equal(second.helperVersion, 2);
  assert.equal(existsSync(join(source, '__pycache__')), false);
});

test('repo and packaged helper layout retain identical real PDF results in isolated Python', { skip: unavailable }, async (t) => {
  const { root, source, run: packagedRun } = await fixture(t);
  for (const name of ['pdf.py', 'pdf_regions.py']) {
    await copyFile(join(repository, 'services/workspace', name), join(source, name));
  }
  const pdf = join(root, '原页 fixture.pdf');
  const rotations = await runPdf({ action: 'coordinate_probe', outputPath: pdf }, { pythonPath });
  assert.deepEqual(rotations.map((page) => page.rotation), [0, 90, 180, 270]);
  assert.deepEqual(await packagedRun({ action: 'coordinate_probe' }, { pythonPath }), rotations);
  const manifest = await runPdf({ action: 'manifest', path: pdf }, { pythonPath });
  assert.deepEqual(await packagedRun({ action: 'manifest', path: pdf }, { pythonPath }), manifest);
  assert.equal(manifest.pages.length, 1);
  const request = { action: 'regions', path: pdf, blocks: [{ id: 'mapped', type: 'para', text: 'Mapped text', source: [{ page: 1 }] }] };
  const regions = await runPdf(request, { pythonPath });
  assert.deepEqual(await packagedRun(request, { pythonPath }), regions);
  assert.ok(regions.regions.some((region) => region.blockId === 'mapped' && Array.isArray(region.box)));
  const outputPath = join(root, '渲染 result.png');
  const rendered = await packagedRun({ action: 'render', path: pdf, page: 1, width: 600, outputPath }, { pythonPath });
  assert.equal(rendered.pixelWidth, 600);
  assert.deepEqual((await readFile(outputPath)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});
