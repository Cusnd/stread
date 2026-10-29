'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const directory = path.resolve(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(directory, name), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

function timers() {
  let next = 0;
  const pending = new Map();
  return {
    setTimeout(callback, delay) { const id = ++next; pending.set(id, { callback, delay }); return id; },
    clearTimeout(id) { pending.delete(id); },
    setInterval() { return ++next; },
    clearInterval() {},
    pending,
  };
}

async function eventually(check, description) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (check()) return;
    await new Promise(setImmediate);
  }
  assert.ok(check(), description);
}

function mainFixture({ loadFailure, rendererReady = true, failWindowState = false, args = [], platform = 'win32', packaged = false, savedState, dialogResponse = 1, fetchResponse, env = {}, updater, readerRuntime, ownsInstance, relaunchFailure } = {}) {
  const clock = timers(), app = new EventEmitter(), ipcMain = new EventEmitter();
  const ipcHandlers = new Map();
  ipcMain.handle = (channel, handler) => ipcHandlers.set(channel, handler);
  ipcMain.removeHandler = (channel) => ipcHandlers.delete(channel);
  const home = path.join(directory, 'mock-home');
  const override = args.find((arg) => arg.startsWith('--reader-user-data='))?.slice('--reader-user-data='.length);
  const userData = override ? path.resolve(override) : path.join(home, '.continuous-reader');
  const paths = new Map([['home', home], ['userData', path.join(home, 'AppData', 'Roaming', 'Continuous Reader')]]);
  const files = new Map(), windows = [], errors = [], quits = [], exits = [], log = [], messages = [], parentMessages = [], requests = [], relaunches = [], externalUrls = [];
  const protocolHandlers = new Map(), parentProcess = new EventEmitter();
  if (savedState) files.set(path.join(userData, 'desktop-state.json'), JSON.stringify(savedState));
  Object.assign(parentProcess, { argv: ['electron', '.', ...args], env, pid: 123, versions: { electron: 'test' }, platform,
    resourcesPath: path.join(directory, 'packaged-resources'), send: (message) => parentMessages.push(plain(message)), stderr: { write() {} } });
  let flushes = 0, singleLocks = 0;
  Object.assign(app, {
    isPackaged: packaged,
    readerUpdater: updater, readerRuntime, readerOwnsInstance: ownsInstance,
    setName() {}, setAppUserModelId() {}, setPath(name, value) { paths.set(name, value); },
    getPath: (name) => paths.get(name),
    getVersion: () => 'test',
    requestSingleInstanceLock: () => { singleLocks++; return true; },
    whenReady: () => Promise.resolve(),
    quit() { const attempt = event(); app.emit('before-quit', attempt); quits.push(attempt); },
    exit(code) { exits.push(code); },
    relaunch(options) { if (relaunchFailure) throw relaunchFailure; relaunches.push(plain(options)); },
  });
  const disk = {
    mkdirSync() {},
    readFileSync(file) { if (files.has(file)) return files.get(file); throw Object.assign(new Error('Missing file'), { code: 'ENOENT' }); },
    writeFileSync(file, value) {
      if (failWindowState && file === path.join(userData, 'desktop-state.json.tmp')) throw Object.assign(new Error('Window state is read-only'), { code: 'EACCES' });
      files.set(file, value);
    },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    appendFileSync(_file, value) { log.push(value); },
    unlinkSync(file) { files.delete(file); },
  };
  const backend = new EventEmitter();
  Object.assign(backend, {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    postMessage(message) {
      messages.push(plain(message));
      if (message.type === 'start') queueMicrotask(() => backend.emit('message', { type: 'ready', port: 12345, node: 'test' }));
      if (message.type === 'stop') queueMicrotask(() => backend.emit('exit', 0));
    },
    kill() { backend.emit('exit', 1); },
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.destroyCount = 0;
      this.shown = false;
      this.overlayUpdates = [];
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: { url: 'reader://app/?view=collection' },
        sent: [],
        setWindowOpenHandler() {},
        send(channel, value) { this.sent.push({ channel, value }); },
        getURL: () => this.webContents.mainFrame.url,
      });
      windows.push(this);
    }
    async loadURL(url) {
      if (loadFailure) throw loadFailure;
      this.loadedUrl = url; this.webContents.mainFrame.url = url;
      if (rendererReady && this.options.webPreferences.additionalArguments?.includes('--reader-updates')) ipcMain.emit('reader:ready', { sender: this.webContents, senderFrame: this.webContents.mainFrame });
    }
    show() { this.shown = true; }
    maximize() {}
    isMaximized() { return false; }
    isDestroyed() { return this.destroyed; }
    setTitleBarOverlay(options) { this.overlayUpdates.push(plain(options)); }
    getNormalBounds() { return { x: 40, y: 50, width: 1200, height: 800 }; }
    destroy() { this.destroyed = true; this.destroyCount++; app.emit('window-all-closed'); }
  }
  const electron = {
    app, BrowserWindow, ipcMain,
    Menu: { buildFromTemplate: (template) => template, setApplicationMenu() {} },
    dialog: { showMessageBox: async () => ({ response: dialogResponse }), showErrorBox: (...args) => errors.push(args) },
    protocol: { registerSchemesAsPrivileged() {}, handle(scheme, handler) { protocolHandlers.set(scheme, handler); } },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, flushStorageData() { flushes++; } } },
    shell: { openExternal(url) { externalUrls.push(url); }, openPath() {} },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }), getAllDisplays: () => [] },
    utilityProcess: { fork: () => backend },
  };
  vm.runInNewContext(source('main.cjs'), {
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:fs') return disk;
      if (name === './workspace-migration.cjs') return { migrateWorkspace: async () => ({}) };
      if (name === './development.cjs') return require('../development.cjs');
      if (name === './remote-backend.cjs') throw new Error('The desktop must not load the retired cloud proxy');
      return require(name);
    },
    __dirname: directory,
    process: parentProcess,
    URL, Headers, Response, Buffer, AbortSignal,
    fetch: async (url, init) => { requests.push({ url, init }); return fetchResponse ? fetchResponse(url, init) : { ok: true }; },
    ...clock,
  }, { filename: path.join(directory, 'main.cjs') });
  const prepared = () => windows[0]?.webContents.sent.filter((message) => message.channel === 'reader:prepare-close') || [];
  return {
    app, windows, errors, quits, exits, log, messages, files, clock, prepared, home, userData, paths, ipcMain, ipcHandlers, parentProcess, parentMessages, protocolHandlers, requests, relaunches, externalUrls,
    get flushes() { return flushes; },
    get singleLocks() { return singleLocks; },
    async ready() { await eventually(() => windows[0]?.shown, 'main window should finish loading'); return windows[0]; },
    acknowledgeClose(error) {
      assert.equal(prepared().length, 1, 'one renderer handshake should be in flight');
      const contents = windows[0].webContents;
      ipcMain.emit('reader:close-ready', { sender: contents, senderFrame: contents.mainFrame }, { id: prepared()[0].value, ...(error ? { error } : {}) });
    },
  };
}

