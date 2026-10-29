'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { createRequire } = require('node:module');
const afterPack = require('../verify-package.cjs');
const { verifyRuntime, requiredFiles, directDependencies } = afterPack;

async function put(root, name, value = 'runtime fixture\n') {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'reader-package-test-'));
  t.after(async () => {
    assert.ok(root.startsWith(path.join(tmpdir(), 'reader-package-test-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  const stagedRuntime = path.join(root, 'stage/runtime'), runtime = path.join(root, 'package/runtime');
  for (const file of requiredFiles) await put(stagedRuntime, file);
  await put(stagedRuntime, 'package.json', JSON.stringify({ name: 'continuous-reader-runtime', dependencies: Object.fromEntries(Object.keys(directDependencies).map((name) => [name, '1.0.0'])) }));
  for (const [name, specifier] of Object.entries(directDependencies)) {
    const main = 'index.js';
    await put(stagedRuntime, 'node_modules/' + name + '/package.json', JSON.stringify({ name, version: '1.0.0', main }));
    await put(stagedRuntime, 'node_modules/' + name + '/' + main, 'module.exports = {};\n');
    if (specifier.startsWith(name + '/')) await put(stagedRuntime, 'node_modules/' + specifier, 'module.exports = {};\n');
  }
  await put(stagedRuntime, 'node_modules/zod/v4/core/util.js', 'module.exports = {};\n');
  await put(stagedRuntime, 'client/index.html', '<script type="module" src="/assets/index.js"></script><link rel="stylesheet" href="/assets/index.css">');
  await put(stagedRuntime, 'client/assets/index.js', 'console.log("fixture");');
  await put(stagedRuntime, 'client/assets/index.css', 'body { color: black; }');
  await put(stagedRuntime, 'python/python313._pth', 'python313.zip\n.\nLib/site-packages\n../services/workspace\n# isolated runtime\n');
  await put(stagedRuntime, 'python/python313.dll');
  await put(stagedRuntime, 'python/python313.zip');
  await put(stagedRuntime, 'python/py.typed', '');
  await put(stagedRuntime, 'python/continuous-reader-runtime.json', JSON.stringify({ schema: 2, payload: 'runtime-only-v2', files: [
    { path: 'python.exe', bytes: (await fs.stat(path.join(stagedRuntime, 'python/python.exe'))).size },
    { path: 'py.typed', bytes: 0 },
  ] }));
  await fs.cp(stagedRuntime, runtime, { recursive: true });
  return { root, runtime, stagedRuntime, verify: () => verifyRuntime({ runtime, stagedRuntime }) };
}

test('a complete staged/packaged runtime resolves every production dependency only from its own node_modules', async (t) => {
  const h = await fixture(t), report = await h.verify();
  assert.equal(Object.keys(report.dependencies).length, Object.keys(directDependencies).length);
  assert.ok(Object.values(report.dependencies).every((name) => name.startsWith('node_modules/')));
  assert.ok(report.fileCount > requiredFiles.length);
  assert.ok(report.bytes > 0);
});

test('ancestor-installed dependencies cannot hide a missing packaged dependency', async (t) => {
  const h = await fixture(t);
  const packagePath = path.join(h.runtime, 'node_modules/css-tree');
  assert.ok(packagePath.startsWith(h.root + path.sep));
  await fs.rm(packagePath, { recursive: true });
  await put(path.dirname(h.runtime), 'node_modules/css-tree/package.json', '{"name":"css-tree","main":"index.js"}');
  await put(path.dirname(h.runtime), 'node_modules/css-tree/index.js', 'module.exports = {};');
  const external = createRequire(path.join(h.runtime, 'package.json')).resolve('css-tree');
  assert.equal(external, path.join(path.dirname(h.runtime), 'node_modules/css-tree/index.js'));
  await assert.rejects(h.verify(), /required file is missing: node_modules\/css-tree\/package.json/);
});

test('a junction to host dependencies is rejected even when module resolution succeeds', async (t) => {
  const h = await fixture(t), packagePath = path.join(h.runtime, 'node_modules/css-tree');
  const external = path.join(h.root, 'host-css-tree');
  await put(external, 'package.json', '{"name":"css-tree","main":"index.js"}');
  await put(external, 'index.js', 'module.exports = {};');
  assert.ok(packagePath.startsWith(h.root + path.sep));
  await fs.rm(packagePath, { recursive: true });
  await fs.symlink(external, packagePath, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(h.verify(), /resolves outside the package/);
});

test('missing transitive code is caught by full production-tree comparison after direct dependencies resolve', async (t) => {
  const h = await fixture(t);
  await fs.unlink(path.join(h.runtime, 'node_modules/zod/v4/core/util.js'));
  await assert.rejects(h.verify(), /payload mismatch.*zod\/v4\/core\/util.js/);
});

test('the built HTML must reference files that exist in the package', async (t) => {
  const h = await fixture(t);
  await fs.unlink(path.join(h.runtime, 'client/assets/index.css'));
  await assert.rejects(h.verify(), /required file is missing: client\/assets\/index.css/);
});

test('PDF engine and isolated Python search paths must be packaged', async (t) => {
  const h = await fixture(t);
  await put(h.runtime, 'python/python313._pth', 'python313.zip\n.\nLib/site-packages\n../../host-python\n');
  await assert.rejects(h.verify(), /_pth references the host environment/);
  await fs.copyFile(path.join(h.stagedRuntime, 'python/python313._pth'), path.join(h.runtime, 'python/python313._pth'));
  await fs.unlink(path.join(h.runtime, 'python/Lib/site-packages/fitz/__init__.py'));
  await assert.rejects(h.verify(), /required file is missing: python\/Lib\/site-packages\/fitz/);
});

test('Python runtime rejects previous pip-built payloads and host-specific metadata', async (t) => {
  const h = await fixture(t), manifestPath = 'python/continuous-reader-runtime.json';
  const manifest = JSON.parse(await fs.readFile(path.join(h.runtime, manifestPath), 'utf8'));
  await put(h.runtime, manifestPath, JSON.stringify({ ...manifest, payload: 'runtime-only-v1' }));
  await assert.rejects(h.verify(), /preparation manifest is invalid/);
  await put(h.runtime, manifestPath, JSON.stringify(manifest));
  for (const name of ['python/Lib/site-packages/bin/pymupdf.exe', 'python/Lib/site-packages/pymupdf-1.0.dist-info/direct_url.json']) {
    await put(h.runtime, name, 'host-specific fixture');
    await assert.rejects(h.verify(), /host-specific Python installation metadata/);
    await fs.unlink(path.join(h.runtime, name));
    if (name.includes('/bin/')) await fs.rmdir(path.join(h.runtime, 'python/Lib/site-packages/bin'));
  }
});

test('workspace databases and desktop profile files are forbidden in runtime payloads', async (t) => {
  const h = await fixture(t);
  await put(h.runtime, 'services/workspace/.data/workspace.sqlite', 'private data');
  await assert.rejects(h.verify(), /private workspace\/profile data/);
  assert.throws(() => afterPack.validatePrivatePath('connection.json'), /private workspace\/profile data/);
  assert.throws(() => afterPack.validatePrivatePath('profile/reader-session.json'), /private workspace\/profile data/);
});

test('the compact runtime must retain every published authoring document', async (t) => {
  const h = await fixture(t);
  await fs.unlink(path.join(h.runtime, 'spec/双语对照.md'));
  await assert.rejects(h.verify(), /required file is missing: spec\/双语对照.md/);
});

test('retired Agent host and bundled provider payloads cannot return to the runtime', async (t) => {
  const h = await fixture(t);
  for (const file of ['services/agent-host/host.mjs', 'node_modules/@agentclientprotocol/sdk/package.json', 'node_modules/@openai/codex-win32-x64/package.json']) {
    await put(h.runtime, file);
    await assert.rejects(h.verify(), /retired Agent runtime must not be shipped/);
    const root = path.join(h.runtime, file.startsWith('services/') ? 'services/agent-host' : file.includes('@agentclientprotocol') ? 'node_modules/@agentclientprotocol' : 'node_modules/@openai');
    assert.ok(root.startsWith(h.runtime + path.sep));
    await fs.rm(root, { recursive: true });
  }
});

test('MuPDF development libraries cannot silently return to the package', async (t) => {
  const h = await fixture(t);
  await put(h.runtime, 'python/Lib/site-packages/pymupdf/mupdf-devel/lib/mupdfcpp64.lib');
  await assert.rejects(h.verify(), /MuPDF build-only files must not be shipped/);
});

test('afterPack refuses an application archive without the desktop MCP entry', async (t) => {
  const h = await fixture(t), appSource = path.join(h.root, 'app-source'), resources = path.dirname(h.runtime);
  for (const file of ['electron/main.cjs', 'electron/preload.cjs', 'electron/backend.cjs', 'electron/workspace-migration.cjs', 'package.json']) await put(appSource, file);
  await require('@electron/asar').createPackage(appSource, path.join(resources, 'app.asar'));
  await assert.rejects(afterPack({ appOutDir: h.root, packager: { projectDir: h.root, getResourcesDir: () => resources } }), /desktop entry is missing from app.asar: electron\/mcp.cjs/);
});

async function packagedFixture(t) {
  const h = await fixture(t), appSource = path.join(h.root, 'app-source'), resources = path.dirname(h.runtime);
  for (const file of ['assets/continuous-reader.ico', 'assets/continuous-reader.png']) await put(resources, file);
  for (const file of afterPack.requiredAppFiles) await put(appSource, file);
  await require('@electron/asar').createPackage(appSource, path.join(resources, 'app.asar'));
  await fs.mkdir(path.join(h.root, '.desktop'), { recursive: true });
  const base = JSON.stringify({ schema: 1, foundation: 'a'.repeat(64), id: 'b'.repeat(64), files: [{ path: 'app/electron/main.cjs' }] });
  await put(resources, 'update-base.json', base);
  await put(h.root, '.desktop/update-base.json', base);
  await fs.cp(h.stagedRuntime, path.join(h.root, '.desktop/runtime'), { recursive: true });
  return { ...h, resources, verifyPackage: (directory = resources) => afterPack({ appOutDir: h.root, packager: { projectDir: h.root, getResourcesDir: () => directory } }) };
}

test('afterPack accepts a complete local application without the retired remote proxy', async (t) => {
  const h = await packagedFixture(t), report = await h.verifyPackage();
  assert.ok(report.fileCount > requiredFiles.length);
});

test('package root aliases preserve containment while resource junctions cannot escape the canonical root', async (t) => {
  const h = await packagedFixture(t), alias = path.join(h.root, 'package-alias');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(h.resources, alias, linkType);
  assert.notEqual(path.resolve(alias), await fs.realpath(alias));
  const report = await h.verifyPackage(alias);
  assert.ok(report.fileCount > requiredFiles.length);

  const assets = path.join(h.resources, 'assets'), external = path.join(h.root, 'outside-assets');
  assert.ok(assets.startsWith(h.root + path.sep) && external.startsWith(h.root + path.sep));
  await fs.rename(assets, external);
  await fs.symlink(external, assets, linkType);
  await assert.rejects(h.verifyPackage(alias), /required file resolves outside the package: assets\/continuous-reader\.ico/);
});
