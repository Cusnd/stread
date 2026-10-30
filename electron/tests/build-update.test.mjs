import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { appFiles, foundationFiles, buildUpdate, digest, foundationId, manifestName, parseArguments, validateUpdatePath, verifyEnvelope } from '../build-update.mjs';
import { generateUpdateKey } from '../update-keygen.mjs';
import updateClient from '../update-core.cjs';

async function put(root, path, value) {
  const file = join(root, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, value);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'reader-update-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const pkg = { name: 'stread', version: '1.0.0', type: 'module', main: 'electron/bootstrap.cjs', scripts: { privateBuildPath: 'not shipped' }, devDependencies: { electron: '45.0.0' } };
  await put(root, 'package.json', JSON.stringify(pkg));
  for (const file of appFiles) await put(root, file, '// ' + file + '\n');
  for (const file of foundationFiles) await put(root, file, '// foundation ' + file + '\n');
  await put(root, 'electron/update-public-key.pem', keys.publicKey);
  for (const file of ['stread.ico', 'stread.png']) await put(root, 'electron/assets/' + file, 'icon');
  await put(root, '.desktop/runtime/node_modules/example/index.js', 'dependency');
  await put(root, '.desktop/runtime/python/python.exe', 'python');
  await put(root, '.desktop/runtime/package.json', '{"type":"module"}');
  await put(root, '.desktop/runtime/client/index.html', '<h1>Reader</h1>');
  await put(root, '.desktop/runtime/client/old.js', 'old resource');
  await put(root, '.desktop/runtime/services/workspace/server.mjs', 'export const version = 1;');
  await put(root, '.desktop/runtime/services/workspace/stdio.mjs', 'export const protocol = 1;');
  for (const name of ['workspace-schema.mjs', 'sync-schema.mjs']) await put(root, '.desktop/runtime/services/workspace/' + name, 'export const schema = 1;\n');
  const options = { root, privateKeyPem: keys.privateKey, verifyRuntime: false };
  return { root, pkg, keys, options, build: (extra = {}) => buildUpdate({ ...options, fullFoundation: !extra.base, ...extra }), version: async (value) => { pkg.version = value; await put(root, 'package.json', JSON.stringify(pkg)); } };
}

async function envelope(report) { return JSON.parse(await readFile(report.manifest, 'utf8')); }
async function payload(report, meta) {
  const bytes = await readFile(join(report.out, meta.name));
  assert.equal(bytes.length, meta.bytes);
  assert.equal(digest(bytes), meta.sha256);
  return JSON.parse(gunzipSync(bytes));
}

test('full application update is signed and excludes the heavy runtime and development package metadata', async (t) => {
  const h = await fixture(t), report = await h.build(), signed = await envelope(report);
  assert.equal(signed.manifest.installerVersion, '1.0.0');
  assert.equal(verify(null, Buffer.from(JSON.stringify(signed.manifest)), createPublicKey(h.keys.publicKey), Buffer.from(signed.signature, 'base64')), true);
  assert.equal(updateClient.verifyEnvelope(signed, h.keys.publicKey).id, signed.manifest.id);
  const body = await payload(report, signed.manifest.payload);
  assert.equal(body.schema, 1);
  assert.equal(body.files.some((entry) => /python|node_modules/.test(entry.path)), false);
  const metadata = JSON.parse(Buffer.from(body.files.find((entry) => entry.path === 'app/package.json').data, 'base64'));
  assert.equal(metadata.version, '1.0.0');
  assert.equal(metadata.main, 'electron/main.cjs');
  assert.equal('scripts' in metadata, false);
  assert.equal('devDependencies' in metadata, false);
  for (const entry of signed.manifest.files) {
    const file = body.files.find((file) => file.path === entry.path);
    const bytes = Buffer.from(file.data, 'base64');
    assert.equal(bytes.length, entry.bytes);
    assert.equal(digest(bytes), entry.sha256);
  }
  assert.equal(report.manifest, join(report.out, manifestName));
});

