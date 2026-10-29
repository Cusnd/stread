'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { generateKeyPairSync, sign } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { createUpdater, validateManifest, validatePath, verifyEnvelope, compareVersion, sha, config } = require('../update-core.cjs');

const keyPair = generateKeyPairSync('ed25519');
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' });
const foundation = sha('fixture foundation');
const appNames = ['main', 'preload', 'backend', 'mcp', 'workspace-migration', 'development'].map((name) => 'app/electron/' + name + '.cjs');
const names = [...appNames, 'app/package.json', 'runtime/client/index.html', 'runtime/client/assets/current.js', 'runtime/services/workspace/server.mjs', 'runtime/services/workspace/stdio.mjs', 'runtime/package.json'].sort();
const initial = new Map(names.map((name) => [name, Buffer.from(name === 'app/package.json' ? '{"version":"1.0.0"}' : 'initial ' + name)]));
function descriptors(files) { return [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) => ({ path: name, sha256: sha(bytes), bytes: bytes.length })); }
function envelope(manifest) { return { manifest, signature: sign(null, Buffer.from(JSON.stringify(manifest)), keyPair.privateKey).toString('base64') }; }
function release(files, releaseVersion = '1.0.1', options = {}) {
  const list = descriptors(files), payloadBytes = gzipSync(Buffer.from(JSON.stringify({ schema: 1, files: [...files].map(([name, bytes]) => ({ path: name, data: bytes.toString('base64') })) })));
  const manifest = { schema: 1, version: releaseVersion, installerVersion: '1.0.0', platform: 'win32', arch: 'x64', foundation, id: sha(JSON.stringify(list)), files: list,
    payload: { name: 'reader-' + releaseVersion + '.crupdate', bytes: payloadBytes.length, sha256: sha(payloadBytes) }, ...options };
  const output = { manifest, signed: envelope(manifest), payloadBytes };
  if (options.previous) {
    delete manifest.previous;
    const previous = options.previous, changed = [...files].filter(([name, bytes]) => previous.get(name)?.equals(bytes) !== true);
    output.deltaBytes = gzipSync(Buffer.from(JSON.stringify({ schema: 1, files: changed.map(([name, bytes]) => ({ path: name, data: bytes.toString('base64') })) })));
    manifest.delta = { name: 'reader-' + releaseVersion + '-delta.crupdate', from: sha(JSON.stringify(descriptors(previous))), bytes: output.deltaBytes.length, sha256: sha(output.deltaBytes) };
    output.signed = envelope(manifest);
  }
  return output;
}
function nextFiles(releaseVersion = '1.0.1') {
  const files = new Map(initial); files.set('app/package.json', Buffer.from(JSON.stringify({ version: releaseVersion })));
  files.set('runtime/client/assets/current.js', Buffer.from('updated UI ' + releaseVersion)); return files;
}
function write(root, name, bytes) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; }
function fixture(t, { baseVersion = '1.0.0', network } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-update-test-')), resourcesPath = path.join(root, 'install/resources'), appRoot = path.join(resourcesPath, 'app'), profile = path.join(root, 'profile');
  t.after(() => { assert.ok(path.basename(root).startsWith('reader-update-test-')); fs.rmSync(root, { recursive: true, force: true }); });
  for (const [name, bytes] of initial) write(resourcesPath, name, bytes);
  write(resourcesPath, 'runtime/node_modules/dependency/index.js', 'baseline dependency');
  write(resourcesPath, 'runtime/python/python.exe', 'baseline python');
  const files = descriptors(initial), base = { schema: 1, platform: 'win32', arch: 'x64', version: baseVersion, foundation, id: sha(JSON.stringify(files)), files,
    foundationFiles: descriptors(new Map([['runtime/node_modules/dependency/index.js', Buffer.from('baseline dependency')], ['runtime/python/python.exe', Buffer.from('baseline python')]])) };
  write(resourcesPath, 'update-base.json', JSON.stringify(base));
  write(profile, 'workspace/workspace.sqlite', 'PRIVATE DATABASE'); write(profile, 'reader-session.json', 'PRIVATE DRAFT');
  let available = release(nextFiles()), requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (network) return network(url, options, available);
    if (url.endsWith('/releases/latest')) return Response.json({ draft: false, prerelease: false, published_at: '2026-10-28T12:00:00Z', tag_name: 'v' + available.manifest.version, assets: [{ name: config.manifestName }] });
    if (url.endsWith(config.manifestName)) return Response.json(available.signed);
    if (url.endsWith(available.manifest.delta?.name)) return new Response(available.deltaBytes);
    if (url.endsWith(available.manifest.payload.name)) return new Response(available.payloadBytes);
    throw new Error('Unexpected URL: ' + url);
  };
  const create = () => createUpdater({ app: {}, profile, resourcesPath, appRoot, fetchImpl, publicKey, platform: 'win32', arch: 'x64' });
  return { root, resourcesPath, appRoot, profile, base, create, requests, setRelease(value) { available = value; }, get release() { return available; },
    state() { return JSON.parse(fs.readFileSync(path.join(profile, 'updates/state.json'), 'utf8')); },
    assertPrivate() { assert.equal(fs.readFileSync(path.join(profile, 'workspace/workspace.sqlite'), 'utf8'), 'PRIVATE DATABASE'); assert.equal(fs.readFileSync(path.join(profile, 'reader-session.json'), 'utf8'), 'PRIVATE DRAFT'); },
  };
}