test('desktop profile defaults outside AppData and an explicit profile overrides it for all workspace state', async () => {
  const defaults = mainFixture();
  await defaults.ready();
  assert.equal(defaults.ipcHandlers.has('reader:agent-request'), false);
  assert.equal(defaults.paths.get('userData'), path.join(defaults.home, '.continuous-reader'));
  assert.equal(defaults.messages.find((message) => message.type === 'start').dataDir, path.join(defaults.userData, 'workspace'));
  assert.ok(defaults.files.has(path.join(defaults.userData, 'connection.json')));
  const explicit = path.join(directory, 'custom-profile');
  const overridden = mainFixture({ args: ['--reader-user-data=' + explicit] });
  await overridden.ready();
  assert.equal(overridden.paths.get('userData'), explicit);
  assert.equal(overridden.messages.find((message) => message.type === 'start').dataDir, path.join(explicit, 'workspace'));
  assert.ok(overridden.files.has(path.join(explicit, 'connection.json')));
});

test('legacy cloud settings cannot select a remote backend or change the local MCP connection', async () => {
  const secret = 'remote-test-token-never-in-renderer';
  const fixture = mainFixture({ env: {
    CONTINUOUS_READER_REMOTE_URL: 'https://reader.example.test', CONTINUOUS_READER_REMOTE_TOKEN: secret,
    CONTINUOUS_READER_SYNC_URL: 'https://reader.example.test', CONTINUOUS_READER_SYNC_TOKEN: secret,
    CONTINUOUS_READER_ONLINE_PREVIEW_URL: 'https://reader.example.test', CONTINUOUS_READER_ONLINE_PREVIEW_TOKEN: secret,
  }, fetchResponse: async (url) => { assert.ok(url.startsWith('http://127.0.0.1:12345/')); return Response.json({ ok: true }); } });
  const window = await fixture.ready(), start = fixture.messages.find((message) => message.type === 'start');
  assert.equal(start.remote, undefined); assert.equal(start.sync, undefined);
  assert.equal(start.dataDir, path.join(fixture.userData, 'workspace'));
  assert.deepEqual(fixture.requests.map(({ url }) => url), ['http://127.0.0.1:12345/health']);
  const saved = JSON.parse(fixture.files.get(path.join(fixture.userData, 'connection.json')));
  assert.equal(saved.backend, 'local'); assert.equal(saved.url, 'http://127.0.0.1:12345'); assert.notEqual(saved.token, secret);
  assert.ok(!JSON.stringify([...fixture.files.values()]).includes(secret)); assert.ok(!fixture.log.join('').includes(secret));
  assert.ok(!JSON.stringify(window.options).includes(secret));
  const handle = fixture.protocolHandlers.get('reader');
  await handle(new Request('reader://app/api/workspace'));
  const forwarded = fixture.requests.at(-1);
  assert.equal(forwarded.url, saved.url + '/api/workspace'); assert.equal(forwarded.init.headers.get('authorization'), 'Bearer ' + saved.token);
  window.emit('close', event()); fixture.acknowledgeClose();
  await eventually(() => fixture.quits.length === 1, 'local service should stop after the existing save handshake');
  assert.equal(fixture.messages.filter((message) => message.type === 'stop').length, 1); assert.equal(fixture.files.has(path.join(fixture.userData, 'connection.json')), false);
});

