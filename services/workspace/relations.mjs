import { randomUUID } from "node:crypto";
import { canonical, check, clone, hash, identifier, json, version } from "./errors.mjs";
import { documentIdentity, extractBibliography, matchBibliography } from "./bibliography.mjs";
import { applySchemaMigrations } from "./schema-migrations.mjs";
import { mapRead, rowStatement } from './sql-commit.mjs';

const now = () => new Date().toISOString();
const parsed = (row) => row ? JSON.parse(row.payload) : undefined;
const clean = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const identityKey = (identity, fallback) => identity.identifiers?.doi ? "doi:" + identity.identifiers.doi
  : identity.identifiers?.arxiv ? "arxiv:" + identity.identifiers.arxiv
    : identity.title && identity.year && identity.authors?.length ? "citation:" + hash(canonical([clean(identity.title), identity.year, clean(Array.isArray(identity.authors) ? identity.authors.join("; ") : identity.authors)])) : fallback;
const sourceFingerprint = (entry) => hash(canonical({ raw: entry.raw, title: entry.title, authors: entry.authors, year: entry.year, identifiers: entry.identifiers }));
const content = (entry) => { const { version, createdAt, updatedAt, ...rest } = entry; return rest; };
const invalidate = "INSERT INTO relation_match_state(key,value) VALUES('dirty','1') ON CONFLICT(key) DO UPDATE SET value='1' WHERE value<>'1';";
const triggers = ["bibliographic_documents", "document_relations"].flatMap((table) => ["INSERT", "UPDATE", "DELETE"].map((event) =>
  `CREATE TRIGGER IF NOT EXISTS relation_match_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN ${invalidate} END;`)).join("\n");
export const relationSchemaMigrations = [{ version: 1, name: "Adopt scholarly work and citation identities", sql: `CREATE TABLE IF NOT EXISTS bibliographic_works (id TEXT PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bibliographic_documents (document_id TEXT PRIMARY KEY REFERENCES documents(id), revision INTEGER NOT NULL, work_id TEXT NOT NULL REFERENCES bibliographic_works(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS document_relations (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), source_key TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(document_id,source_key));
      CREATE INDEX IF NOT EXISTS document_relations_source ON document_relations(document_id);`
    }, { version: 2, name: "Persist relation matching invalidation across restarts and replication", sql: `
      CREATE TABLE IF NOT EXISTS relation_match_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO relation_match_state VALUES('dirty','1');
      ${triggers}
      CREATE TRIGGER IF NOT EXISTS relation_match_archive AFTER UPDATE OF archived_at ON documents WHEN NEW.archived_at IS NOT OLD.archived_at BEGIN ${invalidate} END;
      CREATE TRIGGER IF NOT EXISTS relation_match_document_delete AFTER DELETE ON documents BEGIN ${invalidate} END;
    ` }];

function workLookup(identity, fallback, lookup) {
  let key = identityKey(identity, fallback), previous = lookup(key);
  if (previous && ['doi', 'arxiv'].some(field => parsed(previous).identifiers?.[field] && identity.identifiers?.[field]
    && parsed(previous).identifiers[field] !== identity.identifiers[field])) {
    key += ':conflict:' + hash(canonical(identity.identifiers)); previous = lookup(key);
  }
  return { key, previous };
}
function workRow(identity, key) {
  const id = 'work-' + randomUUID();
  const facts = Object.fromEntries(['title', 'authors', 'year', 'identifiers'].filter(field => identity[field] !== undefined).map(field => [field, clone(identity[field])]));
  return { id, identity_key: key, payload: json({ id, ...facts, createdAt: now() }) };
}
function savedRelation(next, previous) {
  next = JSON.parse(json(next));
  if (previous && canonical(content(next)) === canonical(content(previous))) return previous;
  return { ...next, version: (previous?.version || 0) + 1, createdAt: previous?.createdAt || now(), updatedAt: now() };
}
function extractedRelation(document, entry, previous, work) {
  const sourceHash = sourceFingerprint(entry), changed = previous && previous.sourceHash !== sourceHash;
  const next = { ...previous, ...entry, id: previous?.id || 'relation-' + randomUUID(), documentId: document.id, sourceKey: entry.key,
    sourceRevision: document.revision, sourceHash, sourceMissing: false, decision: previous?.decision || 'automatic',
    targetWorkId: previous?.targetWorkId && !(changed && previous.decision === 'automatic') ? previous.targetWorkId : work(entry, 'reference:' + document.id + ':' + entry.key + ':' + sourceHash),
    status: changed && previous.decision !== 'automatic' ? 'stale' : previous?.status || 'unresolved' };
  if (next.decision === 'automatic') next.needsReview = false;
  if (changed && previous.decision !== 'automatic') next.needsReview = true;
  return next;
}

