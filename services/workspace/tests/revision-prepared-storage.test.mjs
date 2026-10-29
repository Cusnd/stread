import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RevisionStorage, revisionSchemaMigrations } from "../revision-storage.mjs";
import { workspaceSchemaMigrations } from "../workspace-schema.mjs";
import { objectBytes } from "../immutable-objects.mjs";
import { compileInput, validateDocument } from "../documents.mjs";
import { canonical, hash } from "../errors.mjs";
import { prepareAuthoring } from "../authoring-core.mjs";
import { createAuthoringEditPackage, revisionReferenceGuard } from "../authoring-edit-package.mjs";
import { freezeAuthoringPreview, preparePreviewPublication } from "../authoring-preview.mjs";
import { previewQualityReport } from "../authoring-quality.mjs";
import { sqliteAccess, createReadSet, businessAssertionSchema, rowStatement, assertSql } from "../sql-commit.mjs";
import { createProtocolReviewEvidence } from "./authoring-protocol-evidence-fixture.mjs";

async function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.transaction = operation => { db.exec("BEGIN IMMEDIATE"); try { const result = operation(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  t.after(() => db.close());
  for (const migration of [...workspaceSchemaMigrations, ...revisionSchemaMigrations]) db.exec(migration.sql);
  db.exec(`CREATE TABLE document_relations(id TEXT PRIMARY KEY,document_id TEXT,version INTEGER,payload TEXT); ${businessAssertionSchema}`);
  const objects = new Map(), files = new Map(), sql = sqliteAccess(db);
  const resources = {
    async putObject(value) { const { bytes, ref } = objectBytes(value); objects.set(ref.sha256, bytes); return ref; },
    async readObject(ref) { return JSON.parse(objects.get(ref.sha256)); },
    async open(digest) { return [files.get(digest)]; },
    async read(digest) { return files.get(digest); },
  };
  const storage = new RevisionStorage(db, resources), asyncStorage = new RevisionStorage(null, resources, { sql: { query: async (...args) => { await Promise.resolve(); return sql.query(...args); } } });
  const authoring = { format: "reader-authoring-1", key: "async-revision", meta: { title: "Prepared revision", language: "en" }, blocks: [{ key: "paragraph", type: "para", text: "中文 😀 ".repeat(5000) }] };
  const compiled = await compileInput(authoring), validated = await validateDocument(compiled.document, { resourceMap: {} });
  db.prepare("INSERT INTO documents VALUES(?,1,1,?,NULL,'fixed','fixed')").run(validated.document.id, JSON.stringify({ title: authoring.meta.title }));
  const options = { authoring: compiled.authoring, identity: compiled.identity, actor: "fixture" };
  await storage.prepare(validated, {}, options);
  const prepared = storage.preparedChanges(validated, {}, options);
  const commit = (value = prepared, extra = []) => sql.batch([...extra, ...value.changes.map(change => rowStatement(change.entity, ["document_id", "revision"], change.value)), ...value.statements]);
  const upload = (value, id, mediaType = "application/json") => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), digest = hash(bytes); files.set(digest, bytes); return { id, filename: id + ".json", mediaType, sha256: digest, size: bytes.length }; };
  return { db, sql, storage, asyncStorage, resources, validated, compiled, prepared, options, commit, upload };
}

test("prepared immutable revision and indexes commit atomically and read identically through true async SQL", async t => {
  const h = await fixture(t), row = h.prepared.changes[0].value;
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM revisions").get().n, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM revision_indexes").get().n, 0);
  assert.throws(() => h.commit(h.prepared, assertSql("0")), /CHECK constraint/);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM revisions").get().n, 0);
  h.commit();
  assert.deepEqual(await h.asyncStorage.index(row), h.storage.index(row));
  assert.deepEqual(await h.asyncStorage.nav(row), h.storage.nav(row));
  assert.deepEqual(await h.asyncStorage.load(row), await h.storage.load(row));
  assert.ok(h.db.prepare("SELECT COUNT(*) n FROM revision_indexes WHERE kind='text'").get().n > 1);
  const pieces = h.db.prepare("SELECT payload FROM revision_indexes WHERE kind='text' ORDER BY part").all();
  assert.ok(pieces.every(piece => !/[\uD800-\uDBFF]$/.test(piece.payload)), "chunking does not split a surrogate pair");
  h.db.prepare("DELETE FROM revision_indexes WHERE kind='text' AND part=1").run();
  await assert.rejects(h.asyncStorage.index(row), error => error.code === "OBJECT_INDEX_CORRUPT");
  h.validated.document.meta.title = "Changed after object publication";
  assert.throws(() => h.storage.preparedChanges(h.validated, {}, h.options), error => error.code === "OBJECT_PREPARATION_CHANGED");
});