test('partial and invalid retired cloud configuration cannot prevent local startup', async () => {
  for (const env of [
    { CONTINUOUS_READER_REMOTE_URL: 'http://reader.example.test' },
    { CONTINUOUS_READER_SYNC_TOKEN: 'old-private-token' },
    { CONTINUOUS_READER_REMOTE_URL: 'not a URL', CONTINUOUS_READER_REMOTE_TOKEN: 'old-private-token', CONTINUOUS_READER_SYNC_URL: 'invalid', CONTINUOUS_READER_SYNC_TOKEN: 'old-private-token' },
  ]) {
    const fixture = mainFixture({ env });
    await fixture.ready();
    const start = fixture.messages.find((message) => message.type === 'start');
    assert.equal(start.remote, undefined); assert.equal(start.sync, undefined);
    assert.equal(start.dataDir, path.join(fixture.userData, 'workspace'));
    assert.equal(fixture.errors.length, 0); assert.equal(fixture.quits.length, 0);
    assert.deepEqual(fixture.requests.map(({ url }) => url), ['http://127.0.0.1:12345/health']);
  }
});

function preloadFixture({ platform = 'win32', args = [] } = {}) {
  const clock = timers(), ipcRenderer = new EventEmitter(), storage = new Map([['reader-draft', 'before close'], ['unrelated', 'private elsewhere']]);
  const writes = [], sent = [], invoked = [], exposed = {};
  const sessionStorage = {
    get length() { return storage.size; },
    key: (index) => [...storage.keys()][index],
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  Object.assign(ipcRenderer, {
    sendSync(channel, value) {
      if (channel === 'reader:session-read') return {};
      assert.equal(channel, 'reader:session-write-sync');
      writes.push(plain(value));
      return { ok: true };
    },
    send(channel, value) { sent.push({ channel, value: value === undefined ? undefined : plain(value) }); },
    invoke(...args) { invoked.push(args); return Promise.resolve({ state: 'idle' }); },
  });
  vm.runInNewContext(source('preload.cjs'), {
    require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value; } } };
    },
    sessionStorage, process: { platform, argv: args }, window: { addEventListener() {} }, ...clock,
  }, { filename: path.join(directory, 'preload.cjs') });
  return { ipcRenderer, storage, writes, sent, invoked, api: exposed.continuousReaderDesktop };
}

test('Windows integrates native caption controls and accepts bounded height changes only from its own trusted main frame', async () => {
  const fixture = mainFixture(), window = await fixture.ready(), contents = window.webContents;
  assert.equal(window.options.titleBarStyle, 'hidden');
  assert.deepEqual(plain(window.options.titleBarOverlay), { color: '#ffffff', symbolColor: '#292b2c', height: 56 });
  assert.notEqual(window.options.frame, false, 'native controls and system window behavior remain enabled');
  const trusted = { sender: contents, senderFrame: contents.mainFrame };
  for (const value of [undefined, null, '72', NaN, Infinity, {}, { height: 72 }, [72]]) fixture.ipcMain.emit('reader:titlebar-height', trusted, value);
  fixture.ipcMain.emit('reader:titlebar-height', { sender: new EventEmitter(), senderFrame: contents.mainFrame }, 72);
  fixture.ipcMain.emit('reader:titlebar-height', { sender: contents, senderFrame: { url: 'reader://app/' } }, 72);
  const originalUrl = contents.mainFrame.url;
  contents.mainFrame.url = 'https://example.com/';
  fixture.ipcMain.emit('reader:titlebar-height', trusted, 72);
  contents.mainFrame.url = originalUrl;
  fixture.ipcMain.emit('reader:titlebar-height', trusted, 56);
  assert.deepEqual(window.overlayUpdates, []);
  for (const value of [67.2, 67.4, 300, -4]) fixture.ipcMain.emit('reader:titlebar-height', trusted, value);
  assert.deepEqual(window.overlayUpdates, [{ height: 67 }, { height: 120 }, { height: 32 }]);
  window.destroyed = true;
  fixture.ipcMain.emit('reader:titlebar-height', trusted, 72);
  assert.equal(window.overlayUpdates.length, 3);
});

