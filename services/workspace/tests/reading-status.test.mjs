import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkspaceServer } from '../server.mjs';
import { publishAuthoringFixture } from './authoring-fixture.mjs';
import { deriveCollection } from '../../../prototypes/insight-composer/src/workspace/model.js';

async function harness(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'reader-status-'));
  let server, base;
  const start = async () => {
    server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    base = 'http://127.0.0.1:' + server.address().port;
  };
  await start();
  t.after(async () => {
    await server.shutdown();
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep));
    assert.match(dataDir, /reader-status-/);
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  return {
    request,
    command: input => request('/api/commands', { requestId: randomUUID(), ...input }),
    author: (key = 'completed-reading-status') => publishAuthoringFixture({ base, authoring: {
      format: 'reader-authoring-1', key, meta: { title: key, language: 'en' },
      blocks: [{ key: 'paragraph', type: 'para', text: 'A completed article can still have an insight edited.' }],
    } }),
    restart: async () => { await server.shutdown(); await start(); },
  };
}

test('reviewing and editing an insight keeps its completed article in the done filter across restart', async t => {
  const h = await harness(t), article = await h.author(), documentId = article.document.id;
  const opened = await h.command({ kind: 'reading.open', documentId });
  assert.equal(opened.record.status, 'reading', 'a first open still begins reading');
  const state = { documentId, revision: 1, blockId: article.blockIds.paragraph, offsetRatio: 0.6, mode: 'source' };
  await h.command({ kind: 'reading.checkpoint', documentId, readingState: state });
  const done = await h.command({ kind: 'document.update', documentId, expectedVersion: opened.record.version, patch: { status: 'done' } });
  const { insight } = await h.command({ kind: 'insight.save', documentId, insight: { type: 'note', body: 'Original insight', color: 'amber' } });

  // Flow edit/source navigation sends this same ordinary reading.open command.
  const revisit = { kind: 'reading.open', documentId, restart: false, requestId: randomUUID() };
  const result = await h.command(revisit);
  assert.equal(result.record.status, 'done');
  assert.equal(result.record.version, done.record.version + 1);
  assert.deepEqual(result.record.readingState, state);
  assert.deepEqual(await h.command(revisit), result, 'a retried open replays its exact receipt');
  const edited = await h.command({ kind: 'insight.save', documentId, expectedVersion: insight.version, insight: { id: insight.id, body: 'Edited insight' } });
  assert.equal(edited.insight.reference, insight.reference);
  await h.command({ kind: 'reading.checkpoint', documentId, readingState: { ...state, offsetRatio: 0.2 } });
  const snapshot = await h.request('/api/workspace');
  assert.equal(snapshot.currentId, null, 'a completed article does not become the current unfinished read');
  assert.deepEqual(deriveCollection(snapshot, { status: 'done' }).rows.map(row => row.id), [documentId]);
  assert.deepEqual(deriveCollection(snapshot, { status: 'reading' }).rows, []);

  await h.restart();
  assert.deepEqual(await h.command(revisit), result, 'service restart retains the original receipt');
  assert.equal((await h.request('/api/documents/' + documentId)).record.status, 'done');
  assert.equal((await h.command({ kind: 'reading.open', documentId })).record.status, 'done', 'omitting restart is also a revisit');

  const restarted = await h.command({ kind: 'reading.open', documentId, restart: true });
  assert.equal(restarted.record.status, 'reading', 'explicit rereading begins a new read');
  assert.equal(restarted.record.readingState, null, 'explicit rereading still clears the old position');
  const afterRestart = await h.request('/api/workspace');
  assert.equal(afterRestart.currentId, documentId, 'explicit rereading makes the article the current read');
  assert.deepEqual(deriveCollection(afterRestart, { status: 'done' }).rows, []);
  assert.deepEqual(deriveCollection(afterRestart, { status: 'reading' }).rows.map(row => row.id), [documentId]);
  assert.equal((await h.request('/api/documents/' + documentId)).insights[0].body, 'Edited insight');
});

test('reviewing a completed article retains a different current unfinished read', async t => {
  const h = await harness(t), completed = await h.author('completed-article'), ongoing = await h.author('ongoing-article');
  const firstOpen = await h.command({ kind: 'reading.open', documentId: completed.document.id });
  await h.command({ kind: 'document.update', documentId: completed.document.id, expectedVersion: firstOpen.record.version, patch: { status: 'done' } });
  await h.command({ kind: 'reading.open', documentId: ongoing.document.id });
  await h.command({ kind: 'reading.open', documentId: completed.document.id, restart: false });
  const snapshot = await h.request('/api/workspace');
  assert.equal(snapshot.currentId, ongoing.document.id);
  assert.deepEqual(deriveCollection(snapshot, { status: 'done' }).rows.map(row => row.id), [completed.document.id]);
  assert.deepEqual(deriveCollection(snapshot, { status: 'reading' }).rows.map(row => row.id), [ongoing.document.id]);
});

test('saved positions alone do not manufacture completed reading state', async t => {
  const h = await harness(t), article = await h.author(), documentId = article.document.id;
  await h.command({ kind: 'reading.checkpoint', documentId, readingState: { revision: 1, blockId: article.blockIds.paragraph, offsetRatio: 1 } });
  let snapshot = await h.request('/api/workspace');
  assert.equal(snapshot.documents[0].status, 'unread');
  assert.deepEqual(deriveCollection(snapshot, { status: 'done' }).rows, []);
  await h.command({ kind: 'reading.open', documentId });
  snapshot = await h.request('/api/workspace');
  assert.equal(snapshot.documents[0].status, 'reading');
  assert.deepEqual(deriveCollection(snapshot, { status: 'done' }).rows, []);
});
