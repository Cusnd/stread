import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DocumentRelations, prepareRelationChanges } from '../relations.mjs';
import { sqliteAccess, createReadSet, businessAssertionSchema, rowStatement } from '../sql-commit.mjs';
import { cloudSyncSchema } from '../sync-table-definitions.mjs';
const applyStatements = prepared => [...prepared.changes.map(change => rowStatement(change.entity, cloudSyncSchema.get(change.entity).keys, change.value, JSON.parse(change.key))), ...prepared.statements];

const documents = [
  { id: 'source', revision: 1, meta: { title: 'A citing article', language: 'en' }, blocks: [
    { id: 'body', type: 'para', text: 'See [1](#bib-one).' },
    { id: 'refs', type: 'heading', level: 1, text: 'References' },
    { id: 'bib-one', type: 'para', text: '[1] Alice Smith. A reliable target paper. Journal of Testing, 2020. https://doi.org/10.5555/target.2020.' },
  ] },
  { id: 'target', revision: 1, meta: { title: 'A reliable target paper', authors: 'Alice Smith', date: '2020', doi: '10.5555/target.2020', language: 'en' }, blocks: [{ id: 'target-body', type: 'para', text: 'A result.' }] },
];

function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.transaction = operation => { db.exec('BEGIN IMMEDIATE'); try { const result = operation(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  db.exec('CREATE TABLE documents(id TEXT PRIMARY KEY,archived_at TEXT,created_at TEXT);' + businessAssertionSchema);
  const relations = new DocumentRelations(db), sql = sqliteAccess(db);
  for (const document of documents) db.prepare('INSERT INTO documents VALUES(?,NULL,?)').run(document.id, '2026-10-24');
  db.transaction(() => relations.sync(documents));
  t.after(() => db.close());
  return { db, sql, relations };
}

test('explicit relation preparation preserves dry-run proposal values, identity, version and stable row order', async t => {
  const { db, sql, relations } = setup(t), before = relations.rows('source')[0];
  assert.equal(before.status, 'linked');
  const command = { kind: 'relation.dismiss', documentId: 'source', relationId: before.id, expectedVersion: before.version };
  const reads = createReadSet(sql), preview = await prepareRelationChanges({ reads, command, dryRun: true });
  assert.deepEqual(preview.next, relations.prepare(command).next);
  assert.deepEqual(preview.previous, before); assert.deepEqual(preview.changes, []); assert.deepEqual(preview.statements, []);
  assert.deepEqual(relations.rows('source')[0], before, 'preparation never mutates business state');
  const finalReads = createReadSet(sql), prepared = await prepareRelationChanges({ reads: finalReads, command });
  const rowid = db.prepare('SELECT rowid FROM document_relations WHERE id=?').get(before.id).rowid;
  await sql.batch([...finalReads.guards, ...applyStatements(prepared)]);
  const result = relations.rows('source')[0];
  assert.equal(result.id, before.id); assert.equal(result.version, before.version + 1); assert.equal(result.status, 'dismissed');
  assert.equal(result.createdAt, before.createdAt); assert.deepEqual(result, prepared.relation);
  assert.equal(db.prepare('SELECT rowid FROM document_relations WHERE id=?').get(before.id).rowid, rowid);
});

test('catalog overlays produce cross-document changes and read guards reject a newly inserted dependency', async t => {
  const { db, sql, relations } = setup(t), before = relations.rows('source')[0];
  const reads = createReadSet(sql), prepared = await prepareRelationChanges({ reads, documentRows: [{ id: 'target', archived_at: '2026-10-25', created_at: '2026-10-24' }] });
  const changed = prepared.changes.find(change => change.entity === 'document_relations');
  assert.equal(JSON.parse(changed.value.payload).status, 'unresolved');
  assert.equal(changed.value.document_id, 'source', 'archive of a target changes an actually dependent source');
  db.prepare('INSERT INTO documents VALUES(?,NULL,?)').run('new-concurrent-document', '2026-10-24');
  assert.throws(() => sql.batch([...reads.guards, ...applyStatements(prepared)]), /CHECK|constraint/);
  assert.deepEqual(relations.rows('source')[0], before, 'phantom catalog insert blocks all prepared writes');
  const retryReads = createReadSet(sql), retry = await prepareRelationChanges({ reads: retryReads, documentRows: [{ id: 'target', archived_at: '2026-10-25', created_at: '2026-10-24' }] });
  await sql.batch([...retryReads.guards, { sql: "UPDATE documents SET archived_at='2026-10-25' WHERE id='target'", values: [] }, ...applyStatements(retry)]);
  assert.equal(relations.rows('source')[0].status, 'unresolved');
});

test('async relation reads use the same projection without a synchronous cloud database', async t => {
  const { db, relations } = setup(t);
  const asyncDb = { prepare(statement) { const saved = db.prepare(statement); return {
    async all(...values) { return saved.all(...values); }, async get(...values) { return saved.get(...values); },
  }; } };
  const remote = new DocumentRelations(asyncDb, { initialize: false });
  assert.deepEqual(await remote.query('source', 1), relations.query('source', 1));
  const relation = relations.rows('source')[0];
  assert.deepEqual(await remote.get(relation.id, 'source'), relation);
  assert.deepEqual(await remote.prepare({ kind: 'relation.reset', documentId: 'source', relationId: relation.id, expectedVersion: relation.version }),
    relations.prepare({ kind: 'relation.reset', documentId: 'source', relationId: relation.id, expectedVersion: relation.version }));
});