test('the titlebar bridge exposes only height reporting and keeps other platforms on their existing window chrome', async () => {
  const preload = preloadFixture();
  assert.equal('agents' in preload.api, false);
  assert.equal(preload.ipcRenderer.listenerCount('reader:agent-event'), 0);
  assert.equal(preload.api.titleBarOverlay, true);
  assert.equal(preload.api.platform, 'win32');
  for (const value of [undefined, NaN, Infinity, '72', {}]) preload.api.setTitlebarHeight(value);
  assert.deepEqual(preload.sent, []);
  preload.api.setTitlebarHeight(67.2);
  assert.deepEqual(preload.sent, [{ channel: 'reader:titlebar-height', value: 67.2 }]);
  for (const platform of ['darwin', 'linux']) {
    const otherPreload = preloadFixture({ platform });
    assert.equal(otherPreload.api.titleBarOverlay, false);
    otherPreload.api.setTitlebarHeight(72);
    assert.deepEqual(otherPreload.sent, []);
    const otherMain = mainFixture({ platform }), window = await otherMain.ready();
    assert.equal(window.options.titleBarOverlay, undefined);
    assert.equal(window.options.titleBarStyle, undefined);
    otherMain.ipcMain.emit('reader:titlebar-height', { sender: window.webContents, senderFrame: window.webContents.mainFrame }, 72);
    assert.deepEqual(window.overlayUpdates, []);
  }
});

test('repeated window and application close requests remain prevented until one renderer handshake finishes', async () => {
  const fixture = mainFixture(), window = await fixture.ready();
  const first = event(), second = event(), quit = event();
  window.emit('close', first);
  window.emit('close', second);
  fixture.app.emit('before-quit', quit);
  assert.ok(first.defaultPrevented && second.defaultPrevented && quit.defaultPrevented);
  assert.equal(fixture.prepared().length, 1);
  assert.equal(window.destroyCount, 0);
  assert.equal(fixture.quits.length, 0);
  fixture.acknowledgeClose();
  await eventually(() => fixture.quits.length === 1, 'successful handshake should finish quitting');
  assert.equal(window.destroyCount, 1);
  assert.equal(fixture.messages.filter((message) => message.type === 'stop').length, 1);
  assert.equal(fixture.quits[0].defaultPrevented, false);
  assert.equal(fixture.clock.pending.size, 0);
});

test('a failing before-close callback still synchronously snapshots its latest draft before acknowledging failure', async () => {
  const fixture = preloadFixture();
  fixture.api.onBeforeClose(async () => {
    fixture.storage.set('reader-draft', 'latest draft retained after callback failure');
    fixture.storage.set('flow-selected-insight', 'Q00001');
    throw new Error('Reading position save failed');
  });
  fixture.ipcRenderer.emit('reader:prepare-close', {}, 'close-request');
  await eventually(() => fixture.sent.some((message) => message.channel === 'reader:close-ready'), 'preload should acknowledge the failed callback');
  assert.equal(fixture.writes.length, 2);
  assert.equal(fixture.writes[0]['reader-draft'], 'before close');
  assert.deepEqual(fixture.writes[1], { 'reader-draft': 'latest draft retained after callback failure', 'flow-selected-insight': 'Q00001' });
  const response = fixture.sent.find((message) => message.channel === 'reader:close-ready').value;
  assert.equal(response.id, 'close-request');
  assert.equal(response.error, 'Reading position save failed');
});

