import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localActor } from '../service.mjs';
import { createWorkspaceServer } from '../server.mjs';
import { createWorkspaceSync } from '../sync-engine.mjs';
import { publishAuthoringFixture } from './authoring-fixture.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'reader-local-reference-'));
  let server;
  const start = async () => {
    server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false });
    server.workspace.localOnly = true;
    await new Promise(done => server.listen(0, '127.0.0.1', done));
  };
  await start();
  t.after(async () => {
    await server?.shutdown();
    assert.ok(dataDir.startsWith(join(tmpdir(), 'reader-local-reference-')));
    await rm(dataDir, { recursive: true, force: true });
  });
  const { document } = await publishAuthoringFixture({ base: `http://127.0.0.1:${server.address().port}`, authoring: {
    format: 'reader-authoring-1', key: 'local-reference-' + randomUUID(), meta: { title: 'Local reference fixture', language: 'en' },
    blocks: [{ key: 'paragraph', type: 'para', text: 'A retained source for local reference allocation.' }],
  } });
  const execute = input => server.workspace.execute(localActor, { requestId: randomUUID(), documentId: document.id, ...input });
  return {
    get workspace() { return server.workspace; }, document, execute,
    question: (extra = {}) => execute({ kind: 'insight.save', insight: { type: 'question', body: 'A local question', color: 'sky' }, ...extra }),
    note: () => execute({ kind: 'insight.save', insight: { type: 'note', body: 'A local note', color: 'sky' } }),
    request: () => execute({ kind: 'change_request.save', changeRequest: { category: 'instruction', body: 'Keep the original source.', revision: 1 } }),
    restart: async () => { await server.shutdown(); await start(); },
  };
}

test('local reference allocation preserves retired range identities across restart, history access and exact retry', async t => {
  const h = await fixture(t);
  h.workspace.localOnly = false;
  await createWorkspaceSync(h.workspace, { mode: 'client' });
  for (const [series, start] of [['Q', 1000000], ['N', 2000000], ['R', 3000000]]) {
    h.workspace.db.prepare('INSERT INTO sync_reference_ranges VALUES(?,?,?,?)').run(series, start, start, start);
  }
  const oldQuestion = await h.question(), oldNote = await h.note(), oldRequest = await h.request();
  assert.equal(oldQuestion.insight.reference, '#Q1000000');
  assert.equal(oldNote.insight.reference, '#N2000000');
  assert.equal(oldRequest.changeRequest.reference, '#R3000000');
  assert.equal(h.workspace.db.prepare("SELECT value FROM counters WHERE series='Q'").get().value, 0);
  await h.execute({ kind: 'insight.archive', insightId: oldQuestion.insight.id, expectedVersion: 1 });
  await h.execute({ kind: 'change_request.cancel', changeRequestId: oldRequest.changeRequest.id, expectedVersion: 1 });
  const ranges = h.workspace.db.prepare('SELECT * FROM sync_reference_ranges ORDER BY series').all();
  await h.restart();
  assert.equal(h.workspace.sync, undefined);
  const input = { requestId: 'local-reference-exact-retry' };
  const first = await h.question(input);
  assert.equal(first.insight.reference, '#Q1000001');
  assert.deepEqual(await h.question(input), first);
  assert.equal(h.workspace.db.prepare('SELECT insight_id FROM references_map WHERE reference=?').get(oldQuestion.insight.reference).insight_id, oldQuestion.insight.id);

  // Opening retained conflicts may construct the historical local engine.
  // This must never reactivate range exhaustion or consume its saved rows.
  await createWorkspaceSync(h.workspace, { mode: 'client' });
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => h.question()));
  assert.deepEqual(concurrent.map(value => value.insight.reference).sort(), ['#Q1000002', '#Q1000003', '#Q1000004', '#Q1000005', '#Q1000006', '#Q1000007']);
  assert.equal((await h.note()).insight.reference, '#N2000001');
  assert.equal((await h.request()).changeRequest.reference, '#R3000001');
  assert.deepEqual(h.workspace.db.prepare('SELECT * FROM sync_reference_ranges ORDER BY series').all(), ranges);
  await h.restart();
  assert.equal((await h.question()).insight.reference, '#Q1000008');
  assert.deepEqual(await h.question(input), first);
  assert.deepEqual(h.workspace.db.prepare('SELECT * FROM sync_reference_ranges ORDER BY series').all(), ranges);
});

test('local numbering honors both retained rows and issued historical gaps without creating sync state', async t => {
  const h = await fixture(t);
  const first = await h.question();
  assert.equal(first.insight.reference, '#Q00001');
  h.workspace.db.prepare("UPDATE counters SET value=0 WHERE series='Q'").run();
  assert.equal((await h.question()).insight.reference, '#Q00002');
  assert.equal(h.workspace.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_reference_ranges'").get(), undefined);
  await createWorkspaceSync(h.workspace, { mode: 'client' });
  h.workspace.db.prepare('INSERT INTO sync_reference_ranges VALUES(?,?,?,?)').run('Q', 1000000, 1999999, 1000013);
  assert.equal((await h.question()).insight.reference, '#Q1000013');
  assert.equal(h.workspace.db.prepare("SELECT next FROM sync_reference_ranges WHERE series='Q'").get().next, 1000013);
});
