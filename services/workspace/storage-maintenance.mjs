// Offline desktop maintenance. Source connections are read-only; every schema
// upgrade and repair is performed in an explicitly new candidate directory.
import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, readdir, lstat, cp, writeFile, realpath } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, dirname, basename, sep } from "node:path";
import { createHash } from "node:crypto";
import { canonical, check } from "./errors.mjs";
import { objectReference, hydrateObjectPointers } from "./immutable-objects.mjs";
import { ResourceFiles } from "./resources.mjs";
import { createWorkspace } from "./service.mjs";
import { reconcileReadingEvents } from "./sync-reading.mjs";

const quoted = (value) => '"' + value.replaceAll('"', '""') + '"';
const derivedTables = new Set(["schema_versions", "revision_indexes", "preview_metadata", "relation_match_state", "reading_event_index", "reading_projection_dirty", "reading_projection_sessions", "reading_projection_state", "reading_active_ranges", "_reader_values"]);
const sourceDatabase = (dataDir) => {
  const db = new DatabaseSync(join(dataDir, "workspace.sqlite"), { readOnly: true });
  db.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  return db;
};
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);

const jsonColumns = new Set(["payload", "content", "text_index", "fingerprints", "resources", "report", "authoring", "identity", "metadata", "value", "start_position", "end_position", "start_input", "end_input"]);
const derivedColumns = { reading_activity: new Set(["accepted_ms"]), reading_sessions: new Set(["active_ms", "last_activity_ms"]) };

function inspectReadingProjection(db, names) {
  const sessions = names.includes("reading_sessions") ? db.prepare("SELECT * FROM reading_sessions ORDER BY id").all() : [];
  const events = names.includes("reading_activity") ? db.prepare("SELECT * FROM reading_activity ORDER BY session_id,sequence").all() : [];
  const expected = reconcileReadingEvents(sessions, events);
  const stored = {
    sessions: sessions.map((row) => ({ id: row.id, activeMs: row.active_ms, lastActivityMs: row.last_activity_ms })),
    accepted: events.map((row) => ({ sessionId: row.session_id, sequence: row.sequence, activeMs: row.accepted_ms })),
    ranges: names.includes("reading_active_ranges") ? db.prepare("SELECT * FROM reading_active_ranges").all().map((row) => ({ sessionId: row.session_id, sequence: row.sequence, part: row.part, actor: row.actor_id, start: row.start_ms, end: row.end_ms })) : [],
  };
  // The oracle and persisted rows use different query orders. Sort their exact
  // values before hashing, without relying on the host's locale or attribution.
  const fingerprint = (projection) => createHash("sha256").update(canonical(Object.fromEntries(
    Object.entries(projection).map(([key, rows]) => [key, rows.map(canonical).sort()])
  ))).digest("hex");
  const sha256 = fingerprint(expected), storedHash = fingerprint(stored);
  return { sessions: sessions.length, activities: events.length, activeMs: expected.sessions.reduce((sum, row) => sum + row.activeMs, 0), sha256,
    stored: { activeMs: stored.sessions.reduce((sum, row) => sum + row.activeMs, 0), acceptedMs: stored.accepted.reduce((sum, row) => sum + row.activeMs, 0),
      rangeMs: stored.ranges.reduce((sum, row) => sum + row.end - row.start, 0), sha256: storedHash, matchesOracle: storedHash === sha256 } };
}

