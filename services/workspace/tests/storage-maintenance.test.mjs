import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWorkspace, localActor } from "../service.mjs";
import { inspectWorkspaceStorage, copyValidateWorkspaceStorage } from "../storage-maintenance.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "reader-storage-maintenance-")), dataDir = join(root, "source");
  const w = await createWorkspace({ dataDir, bootstrap: false, glossaryPath: false });
  t.after(async () => { await w.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith("reader-storage-maintenance-")); await rm(root, { recursive: true, force: true }); });
  const input = { format: "reader-authoring-1", key: "maintenance", meta: { title: "Retained", language: "en" }, blocks: [{ key: "paragraph", type: "para", text: "Existing body" }] };
  const file = await w.upload(localActor, Buffer.from(JSON.stringify(input)), { filename: "authoring.json" });
  // Maintenance tests need saved synthetic business data, not a conversion
  // completion claim; seed it through the retained internal business API.
  const result = await w.publishAuthoring(localActor, { authoringSourceId: file.sourceId, requestId: randomUUID() });
  const id = result.document.id;
  await w.execute({ kind: "insight.save", documentId: id, requestId: randomUUID(), insight: { type: "note", color: "yellow", body: "Keep exact body and reference." } });
  await w.execute({ kind: "plan.add", documentId: id, requestId: randomUUID() });
  return { root, dataDir, w, id, file };
}

test("offline copy uses a consistent live-WAL SQLite backup, validates semantics, and retains a usable pre-migration copy", async (t) => {
  const h = await fixture(t), saved = await h.w.revision(h.id);
  // Reconstruct the old inline layout only in this synthetic database.
  h.w.db.prepare("UPDATE revisions SET content=?,text_index=?,fingerprints=?,resources=?,report=?,authoring=?,identity=? WHERE document_id=?")
    .run(...[saved.document, saved.index, saved.fingerprints, saved.resourceMap, saved.report, saved.authoring, saved.identity].map(JSON.stringify), h.id);
  h.w.db.exec("DELETE FROM revision_indexes; DELETE FROM metadata WHERE key='immutableStorageVersion'; DELETE FROM schema_versions;");
  assert.ok((await stat(join(h.dataDir, "workspace.sqlite-wal"))).size > 0);
  const original = await inspectWorkspaceStorage(h.dataDir, { semantic: true, verifyObjects: true });
  const result = await copyValidateWorkspaceStorage(h.dataDir, join(h.root, "evidence"));
  assert.equal(result.status, "validated"); assert.deepEqual(result.differences, []);
  assert.deepEqual((await inspectWorkspaceStorage(h.dataDir, { semantic: true, verifyObjects: true })).fingerprints, original.fingerprints);
  assert.equal(h.w.db.prepare("SELECT value FROM metadata WHERE key='immutableStorageVersion'").get(), undefined, "the live source is not migrated");
  const before = new DatabaseSync(join(h.root, "evidence", "before", "workspace.sqlite"), { readOnly: true });
  try {
    assert.equal(JSON.parse(before.prepare("SELECT content FROM revisions").get().content).id, h.id);
    assert.equal(before.prepare("SELECT COUNT(*) AS count FROM insights").get().count, 1, "WAL-backed latest state was copied");
  } finally { before.close(); }
  const candidate = await createWorkspace({ dataDir: join(h.root, "evidence", "candidate"), bootstrap: false, glossaryPath: false });
  try { assert.deepEqual(await candidate.revision(h.id), saved); assert.equal(candidate.insights(h.id)[0].body, "Keep exact body and reference."); }
  finally { await candidate.close(); }
  const evidence = JSON.parse(await readFile(result.evidencePath, "utf8")); assert.equal(evidence.status, "validated");
  assert.equal(evidence.rollback.automaticSourceReplacement, false);
  await assert.rejects(copyValidateWorkspaceStorage(h.dataDir, join(h.root, "evidence")), { code: "STORAGE_DESTINATION_EXISTS" });
  await assert.rejects(copyValidateWorkspaceStorage(h.dataDir, join(h.dataDir, "nested")), { code: "STORAGE_DESTINATION_INVALID" });
});