test('delta contains exactly added/changed files and a full fallback, while removed files disappear from inventory', async (t) => {
  const h = await fixture(t), first = await h.build(), base = await envelope(first);
  await h.version('1.0.1');
  await put(h.root, '.desktop/runtime/services/workspace/server.mjs', 'export const version = 2;');
  await put(h.root, '.desktop/runtime/client/new.js', 'new resource');
  await rm(join(h.root, '.desktop/runtime/client/old.js'));
  const report = await h.build({ base, requireCompatibleBase: true }), next = (await envelope(report)).manifest;
  assert.equal(next.foundation, base.manifest.foundation);
  assert.equal(next.installerVersion, '1.0.0');
  assert.equal(next.delta.from, base.manifest.id);
  assert.equal(next.files.some((entry) => entry.path.endsWith('/old.js')), false);
  const change = await payload(report, next.delta);
  assert.deepEqual(change.files.map((entry) => entry.path), ['app/package.json', 'runtime/client/new.js', 'runtime/services/workspace/server.mjs']);
  const full = await payload(report, next.payload);
  const old = await payload(first, base.manifest.payload);
  const reconstructed = new Map(old.files.map((entry) => [entry.path, entry.data]));
  for (const entry of change.files) reconstructed.set(entry.path, entry.data);
  for (const path of reconstructed.keys()) if (!next.files.some((entry) => entry.path === path)) reconstructed.delete(path);
  assert.deepEqual([...reconstructed].sort(), full.files.map((entry) => [entry.path, entry.data]).sort());
  await h.version('1.0.2');
  const later = await h.build({ base: await envelope(report), requireCompatibleBase: true });
  assert.equal((await envelope(later)).manifest.installerVersion, '1.0.0');
});

test('the shipped updater installs a publisher-generated delta over an exact baseline', async (t) => {
  const h = await fixture(t), first = await h.build(), base = await envelope(first);
  const resourcesPath = join(h.root, 'install/resources'), appRoot = join(resourcesPath, 'app'), profile = join(h.root, 'profile');
  await cp(join(h.root, '.desktop/runtime'), join(resourcesPath, 'runtime'), { recursive: true });
  await cp(join(h.root, '.desktop/update-base.json'), join(resourcesPath, 'update-base.json'));
  for (const file of appFiles) await put(appRoot, file, await readFile(join(h.root, file)));
  await put(appRoot, 'package.json', await readFile(join(h.root, 'package.json')));
  await put(profile, 'workspace/private.sqlite', 'private fixture');
  await h.version('1.0.1');
  await put(h.root, '.desktop/runtime/client/index.html', '<h1>Updated</h1>');
  const next = await h.build({ base, requireCompatibleBase: true }), signed = await envelope(next), downloads = [];
  const create = () => updateClient.createUpdater({ app: {}, profile, resourcesPath, appRoot, publicKey: h.keys.publicKey, platform: 'win32', arch: 'x64', fetchImpl: async (url) => {
    downloads.push(url);
    if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'v1.0.1', draft: false, prerelease: false, published_at: '2026-10-28T12:00:00Z', assets: [{ name: manifestName }] });
    if (url.endsWith(manifestName)) return Response.json(signed);
    const file = url.slice(url.lastIndexOf('/') + 1);
    return new Response(await readFile(join(next.out, file)));
  } });
  const client = create();
  assert.equal(client.select().version, '1.0.0');
  assert.equal((await client.check()).incremental, true);
  await client.download(); client.activate();
  const launched = create(), selected = launched.select();
  assert.equal(selected.version, '1.0.1');
  assert.equal(await readFile(join(selected.runtime, 'client/index.html'), 'utf8'), '<h1>Updated</h1>');
  assert.equal(await readFile(join(selected.runtime, 'node_modules/example/index.js'), 'utf8'), 'dependency');
  assert.equal(await readFile(join(profile, 'workspace/private.sqlite'), 'utf8'), 'private fixture');
  assert.ok(downloads.at(-1).endsWith(signed.manifest.delta.name));
  launched.markHealthy();
  assert.equal(create().select().version, '1.0.1');
});

test('foundation fingerprints file bytes, locks and bootstrap, and app-only builds stop across a foundation change', async (t) => {
  const h = await fixture(t), first = await h.build(), base = await envelope(first);
  await h.version('1.0.1');
  await put(h.root, '.desktop/runtime/node_modules/example/index.js', 'DEPENDENCY');
  await assert.rejects(h.build({ base, requireCompatibleBase: true }), /compatible published baseline/);
  const full = await h.build({ base, fullFoundation: true });
  assert.notEqual(full.foundation, first.foundation);
  assert.equal((await envelope(full)).manifest.installerVersion, '1.0.1');
  assert.equal((await envelope(full)).manifest.delta, undefined);
  const before = full.foundation;
  await put(h.root, 'electron/bootstrap.cjs', '// changed bootstrap');
  assert.notEqual(await foundationId({ root: h.root, runtime: join(h.root, '.desktop/runtime'), electron: '45.0.0' }), before);
});

