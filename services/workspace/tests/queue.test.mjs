import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createWorkspace, localActor } from '../service.mjs';
import { Workspace } from '../workspace-core.mjs';
import { createProtocolReviewEvidence } from './authoring-protocol-evidence-fixture.mjs';

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stread-queue-test-'));
  const open = () => createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  let workspace = await open();
  t.after(async () => {
    await workspace.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /stread-queue-test-/);
    await rm(directory, { recursive: true, force: true });
  });
  const upload = (value, filename = 'original.txt', mediaType = 'text/plain') => workspace.upload(localActor, Buffer.from(value), { filename, mediaType });
  const command = input => workspace.execute(localActor, { requestId: randomUUID(), ...input });
  const task = async id => (await workspace.query(localActor, { kind: 'queue.task', taskId: id })).task;
  const create = async input => (await command({ kind: 'queue.create', task: input })).task;
  return { get workspace() { return workspace; }, upload, command, create, task,
    restart: async () => { await workspace.close(); workspace = await open(); } };
}

async function documentFixture(h) {
  const authoring = { format: 'reader-authoring-1', key: 'queue-fixture-' + randomUUID(), meta: { title: 'Queue fixture', language: 'en' },
    blocks: [{ key: 'paragraph', type: 'para', text: 'Alpha beta gamma.' }] };
  const file = await h.upload(JSON.stringify(authoring), 'authoring.json', 'application/json');
  const published = await h.workspace.publishAuthoring(localActor, { authoringSourceId: file.sourceId, requestId: randomUUID() });
  const saved = await h.workspace.revision(published.document.id);
  return { documentId: saved.document.id, blockId: saved.document.blocks[0].id };
}

async function conversionFixture(h, { language = 'zh-CN', task, original, bind = true, translated = true } = {}) {
  original ||= await h.upload(language === 'zh-CN' ? '原始内容。' : 'Original content.');
  task ||= await h.create({ type: 'conversion', sourceId: original.sourceId, sourceLanguage: language });
  const authoring = { format: 'reader-authoring-1', key: 'queue-conversion-' + randomUUID(),
    meta: { title: language === 'zh-CN' ? '队列测试' : 'Queue test', language,
      ...(language !== 'zh-CN' && translated ? { translations: { 'zh-CN': { title: '队列测试' } } } : {}) },
    source: { path: 'original.txt', media_type: 'text/plain', sha256: original.sha256 },
    ...(bind ? { extensions: { 'stread.queue': { taskId: task.id, taskVersion: task.version } } } : {}),
    blocks: [{ key: 'paragraph', type: 'para', text: language === 'zh-CN' ? '原始内容。' : 'Original content.',
      ...(language !== 'zh-CN' && translated ? { translations: { 'zh-CN': { text: '原始内容。' } } } : {}) }] };
  const file = await h.upload(JSON.stringify(authoring), 'authoring.json', 'application/json');
  const input = { authoringSourceId: file.sourceId, resources: { 'original.txt': original.sourceId }, requestId: randomUUID() };
  return { task, original, authoring, input,
    preview: async () => (await h.workspace.createAuthoringPreview(localActor, input)).preview };
}

async function publication(h, preview, target = 'source') {
  // Deliberately synthetic evidence tests the transaction and binding contract,
  // not actual independent review, translation fidelity or Reader acceptance.
  const evidence = await createProtocolReviewEvidence({ preview,
    readReport: async item => (await h.workspace.getPreviewArtifact(localActor, item.id, 'report')).value,
    upload: h.upload });
  if (target !== 'source') {
    evidence.report.delivery = { targetLanguage: target };
    const updated = await h.upload(JSON.stringify(evidence.report), 'queue-protocol-review.json', 'application/json');
    evidence.review.evidenceSourceIds = [...evidence.ids.slice(0, -1), updated.sourceId];
  }
  const input = { previewId: preview.id, expectedHash: preview.hash, requestId: randomUUID(), review: evidence.review };
  return { input, run: () => h.workspace.publishAuthoringPreview(localActor, input) };
}

