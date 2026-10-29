import { check } from "./errors.mjs";
import { sqlName } from "./sync-schema.mjs";

// Explicit local maintenance only. No constructor, scheduler or desktop path
// invokes this module. Business rows, transport receipts and published objects
// are not deletion candidates.
export const SYNC_RETENTION_DEFAULTS = Object.freeze({
  maxStages: 2, maxStageRows: 256, maxRootRows: 8192,
  maxRootBytes: 4 * 1024 * 1024, maxPayloadParts: 256,
});

// Include every persistent field passed to WorkspaceSync.encode, plus the
// direct state/device JSON fields. A new table or column blocks collection
// until its roots have been deliberately classified here.
export const SYNC_RETENTION_ROOTS = Object.freeze([
  ["sync_state", "value", "plain"], ["sync_client_state", "value", "plain"],
  ["sync_devices", "payload", "json"], ["sync_entities", "value", "entity"],
  ["sync_journal", "payload", "json"], ["sync_receipts", "payload", "json"],
  ["sync_outbox", "payload", "json"], ["sync_conflicts", "payload", "json"],
  ["sync_conflict_history", "payload", "json"],
  ["sync_snapshot_stages", "descriptor", "json"], ["sync_snapshot_chunks", "payload", "json"],
  ["sync_snapshot_rows", "payload", "json"], ["sync_snapshot_indexes", "payload", "json"],
].map(([table, column, kind]) => Object.freeze({ table, column, kind })));

const schemas = new Map(Object.entries({
  sync_state: "key value", sync_client_state: "key value",
  sync_entities: "entity key version hash value", sync_dirty: "entity key",
  sync_dirty_groups: "ordinal entity key group_id",
  sync_journal: "sequence replica_id request_id payload created_at",
  sync_receipts: "replica_id request_id digest payload",
  sync_outbox: "request_id payload status created_at",
  sync_conflicts: "id version status payload created_at",
  sync_conflict_history: "conflict_id version payload",
  sync_devices: "id request_id payload", sync_reference_ranges: "series start end next",
  sync_payloads: "digest part value",
  sync_snapshot_stages: "snapshot_id history_id sequence sha256 size descriptor status",
  sync_snapshot_chunks: "snapshot_id chunk_index payload ready",
  sync_snapshot_rows: "snapshot_id entity key chunk_index payload",
  sync_snapshot_indexes: "snapshot_id document_id revision sha256 payload",
}).map(([table, columns]) => [table, columns.split(" ").sort().join(" ")]));
const stageChildren = ["sync_snapshot_indexes", "sync_snapshot_rows", "sync_snapshot_chunks"];
const payloadMarker = "$readerSyncPayload", currentMarker = "$readerSyncCurrent";
const cursorKey = "retentionPayloadCursor";
const hashPattern = /^[a-f0-9]{64}$/;

function blocked(code, details = {}) { return { code, ...details }; }
function inventory(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(name) GLOB 'sync_*' ORDER BY name LIMIT 65").all();
  if (rows.length > 64) return { blocked: blocked("SYNC_RETENTION_SCHEMA", { reason: "table_limit" }) };
  const tables = new Set(rows.map(row => row.name));
  for (const table of tables) {
    if (!schemas.has(table)) return { blocked: blocked("SYNC_RETENTION_SCHEMA", { table, reason: "unknown_table" }) };
    const columns = db.prepare("PRAGMA table_info(" + sqlName(table) + ")").all().map(row => row.name).sort().join(" ");
    if (columns !== schemas.get(table)) return { blocked: blocked("SYNC_RETENTION_SCHEMA", { table, reason: "unknown_columns" }) };
  }
  for (const table of ["sync_state", "sync_payloads", "sync_entities", "sync_outbox", "sync_conflicts", "sync_conflict_history", "sync_journal", "sync_receipts"])
    if (!tables.has(table)) return { blocked: blocked("SYNC_RETENTION_SCHEMA", { table, reason: "missing_table" }) };
  const stageTableCount = ["sync_snapshot_stages", ...stageChildren].filter(table => tables.has(table)).length;
  if (stageTableCount !== 0 && stageTableCount !== stageChildren.length + 1)
    return { blocked: blocked("SYNC_RETENTION_SCHEMA", { reason: "incomplete_snapshot_schema" }) };
  return { tables };
}