test('startup page-load failure destroys the partial window and clears its quit guard', async () => {
  const fixture = mainFixture({ loadFailure: new Error('Reader page failed to load') });
  await eventually(() => fixture.quits.length === 1, 'failed startup should stop its backend and quit');
  assert.equal(fixture.windows.length, 1);
  assert.equal(fixture.windows[0].destroyCount, 1);
  assert.equal(fixture.errors.length, 1);
  assert.match(fixture.errors[0][1], /Reader page failed to load/);
  assert.equal(fixture.prepared().length, 0);
  assert.equal(fixture.messages.filter((message) => message.type === 'stop').length, 1);
  assert.equal(fixture.quits[0].defaultPrevented, false);
  const anotherQuit = event();
  fixture.app.emit('before-quit', anotherQuit);
  assert.equal(anotherQuit.defaultPrevented, false, 'a destroyed startup window must not keep intercepting quit');
  assert.equal(fixture.clock.pending.size, 0);
});

test('failure to persist window bounds is logged without deadlocking an acknowledged close', async () => {
  const fixture = mainFixture({ failWindowState: true }), window = await fixture.ready();
  const close = event();
  window.emit('close', close);
  assert.equal(close.defaultPrevented, true);
  fixture.acknowledgeClose();
  await eventually(() => fixture.quits.length === 1, 'window-state failure must not block shutdown');
  assert.ok(fixture.log.some((message) => message.includes('Window state is read-only')));
  assert.equal(fixture.flushes, 1);
  assert.equal(window.destroyCount, 1);
  assert.equal(fixture.messages.filter((message) => message.type === 'stop').length, 1);
  assert.equal(fixture.quits[0].defaultPrevented, false);
  assert.equal(fixture.clock.pending.size, 0);
});

const developmentArgs = ['--reader-dev-root=' + path.resolve(directory, '..'), '--reader-dev-url=http://127.0.0.1:52341'];

test('development proxies frontend without credentials, keeps API authorization private and isolates HMR CSP', async () => {
  const fixture = mainFixture({ args: developmentArgs, fetchResponse: async (url) => new Response(url.endsWith('/api/original') ? 'original' : '<html>dev</html>', {
    headers: { 'Content-Type': url.endsWith('/api/original') ? 'text/html' : url.includes('/api/') ? 'application/json' : 'text/html',
      ...(url.endsWith('/api/original') ? { 'Content-Security-Policy': "sandbox; default-src 'none'" } : {}) },
  }) });
  const window = await fixture.ready(), handle = fixture.protocolHandlers.get('reader');
  assert.deepEqual(plain(window.options.webPreferences.additionalArguments), ['--reader-development']);
  assert.equal(fixture.messages[0].sourceRoot, path.resolve(directory, '..'));
  const frontend = await handle(new Request('reader://app/src/main.jsx', { headers: { Authorization: 'renderer must not forward', Cookie: 'secret', Origin: 'https://untrusted.invalid' } }));
  const asset = fixture.requests.at(-1);
  assert.equal(asset.url, 'http://127.0.0.1:52341/src/main.jsx');
  assert.equal(asset.init.headers.has('authorization'), false);
  assert.equal(asset.init.headers.has('cookie'), false);
  assert.equal(asset.init.headers.has('origin'), false);
  assert.equal(frontend.headers.get('cache-control'), 'no-store');
  assert.match(frontend.headers.get('content-security-policy'), /ws:\/\/127\.0\.0\.1:52341/);
  await handle(new Request('reader://app/api/documents'));
  const api = fixture.requests.at(-1);
  assert.equal(api.url, 'http://127.0.0.1:12345/api/documents');
  assert.match(api.init.headers.get('authorization'), /^Bearer /);
  const original = await handle(new Request('reader://app/api/original'));
  assert.equal(original.headers.get('content-security-policy'), "sandbox; default-src 'none'");
});

test('safe development restart flushes once, stops backend before exit 75 and retains the current route', async () => {
  const savedUrl = 'reader://app/?document=paper#section-3';
  const fixture = mainFixture({ args: developmentArgs, savedState: { devLastUrl: savedUrl } });
  const window = await fixture.ready();
  assert.equal(window.loadedUrl, savedUrl);
  fixture.parentProcess.emit('message', { type: 'reader-dev:restart' });
  fixture.parentProcess.emit('message', { type: 'reader-dev:restart' });
  assert.equal(fixture.prepared().length, 1);
  assert.equal(fixture.messages.filter((message) => message.type === 'stop').length, 0);
  assert.equal(window.destroyCount, 0);
  fixture.acknowledgeClose();
  await eventually(() => fixture.exits.length === 1, 'restart should finish after saving');
  assert.deepEqual(fixture.exits, [75]);
  assert.equal(fixture.messages.filter((message) => message.type === 'stop').length, 1);
  assert.equal(fixture.files.has(path.join(fixture.userData, 'connection.json')), false);
  assert.equal(JSON.parse(fixture.files.get(path.join(fixture.userData, 'desktop-state.json'))).devLastUrl, savedUrl);
});