test('signed full update downloads only program files, preserves installation and profile, and activates on next launch', async (t) => {
  const h = fixture(t), updater = h.create();
  const before = updater.select(); assert.equal(before.version, '1.0.0');
  const exposed = updater.status(); assert.equal(exposed.repository, 'Cusnd/stread');
  exposed.repository = 'untrusted/project'; exposed.releaseUrl = 'https://untrusted.invalid';
  assert.equal(updater.status().repository, 'Cusnd/stread');
  assert.equal(updater.status().releaseUrl, 'https://github.com/Cusnd/stread/releases');
  assert.equal((await updater.check()).state, 'available'); assert.equal((await updater.download()).state, 'downloaded');
  assert.equal(h.requests[0].url, 'https://api.github.com/repos/Cusnd/stread/releases/latest');
  assert.ok(h.requests.slice(1).every(({ url }) => url.startsWith('https://github.com/Cusnd/stread/releases/download/v1.0.1/')));
  assert.equal(updater.status().version, '1.0.0'); assert.equal(h.state().active, null); assert.equal(h.state().downloaded, h.release.manifest.id);
  updater.activate(); assert.equal(h.state().active, null); assert.equal(h.state().pending, h.release.manifest.id);
  const next = h.create(), selected = next.select(); assert.equal(selected.version, '1.0.1'); assert.equal(h.state().trial.id, selected.id);
  assert.equal(fs.readFileSync(path.join(selected.runtime, 'client/assets/current.js'), 'utf8'), 'updated UI 1.0.1');
  assert.equal(fs.readFileSync(path.join(selected.runtime, 'node_modules/dependency/index.js'), 'utf8'), 'baseline dependency');
  assert.equal(fs.readFileSync(path.join(h.resourcesPath, 'runtime/client/assets/current.js'), 'utf8'), 'initial runtime/client/assets/current.js');
  next.markHealthy(); assert.equal(h.state().trial, null); assert.equal(h.create().select().version, '1.0.1'); h.assertPrivate();
  assert.ok(h.requests.every(({ options }) => !('Authorization' in options.headers)));
});

test('matching baselines receive a true changed-file delta; deleted assets are absent from new immutable version', async (t) => {
  const h = fixture(t), files = nextFiles(); files.delete('runtime/client/assets/current.js'); files.set('runtime/client/assets/new.js', Buffer.from('new hashed asset'));
  h.setRelease(release(files, '1.0.1', { previous: initial }));
  const updater = h.create(); updater.select(); assert.equal((await updater.check()).incremental, true);
  await updater.download(); updater.activate(); const selected = h.create().select();
  assert.equal(fs.existsSync(path.join(selected.runtime, 'client/assets/current.js')), false);
  assert.equal(fs.readFileSync(path.join(selected.runtime, 'client/assets/new.js'), 'utf8'), 'new hashed asset');
  assert.equal(h.requests.some(({ url }) => url.endsWith(h.release.manifest.payload.name)), false); h.assertPrivate();
});

test('users skipping a release select full application payload instead of an inapplicable delta', async (t) => {
  const h = fixture(t); h.setRelease(release(nextFiles('1.0.3'), '1.0.3', { previous: nextFiles('1.0.2') }));
  const updater = h.create(); updater.select(); assert.equal((await updater.check()).incremental, false);
  await updater.download(); assert.equal(h.requests.at(-1).url.endsWith(h.release.manifest.payload.name), true);
});

