"use strict";

const fs = require("node:fs/promises");
const { createReadStream, constants } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { backup, DatabaseSync } = require("node:sqlite");

const DATABASE = "workspace.sqlite";
const MANIFEST = "migration-manifest.json";
const HASH = /^[a-f0-9]{64}$/;
const PAGE = /^[a-f0-9]{64}-[1-9][0-9]*-[1-9][0-9]*\.png$/;
const REQUIRED_TABLES = ["metadata", "documents", "revisions", "files", "insights"];

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function absoluteDirectory(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || !path.isAbsolute(value)) throw failure("INVALID_PATH", `${label} must be an absolute directory path.`);
  return path.resolve(value);
}

async function maybeStat(value) {
  try { return await fs.lstat(value); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

// Windows realpath can change drive/ancestor casing after missing directories
// are created. path.relative follows the host's case semantics; a different
// canonical destination (including a redirected junction) still cannot match.
const samePath = (left, right) => path.relative(left, right) === "";

async function canonicalDestination(value) {
  const missing = [];
  let current = value;
  for (;;) {
    try { return path.resolve(await fs.realpath(current), ...[...missing].reverse()); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

async function inspectTarget(targetDir) {
  const existing = await maybeStat(targetDir);
  if (!existing) return "missing";
  if (!existing.isDirectory() || existing.isSymbolicLink()) throw failure("INVALID_TARGET", "Migration target must be a regular directory, not a file or symbolic link.");
  // Even an invalid/partial existing database belongs to the caller. Never
  // overwrite or repair it as a side effect of first-run migration.
  if (await maybeStat(path.join(targetDir, DATABASE))) return "database";
  if ((await fs.readdir(targetDir)).length) throw failure("TARGET_NOT_EMPTY", "Migration target contains files but no workspace database; nothing was overwritten.");
  return "empty";
}

function tableNames(database) {
  return database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
}

function requireWorkspace(database) {
  const names = tableNames(database);
  if (REQUIRED_TABLES.some((name) => !names.includes(name))) throw failure("INVALID_WORKSPACE", "Source database does not contain the workspace tables.");
  if (names.includes("sync_state") && database.prepare("SELECT value FROM sync_state WHERE key='replicaId'").get()?.value) throw failure("SYNC_PROFILE_COPY", "此资料库已有历史同步身份，不能复制为另一份首次迁移资料库。请直接使用原 profile；备份恢复需先停止原副本并保留全部历史记录。");
  return names;
}

function inspectSnapshot(databasePath) {
  const database = new DatabaseSync(databasePath, { timeout: 5000 });
  try {
    // Normalize only the new copy. It must be complete without requiring the
    // source WAL or SHM files when its directory is published atomically.
    database.exec("PRAGMA journal_mode=DELETE;");
    const names = requireWorkspace(database);
    const integrity = database.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok") throw failure("INVALID_DATABASE", "The migrated database failed its integrity check.");
    const counts = Object.fromEntries(names.map((name) => [name, database.prepare('SELECT COUNT(*) AS count FROM "' + name.replaceAll('"', '""') + '"').get().count]));
    const requiredBlobs = new Map(), requiredObjects = new Map(), resourceMaps = [];
    const rememberObject = (value) => {
      const ref = value?.$readerObject;
      if (!ref) return;
      if (Object.keys(value).length !== 1 || !HASH.test(ref.sha256 || "") || ref.key !== `objects/sha256/${ref.sha256}` || ref.version !== 1 || !Number.isSafeInteger(ref.size) || ref.size < 1 || ref.size > 100 * 1024 * 1024) throw failure("INVALID_RESOURCE", "The database contains an invalid immutable object reference.");
      if (requiredObjects.has(ref.sha256) && requiredObjects.get(ref.sha256) !== ref.size) throw failure("INVALID_RESOURCE", "The database contains inconsistent immutable object sizes.");
      requiredObjects.set(ref.sha256, ref.size);
    };
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      rememberObject(value);
      for (const item of Object.values(value)) if (item && typeof item === "object") visit(item);
    };
    // New immutable fields can occur in revisions, previews, drafts and receipts.
    // Scan structured columns rather than assuming only the current revision owns them.
    for (const name of names) for (const row of database.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').iterate()) {
      for (const value of Object.values(row)) if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) {
        let parsed; try { parsed = JSON.parse(value); } catch { continue; }
        visit(parsed);
      }
    }
    const remember = (sha256, size) => {
      if (!HASH.test(sha256 || "") || !Number.isSafeInteger(size) || size < 0) throw failure("INVALID_RESOURCE", "The database contains an invalid resource descriptor.");
      if (requiredBlobs.has(sha256) && requiredBlobs.get(sha256) !== size) throw failure("INVALID_RESOURCE", "The database contains inconsistent resource sizes.");
      requiredBlobs.set(sha256, size);
    };
    for (const row of database.prepare("SELECT sha256,size FROM files").all()) remember(row.sha256, row.size);
    // Older stored revisions can retain resources independently of the current
    // files catalog. Their immutable resources must survive migration too.
    for (const row of database.prepare("SELECT resources FROM revisions").all()) {
      let resources;
      try { resources = JSON.parse(row.resources); }
      catch (error) { throw failure("INVALID_RESOURCE", "A stored revision has an invalid resource map.", error); }
      if (!resources || typeof resources !== "object" || Array.isArray(resources)) throw failure("INVALID_RESOURCE", "A stored revision has an invalid resource map.");
      if (resources.$readerObject) resourceMaps.push(resources.$readerObject);
      else for (const resource of Object.values(resources)) remember(resource?.sha256, resource?.size);
    }
    return { counts, requiredBlobs, requiredObjects, resourceMaps };
  } finally { database.close(); }
}

async function digest(filename) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest("hex");
}

async function copyResources(sourceDir, stagingDir, kind, pattern, requiredBlobs = new Map()) {
  const source = path.join(sourceDir, kind), target = path.join(stagingDir, kind);
  await fs.mkdir(target, { recursive: true });
  const sourceInfo = await maybeStat(source);
  if (sourceInfo && (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())) throw failure("INVALID_RESOURCE_PATH", `${kind} must be a regular directory.`);
  const entries = sourceInfo ? await fs.readdir(source, { withFileTypes: true }) : [];
  const copied = new Set();
  let bytes = 0, skipped = 0;
  for (const entry of entries) {
    // Blob uploads and page renders are published by rename. Temporary files
    // have other names and must never be treated as complete resources.
    if (!pattern.test(entry.name)) { skipped += 1; continue; }
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    const info = await fs.lstat(from);
    if (!info.isFile() || info.isSymbolicLink()) throw failure("INVALID_RESOURCE_PATH", `A completed ${kind} resource is not a regular file.`);
    await fs.copyFile(from, to, constants.COPYFILE_EXCL);
    const copiedInfo = await fs.stat(to);
    if (kind === "blobs" || kind === "objects/sha256") {
      if (await digest(to) !== entry.name) throw failure("RESOURCE_HASH_MISMATCH", "A copied blob does not match its content-addressed filename.");
      if (requiredBlobs.has(entry.name) && copiedInfo.size !== requiredBlobs.get(entry.name)) throw failure("RESOURCE_SIZE_MISMATCH", "A copied blob does not match its stored size.");
    }
    // Windows FlushFileBuffers requires a writable handle. This is the new
    // staging copy only; the source blob is never opened for writing.
    const handle = await fs.open(to, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    copied.add(entry.name);
    bytes += copiedInfo.size;
  }
  for (const sha256 of requiredBlobs.keys()) if (!copied.has(sha256)) throw failure("MISSING_RESOURCE", "A resource referenced by the database is missing from the source blobs directory.");
  return { copied: copied.size, bytes, skipped, ...(kind === "blobs" || kind === "objects/sha256" ? { referenced: requiredBlobs.size } : {}) };
}

async function inspectObjectResources(stagingDir, maps, requiredBlobs) {
  for (const reference of maps) {
    let resources;
    try { resources = JSON.parse(await fs.readFile(path.join(stagingDir, "objects", "sha256", reference.sha256), "utf8")); }
    catch (error) { throw failure("INVALID_RESOURCE", "A revision resource object is not valid JSON.", error); }
    if (!resources || typeof resources !== "object" || Array.isArray(resources)) throw failure("INVALID_RESOURCE", "A stored revision has an invalid resource object.");
    for (const resource of Object.values(resources)) {
      if (!HASH.test(resource?.sha256 || "") || !Number.isSafeInteger(resource?.size) || resource.size < 0 || requiredBlobs.has(resource.sha256) && requiredBlobs.get(resource.sha256) !== resource.size) throw failure("INVALID_RESOURCE", "A resource object contains an invalid or inconsistent blob descriptor.");
      requiredBlobs.set(resource.sha256, resource.size);
    }
  }
}

async function removeStaging(stagingDir, parentDir, prefix) {
  if (!samePath(path.dirname(stagingDir), parentDir) || !path.basename(stagingDir).startsWith(prefix)) throw failure("INVALID_STAGING_PATH", "Refusing to remove a path outside the migration staging area.");
  const info = await maybeStat(stagingDir);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fs.realpath(stagingDir), stagingDir)) throw failure("INVALID_STAGING_PATH", "Migration staging directory was replaced.");
  await fs.rm(stagingDir, { recursive: true, force: true });
}

/**
 * Migrate an explicitly selected workspace into a fresh Electron workspace.
 * No source path is inferred or bundled. Call before starting the target server.
 * Source data stays live; only a read-only SQLite connection is opened there.
 */
async function migrateWorkspace(sourceDir, targetDir) {
  sourceDir = absoluteDirectory(sourceDir, "Source");
  targetDir = absoluteDirectory(targetDir, "Target");
  if (targetDir === path.parse(targetDir).root) throw failure("INVALID_TARGET", "A filesystem root cannot be a workspace migration target.");
  const skipped = () => ({ status: "skipped", reason: "target-exists", targetDir });
  if (await inspectTarget(targetDir) === "database") return skipped();
  const sourceInfo = await maybeStat(sourceDir);
  if (!sourceInfo?.isDirectory()) throw failure("SOURCE_NOT_FOUND", "Source workspace directory does not exist.");
  sourceDir = await fs.realpath(sourceDir);
  const canonicalTarget = await canonicalDestination(targetDir);
  if (isWithin(sourceDir, canonicalTarget) || isWithin(canonicalTarget, sourceDir)) throw failure("OVERLAPPING_PATHS", "Source and target workspace directories must not contain each other.");
  targetDir = canonicalTarget;
  const sourceDatabase = path.join(sourceDir, DATABASE);
  const databaseInfo = await maybeStat(sourceDatabase);
  if (!databaseInfo?.isFile() || databaseInfo.isSymbolicLink()) throw failure("SOURCE_NOT_FOUND", "Source workspace.sqlite is missing or is not a regular file.");
  let parentDir = path.dirname(targetDir);
  await fs.mkdir(parentDir, { recursive: true });
  const resolvedParent = await fs.realpath(parentDir);
  if (!samePath(resolvedParent, parentDir)) throw failure("INVALID_TARGET", `Target parent directory changed during migration setup: expected ${parentDir}, resolved ${resolvedParent}.`);
  parentDir = resolvedParent;
  targetDir = path.join(parentDir, path.basename(targetDir));
  const prefix = "." + path.basename(targetDir) + ".migration-";
  let stagingDir = await fs.mkdtemp(path.join(parentDir, prefix));
  try {
    const source = new DatabaseSync(sourceDatabase, { readOnly: true, timeout: 5000 });
    let backupPages;
    const walPresent = Boolean(await maybeStat(sourceDatabase + "-wal"));
    try {
      source.exec("PRAGMA query_only=ON; BEGIN;");
      requireWorkspace(source); // Establish one read snapshot, including WAL.
      backupPages = await backup(source, path.join(stagingDir, DATABASE));
    } finally { if (source.isTransaction) source.exec("ROLLBACK;"); source.close(); }
    const { counts, requiredBlobs, requiredObjects, resourceMaps } = inspectSnapshot(path.join(stagingDir, DATABASE));
    const objectRoot = await maybeStat(path.join(sourceDir, "objects"));
    if (objectRoot && (!objectRoot.isDirectory() || objectRoot.isSymbolicLink())) throw failure("INVALID_RESOURCE_PATH", "objects must be a regular directory.");
    const objects = await copyResources(sourceDir, stagingDir, "objects/sha256", HASH, requiredObjects);
    await inspectObjectResources(stagingDir, resourceMaps, requiredBlobs);
    const blobs = await copyResources(sourceDir, stagingDir, "blobs", HASH, requiredBlobs);
    const pages = await copyResources(sourceDir, stagingDir, "pages", PAGE);
    const manifest = {
      format: "continuous-reader-workspace-migration-1",
      createdAt: new Date().toISOString(),
      source: { directory: sourceDir, database: DATABASE, readOnly: true, walPresent },
      database: { backupPages, integrity: "ok", counts },
      resources: { blobs, objects, pages, work: { copied: false, reason: "Retired conversion scratch; no current workspace reader uses this directory." } },
    };
    const manifestFile = await fs.open(path.join(stagingDir, MANIFEST), "wx");
    try { await manifestFile.writeFile(JSON.stringify(manifest, null, 2) + "\n"); await manifestFile.sync(); }
    finally { await manifestFile.close(); }
    // A competing first-run migration may have completed while this snapshot
    // was copied. A non-empty directory can never be replaced by rename.
    const targetState = await inspectTarget(targetDir);
    if (targetState === "database") return skipped();
    if (targetState === "empty") await fs.rmdir(targetDir);
    try { await fs.rename(stagingDir, targetDir); }
    catch (error) {
      if (await inspectTarget(targetDir) === "database") return skipped();
      throw error;
    }
    stagingDir = null;
    return { status: "migrated", sourceDir, targetDir, manifestPath: path.join(targetDir, MANIFEST), counts };
  } finally { if (stagingDir) await removeStaging(stagingDir, parentDir, prefix); }
}

module.exports = { migrateWorkspace };