test("revision reference preparation observes new affected dependencies and guards the final batch", async t => {
  const h = await fixture(t); h.commit();
  const blockId = h.validated.document.blocks[0].id, id = h.validated.document.id;
  const reads = createReadSet({ query: async (...args) => h.sql.query(...args) });
  const first = await revisionReferenceGuard(reads, id, { affectedBlocks: [blockId] }, h.validated.index);
  assert.deepEqual(first.references, []);
  const note = { id: "note", source: { documentId: id, revision: 1, blockId, field: "text", variant: "source", quote: "中文" } };
  h.db.prepare("INSERT INTO insights VALUES(?,?,1,?,NULL)").run(note.id, id, JSON.stringify(note));
  assert.throws(() => h.sql.batch(reads.guards), /CHECK constraint/);
  const next = await revisionReferenceGuard({ all: async (statement, ...values) => h.sql.query(statement, values) }, id, { affectedBlocks: [blockId] }, h.validated.index);
  assert.notEqual(first.hash, next.hash);
  assert.equal(next.references[0].references[0].historicalReferencePreserved, true);
  assert.equal(next.references[0].references[0].candidateReferenceStatus, "resolved");
});

test("authoring revision preparation and frozen publication await file, row, revision and reference ports", async t => {
  const h = await fixture(t); h.commit();
  const row = h.prepared.changes[0].value, baseline = await h.storage.load(row), pkg = await createAuthoringEditPackage(baseline);
  const input = structuredClone(pkg.authoring); input.blocks[0].text = "Explicit revised text.";
  const file = h.upload(input, "authoring"), resource = h.upload("Resource text", "resource", "text/plain"), evidence = h.upload("Reviewed exact content", "evidence", "text/plain");
  const uploadedFiles = { authoring: file, resource, evidence }, seen = [], ports = {
    async file(id) { seen.push("file:" + id); await Promise.resolve(); return uploadedFiles[id]; },
    async files(ids) { seen.push("files:" + ids.join(",")); await Promise.resolve(); seen.push("files:resolved"); return ids.map(id => uploadedFiles[id] || null); },
    async row(id) { seen.push("row:" + id); await Promise.resolve(); return { current_revision: 1 }; },
    async revisionRow(id, revision) { seen.push("revision:" + revision); await Promise.resolve(); return row; },
    storage: h.asyncStorage, resources: h.resources,
    sql: { query: async (...args) => { seen.push("references"); return h.sql.query(...args); } },
  };
  const prepared = await prepareAuthoring(ports, { authoringSourceId: file.id, resources: { "source.txt": resource.id }, target: { documentId: baseline.document.id, baseRevision: 1, baseHash: hash(canonical(baseline.document)) } });
  assert.equal(prepared.validated.document.revision, 2);
  assert.equal(prepared.validated.document.blocks[0].id, baseline.document.blocks[0].id);
  assert.equal(prepared.resourceMap["source.txt"].sha256, resource.sha256);
  assert.equal(prepared.revisionTarget.referenceGuardHash.length, 64);
  const frozen = freezeAuthoringPreview(prepared);
  const { review } = await createProtocolReviewEvidence({ preview: frozen, evidenceSourceIds: [evidence.id],
    readReport: async () => ({ quality: previewQualityReport(frozen) }),
    upload: async (bytes, filename, mediaType) => {
      const uploaded = h.upload(bytes, filename, mediaType); uploadedFiles[uploaded.id] = uploaded;
      return { sourceId: uploaded.id, ...uploaded };
    } });
  const publication = await preparePreviewPublication(ports, frozen, { expectedHash: frozen.hash, review });
  assert.equal(publication.validated.report.previewSubmission.evidence[0].sha256, evidence.sha256);
  assert.ok(seen.includes("file:evidence") && seen.includes("files:resource") && seen.includes("files:resolved") && seen.includes("revision:1") && seen.includes("references"));
});
