import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Workspace } from '../workspace-core.mjs';
import { prepareAuthoring, verifyAuthoringFile } from '../authoring-core.mjs';
import { hash } from '../errors.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE files(id TEXT PRIMARY KEY, filename TEXT NOT NULL, media_type TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL)');
  const rows = [], data = new Map(), queries = [], opened = [];
  function add(id, bytes = Buffer.from('Shared immutable fixture bytes'), overrides = {}) {
    const descriptor = { id, filename: id + '.png', mediaType: 'image/png', sha256: hash(bytes), size: bytes.length, ...overrides };
    db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?)').run(descriptor.id, descriptor.filename, descriptor.mediaType, descriptor.sha256, descriptor.size, 'fixed');
    rows.push(descriptor); data.set(descriptor.sha256, bytes); return descriptor;
  }
  const resources = { async open(digest) { opened.push(digest); return [data.get(digest)]; }, async read(digest) { return data.get(digest); } };
  const query = (statement, values = []) => { queries.push({ statement, values }); return db.prepare(statement).all(...values); };
  const sync = new Workspace({ database: db, sql: { query }, resources });
  const asyncWorkspace = new Workspace({ database: null, sql: { query: async (...args) => { await Promise.resolve(); return query(...args); } }, resources });
  return { db, rows, queries, opened, resources, add, sync, asyncWorkspace };
}

test('Workspace.files preserves 2000 independent descriptors, order, duplicates and missing positions with sync or async SQL', async t => {
  const h = fixture(t), expected = new Map();
  for (let i = 0; i < 2000; i++) { const item = h.add('source-' + String(i).padStart(4, '0')); expected.set(item.id, item); }
  const ids = [...expected.keys()].reverse(); ids.splice(781, 0, ids[0], 'missing-source', ids[1399]);
  for (const workspace of [h.sync, h.asyncWorkspace]) {
    h.queries.length = 0;
    const pending = workspace.files(ids);
    assert.equal(pending instanceof Promise, workspace === h.asyncWorkspace);
    const result = await pending;
    assert.deepEqual(result, ids.map(id => expected.has(id) ? { ...expected.get(id) } : null));
    assert.equal(h.queries.length, 1, 'one collection read, including 2000 distinct file identities');
    assert.equal(h.queries[0].values.length, 1, 'D1 does not receive 2000 bound parameters');
    assert.equal(JSON.parse(h.queries[0].values[0]).length, 2001, 'missing ID is retained in the unique requested set');
    assert.notEqual(result[0], result[781], 'duplicate IDs yield independent descriptor objects');
    result[0].filename = 'mutated'; assert.notEqual(result[781].filename, 'mutated');
    h.queries.length = 0; assert.deepEqual(workspace.files([]), []); assert.equal(h.queries.length, 0);
  }
  assert.throws(() => h.sync.file('missing-source'), { code: 'NOT_FOUND', status: 404 });
  await assert.rejects(h.asyncWorkspace.file('missing-source'), { code: 'NOT_FOUND', status: 404 });
});

test('authoring awaits one resource collection read and preserves 2000 distinct source IDs in binding order', async t => {
  const h = fixture(t), resources = {}, input = { format: 'reader-authoring-1', key: 'file-collection', meta: { title: 'Independent source identities', language: 'en' }, blocks: [] };
  for (let i = 0; i < 2000; i++) { const asset = h.add('asset-' + i), path = 'images/' + String(1999 - i).padStart(4, '0') + '.png'; resources[path] = asset.id; input.blocks.push({ key: 'f-' + i, type: 'figure', src: path, alt: 'Synthetic fixture' }); }
  const source = h.add('authoring', Buffer.from(JSON.stringify(input)), { filename: 'authoring.json', mediaType: 'application/json' });
  h.queries.length = 0; h.opened.length = 0;
  const prepared = await prepareAuthoring(h.asyncWorkspace, { authoringSourceId: source.id, resources });
  assert.equal(prepared.validation.valid, true); assert.equal(prepared.validation.summary.resourceCount, 2000);
  assert.deepEqual(Object.keys(prepared.resourceMap), Object.keys(resources));
  for (const [path, id] of Object.entries(resources)) assert.deepEqual(prepared.resourceMap[path], h.rows.find(row => row.id === id));
  assert.equal(h.queries.length, 2, 'one authoring file read and one resource set read');
  assert.deepEqual(h.opened, [source.sha256, h.rows[0].sha256], 'hash verification preserves existing immutable-byte deduplication');
});

test('collection resource preparation keeps legacy missing-file and hash-failure precedence in original binding order', async t => {
  const h = fixture(t), valid = h.add('valid'), corrupt = h.add('corrupt', Buffer.from('actual corrupt fixture'), { sha256: 'f'.repeat(64) });
  const authoring = h.add('authoring', Buffer.from(JSON.stringify({ format: 'reader-authoring-1', key: 'order', meta: { title: 'Ordering' }, blocks: [{ key: 'p', type: 'para', text: 'Bound resources.' }] })), { mediaType: 'application/json' });
  const legacy = async resources => {
    const checked = new Set([authoring.sha256]);
    for (const [, id] of Object.entries(resources)) {
      const file = await h.asyncWorkspace.file(id);
      if (!checked.has(file.sha256)) { await verifyAuthoringFile(file, h.resources); checked.add(file.sha256); }
    }
  };
  const outcome = async action => { try { await action(); return { ok: true }; } catch (error) { return { ok: false, code: error.code, message: error.message, status: error.status, details: error.details }; } };
  for (const [name, resources, expected] of [
    ['corrupt before missing', { 'first.png': corrupt.id, 'second.png': 'missing' }, 'SOURCE_HASH_MISMATCH'],
    ['missing before corrupt', { 'first.png': 'missing', 'second.png': corrupt.id }, 'NOT_FOUND'],
    ['valid aliases before corrupt and missing', { 'one.png': valid.id, 'two.png': valid.id, 'three.png': corrupt.id, 'four.png': 'missing' }, 'SOURCE_HASH_MISMATCH'],
    ['valid before missing', { 'first.png': valid.id, 'second.png': 'missing' }, 'NOT_FOUND'],
  ]) {
    h.opened.length = 0; const before = await outcome(() => legacy(resources)), oldOpened = [...h.opened];
    h.opened.length = 0; const after = await outcome(() => prepareAuthoring(h.asyncWorkspace, { authoringSourceId: authoring.id, resources }));
    assert.equal(after.code, expected, name); assert.deepEqual(after, before, name);
    assert.deepEqual(h.opened.filter(value => value !== authoring.sha256), oldOpened, name + ' byte verification order');
  }
});
