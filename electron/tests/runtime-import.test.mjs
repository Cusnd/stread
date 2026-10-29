import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compilerFiles, contractSpecs, runtimeServices, productionServiceFile, runtimeDependencies, matchingDependencyLock } from '../prepare-runtime.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Resolve only bare dependencies from the installed checkout. Local imports
// must resolve inside the staged payload; falling back for those would hide the
// exact missing-shared-module regression this smoke test is meant to catch.
const smoke = String.raw`
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [stage, repository] = process.argv.slice(1);
const fallbacks = ['services/workspace/package.json', 'prototypes/insight-composer/package.json']
  .map(path => pathToFileURL(join(repository, path)).href);
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (original) {
      const bare = !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#')
        && !/^[a-z][a-z0-9+.-]*:/i.test(specifier);
      if (!bare || original.code !== 'ERR_MODULE_NOT_FOUND') throw original;
      for (const parentURL of fallbacks) {
        try { return nextResolve(specifier, { ...context, parentURL }); }
        catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
      }
      throw original;
    }
  },
});
const staged = path => pathToFileURL(join(stage, path)).href;
const { createWorkspaceServer } = await import(staged('services/workspace/server.mjs'));
assert.equal(typeof createWorkspaceServer, 'function');
const { authoringContract, authoringDocumentation, documentation } = await import(staged('services/workspace/authoring.mjs'));
const contract = authoringContract();
assert.equal(contract.format, 'reader-authoring-1');
const documents = new Map();
for (const [name] of documentation) {
  const descriptor = await authoringDocumentation(name);
  const bytes = descriptor.body ?? await readFile(descriptor.path);
  assert.ok(bytes.length > 0, 'empty packaged documentation: ' + name);
  documents.set(name, bytes);
}
for (const descriptor of contract.documentation) assert.ok(documents.has(descriptor.filename));
const { compileInput } = await import(staged('services/workspace/documents.mjs'));
const minimal = JSON.parse(documents.get('minimal-example.json').toString('utf8'));
const compiled = await compileInput(minimal);
assert.ok(compiled.document.blocks.length > 0);
assert.ok(compiled.document.blocks.some(block => block.translations?.['zh-CN']));
console.log(JSON.stringify({ documents: documents.size, blocks: compiled.document.blocks.length }));
`;

test('declared desktop payload imports the backend and serves every authoring document without checkout source fallback', async (t) => {
  const stage = await mkdtemp(join(tmpdir(), 'reader-runtime-import-'));
  t.after(async () => {
    assert.equal(dirname(resolve(stage)), resolve(tmpdir()));
    assert.ok(basename(stage).startsWith('reader-runtime-import-'));
    await rm(stage, { recursive: true, force: true });
  });
  for (const service of runtimeServices) await cp(join(repository, 'services', service), join(stage, 'services', service), { recursive: true, filter: productionServiceFile });
  for (const file of compilerFiles) {
    const target = join(stage, 'prototypes/insight-composer', file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repository, 'prototypes/insight-composer', file), target);
  }
  await mkdir(join(stage, 'spec'));
  for (const file of contractSpecs) await cp(join(repository, 'spec', file), join(stage, 'spec', file));
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const run = () => spawnSync(process.execPath, ['--input-type=module', '--eval', smoke, stage, repository], {
    cwd: stage, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  const result = run();
  assert.equal(result.status, 0, result.error?.stack || result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim());
  assert.ok(summary.documents >= 4);
  assert.ok(summary.blocks > 0);

  // Each probe starts a fresh module graph, so the preceding successful import
  // cannot mask an omitted shared file through the ESM module cache.
  const shared = join(stage, 'prototypes/insight-composer/src/conversion-request.js');
  const sharedBytes = await readFile(shared);
  await rm(shared);
  const missingModule = run();
  assert.notEqual(missingModule.status, 0);
  assert.match(missingModule.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.match(missingModule.stderr, /conversion-request\.js/);
  await writeFile(shared, sharedBytes);
  await rm(join(stage, 'spec/转换质量反馈.md'));
  const missingDocument = run();
  assert.notEqual(missingDocument.status, 0);
  assert.match(missingDocument.stderr, /ENOENT/);
  assert.match(missingDocument.stderr, /转换质量反馈\.md/);
});

test('runtime dependency merge keeps one pinned version per shared package', () => {
  assert.deepEqual(runtimeDependencies({ dependencies: { shared: '1.2.3' } }, { dependencies: { shared: '1.2.3', agent: '2.0.2' } }), { shared: '1.2.3', agent: '2.0.2' });
  assert.throws(() => runtimeDependencies({ dependencies: { shared: '1.2.3' } }, { dependencies: { shared: '1.2.4' } }), /Conflicting/);
  assert.throws(() => runtimeDependencies({ dependencies: { agent: '^2.0.2' } }), /pinned/);
});

test('runtime lock pins the exact production dependency set across update builds', async () => {
  const lock = JSON.parse(await readFile(join(repository, 'electron/runtime-package-lock.json')));
  const service = JSON.parse(await readFile(join(repository, 'services/workspace/package.json')));
  const client = JSON.parse(await readFile(join(repository, 'prototypes/insight-composer/package.json')));
  const dependencies = runtimeDependencies(service, { dependencies: { 'css-tree': client.dependencies['css-tree'] } });
  assert.equal(matchingDependencyLock(lock, dependencies), true);
  assert.equal(matchingDependencyLock(lock, { ...dependencies, zod: '0.0.0' }), false);
  assert.equal(matchingDependencyLock(lock, { ...dependencies, added: '1.0.0' }), false);
  assert.equal(Boolean(matchingDependencyLock({}, dependencies)), false);
});
