import { canonical, check, hash, object } from "./errors.mjs";

export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_MAX_BYTES = 16 * 1024 * 1024;
export const SYNC_MAX_MUTATIONS = 10000;
// Ordering follows foreign-key dependencies. Configuration, auth/session secrets,
// caches, device counters and derived reading totals never enter replication.
export const SYNC_TABLES = ["files", "collections", "documents", "revisions", "reading", "object_preferences", "insights", "references_map", "change_requests", "legacy_aliases", "legacy_items", "glossary", "proposals", "conversions", "authoring_previews", "authoring_drafts", "bibliographic_works", "bibliographic_documents", "document_relations", "insight_reviews", "reading_sessions", "reading_activity", "receipts", "metadata"];
const metadataKeys = new Set(["plan", "planVersion", "currentId"]);
const derived = { reading_sessions: new Set(["active_ms", "last_activity_ms"]), reading_activity: new Set(["accepted_ms"]) };
export const sqlName = (name) => '"' + name.replaceAll('"', '""') + '"';
export const rowHash = (value) => value === null ? null : hash(canonical(value));
export const stateKey = (entity, key) => entity + "\n" + key;

// Transport packing must not erase original business transaction boundaries.
// Omission is the historical protocol-v1 representation: one atomic group.
export function validateAtomicGroups(input, mutationCount) {
  if (input === undefined) return [Array.from({ length: mutationCount }, (_, index) => index)];
  check(Array.isArray(input) && input.length > 0 && input.length <= mutationCount, "SYNC_SCHEMA", "同步事务分组无效。", 400);
  const seen = new Set();
  const groups = input.map((group) => {
    check(Array.isArray(group) && group.length > 0 && group.length <= mutationCount, "SYNC_SCHEMA", "同步事务分组无效。", 400);
    return group.map((index) => {
      check(Number.isSafeInteger(index) && index >= 0 && index < mutationCount && !seen.has(index), "SYNC_SCHEMA", "同步事务分组包含重复或无效的记录位置。", 400);
      seen.add(index); return index;
    });
  });
  check(seen.size === mutationCount, "SYNC_SCHEMA", "同步事务分组缺少记录。", 400);
  return groups;
}

export function syncSchema(db) {
  const result = new Map();
  for (const name of SYNC_TABLES) {
    const columns = db.prepare("PRAGMA table_info(" + sqlName(name) + ")").all();
    if (!columns.length) continue;
    const keys = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    check(keys.length, "SYNC_SCHEMA", "同步数据表缺少主键。", 500);
    result.set(name, { name, keys, columns: columns.map((column) => column.name).filter((column) => !derived[name]?.has(column)) });
  }
  return result;
}
export function normalizeRow(schema, entity, input) {
  if (input === null) return null;
  const table = schema.get(entity); check(table, "SYNC_ENTITY", "不允许同步此类数据。", 400);
  object(input, "同步记录");
  const value = Object.fromEntries(table.columns.map((name) => [name, input[name] ?? null]));
  for (const [key, item] of Object.entries(input)) check(table.columns.includes(key) || derived[entity]?.has(key), "SYNC_SCHEMA", "同步记录含未知字段。", 400, { entity, field: key });
  for (const item of Object.values(value)) check(item === null || typeof item === "string" || typeof item === "number" && Number.isFinite(item), "SYNC_SCHEMA", "同步字段须为数据库标量。", 400);
  if (entity === "metadata") check(metadataKeys.has(value.key), "SYNC_ENTITY", "此设置只能保存在本机。", 400);
  return value;
}
export function rowKey(table, row) { return canonical(table.keys.map((key) => row[key])); }
export function allowedRow(entity, row) { return entity !== "metadata" || metadataKeys.has(row.key); }
export function validateMutation(schema, mutation, { incoming = false } = {}) {
  object(mutation, "同步修改");
  const table = schema.get(mutation.entity); check(table, "SYNC_ENTITY", "不允许同步此类数据。", 400);
  check(typeof mutation.key === "string" && mutation.key.length <= 2048, "SYNC_SCHEMA", "同步主键无效。", 400);
  let keys; try { keys = JSON.parse(mutation.key); } catch {}
  check(Array.isArray(keys) && keys.length === table.keys.length && keys.every((key) => typeof key === "string" || typeof key === "number" && Number.isFinite(key)) && canonical(keys) === mutation.key, "SYNC_SCHEMA", "同步主键格式无效。", 400);
  if (mutation.entity === "metadata") check(metadataKeys.has(keys[0]), "SYNC_ENTITY", "此设置只能保存在本机。", 400);
  const value = normalizeRow(schema, mutation.entity, mutation.value);
  check(value === null || rowKey(table, value) === mutation.key, "SYNC_SCHEMA", "同步主键与记录不一致。", 400);
  const expected = incoming ? mutation : mutation.expected;
  check(expected && Number.isSafeInteger(expected.version) && expected.version >= (incoming ? 1 : 0) && (expected.hash === null || /^[a-f0-9]{64}$/.test(expected.hash)), "SYNC_SCHEMA", "同步版本无效。", 400);
  check(expected.version !== 0 || expected.hash === null, "SYNC_SCHEMA", "尚不存在的同步记录不能带有摘要。", 400);
  if (incoming) check(expected.hash === rowHash(value), "SYNC_INTEGRITY", "同步记录摘要不符。", 409);
  return { ...mutation, value };
}

