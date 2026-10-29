import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createWorkspace, localActor } from '../service.mjs';
import { createProtocolReviewEvidence } from './authoring-protocol-evidence-fixture.mjs';

// This suite exercises publication transactions and exact receipts using the
// deliberately synthetic review fixture. It makes no model/Reader-review claim.
async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reader-request-publication-'));
  const open = () => createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  let workspace = await open();
  t.after(async () => {
    await workspace.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /reader-request-publication-/);
    await rm(directory, { recursive: true, force: true });
  });
  const upload = (bytes, filename = 'authoring.json', mediaType = 'application/json') => workspace.upload(localActor, bytes, { filename, mediaType });
  const command = input => workspace.execute(localActor, { requestId: randomUUID(), authorized: true, ...input });
  const authoring = { format: 'reader-authoring-1', key: 'request-publication-fixture', meta: { title: 'Original title', language: 'en' },
    blocks: [{ key: 'paragraph', type: 'para', text: 'The original whole-article request.' }] };
  const original = await upload(Buffer.from(JSON.stringify(authoring)));
  const initial = await workspace.publishAuthoring(localActor, { authoringSourceId: original.sourceId, requestId: randomUUID() });
  const documentId = initial.document.id, base = await workspace.revision(documentId);
  const { changeRequest: request } = await command({ kind: 'change_request.save', documentId,
    changeRequest: { category: 'correction', body: 'Update this article title and paragraph.', revision: 1 } });
  assert.equal(request.source, undefined, 'the originating request intentionally has no source block');
  const { value: editing } = await workspace.getAuthoringEditPackageArtifact(localActor, documentId, 1);
  editing.authoring.meta.title = 'Updated title';
  editing.authoring.blocks[0].text = 'The revised whole-article request.';
  const revised = await upload(Buffer.from(JSON.stringify(editing.authoring)));
  const { preview } = await workspace.createAuthoringPreview(localActor, { authoringSourceId: revised.sourceId,
    target: { documentId, baseRevision: 1, baseHash: editing.base.documentHash }, requestId: randomUUID() });
  const evidence = await createProtocolReviewEvidence({ preview,
    readReport: async current => (await workspace.getPreviewArtifact(localActor, current.id, 'report')).value, upload });
  const input = { previewId: preview.id, expectedHash: preview.hash, requestId: randomUUID(), review: evidence.review };
  const execution = { changeRequest: { documentId, changeRequestId: request.id, expectedVersion: request.version, revision: 1 } };
  const getRequest = async () => (await workspace.changeRequests(documentId)).find(item => item.id === request.id);
  const changeRequest = mode => command(mode === 'cancel'
    ? { kind: 'change_request.cancel', documentId, changeRequestId: request.id, expectedVersion: request.version }
    : { kind: 'change_request.save', documentId, expectedVersion: request.version,
      changeRequest: { ...request, body: 'A replacement instruction; do not apply the previous candidate.' } });
  return { get workspace() { return workspace; }, documentId, base, request, preview, input, execution, command, getRequest, changeRequest,
    publish: (context = execution, payload = input) => workspace.publishAuthoringPreview(localActor, payload, context),
    restart: async () => { await workspace.close(); workspace = await open(); } };
}

