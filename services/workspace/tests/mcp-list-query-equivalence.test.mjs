import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createWorkspace, localActor } from '../service.mjs';
import { createWorkspaceMcp } from '../mcp.mjs';
import { canonical, hash, normalized } from '../errors.mjs';

const stamp = '2026-01-01T00:00:00.000Z';
const id = (kind, number) => `${kind}-${String(number).padStart(4, '0')}`;
const binary = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reader-mcp-list-equivalence-'));
  const workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false, refreshRelations: false });
  const documents = [], collections = [], terms = [], sources = [], requests = [], proposals = [];
  const specialTerms = ['Istanbul', 'İzmir', 'ıhlamur', 'Kelvin', 'CAFÉ A', 'cafe\u0301 B', '中文术语', '中文', 'Ｉ FULL'];
  const specialFiles = ['I.txt', 'İ.txt', 'ı.txt', '中文.txt', '100%.txt', '100_.txt', '100x.txt', 'a\\b.txt', 'CAFÉ.txt', 'café.txt'];
  workspace.db.transaction(() => {
    const doc = workspace.db.prepare('INSERT INTO documents VALUES(?,1,1,?,?,?,?)');
    const collection = workspace.db.prepare('INSERT INTO collections VALUES(?,?,?,1)');
    const term = workspace.db.prepare('INSERT INTO glossary VALUES(?,1,?,?,?)');
    const file = workspace.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?)');
    const request = workspace.db.prepare('INSERT INTO change_requests VALUES(?,?,1,?,?)');
    const proposal = workspace.db.prepare('INSERT INTO proposals VALUES(?,?,?,?)');
    for (let n = 0; n < 1000; n++) {
      const archivedAt = n % 5 === 0 ? stamp : null;
      const metadata = { title: n === 1 ? '😀'.repeat(120) : `Document ${n}`, kind: '文档', summary: '正文摘要'.repeat(600),
        tags: n === 0 ? ['字'] : n % 2 ? ['中文', 'Case'] : ['case'], collectionIds: n % 3 ? ['collection-0001'] : ['collection-0000'], status: ['unread', 'reading', 'done'][n % 3] };
      const saved = { id: id('doc', n), archivedAt, metadata, createdAt: stamp };
      documents.push(saved); doc.run(saved.id, JSON.stringify(metadata), archivedAt, stamp, stamp);
      const group = { id: id('collection', n), label: n < 6 ? ['z', 'A', 'a', '中文', 'İ', 'I'][n] : `Group ${String(n).padStart(4, '0')}`,
        parentId: n > 10 && n % 2 ? 'collection-0000' : null, version: 1 };
      collections.push(group); collection.run(group.id, group.label, group.parentId);
      const deletedAt = n >= 10 && n % 7 === 0 ? stamp : null;
      const entry = { id: id('term', n), revision: 1, term: specialTerms[n] || `z-${String(n).padStart(4, '0')}`,
        aliases: [], definition: '释义'.repeat(500), documentId: id('doc', n % 3), origin: 'user', createdAt: stamp, updatedAt: stamp, deletedAt };
      terms.push(entry); term.run(entry.id, normalized(entry.term), JSON.stringify(entry), deletedAt);
      const source = { sourceId: id('source', n), filename: specialFiles[n] || `source-${n}.txt`, createdAt: stamp };
      sources.push(source); file.run(source.sourceId, source.filename, 'text/plain', hash(source.sourceId), n, stamp);
      const change = { id: id('request', n), documentId: id('doc', n % 3), version: 1, reference: `#R${String(n + 1).padStart(5, '0')}`,
        category: 'correction', status: ['pending', 'cancelled', 'completed'][n % 3], body: '修改正文'.repeat(500), revision: 1, createdAt: stamp };
      requests.push(change); request.run(change.id, change.documentId, change.reference, JSON.stringify(change));
      const proposed = { id: id('proposal', n), documentId: id('doc', n % 3), status: n % 2 ? 'pending' : 'accepted',
        kind: 'revise', expectedRevision: 1, payloadHash: hash('proposal-' + n), createdAt: stamp,
        changes: Array.from({ length: 5 }, (_, j) => ({ kind: 'replace_range', blockId: id('block', j), field: 'text',
          before: '前'.repeat(400), after: '后'.repeat(400), start: 0, end: 1 })) };
      proposals.push(proposed); proposal.run(proposed.id, proposed.documentId, proposed.status, JSON.stringify(proposed));
    }
    const index = ['I', 'İ', 'ı', '中文', 'café', 'cafe\u0301', 'ſ', 'K', 'k'].map((text, n) => ({ blockId: id('unicode', n), variant: 'source', field: 'text', text }));
    const document = { format: 'continous-reader', schema: 2, id: 'doc-0000', revision: 1,
      meta: { title: 'Unicode search fixture', language: 'en' }, blocks: index.map(row => ({ id: row.blockId, type: 'para', text: row.text })) };
    workspace.db.prepare('INSERT INTO revisions VALUES(?,1,?,?,?,?,?,NULL,NULL,0,?,?)').run('doc-0000', JSON.stringify(document), JSON.stringify(index), '{}', '{}', '{}', stamp, 'local');
    workspace.db.prepare("UPDATE metadata SET value='73' WHERE key='revision'").run();
    workspace.db.prepare("UPDATE metadata SET value='19' WHERE key='glossaryRevision'").run();
  });
  const queries = [], sql = workspace.sql, originalQuery = sql.query.bind(sql), originalBatch = sql.batch.bind(sql); let callId = 0;
  // The async facade also catches accidentally unawaited count/data reads. It
  // records actual returned rows, not an EXPLAIN estimate or a mocked row limit.
  sql.query = async (statement, values = []) => {
    const rows = originalQuery(statement, values); queries.push({ sql: statement, rows, callId: ++callId }); return rows;
  };
  sql.batch = async statements => {
    const results = originalBatch(statements), batchId = ++callId;
    statements.forEach((statement, at) => queries.push({ sql: statement.sql, rows: results[at].rows, callId: batchId }));
    return results;
  };
  const server = createWorkspaceMcp(workspace, localActor, { baseUrl: 'https://reader.test' });
  const client = new Client({ name: 'list-equivalence-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  t.after(async () => {
    await client.close(); await server.close(); await workspace.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'reader-mcp-list-equivalence-'));
    await rm(directory, { recursive: true, force: true });
  });
  const raw = (name, input = {}) => client.callTool({ name, arguments: input });
  const call = async (name, input = {}) => {
    queries.length = 0;
    const response = await raw(name, input); assert.ok(!response.isError, `${name}: ${JSON.stringify(response)}`);
    // In-memory transport keeps optional undefined properties that JSON-RPC
    // serialization omits (for example an article with no original source).
    assert.deepEqual(JSON.parse(response.content[0].text), JSON.parse(JSON.stringify(response.structuredContent)));
    return response.structuredContent;
  };
  return { workspace, call, raw, queries, documents, collections, terms, sources, requests, proposals };
}