export function validateSyncState(schema, state) {
  const checked = validateMutation(schema, { ...state, expected: { version: state?.version, hash: state?.hash } });
  check(state.hash === rowHash(checked.value) && (state.version !== 0 || checked.value === null), "SYNC_INTEGRITY", "同步确认的内容与版本摘要不一致。", 409);
  return { entity: checked.entity, key: checked.key, value: checked.value, version: state.version, hash: state.hash };
}

export function collectSyncObjects(input) {
  const refs = new Map(), seen = new Set();
  const jsonColumns = new Set(["payload", "content", "text_index", "fingerprints", "resources", "report", "authoring", "identity", "metadata", "value", "start_position", "end_position", "start_input", "end_input"]);
  function visit(value, parseString = false) {
    if (typeof value === "string") { if (parseString && (value[0] === "{" || value[0] === "[") && value.length < SYNC_MAX_BYTES) { try { visit(JSON.parse(value)); } catch {} } return; }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value.$readerObject) visit(value.$readerObject);
    if (typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && value.size > 0) {
      const key = value.key || value.storageKey || "blobs/" + value.sha256;
      if (key === "objects/sha256/" + value.sha256 || key === "blobs/" + value.sha256) refs.set(key, { key, sha256: value.sha256, size: value.size, version: 1, kind: key.startsWith("objects/") ? "object" : "blob" });
    }
    for (const [key, item] of Object.entries(value)) visit(item, jsonColumns.has(key));
  }
  visit(input); return [...refs.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function installSyncTriggers(db, schema) {
  const statements = [];
  for (const table of schema.values()) {
    const name = sqlName(table.name), key = (prefix) => "json_array(" + table.keys.map((column) => prefix + "." + sqlName(column)).join(",") + ")";
    const filter = table.name === "metadata" ? " AND NEW.key IN ('plan','planVersion','currentId')" : "";
    const oldFilter = table.name === "metadata" ? " AND OLD.key IN ('plan','planVersion','currentId')" : "";
    for (const [event, prefix, condition] of [["INSERT", "NEW", filter], ["UPDATE", "NEW", filter], ["DELETE", "OLD", oldFilter]]) {
      const trigger = sqlName("reader_sync_" + table.name + "_" + event.toLowerCase());
      // Projection-only writes and identical retries are not new source facts.
      const changed = event === "UPDATE" ? " AND (" + table.columns.map((column) => `OLD.${sqlName(column)} IS NOT NEW.${sqlName(column)}`).join(" OR ") + ")" : "";
      statements.push(`DROP TRIGGER IF EXISTS ${trigger}; CREATE TRIGGER ${trigger} AFTER ${event} ON ${name}
        WHEN (SELECT value FROM sync_state WHERE key='applying')='0'${condition}${changed}
        BEGIN INSERT INTO sync_dirty(entity,key) VALUES('${table.name}',${key(prefix)}) ON CONFLICT(entity,key) DO NOTHING;
        INSERT INTO sync_dirty_groups(entity,key,group_id) VALUES('${table.name}',${key(prefix)},COALESCE((SELECT value FROM sync_state WHERE key='writeGroup'),'direct-'||lower(hex(randomblob(16))))) ON CONFLICT(entity,key,group_id) DO NOTHING; END;`);
    }
  }
  const digest = hash(statements.join("\n"));
  if (db.prepare("SELECT value FROM sync_state WHERE key='triggerSchema'").get()?.value === digest) return;
  db.transaction(() => {
    for (const statement of statements) db.exec(statement);
    db.prepare("INSERT INTO sync_state VALUES('triggerSchema',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(digest);
  });
}