function references(value, result, parseString = false) {
  if (typeof value === "string") {
    if (parseString && /^[\[{]/.test(value)) { try { references(JSON.parse(value), result); } catch (error) { if (error.code) throw error; } }
    return;
  }
  if (!value || typeof value !== "object") return;
  const ref = objectReference(value);
  if (ref) { result.set(ref.key, { ...ref, kind: "object" }); return; }
  if (/^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && value.size > 0) {
    const key = value.key || value.storageKey || "blobs/" + value.sha256;
    if (key === "blobs/" + value.sha256 || key === "objects/sha256/" + value.sha256) result.set(key, { key, sha256: value.sha256, size: value.size, version: 1, kind: key.startsWith("objects/") ? "object" : "blob" });
  }
  for (const [key, child] of Object.entries(value)) references(child, result, jsonColumns.has(key));
}

export async function inspectWorkspaceStorage(dataDir, { verifyObjects = false, semantic = false } = {}) {
  dataDir = await realpath(resolve(dataDir));
  const db = sourceDatabase(dataDir), resources = new ResourceFiles(dataDir);
  db.exec("BEGIN");
  try {
    const names = tables(db), refs = new Map(), inventory = [], fingerprints = {};
    const quickCheck = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
    const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
    check(quickCheck.length === 1 && quickCheck[0] === "ok" && !foreignKeyErrors.length, "STORAGE_DATABASE_INVALID", "数据库完整性检查未通过。", 409, { quickCheck, foreignKeyErrors });
    for (const name of names) {
      inventory.push({ table: name, rows: db.prepare("SELECT COUNT(*) AS count FROM " + quoted(name)).get().count, derived: derivedTables.has(name) });
      if (derivedTables.has(name)) continue;
      const columns = db.prepare("PRAGMA table_info(" + quoted(name) + ")").all();
      const primary = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => quoted(column.name));
      const digest = createHash("sha256"); let rows = 0;
      for (const row of db.prepare("SELECT * FROM " + quoted(name) + " ORDER BY " + (primary.join(",") || "rowid")).iterate()) {
        if (name === "metadata" && row.key === "immutableStorageVersion") continue;
        references(row, refs);
        if (!semantic) continue;
        const normalized = {};
        for (const [key, value] of Object.entries(row)) {
          if (derivedColumns[name]?.has(key)) continue;
          if (jsonColumns.has(key) && typeof value === "string" && /^[\[{]/.test(value)) {
            let parsed;
            try { parsed = JSON.parse(value); } catch { normalized[key] = value; continue; }
            normalized[key] = await hydrateObjectPointers(parsed, resources);
          } else normalized[key] = value;
        }
        digest.update(canonical(normalized) + "\n"); rows++;
      }
      if (semantic) fingerprints[name] = { rows, sha256: digest.digest("hex") };
    }
    // Object payloads can reference other content and source objects. Resolve
    // the closure with deduplication, checking bytes before trusting children.
    const checked = new Set();
    if (verifyObjects || semantic) for (;;) {
      const pending = [...refs.values()].find((ref) => !checked.has(ref.key));
      if (!pending) break;
      if (pending.kind === "object") references(await resources.readObject(pending), refs);
      else check(await resources.verifyStoredFile(resources.path(pending.sha256), pending.sha256, pending.size), "RESOURCE_MISSING", "原始文件缺失。", 409, { key: pending.key });
      checked.add(pending.key);
    }
    return { format: "reader-storage-inspection-1", dataDir, checkedAt: new Date().toISOString(), quickCheck, foreignKeyErrors,
      schemas: names.includes("schema_versions") ? db.prepare("SELECT * FROM schema_versions ORDER BY scope,version").all() : [], tables: inventory,
      immutableMigrationVersion: names.includes("metadata") ? db.prepare("SELECT value FROM metadata WHERE key='immutableStorageVersion'").get()?.value || null : null,
      objects: { referenced: refs.size, verified: checked.size, bytes: [...refs.values()].reduce((size, ref) => size + ref.size, 0) },
      ...(semantic ? { fingerprints, readingProjection: inspectReadingProjection(db, names) } : {}) };
  } finally { db.exec("ROLLBACK"); db.close(); }
}

async function copyImmutableTree(source, target) {
  let entries; try { entries = await readdir(source, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  await mkdir(target, { recursive: true });
  for (const entry of entries) {
    // In-progress writes are not committed objects and must not enter evidence.
    if (entry.name.endsWith(".tmp")) continue;
    check(!entry.isSymbolicLink(), "STORAGE_LINK_UNSUPPORTED", "离线复制不能跟随存储目录中的符号链接。", 409, { name: entry.name });
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) await copyImmutableTree(from, to);
    else { check(entry.isFile(), "STORAGE_FILE_UNSUPPORTED", "存储目录包含非常规文件。", 409, { name: entry.name }); await cp(from, to, { errorOnExist: true, force: false }); }
  }
}

export async function copyValidateWorkspaceStorage(source, destination) {
  source = await realpath(resolve(source)); destination = resolve(destination);
  destination = join(await realpath(dirname(destination)), basename(destination));
  const within = relative(source, destination);
  check(within && (within === ".." || within.startsWith(".." + sep) || isAbsolute(within)), "STORAGE_DESTINATION_INVALID", "验证副本必须放在源工作台以外的新目录。", 400);
  check(!(await lstat(destination).catch((error) => { if (error.code === "ENOENT") return null; throw error; })), "STORAGE_DESTINATION_EXISTS", "目标目录已存在；拒绝覆盖。", 409);
  await mkdir(destination);
  const before = join(destination, "before"), candidate = join(destination, "candidate"), evidencePath = join(destination, "evidence.json");
  await mkdir(before);
  const evidence = { format: "reader-storage-copy-validation-1", source, before, candidate, startedAt: new Date().toISOString(), status: "copying",
    rollback: { automaticSourceReplacement: false, instructions: "The source is unchanged. Stop the application before selecting any data directory. Keep before/ and its immutable objects together; never copy a WAL file over a running database." } };
  const save = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", { encoding: "utf8" });
  await save();
  try {
    const db = sourceDatabase(source);
    try { await backup(db, join(before, "workspace.sqlite")); } finally { db.close(); }
    // Publication is object-before-reference and immutable objects are retained,
    // so copying them after the consistent SQLite snapshot is safe while writers
    // append. Unreferenced complete objects are retained as recovery material.
    for (const directory of ["blobs", "objects", "pages"]) await copyImmutableTree(join(source, directory), join(before, directory));
    evidence.before = await inspectWorkspaceStorage(before, { verifyObjects: true, semantic: true });
    await cp(before, candidate, { recursive: true, errorOnExist: true, force: false });
    evidence.status = "migrating-copy"; await save();
    const workspace = await createWorkspace({ dataDir: candidate, bootstrap: false, glossaryPath: false, refreshRelations: false, repairStorage: true });
    try {
      // Verify every immutable revision and every frozen preview after repair;
      // fresh lists and current documents alone cannot prove preserved history.
      for (const row of workspace.db.prepare("SELECT document_id,revision FROM revisions ORDER BY document_id,revision").all()) await workspace.revision(row.document_id, row.revision);
      for (const row of workspace.db.prepare("SELECT id FROM authoring_previews ORDER BY id").all()) await workspace.previewSnapshot(row.id);
    } finally { await workspace.close(); }
    evidence.after = await inspectWorkspaceStorage(candidate, { verifyObjects: true, semantic: true });
    evidence.differences = Object.entries(evidence.before.fingerprints).filter(([table, state]) => canonical(state) !== canonical(evidence.after.fingerprints[table]))
      .map(([table, state]) => ({ table, before: state, after: evidence.after.fingerprints[table] }));
    check(!evidence.differences.length, "STORAGE_COPY_CHANGED", "验证副本的业务数据发生变化；未替换源工作台。", 409, { tables: evidence.differences.map((item) => item.table) });
    check(evidence.before.readingProjection.sha256 === evidence.after.readingProjection.sha256
      && evidence.before.readingProjection.activeMs === evidence.after.readingProjection.activeMs,
    "STORAGE_READING_CHANGED", "验证副本的原始阅读活动投影发生变化；未替换源工作台。", 409);
    check(evidence.after.readingProjection.stored.matchesOracle, "STORAGE_READING_PROJECTION_INVALID", "验证副本的阅读活动统计与原始记录不一致；未替换源工作台。", 409);
    evidence.status = "validated"; evidence.completedAt = new Date().toISOString(); await save();
    return { ...evidence, evidencePath };
  } catch (error) {
    evidence.status = "failed"; evidence.completedAt = new Date().toISOString(); evidence.error = { code: error.code || "INTERNAL_ERROR", message: error.message };
    await save(); throw error;
  }
}