test("missing original bytes fail copy validation and leave failed evidence without altering the source", async (t) => {
  const h = await fixture(t), path = h.w.resources.path(h.file.sha256), bytes = await readFile(path);
  await rm(path);
  await assert.rejects(copyValidateWorkspaceStorage(h.dataDir, join(h.root, "failed")), { code: "RESOURCE_MISSING" });
  const evidence = JSON.parse(await readFile(join(h.root, "failed", "evidence.json"), "utf8"));
  assert.equal(evidence.status, "failed"); assert.equal(evidence.error.code, "RESOURCE_MISSING");
  assert.equal(h.w.row(h.id).current_revision, 1);
  await writeFile(path, bytes);
  assert.equal((await inspectWorkspaceStorage(h.dataDir, { verifyObjects: true })).quickCheck[0], "ok");
});

test("plan CLI is read-only and exposes inspect/copy/rollback scope with no automatic replacement", async (t) => {
  const h = await fixture(t), cli = fileURLToPath(new URL("../scripts/storage-maintenance.mjs", import.meta.url));
  const before = await inspectWorkspaceStorage(h.dataDir, { semantic: true });
  const run = spawnSync(process.execPath, [cli, "plan", h.dataDir], { encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, run.stderr); const result = JSON.parse(run.stdout);
  assert.equal(result.plan.sourceMutation, false); assert.equal(result.plan.nextAction, "copy-validate");
  assert.match(result.plan.rollback, /never replaces the source/);
  assert.deepEqual((await inspectWorkspaceStorage(h.dataDir, { semantic: true })).fingerprints, before.fingerprints);
});

test("object-looking quoted insight text is not treated as an authoritative storage reference", async (t) => {
  const h = await fixture(t), fake = { $readerObject: { key: "objects/sha256/" + "a".repeat(64), sha256: "a".repeat(64), size: 9, version: 1 } };
  await h.w.execute({ kind: "insight.save", documentId: h.id, requestId: randomUUID(), insight: { type: "note", color: "yellow", body: JSON.stringify(fake) } });
  assert.equal((await inspectWorkspaceStorage(h.dataDir, { verifyObjects: true })).quickCheck[0], "ok");
});

async function overlappingReading(h) {
  const start = Date.now() - 60000, end = start + 15000;
  for (const sessionId of ["b-session", "a-session"]) {
    await h.w.execute(localActor, { kind: "reading.session.start", sessionId, documentId: h.id, documentRevision: 1, startedAt: new Date(start).toISOString(), requestId: randomUUID() });
    await h.w.execute(localActor, { kind: "reading.session.activity", sessionId, sequence: 1, startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), activeMs: 15000, requestId: randomUUID() });
  }
  return { start, end };
}

