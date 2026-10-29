import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createWorkspace, localActor } from '../service.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reader-read-races-'));
  const workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  t.after(async () => {
    await workspace.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.match(directory, /reader-read-races-/);
    await rm(directory, { recursive: true, force: true });
  });
  const authoring = { format: 'reader-authoring-1', key: 'read-races', meta: { title: 'Read consistency', language: 'en' }, blocks: [
    { key: 'body', type: 'para', text: 'Original body.' },
    { key: 'references', type: 'heading', level: 1, text: 'References' },
    { key: 'citation', type: 'para', text: '[1] Alice Smith. A reliable target paper. Journal of Testing, 2020. https://doi.org/10.5555/target.2020.' },
  ] };
  const file = await workspace.upload(localActor, Buffer.from(JSON.stringify(authoring)), { filename: 'authoring.json', mediaType: 'application/json' });
  const published = await workspace.publishAuthoring(localActor, { authoringSourceId: file.sourceId, requestId: 'seed-document' });
  const documentId = published.document.id, saved = await workspace.revision(documentId);
  const revise = () => workspace.execute(localActor, { kind: 'document.revise', documentId, expectedRevision: 1, authorized: true,
    requestId: 'concurrent-revision', operations: [{ kind: 'replace', blockId: saved.document.blocks[0].id, field: 'text', value: 'New body committed.' }] });
  return { workspace, documentId, saved, revise };
}

function reviseAfterDocumentRow(workspace, documentId, revise) {
  const query = workspace.sql.query.bind(workspace.sql);
  let armed = true, commits = 0;
  workspace.sql.query = async (statement, values = []) => {
    const rows = await query(statement, values);
    if (armed && statement === 'SELECT * FROM documents WHERE id=?' && values[0] === documentId) {
      armed = false;
      await revise();
      commits++;
    }
    return rows;
  };
  return () => commits;
}

test('workspace snapshots never attach a newer delivery watermark to previously read document rows', async t => {
  const { workspace, documentId } = await fixture(t);
  const before = workspace.snapshot();
  assert.equal(typeof before?.then, 'undefined', 'the local snapshot API remains synchronous');
  const query = workspace.sql.query.bind(workspace.sql), batch = workspace.sql.batch.bind(workspace.sql);
  let armed = true, concurrent, commits = 0;
  const commit = () => {
    armed = false;
    concurrent = workspace.execute(localActor, { kind: 'document.update', documentId, expectedVersion: 1,
      patch: { summary: 'New summary committed.' }, requestId: 'concurrent-metadata' }).then(result => { commits++; return result; });
    return concurrent;
  };
  const documentsRead = statement => statement.startsWith('WITH summary AS');
  workspace.sql.query = async (statement, values = []) => {
    // This path reproduces the former separate reads: old document rows,
    // followed by the new revision, must not be returned as one snapshot.
    if (armed && documentsRead(statement)) {
      const rows = query(statement, values);
      await commit();
      return rows;
    }
    if (concurrent && statement === 'SELECT value FROM metadata WHERE key=?') await concurrent;
    return query(statement, values);
  };
  workspace.sql.batch = async statements => {
    const result = batch(statements);
    // A read batch may finish just before another writer commits. Its complete
    // older snapshot is valid even though delivery happens after that commit.
    if (armed && statements.some(item => documentsRead(item.sql))) await commit();
    return result;
  };
  const snapshot = await workspace.snapshot(), after = await workspace.snapshot();
  assert.equal(commits, 1);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.documents[0].summary, 'New summary committed.');
  const valid = [before, after].some(value => value.revision === snapshot.revision && value.documents[0].summary === snapshot.documents[0].summary);
  assert.ok(valid, 'document rows and the revision watermark must come from the same committed state');
  assert.equal(snapshot.documents[0].version, snapshot.revision === before.revision ? 1 : 2);
});

test('an explicitly requested historical relation view cannot expose the next revision current projection', async t => {
  const { workspace, documentId, revise } = await fixture(t);
  const original = workspace.documentRelations(documentId, 1);
  assert.equal(typeof original?.then, 'undefined', 'the local relation read remains synchronous');
  assert.equal(original.outgoing.length, 1);
  assert.equal(original.outgoing[0].sourceRevision, 1);
  const committed = reviseAfterDocumentRow(workspace, documentId, revise);
  const result = await workspace.query(localActor, { kind: 'document_relations', documentId, revision: 1 });
  assert.equal(committed(), 1);
  assert.deepEqual(result, { documentId, revision: 1, currentRevision: 2, readOnly: true, outgoing: [], incoming: [] });
  const current = await workspace.documentRelations(documentId, 2);
  assert.equal(current.revision, 2);
  assert.equal(current.outgoing.length, 1);
  assert.ok(current.outgoing.every(item => item.sourceRevision === 2));
});

test('an unpinned document envelope uses the content revision selected with its metadata row', async t => {
  const { workspace, documentId, saved, revise } = await fixture(t);
  const committed = reviseAfterDocumentRow(workspace, documentId, revise);
  const envelope = await workspace.query(localActor, { kind: 'document', documentId });
  assert.equal(committed(), 1);
  assert.equal(envelope.record.revision, 1);
  assert.equal(envelope.document.revision, envelope.record.revision);
  assert.equal(envelope.document.blocks[0].text, 'Original body.');
  assert.deepEqual(envelope.fingerprints, saved.fingerprints);
  const current = await workspace.envelope(documentId);
  assert.equal(current.record.revision, 2);
  assert.equal(current.document.revision, 2);
  assert.equal(current.document.blocks[0].text, 'New body committed.');
});