function cleanStages(engine, tables, limits) {
  const db = engine.db, result = { visited: 0, stagesDeleted: 0, rowsDeleted: 0, hasMore: false, blocked: [] };
  if (!tables.has("sync_snapshot_stages") || !limits.maxStages || !limits.maxStageRows) return result;
  const stages = db.prepare("SELECT snapshot_id,history_id,sequence,status FROM sync_snapshot_stages WHERE status IN ('installed','abandoned') ORDER BY snapshot_id LIMIT ?").all(limits.maxStages + 1);
  result.hasMore = stages.length > limits.maxStages;
  let available = limits.maxStageRows;
  for (const stage of stages.slice(0, limits.maxStages)) {
    if (!available) { result.hasMore = true; break; }
    result.visited++;
    if (stage.status === "installed" && !(engine.state("snapshotInstalled") === stage.snapshot_id
      && engine.state("historyId") === stage.history_id && engine.cursor >= stage.sequence && engine.state("importComplete") === "1")) {
      result.blocked.push(blocked("SYNC_RETENTION_STAGE_GUARD", { snapshotId: stage.snapshot_id })); continue;
    }
    for (const table of stageChildren) {
      if (!available) break;
      const deleted = db.prepare("DELETE FROM " + sqlName(table) + " WHERE rowid IN (SELECT rowid FROM " + sqlName(table) + " WHERE snapshot_id=? LIMIT ?)").run(stage.snapshot_id, available).changes;
      result.rowsDeleted += deleted; available -= deleted;
    }
    const childrenRemain = stageChildren.some(table => db.prepare("SELECT 1 FROM " + sqlName(table) + " WHERE snapshot_id=? LIMIT 1").get(stage.snapshot_id));
    if (childrenRemain || !available) { result.hasMore = true; continue; }
    // The immutable installation identity stays in sync_state. Missing stages
    // are terminal to in-flight prepare/saveChunk continuations.
    const deleted = db.prepare("DELETE FROM sync_snapshot_stages WHERE snapshot_id=? AND status=?").run(stage.snapshot_id, stage.status).changes;
    result.stagesDeleted += deleted; result.rowsDeleted += deleted; available -= deleted;
  }
  return result;
}