test('signature tampering and wrong signing keys are rejected before download or installation', async (t) => {
  const h = fixture(t); h.release.signed.manifest.version = '1.0.2';
  await assert.rejects(h.create().check(), /签名校验失败/);
  assert.equal(h.requests.length, 2); assert.deepEqual(fs.readdirSync(path.join(h.profile, 'updates/releases')), []);
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' });
  assert.throws(() => verifyEnvelope(envelope(release(nextFiles()).manifest), other), /签名校验失败/);
});

test('download corruption and invalid gzip preserve the running version and leave no staged release', async (t) => {
  const h = fixture(t), updater = h.create(); updater.select(); await updater.check(); h.release.payloadBytes[0] ^= 255;
  await assert.rejects(updater.download(), /下载校验失败/); assert.equal(updater.status().state, 'error');
  assert.deepEqual(fs.readdirSync(path.join(h.profile, 'updates/releases')), []); h.assertPrivate();
});

test('signed payload cannot smuggle traversal, private files, duplicate paths or extra executable files', async (t) => {
  for (const pathName of ['runtime/../../outside', 'runtime/client/CON.txt', 'runtime/client/x.', 'runtime/client/a:b', 'runtime/client\\evil', 'runtime/services/.data/workspace.sqlite', 'app/electron/bootstrap.cjs', 'runtime/node_modules/x.js', 'runtime/client/connection.json']) assert.throws(() => validatePath(pathName));
  const h = fixture(t), bytes = gzipSync(Buffer.from(JSON.stringify({ schema: 1, files: [{ path: '../outside', data: Buffer.from('evil').toString('base64') }] })));
  h.release.payloadBytes = bytes; h.release.manifest.payload.bytes = bytes.length; h.release.manifest.payload.sha256 = sha(bytes); h.release.signed = envelope(h.release.manifest);
  const updater = h.create(); await updater.check(); await assert.rejects(updater.download(), /路径无效/);
  assert.equal(fs.existsSync(path.join(h.profile, 'outside')), false); h.assertPrivate();
  const manifest = release(nextFiles()).manifest; manifest.files.push({ path: 'runtime/client/INDEX.html', sha256: sha('x'), bytes: 1 }); manifest.files.sort((a, b) => a.path < b.path ? -1 : 1); manifest.id = sha(JSON.stringify(manifest.files));
  assert.throws(() => validateManifest(manifest), /重复/);
});

test('foundation changes require a full installer without downloading application payload', async (t) => {
  const h = fixture(t); h.release.manifest.foundation = sha('new Electron or Python'); h.release.signed = envelope(h.release.manifest);
  const updater = h.create(); const status = await updater.check(); assert.equal(status.state, 'full-update-required');
  assert.equal(status.releaseUrl, 'https://github.com/Cusnd/stread/releases/tag/v1.0.0');
  await assert.rejects(updater.download(), /先检查/); assert.equal(h.requests.length, 2);
});

test('unconfirmed UI boot rolls back on next UI launch while MCP selection leaves trial state untouched', async (t) => {
  const h = fixture(t), updater = h.create(); updater.select(); await updater.check(); await updater.download(); updater.activate();
  const trial = h.create(); assert.equal(trial.select().version, '1.0.1'); assert.equal(trial.status().trial, true); const before = fs.readFileSync(path.join(h.profile, 'updates/state.json'));
  const mcp = h.create(); assert.equal(mcp.select({ mcp: true }).version, '1.0.1'); assert.equal(mcp.status().trial, false); assert.deepEqual(fs.readFileSync(path.join(h.profile, 'updates/state.json')), before);
  const restarted = h.create(); assert.equal(restarted.select().version, '1.0.0'); assert.equal(h.state().trial, null); assert.match(restarted.status().error, /恢复/); h.assertPrivate();
});

test('failed later update returns to previous healthy version without reverting user data', async (t) => {
  const h = fixture(t), first = h.create(); first.select(); await first.check(); await first.download(); first.activate();
  const healthy = h.create(); healthy.select(); healthy.markHealthy();
  h.setRelease(release(nextFiles('1.0.2'), '1.0.2')); await healthy.check(); await healthy.download(); healthy.activate();
  const failing = h.create(); assert.equal(failing.select().version, '1.0.2'); failing.markFailed();
  assert.equal(h.create().select().version, '1.0.1'); h.assertPrivate();
});

