import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDevController, isRestartSource, parseDevArguments } from '../dev-controller.mjs';
import { ensurePythonRuntime, watchRestartSources } from '../dev.mjs';

function fixture({ spawnFailure = false } = {}) {
  const children = [], logs = [], callbacks = new Map();
  let next = 0, serverClosed = 0, watchersClosed = 0;
  const controller = createDevController({
    timers: { setTimeout(callback) { const id = ++next; callbacks.set(id, callback); return id; }, clearTimeout(id) { callbacks.delete(id); } },
    spawnElectron() {
      if (spawnFailure) throw new Error('missing executable');
      const child = new EventEmitter();
      Object.assign(child, { pid: 100 + children.length, connected: true, sent: [], send(message, callback) { child.sent.push(message); callback?.(); }, kill() { throw new Error('must never kill Electron'); } });
      children.push(child);
      return child;
    },
    createWatchers: () => [{ close() { watchersClosed++; } }, { close() { watchersClosed++; } }],
    closeServer: async () => { serverClosed++; },
    log: (message) => logs.push(message),
  });
  controller.start();
  return { controller, children, logs, callbacks,
    tick() { const pending = [...callbacks.values()]; callbacks.clear(); for (const callback of pending) callback(); },
    get serverClosed() { return serverClosed; }, get watchersClosed() { return watchersClosed; },
  };
}

test('debounced source changes restart only after the saved child exits 75', async () => {
  const f = fixture();
  f.controller.sourceChanged('services/workspace/server.mjs'); f.controller.sourceChanged(); f.controller.sourceChanged();
  assert.ok(f.logs.some((message) => message.includes('services/workspace/server.mjs')));
  assert.equal(f.callbacks.size, 1);
  f.tick();
  assert.deepEqual(f.children[0].sent, [{ type: 'reader-dev:restart' }]);
  f.controller.sourceChanged(); f.tick();
  assert.equal(f.children.length, 1, 'a process still saving must retain sole workspace ownership');
  assert.equal(f.children[0].sent.length, 1);
  f.children[0].emit('exit', 75, null);
  assert.equal(f.children.length, 2);
  assert.equal(f.serverClosed, 0);
  f.children[1].emit('exit', 0, null);
  assert.equal(await f.controller.done, 0);
  assert.equal(f.serverClosed, 1);
  assert.equal(f.watchersClosed, 2);
});

test('cancelled save retains the window and server without a retry loop', async () => {
  const f = fixture();
  f.controller.sourceChanged(); f.tick();
  f.children[0].emit('message', { type: 'reader-dev:restart-cancelled', reason: 'draft save failed' });
  f.tick();
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].sent.length, 1);
  assert.equal(f.serverClosed, 0);
  f.controller.sourceChanged(); f.tick();
  assert.equal(f.children[0].sent.length, 2, 'a later source edit can explicitly retry');
  f.children[0].emit('exit', 0, null);
  assert.equal(await f.controller.done, 0, 'normal close never restarts even with a pending request');
});

test('signals request a save handshake, cancellation retains the session, and retry is safe', async () => {
  const f = fixture();
  f.controller.requestStop(); f.controller.requestStop();
  assert.deepEqual(f.children[0].sent, [{ type: 'reader-dev:stop' }]);
  assert.equal(f.serverClosed, 0);
  f.children[0].emit('message', { type: 'reader-dev:stop-cancelled' });
  f.controller.requestStop();
  assert.equal(f.children[0].sent.length, 2);
  f.children[0].emit('exit', 0, null);
  assert.equal(await f.controller.done, 0);
  assert.equal(f.serverClosed, 1);
});

test('stop wins a restart race and never respawns an exited child', async () => {
  const f = fixture();
  f.controller.sourceChanged(); f.tick();
  f.controller.requestStop();
  assert.deepEqual(f.children[0].sent.map((value) => value.type), ['reader-dev:restart', 'reader-dev:stop']);
  f.children[0].emit('exit', 75, null);
  assert.equal(await f.controller.done, 0);
  assert.equal(f.children.length, 1);
});

test('stop retries after main ignores it during a cancelled restart handshake', async () => {
  const f = fixture();
  f.controller.sourceChanged(); f.tick();
  f.controller.requestStop();
  f.children[0].emit('message', { type: 'reader-dev:restart-cancelled' });
  assert.deepEqual(f.children[0].sent.map((value) => value.type), ['reader-dev:restart', 'reader-dev:stop', 'reader-dev:stop']);
  f.children[0].emit('message', { type: 'reader-dev:stop-cancelled' });
  f.controller.requestStop();
  assert.equal(f.children[0].sent.length, 4, 'cancellation must leave a later signal usable');
  f.children[0].emit('exit', 0, null);
  assert.equal(await f.controller.done, 0);
});