function rootReference(row, root) {
  const input = row.value;
  if (input === null && root.kind === "entity") return {};
  if (typeof input !== "string") return { blocked: blocked("SYNC_RETENTION_ROOT", { table: root.table, reason: "non_text_root" }) };
  let value;
  try { value = JSON.parse(input); }
  catch {
    return root.kind === "plain" && !input.includes("$readerSync") ? {}
      : { blocked: blocked("SYNC_RETENTION_ROOT", { table: root.table, reason: "invalid_json" }) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const markerKeys = Object.keys(value).filter(key => key.startsWith("$readerSync"));
  if (!markerKeys.length) return {};
  if (Object.keys(value).length !== 1 || markerKeys.length !== 1)
    return { blocked: blocked("SYNC_RETENTION_MARKER", { table: root.table, reason: "ambiguous_marker" }) };
  const key = markerKeys[0], ref = value[key];
  if (key === payloadMarker && ref && typeof ref === "object" && !Array.isArray(ref)
    && Object.keys(ref).sort().join(" ") === "digest length" && typeof ref.digest === "string" && hashPattern.test(ref.digest)
    && Number.isSafeInteger(ref.length) && ref.length >= 0) return { digest: ref.digest };
  if (key === currentMarker && root.kind === "entity" && ref && typeof ref === "object" && !Array.isArray(ref)
    && Object.keys(ref).sort().join(" ") === "entity hash key version" && ref.version === 1
    && ref.entity === row.entity && ref.key === row.key && ref.hash === row.hash && hashPattern.test(ref.hash)) return {};
  return { blocked: blocked("SYNC_RETENTION_MARKER", { table: root.table, reason: "unknown_or_invalid_marker" }) };
}

function proveRoots(db, tables, limits, result) {
  const live = new Set();
  for (const root of SYNC_RETENTION_ROOTS) {
    if (!tables.has(root.table)) continue;
    const extra = root.kind === "entity" ? ",entity,key,hash" : "";
    const remaining = limits.maxRootRows - result.rootRows;
    for (const row of db.prepare("SELECT " + sqlName(root.column) + " AS value" + extra + " FROM " + sqlName(root.table) + " LIMIT ?").iterate(remaining + 1)) {
      if (result.rootRows >= limits.maxRootRows) return { blocked: blocked("SYNC_RETENTION_BUDGET", { reason: "root_rows", limit: limits.maxRootRows }) };
      const bytes = typeof row.value === "string" ? Buffer.byteLength(row.value) : 0;
      if (result.rootBytes + bytes > limits.maxRootBytes) return { blocked: blocked("SYNC_RETENTION_BUDGET", { reason: "root_bytes", limit: limits.maxRootBytes }) };
      result.rootRows++; result.rootBytes += bytes;
      const reference = rootReference(row, root);
      if (reference.blocked) return reference;
      if (reference.digest) live.add(reference.digest);
    }
  }
  result.liveDigests = live.size;
  return { live };
}

function cleanPayloads(engine, tables, limits) {
  const db = engine.db, result = { proof: "empty", rootRows: 0, rootBytes: 0, liveDigests: 0, partsVisited: 0, partsDeleted: 0, digestsDeleted: 0, hasMore: false };
  if (!db.prepare("SELECT 1 FROM sync_payloads LIMIT 1").get()) return result;
  result.proof = "blocked";
  if (!limits.maxPayloadParts) { result.blocked = blocked("SYNC_RETENTION_BUDGET", { reason: "payload_parts", limit: 0 }); return result; }
  const proof = proveRoots(db, tables, limits, result);
  if (proof.blocked) { result.blocked = proof.blocked; return result; }
  result.proof = "complete";
  const cursor = engine.state(cursorKey) || "";
  if (cursor && !hashPattern.test(cursor)) { result.proof = "blocked"; result.blocked = blocked("SYNC_RETENTION_MARKER", { reason: "invalid_sweep_cursor" }); return result; }
  const rows = db.prepare("SELECT digest,part FROM sync_payloads WHERE digest>? ORDER BY digest,part LIMIT ?").all(cursor, limits.maxPayloadParts + 1);
  result.partsVisited = rows.length;
  const considered = rows.slice(0, limits.maxPayloadParts), groups = new Map();
  for (const row of rows) {
    if (!hashPattern.test(row.digest) || !Number.isSafeInteger(row.part) || row.part < 0) {
      result.proof = "blocked"; result.blocked = blocked("SYNC_RETENTION_MARKER", { reason: "invalid_payload_identity" }); return result;
    }
  }
  for (const row of considered) {
    if (!groups.has(row.digest)) groups.set(row.digest, 0);
    groups.set(row.digest, groups.get(row.digest) + 1);
  }
  for (const [digest, parts] of groups) {
    if (proof.live.has(digest)) continue;
    if (rows.length > considered.length && rows.at(-1).digest === digest) {
      // Never remove a prefix of a digest: encode() treats any surviving part
      // as an existing complete payload. A later encode of identical content
      // must not adopt an intentionally half-deleted object.
      result.blocked = blocked("SYNC_RETENTION_BUDGET", { reason: "indivisible_payload", limit: limits.maxPayloadParts, digest });
      continue;
    }
    const deleted = db.prepare("DELETE FROM sync_payloads WHERE digest=?").run(digest).changes;
    check(deleted === parts, "SYNC_RETENTION_INTEGRITY", "同步分块在回收证明后发生变化。", 409);
    result.partsDeleted += deleted; result.digestsDeleted++;
  }
  const next = considered.at(-1)?.digest || "";
  result.hasMore = Boolean(next && db.prepare("SELECT 1 FROM sync_payloads WHERE digest>? LIMIT 1").get(next));
  // This cursor only bounds the sweep. Each call proves all live roots again
  // in its own transaction; it never reuses a stale reachability proof.
  engine.setState(cursorKey, result.hasMore ? next : "");
  return result;
}

/** Synchronous, bounded, explicit maintenance with no network/R2 operations. */
export function maintainSyncRetention(engine, options = {}) {
  check(engine && typeof engine.transact === "function" && engine.db, "SYNC_RETENTION_CONFIGURATION", "同步维护需要完整的事务引擎。", 500);
  const limits = { ...SYNC_RETENTION_DEFAULTS, ...options };
  const caps = { maxStages: 100, maxStageRows: 100000, maxRootRows: 1000000, maxRootBytes: 128 * 1024 * 1024, maxPayloadParts: 100000 };
  for (const [key, cap] of Object.entries(caps)) check(Number.isSafeInteger(limits[key]) && limits[key] >= 0 && limits[key] <= cap, "SYNC_RETENTION_CONFIGURATION", "同步维护预算无效。", 400, { key });
  return engine.transact(() => {
    const schema = inventory(engine.db);
    if (schema.blocked) return { version: 1, limits, stages: { rowsDeleted: 0, stagesDeleted: 0 }, payloads: { proof: "blocked", partsDeleted: 0, digestsDeleted: 0, blocked: schema.blocked } };
    const stages = cleanStages(engine, schema.tables, limits);
    const payloads = cleanPayloads(engine, schema.tables, limits);
    return { version: 1, limits, stages, payloads };
  });
}