function ordinaryPage(value, key, expected, offset, limit) {
  const selected = expected.slice(offset, offset + limit);
  assert.deepEqual(value[key].map(item => item.id || item.sourceId), selected.map(item => item.id || item.sourceId));
  assert.deepEqual(value.page, { offset, count: selected.length, total: expected.length,
    nextOffset: offset + selected.length < expected.length ? offset + selected.length : null });
}

test('SQL-backed MCP lists preserve the public filtered ranges, Unicode matching and response budgets', async t => {
  const h = await fixture(t);
  await t.test('document filters run before offset and preserve exact tag case and archive behavior', async () => {
    for (const input of [{ offset: 3, limit: 7 }, { collection_id: 'collection-0001', offset: 4, limit: 9 },
      { status: 'reading', tag: '中文', offset: 11, limit: 6 }, { tag: 'Case', offset: 5, limit: 8 },
      { tag: 'case', include_archived: true, offset: 3, limit: 9 }, { tag: '', offset: 1, limit: 2 },
      { include_archived: true, offset: 998, limit: 9 }, { offset: 2000, limit: 2 }]) {
      const expected = h.documents.filter(row => (input.include_archived || !row.archivedAt)
        && (!input.collection_id || row.metadata.collectionIds.includes(input.collection_id))
        && (!input.status || row.metadata.status === input.status)
        && (input.tag === undefined || row.metadata.tags.includes(input.tag)));
      ordinaryPage(await h.call('query_documents', { action: 'list', ...input }), 'documents', expected, input.offset, input.limit);
    }
    const clipped = await h.call('query_documents', { action: 'list', offset: 0, limit: 1 });
    assert.equal(clipped.documents[0].title, '😀'.repeat(80)); assert.equal(clipped.documents[0].titleTruncated, true);
    const explicitArchived = await h.call('query_documents', { action: 'list', document_id: 'doc-0000' });
    assert.equal(explicitArchived.documents[0].id, 'doc-0000'); assert.equal(explicitArchived.documents[0].blockCount, 9);
  });
  await t.test('collection parent filters and binary label order retain the exact continuation token shape', async () => {
    const ordered = [...h.collections].sort((a, b) => binary(a.label, b.label) || binary(a.id, b.id));
    for (const input of [{ offset: 2, limit: 5 }, { parent_id: null, offset: 3, limit: 6 },
      { parent_id: 'collection-0000', offset: 17, limit: 4 }, { parent_id: 'missing', offset: 9, limit: 4 }]) {
      const expected = ordered.filter(row => input.parent_id === undefined || row.parentId === input.parent_id);
      ordinaryPage(await h.call('list_collections', input), 'collections', expected, input.offset, input.limit);
    }
    const first = await h.call('list_collections', { parent_id: null, limit: 3 });
    const scope = hash(canonical({ tool: 'list_collections', actor: localActor, filters: { parent_id: null, limit: 3 } }));
    const version = hash(canonical([...h.collections].sort((a, b) => binary(a.id, b.id)).map(row => ({ id: row.id, label: row.label, parent_id: row.parentId, version: 1 }))));
    assert.equal(first.consistency.snapshot, version);
    assert.equal(first.next.continuation, Buffer.from(JSON.stringify({ v: 1, scope, version, offset: 3 })).toString('base64url'));
    const continued = await h.call('list_collections', first.next);
    assert.equal(continued.consistency.mode, 'continued');
    ordinaryPage(continued, 'collections', ordered.filter(row => row.parentId === null), 3, 3);
    const wrong = await h.raw('list_collections', { ...first.next, parent_id: 'collection-0000' });
    assert.equal(wrong.structuredContent.code, 'CONTINUATION_SCOPE_MISMATCH');
  });
  await t.test('glossary list filters precede pagination and search retains NFKC and JavaScript Unicode case semantics', async () => {
    for (const input of [{ offset: 5, limit: 9 }, { document_id: 'doc-0001', offset: 3, limit: 6 },
      { include_deleted: true, document_id: 'doc-0002', offset: 7, limit: 3 }]) {
      const expected = [...h.terms].reverse().filter(row => (input.include_deleted || !row.deletedAt) && (!input.document_id || row.documentId === input.document_id));
      ordinaryPage(await h.call('query_glossary', { action: 'list', ...input }), 'entries', expected, input.offset, input.limit);
    }
    for (const [query, numbers] of [['i', [8, 3, 1, 0]], ['ı', [2]], ['kelvin', [3]], ['café', [5, 4]], ['中文', [7, 6]]]) {
      const result = await h.call('query_glossary', { action: 'search', query, limit: 20 });
      assert.deepEqual(result.entries.map(row => row.id), numbers.map(n => id('term', n)), query);
      assert.equal(result.page.total, numbers.length);
      const offset = await h.call('query_glossary', { action: 'search', query, offset: 1, limit: 1 });
      assert.deepEqual(offset.entries.map(row => row.id), numbers.slice(1, 2).map(n => id('term', n)), query + ' offset');
    }
  });
  await t.test('document source search keeps RegExp iu behavior rather than SQLite lower behavior', async () => {
    // RegExp /iu intentionally differs from glossary NFKC matching: dotless I,
    // dotted I, composed accents, long s and Kelvin sign retain these results.
    for (const [query, blocks] of [['i', [0]], ['İ', [1]], ['ı', [2]], ['中文', [3]], ['café', [4]], ['s', [6]], ['k', [7, 8]]]) {
      const value = await h.call('query_documents', { action: 'search', document_id: 'doc-0000', query, limit: 20 });
      assert.deepEqual(value.matches.map(row => row.address.blockId), blocks.map(n => id('unicode', n)), query);
      assert.equal(value.page.total, blocks.length);
    }
  });
  await t.test('uploaded filenames preserve literal wildcard escaping and the existing SQLite LIKE case behavior', async () => {
    for (const [input, numbers] of [[{ query: 'I.txt' }, [0]], [{ query: 'İ.txt' }, [1]], [{ query: 'ı.txt' }, [2]],
      [{ query: '中文' }, [3]], [{ query: '%' }, [4]], [{ query: '_' }, [5]], [{ query: '\\' }, [7]],
      [{ filename: 'CAFÉ.txt' }, [8]], [{ filename: 'café.txt' }, [9]]]) {
      const value = await h.call('query_uploaded_sources', { action: 'list', ...input, limit: 20 });
      assert.deepEqual(value.sources.map(row => row.sourceId), numbers.map(n => id('source', n)), JSON.stringify(input));
      assert.equal(value.page.total, numbers.length);
    }
    const expected = [...h.sources].reverse();
    ordinaryPage(await h.call('query_uploaded_sources', { action: 'list', offset: 21, limit: 8 }), 'sources', expected, 21, 8);
  });
  await t.test('change-request filters and proposal character truncation retain total and resume without skipping', async () => {
    const changes = [...h.requests].reverse().filter(row => row.documentId === 'doc-0001' && row.status === 'cancelled');
    ordinaryPage(await h.call('list_change_requests', { document_id: 'doc-0001', status: 'cancelled', offset: 7, limit: 6 }), 'changeRequests', changes, 7, 6);
    const expected = [...h.proposals].reverse().filter(row => row.documentId === 'doc-0002');
    const first = await h.call('list_revision_proposals', { document_id: 'doc-0002', offset: 5, limit: 20 });
    assert.ok(first.page.count > 0 && first.page.count < 20, 'the 22k character budget cuts a full SQL page');
    assert.equal(first.page.total, expected.length); assert.equal(first.page.nextOffset, 5 + first.page.count);
    assert.deepEqual(first.proposals.map(row => row.id), expected.slice(5, first.page.nextOffset).map(row => row.id));
    const chars = first.proposals.reduce((sum, row) => sum + JSON.stringify(row).length, 0);
    assert.ok(chars <= 22000);
    const second = await h.call('list_revision_proposals', first.next);
    assert.equal(second.proposals[0].id, expected[first.page.nextOffset].id);
    assert.ok(chars + JSON.stringify(second.proposals[0]).length > 22000, 'the next projected item would exceed the original page budget');
    assert.equal(second.page.total, first.page.total); assert.equal(second.consistency.mode, 'continued');
  });
  await t.test('a 1000-row catalog only returns a bounded page of business payloads from SQL', async () => {
    const cases = [
      ['query_documents', { action: 'list', offset: 400, limit: 7 }, row => typeof row.metadata === 'string'],
      ['list_collections', { offset: 400, limit: 7 }, row => Object.hasOwn(row, 'parentId')],
      ['query_glossary', { action: 'list', offset: 400, limit: 7 }, row => typeof row.payload === 'string'],
      ['query_uploaded_sources', { action: 'list', offset: 400, limit: 7 }, row => Object.hasOwn(row, 'mediaType')],
      ['list_change_requests', { offset: 400, limit: 7 }, row => typeof row.payload === 'string'],
      ['list_revision_proposals', { offset: 400, limit: 7 }, row => typeof row.payload === 'string'],
    ];
    for (const [name, input, isBusinessPayload] of cases) {
      await h.call(name, input);
      const dataReads = h.queries.filter(query => query.rows.some(isBusinessPayload));
      assert.ok(dataReads.length, name + ' must exercise a real payload read');
      for (const query of dataReads) assert.ok(query.rows.length <= input.limit,
        `${name} materialized ${query.rows.length} business rows for a ${input.limit}-row page: ${query.sql}`);
    }
    // Existing collection/upload continuation hashes read compact whole-list
    // identity metadata. Those guards remain separately visible in the trace;
    // this assertion concerns business page payloads, not a constant-I/O claim.
  });
  await t.test('a 500-entry plan batches its version read while preserving old missing-row and archived-row signatures', async () => {
    const plan = Array.from({ length: 500 }, (_, n) => n < 490 ? id('doc', n) : id('missing', n));
    const reading = new Map();
    h.workspace.db.transaction(() => {
      for (let n = 0; n < 490; n += 7) {
        const payload = JSON.stringify({ revision: 1, blockId: id('position', n), offsetRatio: n / 500, mode: 'source' });
        reading.set(id('doc', n), payload);
        h.workspace.db.prepare('INSERT INTO reading VALUES(?,?)').run(id('doc', n), payload);
      }
      h.workspace.db.prepare("UPDATE metadata SET value=? WHERE key='plan'").run(JSON.stringify(plan));
      h.workspace.db.prepare("UPDATE metadata SET value='9' WHERE key='planVersion'").run();
      h.workspace.db.prepare("UPDATE metadata SET value='\"doc-0450\"' WHERE key='currentId'").run();
    });
    const expected = { planVersion: 9, ids: plan, currentId: 'doc-0450', documents: plan.map((documentId, n) => [
      n < 490 ? { id: documentId, version: 1, current_revision: 1, archived_at: h.documents[n].archivedAt } : undefined,
      reading.has(documentId) ? { payload: reading.get(documentId) } : undefined,
    ]) };
    h.queries.length = 0;
    const value = await h.workspace.readListVersionState('get_reading_plan');
    assert.deepEqual(value, expected);
    assert.equal(hash(canonical(value)), hash(canonical(expected)), 'the old continuation version bytes remain identical');
    const fullCalls = new Set(h.queries.map(row => row.callId)).size;
    assert.equal(fullCalls, 1, '500 plan IDs must use one SQL batch API call');
    h.workspace.db.prepare("UPDATE metadata SET value=? WHERE key='plan'").run(JSON.stringify(plan.slice(0, 1)));
    h.queries.length = 0;
    await h.workspace.readListVersionState('get_reading_plan');
    assert.equal(new Set(h.queries.map(row => row.callId)).size, fullCalls, 'SQL API count does not grow with plan membership');
  });
});