export function resolveRelation(entry, available, catalog) {
  const next = { ...entry, targetDocuments: [], candidates: [] };
  if (entry.sourceMissing || entry.needsReview) return { ...next, status: 'stale' };
  if (entry.decision === 'dismissed') return { ...next, status: 'dismissed' };
  if (entry.decision === 'manual') {
    const selected = catalog.find(item => item.documentId === entry.targetDocumentId) || catalog.find(item => item.workId === entry.targetWorkId);
    const equivalent = selected ? matchBibliography({ ...selected, documentId: entry.documentId, raw: selected.title }, available.filter(item => item.documentId !== entry.documentId)).matches : [];
    const targetIds = new Set(equivalent.map(item => item.documentId));
    if (selected && !selected.archivedAt) targetIds.add(selected.documentId);
    next.targetDocuments = available.filter(item => targetIds.has(item.documentId) && item.documentId !== entry.documentId).map(item => ({ id: item.documentId, title: item.title }));
    return { ...next, status: next.targetDocuments.length ? 'linked' : 'unresolved' };
  }
  const result = matchBibliography(entry, available.filter(item => item.documentId !== entry.documentId));
  next.status = result.status;
  next.candidates = (result.candidates || []).map(item => ({ ...item, id: item.documentId }));
  next.evidence = (result.matches || []).flatMap(item => item.evidence || []);
  if (result.status === 'linked') {
    next.targetDocuments = result.matches.map(item => ({ id: item.documentId, title: item.title }));
    const matched = available.find(item => item.documentId === result.matches[0]?.documentId);
    if (matched) next.targetWorkId = matched.workId;
  }
  return next;
}

export function prepareRelationCommand(command, previous, catalog) {
  check(previous, 'NOT_FOUND', '文献关联不存在。', 404);
  version(command.expectedVersion, '关联预期版本');
  check(previous.version === command.expectedVersion, 'REVISION_CONFLICT', '文献关联已更新，请重新读取。', 409, { currentVersion: previous.version });
  check(!previous.sourceMissing, 'ANCHOR_UNRESOLVED', '这条参考文献已从正文移除。', 409);
  const next = { ...previous, needsReview: false };
  if (command.kind === 'relation.link') {
    const targetId = identifier(command.targetDocumentId, '目标文档 ID'), target = catalog.find(item => item.documentId === targetId && !item.archivedAt);
    check(target && target.documentId !== previous.documentId, 'NOT_FOUND', '目标文献不存在、已归档或是当前文章。', 404);
    next.decision = 'manual'; next.targetDocumentId = target.documentId; next.targetWorkId = target.workId; next.evidence = [{ kind: 'manual', documentId: target.documentId }];
  } else if (command.kind === 'relation.dismiss') next.decision = 'dismissed';
  else { check(command.kind === 'relation.reset', 'VALIDATION_FAILED', '关联操作无效。'); next.decision = 'automatic'; }
  return { previous, next: JSON.parse(json(resolveRelation(next, catalog.filter(item => !item.archivedAt), catalog))) };
}