test('a baseline-only build has no signing key requirement and still writes the logical inventory', async (t) => {
  const h = await fixture(t);
  const result = await h.build({ baselineOnly: true, privateKeyPem: undefined });
  const baseline = JSON.parse(await readFile(result.baseline, 'utf8'));
  assert.equal(baseline.schema, 1);
  assert.equal(baseline.id, digest(JSON.stringify(baseline.files)));
  assert.equal(baseline.version, '1.0.0');
  assert.deepEqual(baseline.foundationFiles.map((entry) => entry.path), ['runtime/node_modules/example/index.js', 'runtime/python/python.exe']);
  assert.equal(result.manifest, undefined);
});

test('schema changes require a new foundation while checkout newline differences do not', async (t) => {
  const h = await fixture(t);
  const options = { root: h.root, runtime: join(h.root, '.desktop/runtime'), electron: '45.0.0' };
  const before = await foundationId(options);
  for (const path of foundationFiles) {
    const original = await readFile(join(h.root, path), 'utf8');
    await put(h.root, path, original.replaceAll('\n', '\r\n'));
  }
  await put(h.root, '.desktop/runtime/services/workspace/workspace-schema.mjs', 'export const schema = 1;\r\n');
  assert.equal(await foundationId(options), before);
  await put(h.root, '.desktop/runtime/services/workspace/workspace-schema.mjs', 'export const schema = 2;\n');
  assert.notEqual(await foundationId(options), before);
});

test('publisher rejects wrong keys, corrupt previous signatures, nonincreasing versions and unsafe paths', async (t) => {
  const h = await fixture(t), wrong = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  await assert.rejects(h.build({ fullFoundation: false }), /requires --base/);
  await assert.rejects(h.build({ privateKeyPem: wrong.privateKey }), /does not match/);
  const first = await h.build(), base = await envelope(first);
  await assert.rejects(h.build({ base }), /must be greater/);
  await h.version('1.0.1');
  const changed = structuredClone(base); changed.manifest.version = '0.9.9';
  await assert.rejects(h.build({ base: changed }), /signature is invalid/);
  for (const path of ['runtime/../bad', 'runtime/client/a:stream', 'runtime/client/CON.txt', 'runtime/client/file.', 'runtime/client/file ', 'runtime/client/a\\b', '/runtime/client/file', 'runtime/python/python.exe', 'runtime/services/workspace/node_modules/a.js', 'runtime/client/.env', 'app/electron/rogue.cjs', 'runtime/services/workspace/.data/workspace.sqlite']) assert.throws(() => validateUpdatePath(path), undefined, path);
  await put(h.root, '.desktop/runtime/services/workspace/.env', 'private');
  await assert.rejects(h.build(), /private workspace/);
});

test('previous signed inventory still rejects an invalid digest or case-colliding paths', async (t) => {
  const h = await fixture(t), base = await envelope(await h.build());
  const res = (manifest) => ({ manifest, signature: sign(null, Buffer.from(JSON.stringify(manifest)), h.keys.privateKey).toString('base64') });
  const digestMismatch = structuredClone(base.manifest); digestMismatch.id = '0'.repeat(64);
  assert.throws(() => verifyEnvelope(res(digestMismatch), h.keys.publicKey), /digest does not match/);
  const duplicate = structuredClone(base.manifest);
  duplicate.files.push({ path: 'runtime/client/INDEX.html', sha256: 'a'.repeat(64), bytes: 1 });
  duplicate.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  duplicate.id = digest(JSON.stringify(duplicate.files));
  assert.throws(() => verifyEnvelope(res(duplicate), h.keys.publicKey), /Invalid previous update inventory/);
});

test('key generation refuses existing keys without modifying either file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reader-update-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicFile = join(root, 'public.pem'), privateFile = join(root, 'private.pem');
  await generateUpdateKey({ publicFile, privateFile });
  const publicBefore = await readFile(publicFile), privateBefore = await readFile(privateFile);
  await assert.rejects(generateUpdateKey({ publicFile, privateFile }), /refusing to replace/);
  assert.deepEqual(await readFile(publicFile), publicBefore);
  assert.deepEqual(await readFile(privateFile), privateBefore);
});

test('release arguments reject ambiguous values and expose explicit baseline-only mode', () => {
  assert.deepEqual(parseArguments(['--baseline-only', '--require-compatible-base']), { baselineOnly: true, requireCompatibleBase: true });
  assert.deepEqual(parseArguments(['--full-foundation']), { fullFoundation: true });
  for (const args of [['--base'], ['--out', '--base'], ['--secret', 'value']]) assert.throws(() => parseArguments(args));
});
