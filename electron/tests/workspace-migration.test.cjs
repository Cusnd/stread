"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { migrateWorkspace } = require("../workspace-migration.cjs");

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "reader-migration-test-"));
  const sourceDir = path.join(root, "source"), targetDir = path.join(root, "desktop", "workspace");
  await fs.mkdir(path.join(sourceDir, "blobs"), { recursive: true });
  await fs.mkdir(path.join(sourceDir, "pages"));
  await fs.mkdir(path.join(sourceDir, "work"));
  const bytes = Buffer.from("Immutable original source document\n"), sha256 = hash(bytes);
  await fs.writeFile(path.join(sourceDir, "blobs", sha256), bytes);
  await fs.writeFile(path.join(sourceDir, "blobs", ".pending-upload.tmp"), "unfinished");
  await fs.writeFile(path.join(sourceDir, "pages", sha256 + "-1-1200.png"), "finished cached page");
  await fs.writeFile(path.join(sourceDir, "pages", "pending-render.png"), "unfinished");
  await fs.writeFile(path.join(sourceDir, "work", "legacy-extraction.json"), "retired scratch");
  const databasePath = path.join(sourceDir, "workspace.sqlite");
  const writer = new DatabaseSync(databasePath);
  writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE documents (id TEXT PRIMARY KEY,title TEXT NOT NULL);
    CREATE TABLE revisions (document_id TEXT,revision INTEGER,resources TEXT NOT NULL);
    CREATE TABLE files (id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,size INTEGER NOT NULL);
    CREATE TABLE insights (id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE reading (document_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    INSERT INTO metadata VALUES('revision','4');
    INSERT INTO documents VALUES('doc-one','Existing workspace article');
    INSERT INTO insights VALUES('n1','{"body":"A saved thought","reference":"#N00001"}');
    INSERT INTO reading VALUES('doc-one','{"blockId":"p2","mode":"bilingual"}');`);
  writer.prepare("INSERT INTO files VALUES(?,?,?)").run("file-one", sha256, bytes.length);
  writer.prepare("INSERT INTO revisions VALUES(?,?,?)").run("doc-one", 1, JSON.stringify({ "source.txt": { sha256, size: bytes.length } }));
  t.after(async () => {
    writer.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, sourceDir, targetDir, databasePath, writer, sha256, bytes };
}

test("read-only online backup includes committed WAL, immutable originals and finished pages without modifying the live source", async (t) => {
  const f = await fixture(t);
  assert.ok((await fs.stat(f.databasePath + "-wal")).size > 0);
  const sourceBytes = await fs.readFile(f.databasePath), walBytes = await fs.readFile(f.databasePath + "-wal");
  const migrated = await migrateWorkspace(f.sourceDir, f.targetDir);
  assert.equal(migrated.status, "migrated");
  assert.equal(migrated.counts.documents, 1);
  assert.equal(migrated.counts.insights, 1);
  assert.equal(migrated.counts.reading, 1);
  assert.deepEqual(await fs.readFile(f.databasePath), sourceBytes);
  assert.deepEqual(await fs.readFile(f.databasePath + "-wal"), walBytes);
  assert.deepEqual(await fs.readFile(path.join(f.targetDir, "blobs", f.sha256)), f.bytes);
  assert.deepEqual(await fs.readdir(path.join(f.targetDir, "blobs")), [f.sha256]);
  assert.deepEqual(await fs.readdir(path.join(f.targetDir, "pages")), [f.sha256 + "-1-1200.png"]);
  await assert.rejects(fs.stat(path.join(f.targetDir, "work")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(f.sourceDir, "work", "legacy-extraction.json"), "utf8"), "retired scratch");
  const manifest = JSON.parse(await fs.readFile(migrated.manifestPath, "utf8"));
  assert.equal(manifest.source.directory, await fs.realpath(f.sourceDir));
  assert.equal(manifest.source.readOnly, true);
  assert.equal(manifest.source.walPresent, true);
  assert.equal(manifest.database.integrity, "ok");
  assert.ok(manifest.database.backupPages > 0);
  assert.ok(Number.isFinite(Date.parse(manifest.createdAt)));
  assert.equal(manifest.resources.blobs.copied, 1);
  assert.equal(manifest.resources.blobs.referenced, 1);
  assert.equal(manifest.resources.blobs.skipped, 1);
  assert.equal(manifest.resources.pages.skipped, 1);
  f.writer.prepare("INSERT INTO insights VALUES(?,?)").run("n2", '{"body":"Written after migration"}');
  const copied = new DatabaseSync(path.join(f.targetDir, "workspace.sqlite"), { readOnly: true });
  try {
    assert.equal(copied.prepare("SELECT COUNT(*) AS count FROM insights").get().count, 1);
    assert.equal(copied.prepare("SELECT title FROM documents").get().title, "Existing workspace article");
    assert.equal(JSON.parse(copied.prepare("SELECT payload FROM reading").get().payload).blockId, "p2");
  } finally { copied.close(); }
  assert.ok((await fs.readdir(path.dirname(f.targetDir))).every((entry) => !entry.includes(".migration-")));
});

test("existing target databases are skipped unchanged before attempting to read the source", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.targetDir, { recursive: true });
  const sentinel = Buffer.from("Caller-owned database; even an invalid one must remain untouched");
  await fs.writeFile(path.join(f.targetDir, "workspace.sqlite"), sentinel);
  const result = await migrateWorkspace(path.join(f.root, "nonexistent-source"), f.targetDir);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "target-exists");
  assert.deepEqual(await fs.readFile(path.join(f.targetDir, "workspace.sqlite")), sentinel);
  assert.deepEqual(await fs.readdir(f.targetDir), ["workspace.sqlite"]);
});

test("Windows canonical casing changes after creating missing profile parents do not reject the same directory", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  const targetDir = path.join(f.root, "Profiles", "Continuous Reader", "workspace");
  const parentDir = path.dirname(targetDir);
  const originalRealpath = fs.realpath;
  // The same Windows directory may be returned with different drive/ancestor
  // casing after it is created. Keep the real filesystem and only vary the
  // spelling returned by realpath, as opposed to redirecting the target.
  t.mock.method(fs, "realpath", async (filename, ...args) => {
    const actual = await originalRealpath(filename, ...args);
    return path.relative(parentDir, filename) === "" ? actual.toUpperCase() : actual;
  });
  const sourceBytes = await fs.readFile(f.databasePath), walBytes = await fs.readFile(f.databasePath + "-wal");
  const blob = path.join(f.sourceDir, "blobs", f.sha256);
  await fs.writeFile(blob, "corrupt contents");
  await assert.rejects(migrateWorkspace(f.sourceDir, targetDir), { code: "RESOURCE_HASH_MISMATCH" });
  assert.deepEqual(await fs.readdir(parentDir), []);
  await fs.writeFile(blob, f.bytes);
  const migrated = await migrateWorkspace(f.sourceDir, targetDir);
  assert.equal(migrated.status, "migrated");
  assert.equal(migrated.counts.documents, 1);
  assert.equal(path.relative(migrated.targetDir, targetDir), "");
  assert.deepEqual(await fs.readFile(f.databasePath), sourceBytes);
  assert.deepEqual(await fs.readFile(f.databasePath + "-wal"), walBytes);
  assert.deepEqual(await fs.readdir(parentDir), ["workspace"]);
  assert.equal((await migrateWorkspace(f.sourceDir, targetDir)).status, "skipped");
});

test("a parent resolving to a different directory is still rejected before a snapshot is created", async (t) => {
  const f = await fixture(t);
  const parentDir = path.dirname(f.targetDir);
  const redirected = path.join(f.root, "different-parent");
  await fs.mkdir(redirected);
  const originalRealpath = fs.realpath;
  t.mock.method(fs, "realpath", async (filename, ...args) => {
    const actual = await originalRealpath(filename, ...args);
    return path.relative(parentDir, filename) === "" ? originalRealpath(redirected) : actual;
  });
  await assert.rejects(migrateWorkspace(f.sourceDir, f.targetDir), { code: "INVALID_TARGET" });
  assert.deepEqual(await fs.readdir(parentDir), []);
  assert.deepEqual(await fs.readdir(redirected), []);
  await assert.rejects(fs.stat(f.targetDir), { code: "ENOENT" });
});

test("an existing empty target can be published atomically; unrelated files cannot be overwritten", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.targetDir, { recursive: true });
  await fs.writeFile(path.join(f.targetDir, "keep.txt"), "existing");
  await assert.rejects(migrateWorkspace(f.sourceDir, f.targetDir), { code: "TARGET_NOT_EMPTY" });
  assert.equal(await fs.readFile(path.join(f.targetDir, "keep.txt"), "utf8"), "existing");
  await fs.unlink(path.join(f.targetDir, "keep.txt"));
  assert.equal((await migrateWorkspace(f.sourceDir, f.targetDir)).status, "migrated");
});

test("missing or corrupt required blobs fail without publishing a partial workspace", async (t) => {
  const f = await fixture(t);
  const blob = path.join(f.sourceDir, "blobs", f.sha256);
  await fs.unlink(blob);
  await assert.rejects(migrateWorkspace(f.sourceDir, f.targetDir), { code: "MISSING_RESOURCE" });
  await assert.rejects(fs.stat(f.targetDir), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(path.dirname(f.targetDir)), []);
  await fs.writeFile(blob, "corrupt contents");
  await assert.rejects(migrateWorkspace(f.sourceDir, f.targetDir), { code: "RESOURCE_HASH_MISMATCH" });
  await assert.rejects(fs.stat(f.targetDir), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(path.dirname(f.targetDir)), []);
  await fs.writeFile(blob, f.bytes);
  assert.equal((await migrateWorkspace(f.sourceDir, f.targetDir)).status, "migrated");
});

test("invalid directories, source schemas and overlapping paths cannot produce a target database", async (t) => {
  const f = await fixture(t);
  await assert.rejects(migrateWorkspace("relative-source", f.targetDir), { code: "INVALID_PATH" });
  await assert.rejects(migrateWorkspace(f.sourceDir, path.join(f.sourceDir, "desktop")), { code: "OVERLAPPING_PATHS" });
  await assert.rejects(migrateWorkspace(path.join(f.root, "missing"), f.targetDir), { code: "SOURCE_NOT_FOUND" });
  const invalidDir = path.join(f.root, "invalid");
  await fs.mkdir(invalidDir);
  const invalid = new DatabaseSync(path.join(invalidDir, "workspace.sqlite"));
  invalid.exec("CREATE TABLE other (id INTEGER);");
  invalid.close();
  await assert.rejects(migrateWorkspace(invalidDir, f.targetDir), { code: "INVALID_WORKSPACE" });
  await assert.rejects(fs.stat(f.targetDir), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(path.dirname(f.targetDir)), []);
});

test("concurrent first-run attempts publish once and never replace the winner", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([migrateWorkspace(f.sourceDir, f.targetDir), migrateWorkspace(f.sourceDir, f.targetDir)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["migrated", "skipped"]);
  const manifest = JSON.parse(await fs.readFile(path.join(f.targetDir, "migration-manifest.json"), "utf8"));
  assert.equal(manifest.database.counts.insights, 1);
  assert.deepEqual(await fs.readdir(path.dirname(f.targetDir)), ["workspace"]);
});

test("immutable JSON and object-backed resource maps are verified before the migrated database becomes visible", async (t) => {
  const f = await fixture(t), directory = path.join(f.sourceDir, "objects", "sha256");
  await fs.mkdir(directory, { recursive: true });
  const objects = [{ title: "Immutable body", blocks: [{ text: "Preserved source content" }] }, { "source.txt": { sha256: f.sha256, size: f.bytes.length } }];
  const refs = [];
  for (const value of objects) {
    const bytes = Buffer.from(JSON.stringify(value)), sha256 = hash(bytes);
    await fs.writeFile(path.join(directory, sha256), bytes);
    refs.push({ key: "objects/sha256/" + sha256, sha256, size: bytes.length, version: 1 });
  }
  await fs.writeFile(path.join(directory, ".pending.json"), "unfinished");
  f.writer.exec("ALTER TABLE revisions ADD COLUMN content TEXT");
  f.writer.prepare("UPDATE revisions SET resources=?,content=?").run(JSON.stringify({ $readerObject: refs[1] }), JSON.stringify({ $readerObject: refs[0] }));
  await fs.unlink(path.join(f.sourceDir, "blobs", f.sha256));
  await assert.rejects(migrateWorkspace(f.sourceDir, f.targetDir), { code: "MISSING_RESOURCE" });
  await fs.writeFile(path.join(f.sourceDir, "blobs", f.sha256), f.bytes);
  await fs.writeFile(path.join(directory, refs[0].sha256), "corrupt object");
  await assert.rejects(migrateWorkspace(f.sourceDir, f.targetDir), { code: "RESOURCE_HASH_MISMATCH" });
  await assert.rejects(fs.stat(f.targetDir), { code: "ENOENT" });
  await fs.writeFile(path.join(directory, refs[0].sha256), JSON.stringify(objects[0]));
  await fs.unlink(path.join(directory, refs[0].sha256));
  await assert.rejects(migrateWorkspace(f.sourceDir, f.targetDir), { code: "MISSING_RESOURCE" });
  await fs.writeFile(path.join(directory, refs[0].sha256), JSON.stringify(objects[0]));
  const result = await migrateWorkspace(f.sourceDir, f.targetDir);
  assert.equal(result.status, "migrated");
  for (const ref of refs) assert.equal(hash(await fs.readFile(path.join(f.targetDir, "objects", "sha256", ref.sha256))), ref.sha256);
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  assert.deepEqual({ copied: manifest.resources.objects.copied, referenced: manifest.resources.objects.referenced, skipped: manifest.resources.objects.skipped }, { copied: 2, referenced: 2, skipped: 1 });
});

test("a source with a replica identity is preserved and refused as a second first-run copy", async (t) => {
  const f = await fixture(t);
  f.writer.exec("CREATE TABLE sync_state (key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO sync_state VALUES('replicaId','replica-original'),('enrolled','1'); CREATE TABLE sync_outbox (request_id TEXT PRIMARY KEY,payload TEXT); INSERT INTO sync_outbox VALUES('pending-stable-id','offline changes');");
  const before = await fs.readFile(f.databasePath + "-wal");
  await assert.rejects(migrateWorkspace(f.sourceDir, f.targetDir), (error) => error.code === "SYNC_PROFILE_COPY" && /原 profile/.test(error.message));
  await assert.rejects(fs.stat(f.targetDir), { code: "ENOENT" });
  assert.equal(f.writer.prepare("SELECT value FROM sync_state WHERE key='replicaId'").get().value, "replica-original");
  assert.equal(f.writer.prepare("SELECT payload FROM sync_outbox WHERE request_id='pending-stable-id'").get().payload, "offline changes");
  assert.deepEqual(await fs.readFile(f.databasePath + "-wal"), before);
  assert.deepEqual(await fs.readdir(path.dirname(f.targetDir)), []);
});
