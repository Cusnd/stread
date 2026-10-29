import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { applySchemaMigrations, schemaMigrationPlan } from "../schema-migrations.mjs";
import { canonical, hash } from "../errors.mjs";
import { objectReference } from "../immutable-objects.mjs";
import { preparePreviewPublication, verifyPreviewSnapshot } from "../authoring-preview.mjs";
import { previewQualityReport } from "../authoring-quality.mjs";
import { createProtocolReviewEvidence } from "./authoring-protocol-evidence-fixture.mjs";

async function harness(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-storage-lifecycle-"));
  let workspace = await createWorkspace({ dataDir, bootstrap: false, glossaryPath: false });
  t.after(async () => { await workspace.close(); assert.equal(dirname(resolve(dataDir)), resolve(tmpdir())); assert.ok(basename(dataDir).startsWith("reader-storage-lifecycle-")); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, get w() { return workspace; }, restart: async (options = {}) => {
    await workspace.close(); workspace = await createWorkspace({ dataDir, bootstrap: false, glossaryPath: false, ...options }); return workspace;
  } };
}
async function uploadInput(w, title = "Storage lifecycle") {
  const input = { format: "reader-authoring-1", key: "storage-" + randomUUID(), meta: { title, language: "en" }, blocks: [
    { key: "heading", type: "heading", level: 1, text: "Heading" }, { key: "text", type: "para", text: "Alpha beta gamma." },
  ] };
  return w.upload(localActor, Buffer.from(JSON.stringify(input)), { filename: "input.json" });
}
async function draft(w, title) {
  const file = await uploadInput(w, title);
  return (await w.createAuthoringPreview(localActor, { authoringSourceId: file.sourceId, requestId: randomUUID() })).preview;
}
async function publish(w, title) {
  // Seed only business state for migration/projection tests; no independent
  // Agent execution or Reader acceptance is asserted by this fixture.
  const file = await uploadInput(w, title);
  return w.publishAuthoring(localActor, { authoringSourceId: file.sourceId, requestId: randomUUID() });
}

test("schema versions adopt existing data, atomically roll back failed DDL, and reject drift or newer versions", () => {
  const db = new DatabaseSync(":memory:");
  db.transaction = (fn) => { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  try {
    db.exec("CREATE TABLE retained (id TEXT PRIMARY KEY,payload TEXT); INSERT INTO retained VALUES('old','keep');");
    const first = [{ version: 1, name: "Adopt retained", sql: "CREATE TABLE IF NOT EXISTS retained (id TEXT PRIMARY KEY,payload TEXT);" }];
    assert.equal(schemaMigrationPlan(db, "test", first).pending.length, 1);
    applySchemaMigrations(db, "test", first);
    assert.equal(db.prepare("SELECT payload FROM retained").get().payload, "keep");
    assert.equal(applySchemaMigrations(db, "test", first).pending.length, 0);
    const failure = [...first, { version: 2, name: "Broken additive change", sql: "CREATE TABLE candidate(id TEXT); INSERT INTO absent VALUES(1);" }];
    assert.throws(() => applySchemaMigrations(db, "test", failure), /absent/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='candidate'").get(), undefined);
    assert.equal(schemaMigrationPlan(db, "test", first).currentVersion, 1);
    assert.throws(() => applySchemaMigrations(db, "test", [{ ...first[0], sql: first[0].sql + " CREATE TABLE accidental(id TEXT);" }]), { code: "SCHEMA_MIGRATION_CHANGED" });
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='accidental'").get(), undefined);
    const second = [...first, { version: 2, name: "Add index", sql: "CREATE INDEX retained_payload ON retained(payload);" }];
    applySchemaMigrations(db, "test", second);
    assert.throws(() => applySchemaMigrations(db, "test", first), { code: "SCHEMA_VERSION_NEWER" });
    assert.equal(db.prepare("SELECT payload FROM retained").get().payload, "keep");
  } finally { db.close(); }
});

test("new preview hash binds every candidate artifact; v1 reviewed hashes remain publishable without recompilation", async (t) => {
  const h = await harness(t), preview = await draft(h.w), snapshot = await h.w.previewSnapshot(preview.id);
  assert.equal(snapshot.manifest.version, "reader-preview-2");
  const mutations = [
    (x) => x.validated.index[0].text = "Other", (x) => x.validated.fingerprints.fake = "Other",
    (x) => x.validated.report.extra = "Other", (x) => x.compiled.report.extra = "Other",
    (x) => x.compiled.authoring.meta.title = "Other", (x) => x.validation.summary.pageCount = 9,
    (x) => x.authoringFile.id = "file-other", (x) => x.resourceMap.extra = { sha256: "a".repeat(64), size: 1, mediaType: "text/plain" },
    (x) => x.manifest.contractVersion = "Other",
  ];
  for (const mutate of mutations) { const changed = structuredClone(snapshot); mutate(changed); assert.throws(() => verifyPreviewSnapshot(changed), { code: "PREVIEW_HASH_MISMATCH" }); }
  const legacy = structuredClone(snapshot); legacy.manifest.version = "reader-preview-1"; delete legacy.manifest.artifactHashes;
  legacy.hash = hash(canonical(legacy.manifest)); legacy.id = "preview-" + legacy.hash;
  // The historical snapshot format is distinct from the review-evidence format:
  // exercise its unchanged hash with explicitly synthetic current evidence.
  const protocol = await createProtocolReviewEvidence({ preview: legacy,
    readReport: async () => ({ quality: previewQualityReport(legacy) }),
    upload: (bytes, filename, mediaType) => h.w.upload(localActor, bytes, { filename, mediaType }),
  });
  const submission = { expectedHash: legacy.hash, review: protocol.review };
  const prepared = await preparePreviewPublication(h.w, legacy, submission);
  assert.deepEqual(prepared.validated.document, snapshot.validated.document);
  assert.deepEqual(prepared.compiled.identity, snapshot.compiled.identity);
  assert.equal(prepared.validated.report.previewSubmission.previewHash, legacy.hash);
  legacy.validated.index[0].text = "A changed legacy derivative";
  await assert.rejects(preparePreviewPublication(h.w, legacy, submission), { code: "PREVIEW_HASH_MISMATCH" });
});

test("preview membership projection is tied to its exact object reference and hydrates an old row only once", async (t) => {
  const h = await harness(t), preview = await draft(h.w), read = h.w.resources.readObject.bind(h.w.resources); let reads = 0;
  h.w.resources.readObject = (...args) => { reads++; return read(...args); };
  assert.deepEqual(await h.w.previewMetadata(preview.id), { id: preview.id, draftId: preview.draftId, hash: preview.hash }); assert.equal(reads, 0);
  h.w.db.prepare("DELETE FROM preview_metadata WHERE preview_id=?").run(preview.id);
  await h.w.previewMetadata(preview.id); assert.equal(reads, 1);
  await h.w.previewMetadata(preview.id); assert.equal(reads, 1);
  const snapshot = await h.w.previewSnapshot(preview.id); snapshot.validated.index[0].text = "Tampered after cache population";
  const ref = await h.w.resources.putObject(snapshot);
  h.w.db.prepare("UPDATE authoring_previews SET payload=? WHERE id=?").run(JSON.stringify({ $readerObject: ref }), preview.id);
  await assert.rejects(h.w.previewMetadata(preview.id), { code: "PREVIEW_HASH_MISMATCH" });
});

test("partial object migration repairs missing indexes; explicit copy repair restores corrupt derivatives without changing business rows", async (t) => {
  const h = await harness(t), result = await publish(h.w), id = result.document.id;
  const saved = await h.w.revision(id), before = h.w.snapshot();
  const receipts = h.w.db.prepare("SELECT * FROM receipts ORDER BY request_id").all();
  h.w.db.exec("DELETE FROM revision_indexes; DELETE FROM metadata WHERE key='immutableStorageVersion';");
  await h.restart();
  assert.deepEqual(await h.w.revision(id), saved);
  assert.deepEqual(h.w.snapshot(), before);
  const chunk = h.w.db.prepare("SELECT payload FROM revision_indexes WHERE document_id=? AND kind='text' AND part=0").get(id).payload;
  h.w.db.prepare("UPDATE revision_indexes SET payload=? WHERE document_id=? AND kind='text' AND part=0").run(chunk.replace("Alpha", "Other"), id);
  assert.throws(() => h.w.revisionIndex(id), { code: "OBJECT_INDEX_CORRUPT" });
  await h.restart({ repairStorage: true });
  assert.deepEqual(await h.w.revision(id), saved);
  assert.deepEqual(h.w.snapshot(), before);
  assert.deepEqual(h.w.db.prepare("SELECT * FROM receipts ORDER BY request_id").all(), receipts);
});

test("Collection projection has a constant query count and preserves first unanswered question without hydrating all insight bodies", async (t) => {
  const h = await harness(t), ids = [];
  for (let i = 0; i < 5; i++) {
    const result = await publish(h.w, "Document " + i); ids.push(result.document.id);
    for (let j = 0; j < 3; j++) await h.w.execute({ kind: "insight.save", requestId: randomUUID(), documentId: result.document.id,
      insight: { type: "question", color: "yellow", body: "Question " + j } });
    const question = h.w.insights(result.document.id)[0];
    await h.w.execute({ kind: "insight.answer", requestId: randomUUID(), documentId: result.document.id, insightId: question.id, expectedVersion: question.version, authorized: true,
      answer: { blocks: [{ type: "paragraph", text: "Large answer ".repeat(1000) }] } });
  }
  const expected = ids.map((id) => h.w.material(h.w.row(id))), originalPrepare = h.w.db.prepare.bind(h.w.db); let queries = 0;
  h.w.db.prepare = (...args) => { queries++; return originalPrepare(...args); };
  const oldInsights = h.w.insights; h.w.insights = () => { throw new Error("Must not hydrate insights to list Collection"); };
  try {
    const result = h.w.snapshot();
    assert.deepEqual(result.documents, expected); assert.equal(queries, 3);
    assert.ok(result.documents.every((document) => document.insightCount === 3 && document.question === "Question 1"));
    queries = 0; assert.equal(h.w.documentSummaries().length, ids.length); assert.equal(queries, 1);
  } finally { h.w.db.prepare = originalPrepare; h.w.insights = oldInsights; }
});

test("source upload streams to disk, publishes without clobber, and cleans interrupted writes", async (t) => {
  const h = await harness(t), resources = h.w.resources, bytes = Buffer.from("first second"), blobRoot = join(h.dataDir, "blobs");
  let wroteBeforeNextChunk = false;
  async function* chunks() {
    yield bytes.subarray(0, 6);
    const temporary = (await readdir(blobRoot)).filter((name) => name.endsWith(".tmp"));
    wroteBeforeNextChunk = temporary.length === 1 && (await stat(join(blobRoot, temporary[0]))).size === 6;
    yield bytes.subarray(6);
  }
  const file = await resources.put(chunks(), { filename: "source.txt" }); assert.equal(wroteBeforeNextChunk, true);
  const copies = await Promise.all(Array.from({ length: 5 }, () => resources.put(bytes, { filename: "source.txt" })));
  assert.ok(copies.every((copy) => copy.sha256 === file.sha256));
  assert.deepEqual(await readFile(resources.path(file.sha256)), bytes);
  const corrupt = Buffer.from("tampered!!!!"); await writeFile(resources.path(file.sha256), corrupt);
  await assert.rejects(resources.put(bytes, { filename: "source.txt" }), { code: "OBJECT_INTEGRITY_FAILED" });
  assert.deepEqual(await readFile(resources.path(file.sha256)), corrupt);
  async function* broken() { yield Buffer.from("partial"); throw new Error("broken stream"); }
  await assert.rejects(resources.put(broken(), { filename: "broken.txt" }), /broken stream/);
  assert.ok((await readdir(blobRoot)).every((name) => /^[a-f0-9]{64}$/.test(name)));
});

test("staged-object mutations cannot silently become stale pointers, and async command preparation keeps original request semantics", async (t) => {
  const h = await harness(t), result = await publish(h.w), saved = await h.w.revision(result.document.id);
  const object = { state: "old" }; await h.w.storage.stage(object); object.state = "new";
  assert.throws(() => h.w.storage.pack({ object }), { code: "OBJECT_PREPARATION_CHANGED" });
  const requestId = randomUUID(), command = { kind: "document.revise", documentId: result.document.id, expectedRevision: 1, requestId, authorized: true,
    operations: [{ kind: "replace_range", blockId: saved.document.blocks[1].id, field: "text", start: 0, end: 5, expectedText: "Alpha", value: "Original" }] };
  const work = h.w.execute(command); command.requestId = randomUUID(); command.operations[0].value = "Changed while pending";
  const receipt = await work;
  assert.equal(receipt.requestId, requestId); assert.equal(receipt.document.blocks[1].text, "Original beta gamma.");
  const row = h.w.revisionRow(result.document.id), reference = objectReference(JSON.parse(row.content));
  assert.ok(reference); assert.equal(receipt.document.revision, 2);
});