test('a cancelled development restart keeps the window and backend alive and notifies its supervisor', async () => {
  const fixture = mainFixture({ args: developmentArgs, dialogResponse: 0 }), window = await fixture.ready();
  fixture.parentProcess.emit('message', { type: 'reader-dev:restart' });
  fixture.acknowledgeClose('draft snapshot could not be saved');
  await eventually(() => fixture.parentMessages.some((message) => message.type === 'reader-dev:restart-cancelled'), 'cancellation should reach launcher');
  assert.equal(window.destroyCount, 0);
  assert.equal(fixture.exits.length, 0);
  assert.equal(fixture.quits.length, 0);
  assert.equal(fixture.messages.filter((message) => message.type === 'stop').length, 0);
});

test('an early development restart waits until the window has loaded; packaged flags remain inert', async () => {
  const pending = mainFixture({ args: developmentArgs });
  pending.parentProcess.emit('message', { type: 'reader-dev:restart' });
  assert.equal(pending.prepared().length, 0);
  await pending.ready();
  assert.equal(pending.prepared().length, 1);
  pending.acknowledgeClose();
  await eventually(() => pending.exits.length === 1, 'early request should finish safely');
  const packaged = mainFixture({ args: developmentArgs, packaged: true, savedState: { devLastUrl: 'reader://app/?view=flow' } });
  const window = await packaged.ready();
  assert.equal(window.loadedUrl, 'reader://app/?view=collection');
  assert.equal(window.options.webPreferences.additionalArguments, undefined);
  assert.equal(packaged.messages[0].sourceRoot, undefined);
  packaged.parentProcess.emit('message', { type: 'reader-dev:restart' });
  assert.equal(packaged.prepared().length, 0);
  const unsafeSaved = mainFixture({ args: developmentArgs, savedState: { devLastUrl: 'https://example.com/' } });
  assert.equal((await unsafeSaved.ready()).loadedUrl, 'reader://app/?view=collection');
});

function updateController(overrides = {}) {
  const calls = [];
  const value = { state: 'downloaded', version: '0.2.0', trial: false, repository: 'Cusnd/stread', availableVersion: '0.2.1', releaseUrl: 'https://github.com/Cusnd/stread/releases/tag/v0.2.1' };
  return {
    calls, value,
    status: () => ({ ...value }),
    check: async () => { calls.push('check'); },
    download: async () => { calls.push('download'); },
    activate: async () => { calls.push('activate'); },
    markHealthy: () => { calls.push('healthy'); },
    markFailed: () => { calls.push('failed'); },
    ...overrides,
  };
}

test('packaged updates use the bootstrap runtime, version and single-instance ownership without checking the network', async () => {
  const updater = updateController(), readerRuntime = path.join(directory, 'versioned-runtime');
  const fixture = mainFixture({ packaged: true, updater, readerRuntime, ownsInstance: true });
  const window = await fixture.ready();
  assert.equal(fixture.singleLocks, 0);
  assert.equal(fixture.messages[0].runtime, readerRuntime);
  assert.equal(JSON.parse(fixture.files.get(path.join(fixture.userData, 'connection.json'))).version, '0.2.0');
  assert.deepEqual(plain(window.options.webPreferences.additionalArguments), ['--reader-updates']);
  assert.deepEqual(updater.calls, ['healthy']);
  const secondary = mainFixture({ packaged: true, updater, ownsInstance: false });
  assert.equal(secondary.singleLocks, 0);
  assert.equal(secondary.windows.length, 0);
  assert.equal(secondary.quits.length, 1);
});

test('update IPC rejects untrusted frames, unknown actions and development processes', async () => {
  const updater = updateController(), fixture = mainFixture({ packaged: true, updater });
  const window = await fixture.ready(), contents = window.webContents;
  const invoke = fixture.ipcHandlers.get('reader:update'), trusted = { sender: contents, senderFrame: contents.mainFrame };
  for (const sender of [{ sender: {}, senderFrame: contents.mainFrame }, { sender: contents, senderFrame: { url: 'reader://app/' } }]) await assert.rejects(invoke(sender, 'check'), /不可用/);
  for (const action of ['apply-url', undefined, { action: 'download' }]) await assert.rejects(invoke(trusted, action), /未知/);
  await invoke(trusted, 'status');
  assert.deepEqual(updater.calls, ['healthy']);
  await invoke(trusted, 'check'); await invoke(trusted, 'download');
  assert.deepEqual(updater.calls, ['healthy', 'check', 'download']);
  const dev = mainFixture({ args: developmentArgs, updater }), devWindow = await dev.ready();
  assert.equal(devWindow.options.webPreferences.additionalArguments.includes('--reader-updates'), false);
  await assert.rejects(dev.ipcHandlers.get('reader:update')({ sender: devWindow.webContents, senderFrame: devWindow.webContents.mainFrame }, 'check'), /不可用/);
});