test('spawn and ordinary crash failures clean up without automatically reopening', async () => {
  const failed = fixture({ spawnFailure: true });
  assert.equal(await failed.controller.done, 1);
  assert.equal(failed.serverClosed, 1);
  assert.equal(failed.watchersClosed, 2);
  const crashed = fixture();
  crashed.controller.sourceChanged(); crashed.tick();
  crashed.children[0].emit('exit', 1, null);
  assert.equal(await crashed.controller.done, 1);
  assert.equal(crashed.children.length, 1);
});

test('a broken IPC channel does not terminate the running application', async () => {
  const f = fixture();
  f.children[0].connected = false;
  f.controller.requestStop();
  assert.equal(f.serverClosed, 0);
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].sent.length, 0);
  f.children[0].emit('exit', 0, null);
  assert.equal(await f.controller.done, 0);
});

test('source filter ignores workspace data, dependencies, frontend and unrelated files', () => {
  const root = path.resolve('repository');
  const matches = (file) => isRestartSource(root, path.resolve(root, file));
  assert.equal(matches('services/agent-host/host.mjs'), false);
  assert.equal(matches('services/agent-host/node_modules/adapter/index.js'), false);
  for (const file of ['electron/main.cjs', 'electron/preload.cjs', 'services/workspace/server.mjs', 'services/workspace/nested/format.json', 'services/workspace/pdf.py', 'services/workspace/authoring-guide.md', 'prototypes/insight-composer/scripts/compile-authoring.mjs', 'prototypes/insight-composer/scripts/authoring-validation.mjs', 'prototypes/insight-composer/src/html-content.js', 'prototypes/insight-composer/src/document-content.js', 'prototypes/insight-composer/src/reading-language.js', 'prototypes/insight-composer/src/conversion-request.js', 'prototypes/insight-composer/src/reader-navigation.js']) assert.equal(matches(file), true, file);
  for (const file of ['electron/tests/main.test.cjs', 'electron/dev.mjs', 'services/workspace/.data/file.json', 'services/workspace/node_modules/pkg/index.mjs', 'services/workspace/tests/test.mjs', 'services/workspace/data/glossary.json', 'prototypes/insight-composer/src/main.jsx', '../elsewhere/main.cjs']) assert.equal(matches(file), false, file);
});

test('profile arguments are preserved without changing the default profile', () => {
  const root = path.resolve('repo');
  assert.deepEqual(parseDevArguments([], root), []);
  assert.deepEqual(parseDevArguments(['--reader-user-data', 'test profile'], root), ['--reader-user-data=' + path.join(root, 'test profile')]);
  assert.deepEqual(parseDevArguments(['--reader-user-data=profile'], root), ['--reader-user-data=' + path.join(root, 'profile')]);
  assert.throws(() => parseDevArguments(['--reader-user-data'], root));
  assert.throws(() => parseDevArguments(['--reader-dev-url=https://example.com'], root));
});

test('watchers include rename events and release partially created watchers on setup failure', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-dev-watcher-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['electron', 'services/workspace', 'prototypes/insight-composer/scripts', 'prototypes/insight-composer/src']) await mkdir(path.join(root, directory), { recursive: true });
  const listeners = [], watched = [];
  let flush;
  const timers = { setTimeout(callback) { flush = callback; return 1; }, clearTimeout() { flush = undefined; } };
  let changes = 0, closed = 0;
  const makeWatcher = (directory, options, callback) => {
    watched.push({ directory, options }); listeners.push(callback);
    const watcher = new EventEmitter(); watcher.close = () => { closed++; }; return watcher;
  };
  const watchers = watchRestartSources(root, () => { changes++; }, () => {}, makeWatcher, { timers });
  for (const file of ['electron/main.cjs', 'services/workspace/server.mjs', 'prototypes/insight-composer/scripts/compile-authoring.mjs', 'prototypes/insight-composer/src/html-content.js']) await writeFile(path.join(root, file), 'new source');
  listeners[0]('rename', 'main.cjs');
  listeners[1]('change', path.join('.data', 'state.json'));
  listeners[1]('change', 'server.mjs');
  listeners[2]('change', 'compile-authoring.mjs');
  listeners[3]('change', 'html-content.js');
  listeners[3]('change', 'App.jsx');
  flush();
  assert.equal(changes, 4);
  assert.equal(watched[1].options.recursive, true);
  for (const watcher of watchers) watcher.close();
  assert.equal(closed, 4);
  let calls = 0;
  assert.throws(() => watchRestartSources(root, () => {}, () => {}, (...args) => { if (++calls === 2) throw new Error('watch unavailable'); return makeWatcher(...args); }));
  assert.equal(closed, 5);
});

test('missing PDF runtime prepares only Python, while existing files are reused', async () => {
  const root = path.resolve('repo');
  let available = false, preparations = 0;
  const options = {
    check: async () => { if (!available) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    run: async (receivedRoot) => { assert.equal(receivedRoot, root); preparations++; available = true; },
    log: () => {},
  };
  await ensurePythonRuntime(root, options);
  await ensurePythonRuntime(root, options);
  assert.equal(preparations, 1);
});