test('corrupt cached updates and newer baseline installations never execute stale application code', async (t) => {
  const h = fixture(t), updater = h.create(); updater.select(); await updater.check(); await updater.download(); updater.activate();
  const trial = h.create(), selected = trial.select(); trial.markHealthy();
  fs.appendFileSync(path.join(selected.appRoot, 'electron/main.cjs'), 'corruption');
  assert.equal(h.create().select().version, '1.0.0');
  const newerBase = { ...h.base, version: '2.0.0' }; write(h.resourcesPath, 'update-base.json', JSON.stringify(newerBase));
  assert.equal(h.create().select().version, '2.0.0'); h.assertPrivate();
});

test('foreign redirects, oversized network responses, and unreleased feeds are rejected', async (t) => {
  const h = fixture(t, { network: async () => new Response('', { status: 302, headers: { location: 'https://example.com/evil' } }) });
  await assert.rejects(h.create().check(), /不受信任/);
  const large = fixture(t, { network: async () => new Response('{}', { headers: { 'content-length': String(config.limits.manifest + 1) } }) });
  await assert.rejects(large.create().check(), /大小限制/);
  const draft = fixture(t, { network: async () => Response.json({ draft: true, prerelease: false, published_at: 'now', tag_name: 'v1.0.1', assets: [] }) });
  await assert.rejects(draft.create().check(), /发布信息无效/);
});

test('GitHub without a published release reports no available update and stable version comparison is numeric', async (t) => {
  const h = fixture(t, { network: async () => new Response('', { status: 404 }) }); assert.equal((await h.create().check()).state, 'idle');
  assert.equal(compareVersion('1.10.0', '1.9.9'), 1); assert.throws(() => compareVersion('1.0.1-beta', '1.0.0'));
});

test('downloaded update survives a normal close and can restart without another network transfer', async (t) => {
  const h = fixture(t), updater = h.create(); updater.select(); await updater.check(); await updater.download();
  const requests = h.requests.length, reopened = h.create(); reopened.select();
  assert.equal(reopened.status().state, 'downloaded'); assert.equal(reopened.status().availableVersion, '1.0.1');
  reopened.activate(); assert.equal(h.create().select().version, '1.0.1'); assert.equal(h.requests.length, requests);
});

test('checking again recognizes a verified download and marks successful checks with a timestamp', async (t) => {
  const h = fixture(t), updater = h.create(); updater.select(); await updater.check(); await updater.download();
  assert.equal((await updater.check()).state, 'downloaded'); assert.equal(typeof updater.status().checkedAt, 'number');
  updater.activate(); assert.equal(h.state().downloaded, null);
});

test('malformed state is preserved as evidence and repaired without preventing a baseline startup', (t) => {
  const h = fixture(t); write(h.profile, 'updates/state.json', 'broken JSON');
  const mcp = h.create(); assert.equal(mcp.select({ mcp: true }).version, '1.0.0');
  assert.equal(fs.readFileSync(path.join(h.profile, 'updates/state.json'), 'utf8'), 'broken JSON');
  const updater = h.create(); assert.equal(updater.select().version, '1.0.0'); assert.doesNotThrow(() => updater.markHealthy());
  assert.equal(h.state().active, null); assert.ok(fs.readdirSync(path.join(h.profile, 'updates')).some((name) => name.startsWith('state-corrupt-'))); h.assertPrivate();
});

test('copied dependency corruption and injected files are rejected before executing a cached update', async (t) => {
  const h = fixture(t), updater = h.create(); updater.select(); await updater.check(); await updater.download(); updater.activate();
  const first = h.create(), selected = first.select(); first.markHealthy();
  fs.appendFileSync(path.join(selected.runtime, 'node_modules/dependency/index.js'), 'changed');
  assert.equal(h.create().select().version, '1.0.0');
  const second = fixture(t), up = second.create(); up.select(); await up.check(); await up.download(); up.activate();
  const active = second.create(), target = active.select(); active.markHealthy(); write(target.runtime, 'services/workspace/injected.cjs', 'extra code');
  assert.equal(second.create().select().version, '1.0.0');
});

