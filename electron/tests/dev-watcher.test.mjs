import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { watchRestartSources } from '../dev.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, { native = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-dev-content-test-'));
  const file = path.join(root, 'services/workspace/server.mjs');
  for (const directory of ['electron', 'services/workspace', 'prototypes/insight-composer/scripts', 'prototypes/insight-composer/src']) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(file, 'export const version = 1;\n');
  // Whole seconds avoid Date rounding changing mtime during the atime probe.
  const timestamp = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
  await utimes(file, timestamp, timestamp);
  const changes = [], errors = [], callbacks = new Map(), pending = new Map();
  let next = 0;
  const timers = { setTimeout(callback) { pending.set(++next, callback); return next; }, clearTimeout(id) { pending.delete(id); } };
  const fakeWatch = (directory, _options, callback) => {
    callbacks.set(directory, callback);
    const watcher = new EventEmitter(); watcher.close = () => {}; return watcher;
  };
  const watchers = watchRestartSources(root, (name) => changes.push(name), (error) => errors.push(error), native ? watch : fakeWatch, native ? { debounceMs: 30 } : { timers });
  t.after(async () => { for (const watcher of watchers) watcher.close(); await rm(root, { recursive: true, force: true }); });
  return { root, file, changes, errors, watchers,
    notify(event = 'change', name = 'server.mjs') { callbacks.get(path.dirname(file))(event, name); },
    flush() { const queued = [...pending.values()]; pending.clear(); for (const callback of queued) callback(); },
  };
}

test('read/metadata notifications, duplicate events and identical rewrites do not restart', async (t) => {
  const f = await fixture(t);
  const bytes = await readFile(f.file), before = await stat(f.file);
  await utimes(f.file, new Date(), before.mtime);
  f.notify(); f.flush();
  await writeFile(f.file, bytes);
  f.notify(); f.notify('rename'); f.flush();
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.errors, []);
});

test('real content changes restart even with the same length and modification time', async (t) => {
  const f = await fixture(t), before = await stat(f.file);
  await writeFile(f.file, 'export const version = 2;\n');
  await utimes(f.file, before.atime, before.mtime);
  f.notify(); f.notify(); f.flush();
  assert.deepEqual(f.changes, ['services/workspace/server.mjs']);
  f.notify(); f.flush();
  assert.equal(f.changes.length, 1, 'startup/duplicate notifications after a restart cannot restart again');
});

test('atomic replacement settles before comparison and reports the final content once', async (t) => {
  const f = await fixture(t), temporary = f.file + '.tmp';
  await rename(f.file, temporary); f.notify('rename');
  await rename(temporary, f.file); f.notify('rename'); f.flush();
  assert.deepEqual(f.changes, [], 'replacing a file with identical content is not an edit');
  await writeFile(temporary, 'export const version = 3;\n');
  await rename(temporary, f.file); f.notify('rename'); f.notify(); f.flush();
  assert.deepEqual(f.changes, ['services/workspace/server.mjs']);
});

test('source deletion and creation are detected while closing discards pending events', async (t) => {
  const f = await fixture(t);
  await rm(f.file); f.notify('rename'); f.flush();
  f.notify('rename'); f.flush();
  await writeFile(f.file, 'restored'); f.notify('rename'); f.flush();
  const added = path.join(path.dirname(f.file), 'added.mjs');
  await writeFile(added, 'new source'); f.notify('rename', 'added.mjs'); f.flush();
  assert.deepEqual(f.changes, ['services/workspace/server.mjs', 'services/workspace/server.mjs', 'services/workspace/added.mjs']);
  await writeFile(f.file, 'later edit'); f.notify();
  for (const watcher of f.watchers) watcher.close();
  f.flush(); f.notify(); f.flush();
  assert.equal(f.changes.length, 3);
  assert.deepEqual(f.errors, []);
});

test('native filesystem metadata events do not restart but a subsequent source edit does', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { native: true });
  const rawEvents = [];
  const raw = watch(path.dirname(f.file), (event, name) => rawEvents.push({ event, name }));
  t.after(() => raw.close());
  const before = await stat(f.file), bytes = await readFile(f.file);
  await utimes(f.file, new Date(), before.mtime);
  await delay(250);
  assert.ok(rawEvents.some(({ name }) => name === 'server.mjs'), 'the OS emitted a real event');
  assert.deepEqual(await readFile(f.file), bytes);
  assert.equal((await stat(f.file)).mtimeMs, before.mtimeMs);
  assert.deepEqual(f.changes, []);
  await writeFile(f.file, 'export const version = 2;\n');
  const deadline = Date.now() + 2000;
  while (!f.changes.length && Date.now() < deadline) await delay(25);
  await delay(150);
  assert.deepEqual(f.changes, ['services/workspace/server.mjs']);
  assert.deepEqual(f.errors, []);
});