test("legacy arrival-order overlap attribution migrates while raw reading facts and canonical totals stay exact", async (t) => {
  const h = await fixture(t), { start, end } = await overlappingReading(h);
  // The old projection credited the first arrival. The new deterministic
  // projection credits a-session, but both represent the same measured 15s.
  h.w.db.transaction(() => {
    h.w.db.exec("UPDATE reading_activity SET accepted_ms=CASE WHEN session_id='b-session' THEN 15000 ELSE 0 END; UPDATE reading_sessions SET active_ms=CASE WHEN id='b-session' THEN 15000 ELSE 0 END; DELETE FROM reading_active_ranges;");
    h.w.db.prepare("INSERT INTO reading_active_ranges VALUES(?,1,0,?,?,?)").run("b-session", "local", start, end);
    for (const row of h.w.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'reader_projection_%'").all()) h.w.db.exec("DROP TRIGGER " + row.name);
    for (const name of ["reading_event_index", "reading_projection_dirty", "reading_projection_sessions", "reading_projection_state"]) h.w.db.exec("DROP TABLE " + name);
    h.w.db.exec("DELETE FROM schema_versions WHERE scope='reading-projection'");
  });
  const raw = (db) => ({
    events: db.prepare("SELECT * FROM reading_activity ORDER BY session_id,sequence").all().map(({ accepted_ms, ...row }) => row),
    sessions: db.prepare("SELECT * FROM reading_sessions ORDER BY id").all().map(({ active_ms, last_activity_ms, ...row }) => row),
  });
  const before = raw(h.w.db), result = await copyValidateWorkspaceStorage(h.dataDir, join(h.root, "legacy-reading"));
  assert.equal(result.status, "validated"); assert.deepEqual(result.differences, []);
  assert.equal(result.before.readingProjection.activeMs, 15000); assert.equal(result.after.readingProjection.activeMs, 15000);
  assert.equal(result.before.readingProjection.sha256, result.after.readingProjection.sha256);
  assert.equal(result.before.readingProjection.stored.matchesOracle, false);
  assert.equal(result.before.readingProjection.stored.activeMs, 15000);
  assert.equal(result.after.readingProjection.stored.matchesOracle, true);
  assert.deepEqual(raw(h.w.db), before, "inspection and copy must not rewrite the source");
  assert.equal(h.w.db.prepare("SELECT accepted_ms FROM reading_activity WHERE session_id='b-session'").get().accepted_ms, 15000);
  const candidate = new DatabaseSync(join(h.root, "legacy-reading", "candidate", "workspace.sqlite"), { readOnly: true });
  try {
    assert.deepEqual(raw(candidate), before);
    assert.equal(candidate.prepare("SELECT accepted_ms FROM reading_activity WHERE session_id='a-session'").get().accepted_ms, 15000);
    assert.equal(candidate.prepare("SELECT accepted_ms FROM reading_activity WHERE session_id='b-session'").get().accepted_ms, 0);
  } finally { candidate.close(); }
});

test("semantic inspection preserves literal JSON-looking labels through copy and detects exact prose changes", async (t) => {
  const h = await fixture(t), label = '{"$readerObject":{}}';
  const result = await h.w.execute(localActor, { kind: "collection.create", label, requestId: randomUUID() });
  const before = await inspectWorkspaceStorage(h.dataDir, { semantic: true, verifyObjects: true });
  const copied = await copyValidateWorkspaceStorage(h.dataDir, join(h.root, "literal-label"));
  assert.equal(copied.status, "validated"); assert.deepEqual(copied.after.fingerprints, before.fingerprints);
  const candidate = new DatabaseSync(join(h.root, "literal-label", "candidate", "workspace.sqlite"), { readOnly: true });
  try { assert.equal(candidate.prepare("SELECT label FROM collections WHERE id=?").get(result.collection.id).label, label); }
  finally { candidate.close(); }
  h.w.db.prepare("UPDATE collections SET label=? WHERE id=?").run('{ "$readerObject": {} }', result.collection.id);
  const changed = await inspectWorkspaceStorage(h.dataDir, { semantic: true });
  assert.notDeepEqual(changed.fingerprints.collections, before.fingerprints.collections, "prose whitespace is not normalized as storage JSON");
});

test("reading projection corruption is visible separately while raw input and session identity remain fingerprinted", async (t) => {
  const h = await fixture(t); await overlappingReading(h);
  const before = await inspectWorkspaceStorage(h.dataDir, { semantic: true });
  assert.equal(before.readingProjection.stored.matchesOracle, true);
  h.w.db.exec("UPDATE reading_activity SET accepted_ms=1; UPDATE reading_sessions SET active_ms=2,last_activity_ms=3; DELETE FROM reading_active_ranges;");
  const corrupt = await inspectWorkspaceStorage(h.dataDir, { semantic: true });
  assert.deepEqual(corrupt.fingerprints, before.fingerprints, "only derived counters changed");
  assert.equal(corrupt.readingProjection.sha256, before.readingProjection.sha256);
  assert.equal(corrupt.readingProjection.activeMs, 15000); assert.equal(corrupt.readingProjection.stored.matchesOracle, false);
  h.w.db.prepare("UPDATE reading_sessions SET actor_id='another-reader' WHERE id='b-session'").run();
  const rawChanged = await inspectWorkspaceStorage(h.dataDir, { semantic: true });
  assert.notDeepEqual(rawChanged.fingerprints.reading_sessions, before.fingerprints.reading_sessions);
  assert.notEqual(rawChanged.readingProjection.sha256, before.readingProjection.sha256);
  assert.equal(rawChanged.readingProjection.activeMs, 30000, "separate readers own separate measured intervals");
  h.w.db.prepare("UPDATE reading_activity SET input='{}' WHERE session_id='a-session'").run();
  await assert.rejects(inspectWorkspaceStorage(h.dataDir, { semantic: true }), { code: "SYNC_INVALID_READING" });
});