test('interrupted transfer leaves downloaded pointer and installed files untouched and allows retry', async (t) => {
  let broken = true;
  const h = fixture(t, { network: async (url, _options, available) => {
    if (url.endsWith('/releases/latest')) return Response.json({ draft: false, prerelease: false, published_at: 'now', tag_name: 'v1.0.1', assets: [{ name: config.manifestName }] });
    if (url.endsWith(config.manifestName)) return Response.json(available.signed);
    if (broken) return new Response(new ReadableStream({ start(controller) { controller.enqueue(available.payloadBytes.subarray(0, 10)); controller.error(new Error('Connection lost')); } }));
    return new Response(available.payloadBytes);
  } });
  const updater = h.create(); updater.select(); await updater.check(); await assert.rejects(updater.download(), /Connection lost/);
  assert.equal(fs.existsSync(path.join(h.profile, 'updates/state.json')), false); assert.deepEqual(fs.readdirSync(path.join(h.profile, 'updates/releases')), []);
  broken = false; await updater.download(); assert.equal(updater.status().state, 'downloaded'); h.assertPrivate();
});

test('update directory junctions are rejected before any write outside the profile', (t) => {
  const h = fixture(t), outside = path.join(h.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(h.profile, 'updates'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => h.create(), /符号链接/); assert.deepEqual(fs.readdirSync(outside), []); h.assertPrivate();
});

test('stable bootstrap resolves the profile and owns the UI lock before touching update state', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bootstrap.cjs'), 'utf8');
  function run({ packaged = true, owns = true, mcp = false, mainThrows = false } = {}) {
    const calls = [], app = {
      isPackaged: packaged,
      getPath: () => 'C:/fixture/home',
      setPath: (name, value) => calls.push(['path', name, value]),
      requestSingleInstanceLock: () => { calls.push(['lock']); return owns; },
      quit: () => calls.push(['quit']), exit: (code) => calls.push(['exit', code]),
    };
    const updater = { select: (options) => { calls.push(['select', options.mcp]); return { appRoot: 'C:/fixture/update/app', runtime: 'C:/fixture/update/runtime' }; }, markFailed: () => calls.push(['failed']) };
    vm.runInNewContext(source, { __dirname: 'C:/fixture/install/electron', process: { argv: ['reader.exe', ...(mcp ? ['--mcp'] : [])], resourcesPath: 'C:/fixture/resources', stderr: { write: () => calls.push(['stderr']) } }, require(name) {
      if (name === 'electron') return { app, dialog: { showErrorBox: () => calls.push(['dialog']) } };
      if (name === 'node:path') return path;
      if (name === 'node:fs') return { mkdirSync: () => calls.push(['mkdir']) };
      if (name === './update-core.cjs') { calls.push(['core']); return { createUpdater: () => updater }; }
      calls.push(['main']); if (mainThrows) throw new Error('Startup failed'); return {};
    } });
    return { calls, app };
  }
  const normal = run(); assert.deepEqual(normal.calls.map(([kind]) => kind), ['mkdir', 'path', 'lock', 'core', 'select', 'main']); assert.equal(normal.app.readerOwnsInstance, true);
  const duplicate = run({ owns: false }); assert.deepEqual(duplicate.calls.map(([kind]) => kind), ['mkdir', 'path', 'lock', 'quit']);
  const mcp = run({ mcp: true }); assert.equal(mcp.calls.some(([kind]) => kind === 'lock'), false); assert.deepEqual(mcp.calls.find(([kind]) => kind === 'select'), ['select', true]);
  assert.deepEqual(run({ packaged: false }).calls, [['main']]);
  const failure = run({ mainThrows: true }); assert.deepEqual(failure.calls.slice(-3), [['failed'], ['dialog'], ['exit', 1]]);
});

test('a corrupt dormant download is quarantined and repaired by retrying the same signed version', async (t) => {
  const h = fixture(t), updater = h.create(); updater.select(); await updater.check(); await updater.download();
  const target = path.join(h.profile, 'updates/releases', h.release.manifest.id);
  fs.appendFileSync(path.join(target, 'app/electron/main.cjs'), 'corrupted download');
  assert.equal((await updater.check()).state, 'available');
  await updater.download(); assert.equal(updater.status().state, 'downloaded');
  const quarantines = fs.readdirSync(path.join(h.profile, 'updates')).filter((name) => name.startsWith('.corrupt-'));
  assert.equal(quarantines.length, 1);
  assert.match(fs.readFileSync(path.join(h.profile, 'updates', quarantines[0], 'app/electron/main.cjs'), 'utf8'), /corrupted download/);
  updater.activate(); const next = h.create(); assert.equal(next.select().version, '1.0.1'); assert.equal(next.status().trial, true);
  next.markHealthy(); assert.equal(next.status().trial, false); h.assertPrivate();
});