const isPublicationBatch = (statements, requestId) => statements.some(statement => /^INSERT INTO receipts\(/.test(statement.sql) && statement.values?.[0] === requestId);
const receiptRow = h => h.workspace.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(h.input.requestId);
async function assertUnpublished(h) {
  assert.deepEqual((await h.workspace.revision(h.documentId)).document, h.base.document);
  assert.equal(h.workspace.db.prepare('SELECT COUNT(*) AS count FROM revisions WHERE document_id=?').get(h.documentId).count, 1);
  assert.equal(h.workspace.db.prepare('SELECT published_document_id FROM authoring_previews WHERE id=?').get(h.preview.id).published_document_id, null);
  assert.equal(receiptRow(h), undefined);
}

for (const mode of ['cancel', 'edit']) {
  test(`a whole-article request ${mode === 'cancel' ? 'cancelled' : 'edited'} after its preview blocks publication`, async t => {
    const h = await harness(t), changed = (await h.changeRequest(mode)).changeRequest;
    await assert.rejects(h.publish(), { code: 'REVISION_CONFLICT' });
    await assertUnpublished(h);
    assert.deepEqual(await h.getRequest(), changed);
    // Supplying the newly observed version cannot turn a cancellation into an
    // authorization to apply the old work.
    if (mode === 'cancel') await assert.rejects(h.publish({ changeRequest: { ...h.execution.changeRequest, expectedVersion: changed.version } }), { code: 'REVISION_CONFLICT' });
  });

  test(`a concurrent request ${mode} at the final publication batch preserves the newer request`, async t => {
    const h = await harness(t), batch = h.workspace.sql.batch.bind(h.workspace.sql);
    let intercepted = 0, changed;
    h.workspace.sql.batch = async statements => {
      if (!intercepted && isPublicationBatch(statements, h.input.requestId)) {
        intercepted++;
        changed = (await h.changeRequest(mode)).changeRequest;
      }
      return batch(statements);
    };
    try { await assert.rejects(h.publish(), { code: 'REVISION_CONFLICT' }); }
    finally { h.workspace.sql.batch = batch; }
    assert.equal(intercepted, 1, 'the competing command commits after preparation and before the guarded publication transaction');
    await assertUnpublished(h);
    assert.deepEqual(await h.getRequest(), changed);
  });
}

test('request completion, body revision, preview publication and receipt roll back together', async t => {
  const h = await harness(t), batch = h.workspace.sql.batch.bind(h.workspace.sql);
  const beforeRevision = h.workspace.meta('revision'), beforeRequest = await h.getRequest();
  let intercepted = 0;
  h.workspace.sql.batch = statements => {
    if (isPublicationBatch(statements, h.input.requestId)) {
      intercepted++;
      // Fail after all intended writes, including the receipt, have executed
      // inside the real SQLite transaction.
      return batch([...statements, { sql: 'SELECT * FROM missing_request_publication_rollback_table' }]);
    }
    return batch(statements);
  };
  try { await assert.rejects(h.publish(), /missing_request_publication_rollback_table/); }
  finally { h.workspace.sql.batch = batch; }
  assert.equal(intercepted, 1);
  await assertUnpublished(h);
  assert.equal(h.workspace.meta('revision'), beforeRevision);
  assert.deepEqual(await h.getRequest(), beforeRequest);
  const result = await h.publish();
  assert.equal(result.document.revision, 2);
  assert.equal(result.changeRequest.status, 'completed');
  assert.equal(result.changeRequest.appliedRevision, 2);
  assert.deepEqual(await h.getRequest(), result.changeRequest);
});

test('bound publication replays its exact completed receipt across later edits and restart', async t => {
  const h = await harness(t), result = await h.publish(), recorded = receiptRow(h);
  assert.equal(result.changeRequest.id, h.request.id);
  assert.equal(result.changeRequest.reference, h.request.reference);
  assert.equal(result.changeRequest.status, 'completed');
  assert.equal(result.changeRequest.version, h.request.version + 1);
  assert.equal(result.changeRequest.appliedRevision, result.document.revision);
  assert.deepEqual(await h.getRequest(), result.changeRequest);
  assert.deepEqual(await h.publish(), result);
  await h.command({ kind: 'document.revise', documentId: h.documentId, expectedRevision: 2,
    operations: [{ kind: 'replace', blockId: h.base.document.blocks[0].id, field: 'text', value: 'A later independent user revision.' }] });
  await h.restart();
  assert.deepEqual(await h.publish(), result, 'the completed request is replayed before any pending/version recheck');
  assert.deepEqual(receiptRow(h), recorded, 'the originally settled receipt is not replaced');
  assert.equal((await h.workspace.revision(h.documentId)).document.revision, 3);
  assert.deepEqual(await h.getRequest(), result.changeRequest);
  await assert.rejects(h.workspace.publishAuthoringPreview(localActor, h.input), { code: 'IDEMPOTENCY_CONFLICT' });
  for (const patch of [{ expectedVersion: 2 }, { revision: 2 }, { changeRequestId: 'different-request' }]) {
    await assert.rejects(h.publish({ changeRequest: { ...h.execution.changeRequest, ...patch } }), { code: 'IDEMPOTENCY_CONFLICT' });
  }
  assert.deepEqual(receiptRow(h), recorded);
});

test('a trusted request binding must match the revision preview document and base revision', async t => {
  const h = await harness(t);
  for (const patch of [{ documentId: 'different-document' }, { revision: 2 }]) {
    await assert.rejects(h.publish({ changeRequest: { ...h.execution.changeRequest, ...patch } }), { code: 'CHANGE_REQUEST_TARGET_MISMATCH' });
    await assertUnpublished(h);
  }
  assert.deepEqual(await h.getRequest(), h.request);
});

test('public publication payloads cannot supply the private request execution binding', async t => {
  const h = await harness(t);
  for (const extra of [{ changeRequestBinding: h.execution.changeRequest }, { execution: h.execution }]) {
    await assert.rejects(h.workspace.publishAuthoringPreview(localActor, { ...h.input, ...extra }), { code: 'VALIDATION_FAILED' });
    await assertUnpublished(h);
  }
  assert.deepEqual(await h.getRequest(), h.request);
});