test('update restart activates only after the save handshake and stopped backend, retaining the selected profile', async () => {
  let fixture;
  const updater = updateController({ activate: async () => {
    assert.equal(fixture.messages.at(-1).type, 'stop');
    assert.equal(fixture.files.has(path.join(fixture.userData, 'connection.json')), false);
    updater.calls.push('activate');
  } });
  const profile = path.join(directory, 'updating-profile');
  fixture = mainFixture({ packaged: true, updater, args: ['--reader-user-data=' + profile] });
  const window = await fixture.ready(), contents = window.webContents;
  const request = fixture.ipcHandlers.get('reader:update')({ sender: contents, senderFrame: contents.mainFrame }, 'restart');
  assert.equal(fixture.prepared().length, 1);
  assert.deepEqual(updater.calls, ['healthy']);
  assert.equal(fixture.relaunches.length, 0);
  fixture.acknowledgeClose();
  await request;
  assert.deepEqual(updater.calls, ['healthy', 'activate']);
  assert.deepEqual(fixture.relaunches, [{ args: ['.', '--reader-user-data=' + profile] }]);
  assert.equal(fixture.quits.length, 1); assert.equal(fixture.flushes, 1);
});

test('cancelled update restart leaves the downloaded update, window and service intact', async () => {
  const updater = updateController(), fixture = mainFixture({ packaged: true, updater, dialogResponse: 0 });
  const window = await fixture.ready(), contents = window.webContents;
  const request = fixture.ipcHandlers.get('reader:update')({ sender: contents, senderFrame: contents.mainFrame }, 'restart');
  fixture.acknowledgeClose('draft save failed');
  assert.equal((await request).state, 'downloaded');
  assert.deepEqual(updater.calls, ['healthy']);
  assert.equal(window.destroyCount, 0); assert.equal(fixture.relaunches.length, 0); assert.equal(fixture.quits.length, 0);
  assert.equal(fixture.messages.some((message) => message.type === 'stop'), false);
});

test('Portable updates relaunch the persistent original executable and preserve arguments', async () => {
  const executable = path.join(directory, 'Continuous-Reader-Portable.exe');
  const fixture = mainFixture({ packaged: true, updater: updateController(), env: { PORTABLE_EXECUTABLE_FILE: executable } });
  const window = await fixture.ready(), contents = window.webContents;
  const request = fixture.ipcHandlers.get('reader:update')({ sender: contents, senderFrame: contents.mainFrame }, 'restart');
  fixture.acknowledgeClose(); await request;
  assert.equal(fixture.relaunches[0].execPath, executable);
});

test('update activation errors report failure without a relaunch or an unhandled close rejection', async () => {
  const updater = updateController({ activate: async () => { throw new Error('Activation failed'); } });
  const fixture = mainFixture({ packaged: true, updater }), window = await fixture.ready(), contents = window.webContents;
  const request = fixture.ipcHandlers.get('reader:update')({ sender: contents, senderFrame: contents.mainFrame }, 'restart');
  fixture.acknowledgeClose(); await request;
  assert.equal(fixture.relaunches.length, 0); assert.equal(fixture.quits.length, 1);
  assert.match(fixture.errors[0][1], /Activation failed/);
});

test('failed updated startup records recovery without confirming a healthy version', async () => {
  const updater = updateController();
  const fixture = mainFixture({ packaged: true, updater, loadFailure: new Error('Broken update') });
  await eventually(() => fixture.quits.length > 0, 'failed update should quit');
  assert.deepEqual(updater.calls, ['failed']);
});

test('an HTML load without a rendered Collection cannot confirm a healthy update', async () => {
  const updater = updateController(); updater.value.trial = true;
  const fixture = mainFixture({ packaged: true, updater, rendererReady: false });
  await eventually(() => fixture.windows.length > 0, 'startup creates a window');
  const contents = fixture.windows[0].webContents;
  fixture.ipcMain.emit('reader:ready', { sender: contents, senderFrame: { url: 'reader://app/' } });
  fixture.ipcMain.emit('reader:ready', { sender: {}, senderFrame: contents.mainFrame });
  assert.deepEqual(updater.calls, []);
  assert.equal(fixture.errors.length, 0);
  const deadline = [...fixture.clock.pending.values()].find((timer) => timer.delay === 30000);
  assert.ok(deadline);
  deadline.callback();
  await eventually(() => fixture.quits.length > 0, 'unready renderer eventually triggers recovery');
  assert.deepEqual(updater.calls, ['failed']);
  assert.match(fixture.errors[0][1], /界面未能完成启动/);
  assert.equal(fixture.clock.pending.size, 0);
});