test('conversion tasks have stable UUID/T identities, guarded edits, cancellation and exact receipts across restart', async t => {
  const h = await harness(t), original = await h.upload('input');
  const input = { kind: 'queue.create', requestId: randomUUID(), task: { type: 'conversion', sourceId: original.sourceId, title: 'Requested title' } };
  const first = await h.command(input), task = first.task;
  assert.match(task.id, /^[0-9a-f-]{36}$/); assert.equal(task.reference, '#T00001');
  assert.deepEqual(task.outputLanguages, ['source', 'zh-CN']); assert.equal(task.sourceLanguage, '');
  assert.equal(task.status, 'pending'); assert.equal(task.documentId, undefined);
  assert.deepEqual(await h.command(input), first);
  await assert.rejects(h.command({ ...input, task: { ...input.task, title: 'Different' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  const edited = (await h.command({ kind: 'queue.update', taskId: task.reference, expectedVersion: task.version,
    patch: { title: 'Revised title', body: 'Keep every table.', sourceLanguage: 'zh-CN' } })).task;
  assert.equal(edited.id, task.id); assert.equal(edited.reference, task.reference); assert.equal(edited.version, 2);
  assert.deepEqual(edited.outputLanguages, ['source']);
  await assert.rejects(h.command({ kind: 'queue.cancel', taskId: task.id, expectedVersion: 1 }), { code: 'REVISION_CONFLICT' });
  const cancelled = (await h.command({ kind: 'queue.cancel', taskId: task.id, expectedVersion: edited.version })).task;
  await assert.rejects(h.command({ kind: 'queue.update', taskId: task.id, expectedVersion: cancelled.version, patch: { body: 'Changed' } }), { code: 'REVISION_CONFLICT' });
  const reopened = (await h.command({ kind: 'queue.reopen', taskId: task.id, expectedVersion: cancelled.version })).task;
  assert.equal(reopened.id, task.id); assert.equal(reopened.reference, task.reference); assert.equal(reopened.status, 'pending');
  await h.restart();
  assert.deepEqual(await h.command(input), first);
  const resolved = await h.task('T00001');
  assert.equal(resolved.version, reopened.version); assert.equal(resolved.sourceFilename, 'original.txt');
  assert.equal(resolved.uploadedSource.sourceId, original.sourceId); assert.match(resolved.sourceUrl, /\/original$/);
});

test('queue validates ownership, source and target inputs without making ordinary questions into jobs', async t => {
  const h = await harness(t), { documentId } = await documentFixture(h);
  const { insight } = await h.command({ kind: 'insight.save', documentId, insight: { type: 'question', color: 'blue', body: 'Why?', revision: 1 } });
  assert.equal((await h.workspace.query({ kind: 'queue' })).total, 0);
  await assert.rejects(h.create({ type: 'conversion', sourceId: 'missing' }), { code: 'NOT_FOUND' });
  await assert.rejects(h.create({ type: 'instruction', body: 'Do something' }), { code: 'VALIDATION_FAILED' });
  await assert.rejects(h.create({ type: 'question', documentId, insightId: 'missing' }), { code: 'NOT_FOUND' });
  const original = await h.upload('input');
  await assert.rejects(h.create({ type: 'conversion', sourceId: original.sourceId, status: 'completed' }), { code: 'VALIDATION_FAILED' });
  await assert.rejects(h.create({ type: 'conversion', sourceId: original.sourceId, body: 42 }), { code: 'VALIDATION_FAILED' });
  await assert.rejects(h.create({ type: 'conversion', sourceId: original.sourceId, outputLanguages: ['zh-CN'] }), { code: 'VALIDATION_FAILED' });
  const readOnly = { workspaceId: 'local', subjectId: 'viewer', scopes: ['read'] };
  await assert.rejects(h.workspace.execute(readOnly, { kind: 'queue.create', requestId: randomUUID(), task: { type: 'conversion', sourceId: original.sourceId } }), { code: 'FORBIDDEN' });
  await assert.rejects(h.workspace.query({ workspaceId: 'elsewhere', scopes: ['read'] }, { kind: 'queue' }), { code: 'FORBIDDEN' });
  const task = await h.create({ type: 'question', documentId, insightId: insight.id });
  assert.equal(task.body, insight.body); assert.equal(task.relatedReference, insight.reference);
  await assert.rejects(h.create({ type: 'question', documentId, insightId: insight.id }), { code: 'QUEUE_TASK_EXISTS' });
  await h.command({ kind: 'insight.answer', documentId, insightId: insight.id, expectedVersion: task.insightVersion, authorized: true,
    answer: { blocks: [{ type: 'paragraph', text: 'Because.' }] } });
  const completed = await h.task(task.id);
  assert.equal(completed.status, 'completed'); assert.equal(completed.result.kind, 'answer'); assert.equal(completed.result.insightId, insight.id);
  await assert.rejects(h.command({ kind: 'queue.update', taskId: task.id, expectedVersion: completed.version, patch: { body: 'New question' } }), { code: 'REVISION_CONFLICT' });
});

test('concurrent mixed task creation allocates a single non-reused T sequence and conflicting edits do not overwrite', async t => {
  const h = await harness(t), original = await h.upload('input'), { documentId } = await documentFixture(h);
  const tasks = await Promise.all(Array.from({ length: 12 }, (_, i) => h.create(i % 2
    ? { type: 'correction', documentId, body: 'Correction ' + i }
    : { type: 'conversion', sourceId: original.sourceId, body: 'Conversion ' + i })));
  assert.equal(new Set(tasks.map(task => task.id)).size, 12);
  assert.deepEqual(tasks.map(task => task.reference).sort(), Array.from({ length: 12 }, (_, i) => '#T' + String(i + 1).padStart(5, '0')));
  const task = tasks[0];
  const races = await Promise.allSettled(['one', 'two'].map(body => h.command({ kind: 'queue.update', taskId: task.id, expectedVersion: task.version, patch: { body } })));
  assert.equal(races.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(races.find(value => value.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const list = await h.workspace.query({ kind: 'queue', type: 'correction', query: 'Correction', limit: 3 });
  assert.equal(list.total, 6); assert.equal(list.tasks.length, 3); assert.equal(list.counts.all, 6); assert.equal(list.allCounts.all, 12); assert.equal(list.typeCounts.conversion, 6);
});

test('question task requirements and cancellation fence old answers while external question edits refresh the same task', async t => {
  const h = await harness(t), { documentId } = await documentFixture(h);
  const { insight } = await h.command({ kind: 'insight.save', documentId, insight: { type: 'question', color: 'blue', body: 'Why beta?', revision: 1 } });
  const task = await h.create({ type: 'question', documentId, insightId: insight.id, expectedInsightVersion: insight.version });
  const answer = expectedVersion => h.command({ kind: 'insight.answer', documentId, insightId: insight.id, expectedVersion,
    authorized: true, answer: { blocks: [{ type: 'paragraph', text: 'An old answer.' }] } });
  await assert.rejects(answer(insight.version), { code: 'REVISION_CONFLICT' });
  const edited = (await h.command({ kind: 'queue.update', taskId: task.id, expectedVersion: task.version, patch: { body: 'Explain with a numerical example.' } })).task;
  await assert.rejects(answer(task.insightVersion), { code: 'REVISION_CONFLICT' });
  const cancelled = (await h.command({ kind: 'queue.cancel', taskId: task.id, expectedVersion: edited.version })).task;
  await assert.rejects(answer(edited.insightVersion), { code: 'REVISION_CONFLICT' });
  const reopened = (await h.command({ kind: 'queue.reopen', taskId: task.id, expectedVersion: cancelled.version })).task;
  const { insight: changed } = await h.command({ kind: 'insight.save', documentId, expectedVersion: reopened.insightVersion,
    insight: { id: insight.id, body: 'Why gamma?' } });
  const refreshed = await h.task(task.id);
  assert.equal(refreshed.id, task.id); assert.equal(refreshed.reference, task.reference);
  assert.equal(refreshed.questionBody, 'Why gamma?'); assert.equal(refreshed.body, 'Explain with a numerical example.');
  assert.equal(refreshed.insightVersion, changed.version); assert.ok(refreshed.version > reopened.version);
  await assert.rejects(answer(reopened.insightVersion), { code: 'REVISION_CONFLICT' });
  await answer(changed.version);
  assert.equal((await h.task(task.id)).status, 'completed');
});

test('existing R requests migrate once and subsequent edits/cancel/reopen retain their T and R identities', async t => {
  const h = await harness(t), { documentId } = await documentFixture(h);
  const request = { id: 'legacy-request', documentId, version: 1, revision: 1, reference: '#R00029', category: 'translation', body: 'Use the correct term.', status: 'pending' };
  h.workspace.db.prepare('INSERT INTO change_requests VALUES(?,?,?,?,?)').run(request.id, documentId, 1, request.reference, JSON.stringify(request));
  await h.restart();
  const initial = (await h.workspace.query({ kind: 'queue' })).tasks[0];
  assert.equal(initial.reference, '#T00001'); assert.equal(initial.relatedReference, '#R00029'); assert.equal(initial.changeRequestId, request.id);
  await h.restart(); assert.equal((await h.workspace.query({ kind: 'queue' })).total, 1);
  await h.command({ kind: 'change_request.save', documentId, expectedVersion: 1, changeRequest: { ...request, body: 'Keep the technical term.' } });
  const edited = await h.task(initial.id);
  assert.equal(edited.reference, initial.reference); assert.equal(edited.body, 'Keep the technical term.'); assert.equal(edited.version, 2);
  const cancelled = (await h.command({ kind: 'queue.cancel', taskId: initial.id, expectedVersion: edited.version })).task;
  assert.equal((await h.workspace.changeRequests(documentId))[0].status, 'cancelled');
  const reopened = (await h.command({ kind: 'queue.reopen', taskId: initial.id, expectedVersion: cancelled.version })).task;
  assert.equal(reopened.relatedReference, request.reference); assert.equal((await h.workspace.changeRequests(documentId))[0].status, 'pending');
});

test('requests remain pending until a proposal is applied and completed tasks point to the actual revision', async t => {
  const h = await harness(t), { documentId, blockId } = await documentFixture(h);
  const task = await h.create({ type: 'correction', documentId, body: 'Change beta to delta.', source: { blockId, field: 'text', start: 6, end: 10, quote: 'beta' } });
  const request = (await h.workspace.changeRequests(documentId))[0];
  const proposed = await h.command({ kind: 'document.revise', documentId, expectedRevision: 1, changeRequestId: request.id, expectedChangeRequestVersion: request.version,
    operations: [{ kind: 'replace_range', blockId, field: 'text', start: 6, end: 10, expectedText: 'beta', value: 'delta' }] });
  const awaiting = await h.task(task.id);
  assert.equal(awaiting.status, 'needs_attention'); assert.equal(awaiting.statusReason, '等待确认修改'); assert.equal(awaiting.proposal.id, proposed.proposal.id);
  assert.equal((await h.workspace.changeRequests(documentId))[0].status, 'pending');
  await h.command({ kind: 'proposal.accept', proposalId: proposed.proposal.id });
  const completed = await h.task(task.id);
  assert.equal(completed.status, 'completed'); assert.equal(completed.result.kind, 'revision'); assert.equal(completed.result.revision, 2);
  assert.equal(completed.reference, task.reference);
  await assert.rejects(h.command({ kind: 'queue.reopen', taskId: task.id, expectedVersion: completed.version }), { code: 'REVISION_CONFLICT' });
});

test('conversion preview binding requires the exact source and current task version and unbound work never completes a task', async t => {
  const h = await harness(t), fixture = await conversionFixture(h), other = await h.upload('different input');
  const wrong = await conversionFixture(h, { original: other, task: fixture.task });
  await assert.rejects(wrong.preview(), { code: 'QUEUE_BINDING_MISMATCH' });
  const preview = await fixture.preview();
  const pending = await h.task(fixture.task.id);
  assert.equal(pending.status, 'needs_attention'); assert.equal(pending.preview.id, preview.id); assert.equal(pending.result, undefined);
  assert.equal(pending.version, fixture.task.version, 'preview state does not invalidate its own requirements binding');
  const edited = (await h.command({ kind: 'queue.update', taskId: fixture.task.id, expectedVersion: fixture.task.version, patch: { body: 'Keep footnotes too.' } })).task;
  const publish = await publication(h, preview);
  await assert.rejects(publish.run(), { code: 'REVISION_CONFLICT' });
  assert.equal((await h.task(edited.id)).status, 'pending', 'obsolete preview is not presented for changed requirements');
  const unbound = await conversionFixture(h, { original: fixture.original, task: edited, bind: false });
  const unrelated = await publication(h, await unbound.preview());
  await unrelated.run();
  assert.equal((await h.task(edited.id)).status, 'pending', 'matching filename or source alone does not identify a task');
});

test('reviewed conversion completes only its bound task atomically and its exact publication receipt survives restart', async t => {
  const h = await harness(t), fixture = await conversionFixture(h);
  const other = await h.create({ type: 'conversion', sourceId: fixture.original.sourceId, sourceLanguage: 'zh-CN', body: 'A separate conversion.' });
  const preview = await fixture.preview(), publish = await publication(h, preview), before = (await h.workspace.query({ kind: 'queue' })).revision;
  await assert.rejects(h.workspace.publishAuthoring(localActor, { ...fixture.input, requestId: randomUUID() }), { code: 'PREVIEW_REQUIRED' });
  const result = await publish.run(), completed = await h.task(fixture.task.id);
  assert.equal(completed.status, 'completed'); assert.equal(completed.result.documentId, result.document.id); assert.equal(completed.result.kind, 'document');
  assert.equal((await h.task(other.id)).status, 'pending'); assert.ok((await h.workspace.query({ kind: 'queue' })).revision > before);
  await h.restart(); assert.deepEqual(await publish.run(), result); assert.equal((await h.task(fixture.task.id)).reference, fixture.task.reference);
});

test('a failed replacement preview surfaces the real diagnostic and advances the queue read revision', async t => {
  const h = await harness(t), fixture = await conversionFixture(h), preview = await fixture.preview();
  const before = await h.workspace.query({ kind: 'queue' });
  const invalid = await h.upload('{invalid JSON', 'broken.json', 'application/json');
  await assert.rejects(h.workspace.createAuthoringPreview(localActor, { authoringSourceId: invalid.sourceId,
    previousPreviewId: preview.id, resources: fixture.input.resources, requestId: randomUUID() }), { code: 'INVALID_JSON' });
  const after = await h.workspace.query({ kind: 'queue' }), task = await h.task(fixture.task.id);
  assert.ok(after.revision > before.revision);
  assert.equal(task.status, 'needs_attention'); assert.equal(task.statusReason, '最新候选需要修复'); assert.equal(task.error.code, 'INVALID_JSON');
  assert.equal(task.version, fixture.task.version);
});

test('a later document revision preserves historical conversion provenance without reopening the completed task', async t => {
  const h = await harness(t), fixture = await conversionFixture(h), preview = await fixture.preview();
  const publish = await publication(h, preview), result = await publish.run(), completed = await h.task(fixture.task.id);
  const { value: editing } = await h.workspace.getAuthoringEditPackageArtifact(localActor, result.document.id, 1);
  assert.equal(editing.authoring.extensions['stread.queue'].taskId, fixture.task.id);
  editing.authoring.meta.title = '之后修改的标题';
  const updated = await h.upload(JSON.stringify(editing.authoring), 'edited-authoring.json', 'application/json');
  const candidate = await h.workspace.createAuthoringPreview(localActor, { authoringSourceId: updated.sourceId,
    target: { documentId: result.document.id, baseRevision: 1, baseHash: editing.base.documentHash }, requestId: randomUUID() });
  assert.equal(candidate.preview.target.documentId, result.document.id);
  assert.deepEqual(await h.task(fixture.task.id), completed);
});

test('conversion publication respects requested target language even when review claims a source-only exception', async t => {
  const h = await harness(t), fixture = await conversionFixture(h, { language: 'en' }), preview = await fixture.preview();
  const wrong = await publication(h, preview);
  await assert.rejects(wrong.run(), { code: 'QUEUE_DELIVERY_MISMATCH' });
  assert.equal((await h.task(fixture.task.id)).status, 'needs_attention');
  const reviewed = await publication(h, preview, 'zh-CN');
  const result = await reviewed.run();
  assert.equal((await h.task(fixture.task.id)).result.documentId, result.document.id);
});

test('a task edit racing final conversion publication aborts the old candidate without a document or receipt', async t => {
  const h = await harness(t), fixture = await conversionFixture(h), preview = await fixture.preview(), publish = await publication(h, preview);
  const batch = h.workspace.sql.batch.bind(h.workspace.sql); let intercepted = false;
  h.workspace.sql.batch = async statements => {
    if (!intercepted && statements.some(statement => /^INSERT INTO receipts\(/.test(statement.sql) && statement.values?.[0] === publish.input.requestId)) {
      intercepted = true;
      await h.command({ kind: 'queue.update', taskId: fixture.task.id, expectedVersion: fixture.task.version, patch: { body: 'Newer requirement.' } });
    }
    return batch(statements);
  };
  try { await assert.rejects(publish.run(), { code: 'REVISION_CONFLICT' }); }
  finally { h.workspace.sql.batch = batch; }
  assert.equal(intercepted, true);
  assert.equal(h.workspace.db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);
  assert.equal(h.workspace.db.prepare('SELECT request_id FROM receipts WHERE request_id=?').get(publish.input.requestId), undefined);
  assert.equal((await h.task(fixture.task.id)).body, 'Newer requirement.');
});

test('queue reads and command preparation support asynchronous SQL without synchronous database access', async t => {
  const h = await harness(t), original = await h.upload('input');
  const sql = { query: async (...args) => h.workspace.sql.query(...args), batch: async (...args) => h.workspace.sql.batch(...args) };
  const asyncWorkspace = new Workspace({ database: null, sql, resources: h.workspace.resources });
  const input = { kind: 'queue.create', requestId: randomUUID(), task: { type: 'conversion', sourceId: original.sourceId } };
  const receipt = await asyncWorkspace.execute(localActor, input);
  assert.deepEqual(await asyncWorkspace.execute(localActor, input), receipt);
  assert.deepEqual(await asyncWorkspace.query(localActor, { kind: 'queue' }), await h.workspace.query(localActor, { kind: 'queue' }));
  assert.equal((await asyncWorkspace.reference(receipt.task.reference)).task.id, receipt.task.id);
});