// Relations are workspace data. Bibliography display text and document revisions remain untouched.
export class DocumentRelations {
  constructor(db, { initialize = true } = {}) {
    this.db = db;
    if (initialize) applySchemaMigrations(db, 'relations', relationSchemaMigrations);
  }
  work(identity, fallback) {
    const { key, previous } = workLookup(identity, fallback, key => this.db.prepare('SELECT * FROM bibliographic_works WHERE identity_key=?').get(key));
    if (previous) return previous.id;
    const row = workRow(identity, key);
    this.db.prepare('INSERT INTO bibliographic_works VALUES(?,?,?)').run(row.id, row.identity_key, row.payload);
    return row.id;
  }
  rows(documentId) { return mapRead(this.db.prepare("SELECT payload FROM document_relations" + (documentId ? " WHERE document_id=?" : "") + " ORDER BY rowid").all(...(documentId ? [documentId] : [])), rows => rows.map(parsed)); }
  store(next, previous) {
    const saved = savedRelation(next, previous); if (saved === previous) return previous;
    this.db.prepare("INSERT INTO document_relations VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,payload=excluded.payload").run(saved.id, saved.documentId, saved.sourceKey, saved.version, json(saved));
    return saved;
  }
  documents() { return mapRead(this.db.prepare("SELECT b.payload,d.archived_at FROM bibliographic_documents b JOIN documents d ON d.id=b.document_id ORDER BY d.created_at,d.id").all(), rows => rows.map(row => ({ ...parsed(row), archivedAt: row.archived_at || null }))); }
  acceptRemoteProjection() {
    // A sync follower consumes the hub's journaled match result. Recomputing
    // between an inbound catalog transaction and its following match journal
    // would create fresh timestamps/versions and manufacture a local conflict.
    // Local user commands still dirty the catalog and match while offline.
    this.db.prepare("UPDATE relation_match_state SET value='0' WHERE key='dirty'").run();
    this.db.prepare("DELETE FROM relation_match_state WHERE key='catalog_hash'").run();
  }
  sync(documents, { rematch = true } = {}) {
    // Only re-extract documents whose content revision changed; matching is local and deterministic.
    for (const document of documents) {
      const previous = this.db.prepare("SELECT revision FROM bibliographic_documents WHERE document_id=?").get(document.id);
      if (previous?.revision === document.revision) continue;
      const identity = documentIdentity(document), workId = this.work(identity, "document:" + document.id);
      this.db.prepare("INSERT INTO bibliographic_documents VALUES(?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision,work_id=excluded.work_id,payload=excluded.payload").run(document.id, document.revision, workId, json({ ...identity, documentId: document.id, workId }));
      const existing = new Map(this.rows(document.id).map((entry) => [entry.sourceKey, entry]));
      for (const entry of extractBibliography(document)) {
        const previous = existing.get(entry.key);
        existing.delete(entry.key);
        const next = extractedRelation(document, entry, previous, (identity, fallback) => this.work(identity, fallback));
        this.store(next, previous);
      }
      for (const previous of existing.values()) this.store({ ...previous, sourceRevision: document.revision, sourceMissing: true, needsReview: true, status: "stale", targetDocuments: [], candidates: [] }, previous);
    }
    if (!rematch || this.db.prepare("SELECT value FROM relation_match_state WHERE key='dirty'").get()?.value === "0") return;
    const catalog = this.documents(), available = catalog.filter((entry) => !entry.archivedAt);
    for (const previous of this.rows()) this.store(this.resolve(previous, available, catalog), previous);
    this.db.prepare("INSERT INTO relation_match_state VALUES('catalog_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hash(canonical(catalog)));
    this.db.prepare("UPDATE relation_match_state SET value='0' WHERE key='dirty'").run();
  }
  resolve(entry, available, catalog) {
    if (available && catalog) return resolveRelation(entry, available, catalog);
    return mapRead(this.documents(), identities => resolveRelation(entry, available || identities.filter(item => !item.archivedAt), catalog || identities));
  }
  get(id, documentId) {
    return mapRead(this.db.prepare("SELECT payload FROM document_relations WHERE id=? AND document_id=?").get(identifier(id, "关联 ID"), identifier(documentId, "文档 ID")), row => {
      const relation = parsed(row); check(relation, "NOT_FOUND", "文献关联不存在。", 404); return relation;
    });
  }
  query(documentId, revision) {
    const values = [this.rows(documentId), this.documents(), this.rows()];
    const project = ([outgoing, catalog, relations]) => {
      const incoming = [], titles = new Map(catalog.filter(entry => !entry.archivedAt).map(entry => [entry.documentId, entry.title]));
      for (const relation of relations) if (relation.status === 'linked' && titles.has(relation.documentId) && relation.targetDocuments?.some(target => target.id === documentId))
        incoming.push({ id: relation.id, version: relation.version, documentId: relation.documentId, title: titles.get(relation.documentId), source: relation.source, label: relation.label, occurrences: relation.occurrences || [] });
      return { documentId, revision, outgoing, incoming };
    };
    return values.some(value => value?.then) ? Promise.all(values).then(project) : project(values);
  }
  prepare(command) {
    return mapRead(this.get(command.relationId, command.documentId), previous => mapRead(this.documents(), catalog => prepareRelationCommand(command, previous, catalog)));
  }
  apply(command) { const { previous, next } = this.prepare(command); return this.store(next, previous); }
}

/** Prepare the concrete relation rows against an observed catalog. The read set
 * supplies final transactional guards (including new catalog members); no
 * database mutation or emulated SQL transaction occurs during this calculation.
 * Local replication keeps its synchronous methods above, sharing the exact
 * identity, extraction, resolution and stored-version functions with this path. */
export async function prepareRelationChanges({ reads, documents = [], documentRows = [], command, dryRun = false, rematch = true }) {
  if (command && !documents.length && !documentRows.length) {
    const row = await reads.get('SELECT payload FROM document_relations WHERE id=? AND document_id=?', identifier(command.relationId, '关联 ID'), identifier(command.documentId, '文档 ID'));
    const catalog = command.kind === 'relation.dismiss' ? [] : (await reads.all('SELECT b.payload,d.archived_at FROM bibliographic_documents b JOIN documents d ON d.id=b.document_id ORDER BY d.created_at,d.id'))
      .map(row => ({ ...parsed(row), archivedAt: row.archived_at || null }));
    const { previous, next } = prepareRelationCommand(command, parsed(row), catalog);
    if (dryRun) return { changes: [], statements: [], previous, next };
    const relation = savedRelation(next, previous);
    if (relation === previous) return { changes: [], statements: [], previous, next, relation };
    const value = { id: relation.id, document_id: relation.documentId, source_key: relation.sourceKey, version: relation.version, payload: json(relation) };
    return { changes: [{ entity: 'document_relations', key: canonical([relation.id]), value }],
      statements: [], previous, next, relation };
  }
  const dirty = await reads.get("SELECT value FROM relation_match_state WHERE key='dirty'");
  for (const row of documentRows) check(row && typeof row.id === 'string', 'VALIDATION_FAILED', '关联准备需要准确的文档状态。');
  if (!command && !documents.length && dirty?.value === '0') {
    const previous = await Promise.all(documentRows.map(row => reads.get('SELECT id,archived_at FROM documents WHERE id=?', row.id)));
    if (documentRows.every((row, index) => previous[index] && previous[index].archived_at === row.archived_at)) return { changes: [], statements: [] };
  }
  const [workRows, bibliographyRows, relationRows, currentDocuments] = await Promise.all([
    reads.all('SELECT * FROM bibliographic_works ORDER BY rowid'),
    reads.all('SELECT * FROM bibliographic_documents ORDER BY rowid'),
    reads.all('SELECT * FROM document_relations ORDER BY rowid'),
    reads.all('SELECT id,archived_at,created_at FROM documents ORDER BY created_at,id'),
  ]);
  const works = new Map(workRows.map(row => [row.identity_key, row]));
  const bibliography = new Map(bibliographyRows.map(row => [row.document_id, row]));
  const relations = new Map(relationRows.map(row => [row.id, parsed(row)]));
  const catalogRows = new Map(currentDocuments.map(row => [row.id, row]));
  let catalogChanged = false;
  for (const row of documentRows) {
    const previous = catalogRows.get(row.id);
    if (!previous || previous.archived_at !== row.archived_at) catalogChanged = true;
    catalogRows.set(row.id, { ...previous, ...row });
  }
  const changed = new Map(), statements = [];
  const put = (entity, keys, value) => changed.set(entity + '\n' + canonical(keys), { entity, key: canonical(keys), value });
  const work = (identity, fallback) => {
    const { key, previous } = workLookup(identity, fallback, key => works.get(key));
    if (previous) return previous.id;
    const row = workRow(identity, key); works.set(key, row); put('bibliographic_works', [row.id], row); return row.id;
  };
  const store = (next, previous) => {
    const saved = savedRelation(next, previous);
    if (saved === previous) return previous;
    relations.set(saved.id, saved);
    put('document_relations', [saved.id], { id: saved.id, document_id: saved.documentId, source_key: saved.sourceKey, version: saved.version, payload: json(saved) });
    return saved;
  };
  for (const document of documents) {
    if (bibliography.get(document.id)?.revision === document.revision) continue;
    const identity = documentIdentity(document), workId = work(identity, 'document:' + document.id);
    const row = { document_id: document.id, revision: document.revision, work_id: workId, payload: json({ ...identity, documentId: document.id, workId }) };
    bibliography.set(document.id, row); put('bibliographic_documents', [document.id], row); catalogChanged = true;
    const existing = new Map([...relations.values()].filter(relation => relation.documentId === document.id).map(relation => [relation.sourceKey, relation]));
    for (const entry of extractBibliography(document)) {
      const previous = existing.get(entry.key); existing.delete(entry.key);
      store(extractedRelation(document, entry, previous, work), previous);
    }
    for (const previous of existing.values()) store({ ...previous, sourceRevision: document.revision, sourceMissing: true, needsReview: true,
      status: 'stale', targetDocuments: [], candidates: [] }, previous);
  }
  const orderedDocuments = [...catalogRows.values()].sort((a, b) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const catalog = orderedDocuments.filter(row => bibliography.has(row.id)).map(row => ({ ...parsed(bibliography.get(row.id)), archivedAt: row.archived_at || null }));
  let previous, next, relation;
  // Explicit link/dismiss/reset never silently rematches unrelated relations.
  if (command) {
    identifier(command.relationId, '关联 ID'); identifier(command.documentId, '文档 ID');
    const found = relations.get(command.relationId);
    ({ previous, next } = prepareRelationCommand(command, found?.documentId === command.documentId ? found : undefined, catalog));
    if (dryRun) return { changes: [], statements: [], previous, next };
    relation = store(next, previous);
  } else if (rematch && (catalogChanged || dirty?.value !== '0' || changed.size)) {
    const available = catalog.filter(entry => !entry.archivedAt);
    for (const previous of [...relations.values()]) store(resolveRelation(previous, available, catalog), previous);
    statements.push(rowStatement('relation_match_state', ['key'], { key: 'catalog_hash', value: hash(canonical(catalog)) }));
    statements.push(rowStatement('relation_match_state', ['key'], { key: 'dirty', value: '0' }));
  } else if (catalogChanged || changed.size) statements.push(rowStatement('relation_match_state', ['key'], { key: 'dirty', value: '1' }));
  const changes = [...changed.values()];
  // New works precede their document/relation references; existing rowids remain
  // stable because the physical write is an UPSERT, never DELETE + INSERT.
  const order = ['bibliographic_works', 'bibliographic_documents', 'document_relations'];
  changes.sort((a, b) => order.indexOf(a.entity) - order.indexOf(b.entity));
  return { changes, statements,
    ...(command ? { previous, next, relation } : {}) };
}