test('trusted Collection readiness confirms startup only after renderer and service are both ready', async () => {
  const updater = updateController(); updater.value.trial = true;
  const fixture = mainFixture({ packaged: true, updater, rendererReady: false });
  await eventually(() => fixture.windows.length > 0, 'startup creates a window');
  const contents = fixture.windows[0].webContents;
  assert.deepEqual(updater.calls, []);
  fixture.ipcMain.emit('reader:ready', { sender: contents, senderFrame: contents.mainFrame });
  await fixture.ready();
  assert.deepEqual(updater.calls, ['healthy']);
  assert.equal(fixture.clock.pending.size, 0);
});

test('ordinary packaged startup retains its recoverable library error page without a trial deadline', async () => {
  const updater = updateController(), fixture = mainFixture({ packaged: true, updater, rendererReady: false });
  await fixture.ready();
  assert.equal(fixture.errors.length, 0); assert.equal(fixture.quits.length, 0);
  assert.equal([...fixture.clock.pending.values()].some((timer) => timer.delay === 30000), false);
  assert.deepEqual(updater.calls, ['healthy']);
});

test('release navigation accepts only the repository release page and never a caller URL', async () => {
  const updater = updateController(), fixture = mainFixture({ packaged: true, updater });
  const window = await fixture.ready(), contents = window.webContents, trusted = { sender: contents, senderFrame: contents.mainFrame };
  const invoke = fixture.ipcHandlers.get('reader:update');
  await invoke(trusted, 'open-release', 'https://untrusted.invalid');
  assert.deepEqual(fixture.externalUrls, [updater.value.releaseUrl]);
  for (const url of ['http://github.com/Cusnd/stread/releases', 'https://github.com/Cusnd/stread-other/releases', 'https://github.com/other/project/releases', 'https://github.com@untrusted.invalid/Cusnd/stread/releases', 'https://github.com/Cusnd/continous-reader/releases', 'https://github.com/Cusnd/stread/releases/tag/v0.2.1?target=https://untrusted.invalid', 'https://github.com/Cusnd/stread/releases/download/unsafe.exe']) {
    updater.value.releaseUrl = url;
    await assert.rejects(invoke(trusted, 'open-release'), /地址无效/);
  }
});

test('release navigation pins the stable controller repository without requiring a config in the overlay', async () => {
  const updater = updateController();
  updater.value.repository = 'example-owner/example-reader';
  updater.value.releaseUrl = 'https://github.com/example-owner/example-reader/releases/tag/v0.2.1';
  const fixture = mainFixture({ packaged: true, updater }), window = await fixture.ready(), contents = window.webContents;
  const invoke = fixture.ipcHandlers.get('reader:update'), trusted = { sender: contents, senderFrame: contents.mainFrame };
  await invoke(trusted, 'open-release', { repository: 'untrusted/project', url: 'https://untrusted.invalid' });
  assert.deepEqual(fixture.externalUrls, ['https://github.com/example-owner/example-reader/releases/tag/v0.2.1']);
  updater.value.repository = 'untrusted/project'; updater.value.releaseUrl = 'https://github.com/untrusted/project/releases';
  await assert.rejects(invoke(trusted, 'open-release'), /地址无效/);
  updater.value.releaseUrl = undefined;
  await invoke(trusted, 'open-release');
  assert.equal(fixture.externalUrls.at(-1), 'https://github.com/example-owner/example-reader/releases');
});

test('preload update capabilities exist only with the packaged flag and expose fixed actions without arguments', async () => {
  assert.equal(preloadFixture().api.updates, undefined);
  const fixture = preloadFixture({ args: ['--reader-updates'] });
  for (const name of ['status', 'check', 'download', 'restart', 'openRelease']) await fixture.api.updates[name]('https://untrusted.invalid');
  assert.deepEqual(fixture.invoked, ['status', 'check', 'download', 'restart', 'open-release'].map((action) => ['reader:update', action]));
  fixture.api.ready();
  assert.deepEqual(fixture.sent, [{ channel: 'reader:ready', value: undefined }]);
});
