import { randomUUID } from "node:crypto";
import { canonical, check, hash, identifier, json, object } from "./errors.mjs";
import { localActor } from "./actor.mjs";
import { projectReadingChanges } from "./reading-projection.mjs";
import { applySchemaMigrations } from "./schema-migrations.mjs";
import { canInstallSyncSnapshot, restoreEmptySyncSnapshot } from "./sync-snapshot.mjs";
import { SyncCurrentValues } from "./sync-current-values.mjs";
import { allowedRow, collectSyncObjects, installSyncTriggers, normalizeRow, rowHash, rowKey, sqlName, stateKey, syncSchema, validateMutation, validateSyncState, validateAtomicGroups, SYNC_MAX_BYTES, SYNC_MAX_MUTATIONS, SYNC_PROTOCOL_VERSION } from "./sync-schema.mjs";
export { collectSyncObjects } from "./sync-schema.mjs";

const parse = (value) => value == null ? null : JSON.parse(value);
const stamp = () => new Date().toISOString();
const empty = { version: 0, hash: null, value: null };
const referenceRangeSize = 1_000_000;
const transactionObserver = Symbol.for("continuous-reader.sync-transaction-observer");
const immutableEntities = new Set(["files", "revisions", "reading_activity"]);
// Packing targets, not limits on an indivisible business transaction. Keeping
// routine batches small also keeps their journal and receipt inline in D1.
export const SYNC_BATCH_TARGET_MUTATIONS = 256;
export const SYNC_BATCH_TARGET_BYTES = 128 * 1024;
const businessVersions = { documents: "version", collections: "version", insights: "version", change_requests: "version", document_relations: "version", glossary: "revision" };
const constraintFailure = (error) => error?.code === "SYNC_CONSTRAINT" || /SQLITE_CONSTRAINT|(?:UNIQUE|FOREIGN KEY|NOT NULL|CHECK) constraint failed/i.test(String(error?.code || "") + " " + String(error?.message || ""));

export async function createWorkspaceSync(workspace, options = {}) {
  const sync = new WorkspaceSync(workspace, options);
  workspace.sync = sync;
  return sync;
}

export class WorkspaceSync {
  constructor(workspace, { replicaId, mode = "client", currentValues = false } = {}) {
    check(["client", "server"].includes(mode), "SYNC_CONFIGURATION", "同步运行模式无效。", 500);
    this.workspace = workspace; this.db = workspace.db; this.mode = mode;
    applySchemaMigrations(this.db, "replication", [{ version: 1, name: "durable-replication-state", sql: `
      CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_entities (entity TEXT NOT NULL,key TEXT NOT NULL,version INTEGER NOT NULL,hash TEXT,value TEXT,PRIMARY KEY(entity,key));
      CREATE TABLE IF NOT EXISTS sync_dirty (entity TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(entity,key));
      CREATE TABLE IF NOT EXISTS sync_dirty_groups (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,entity TEXT NOT NULL,key TEXT NOT NULL,group_id TEXT NOT NULL,UNIQUE(entity,key,group_id));
      CREATE TABLE IF NOT EXISTS sync_journal (sequence INTEGER PRIMARY KEY AUTOINCREMENT,replica_id TEXT NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_receipts (replica_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(replica_id,request_id));
      CREATE TABLE IF NOT EXISTS sync_outbox (request_id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_conflicts (id TEXT PRIMARY KEY,version INTEGER NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_conflict_history (conflict_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(conflict_id,version));
      CREATE TABLE IF NOT EXISTS sync_devices (id TEXT PRIMARY KEY,request_id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_reference_ranges (series TEXT PRIMARY KEY,start INTEGER NOT NULL,end INTEGER NOT NULL,next INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_payloads (digest TEXT NOT NULL,part INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(digest,part));
    ` }, { version: 2, name: "replication-work-queues", sql: `
      CREATE INDEX IF NOT EXISTS sync_dirty_groups_group ON sync_dirty_groups(group_id,entity,key);
      CREATE INDEX IF NOT EXISTS sync_outbox_pending ON sync_outbox(status,created_at,request_id);
      CREATE INDEX IF NOT EXISTS sync_conflicts_status ON sync_conflicts(status,created_at,id);
    ` }, { version: 3, name: "bounded-historical-reading-bootstrap", sql: `
      UPDATE sync_dirty_groups SET group_id='bootstrap-reading-'||json_extract(key,'$[0]')||'-'||CAST((json_extract(key,'$[1]')-1)/256 AS INTEGER)
      WHERE entity='reading_activity' AND group_id='bootstrap-session-'||json_extract(key,'$[0]');
    ` }]);
    for (const [key, value] of Object.entries({ applying: "0", cursor: "0", replicaId: replicaId || "replica-" + randomUUID(), workspaceId: "workspace-" + randomUUID(), enrolled: "0" })) this.db.prepare("INSERT OR IGNORE INTO sync_state VALUES(?,?)").run(key, value);
    this.replicaId = this.state("replicaId");
    check(!replicaId || replicaId === this.replicaId, "SYNC_DEVICE_CHANGED", "已有同步身份不能被覆盖。", 409);
    this.schema = syncSchema(this.db);
    this.currentValues = new SyncCurrentValues(this, { enabled: currentValues });
    installSyncTriggers(this.db, this.schema);
    if (!this.state("initialized")) this.db.transaction(() => {
      this.bootstrapCurrentRevisions = new Map(this.db.prepare("SELECT id,current_revision FROM documents").all().map((row) => [row.id, row.current_revision]));
      for (const table of this.schema.values()) {
        const append = (row) => { if (allowedRow(table.name, row)) {
          const key = rowKey(table, row);
          this.db.prepare("INSERT OR IGNORE INTO sync_dirty VALUES(?,?)").run(table.name, key);
          this.db.prepare("INSERT OR IGNORE INTO sync_dirty_groups(entity,key,group_id) VALUES(?,?,?)").run(table.name, key, this.bootstrapGroup(table.name, row, key));
        } };
        // Bootstrap records keys/dependencies, not copies of all document and
        // receipt bodies in memory. The frozen outbox reads one group later.
        const columns = [...new Set([...table.keys, ...({ collections: ["parent_id"], references_map: ["insight_id"] }[table.name] || [])])];
        if (table.name === "collections") {
          const rows = this.db.prepare("SELECT " + columns.map(sqlName).join(",") + " FROM collections").all();
          const parents = new Map(rows.map((row) => [row.id, row.parent_id]));
          const depth = (row) => { const seen = new Set(); let at = row.parent_id; while (at && !seen.has(at)) { seen.add(at); at = parents.get(at); } return seen.size; };
          rows.sort((a, b) => depth(a) - depth(b)); for (const row of rows) append(row);
          continue;
        }
        let cursor;
        const keys = table.keys.map(sqlName), select = "SELECT " + columns.map(sqlName).join(",") + " FROM " + sqlName(table.name);
        for (;;) {
          const predicate = cursor ? keys.length === 1 ? keys[0] + ">?" : "(" + keys.join(",") + ")>(" + keys.map(() => "?").join(",") + ")" : "";
          const rows = this.db.prepare(select + (predicate ? " WHERE " + predicate : "") + " ORDER BY " + keys.join(",") + " LIMIT 512").all(...(cursor || []));
          for (const row of rows) append(row);
          if (rows.length < 512) break;
          cursor = table.keys.map((key) => rows.at(-1)[key]);
        }
      }
      this.setState("initialized", "1");
      this.bootstrapCurrentRevisions = null;
    });
    // Observe transaction identity without changing the operation or its atomic
    // boundary. Direct SQL writes receive individual IDs from the triggers.
    if (!this.db[transactionObserver]) {
      const transaction = this.db.transaction.bind(this.db), context = { depth: 0, internal: 0, listeners: new Set() };
      this.db[transactionObserver] = context;
      this.db.transaction = (operation) => {
        if (context.depth) return operation();
        const grouped = !context.internal;
        const result = transaction(() => {
          context.depth++;
          if (grouped) this.setState("writeGroup", "transaction-" + randomUUID());
          try { return operation(); }
          finally { if (grouped) this.db.prepare("DELETE FROM sync_state WHERE key='writeGroup'").run(); context.depth--; }
        });
        // Notify only after commit. A scheduler failure never changes the
        // outcome of an already durable user command.
        if (grouped) for (const listener of context.listeners) { try { listener(); } catch {} }
        return result;
      };
    }
  }
  // Replication maintenance changes only replication tables, or applies rows
  // with the capture triggers disabled. It must not manufacture a local write
  // group on an empty manifest/pull/status check. Keep the actual transaction
  // adapter in the call path (including rollback/error behavior).
  transact(operation) {
    const context = this.db[transactionObserver];
    if (!context) return this.db.transaction(operation);
    context.internal++;
    try { return this.db.transaction(operation); }
    finally { context.internal--; }
  }
  onLocalCommit(listener) {
    check(typeof listener === "function", "SYNC_CONFIGURATION", "同步监听器无效。", 500);
    const listeners = this.db[transactionObserver].listeners;
    listeners.add(listener); return () => listeners.delete(listener);
  }
  canInstallSnapshot() { return canInstallSyncSnapshot(this); }
  restoreSnapshot(options) { return restoreEmptySyncSnapshot(this, options); }
  bindHistory(historyId) {
    identifier(historyId, "同步历史标识");
    const previous = this.state("historyId");
    check(!previous || previous === historyId, "SYNC_HISTORY_CHANGED", "远端同步历史已改变；本地资料和待同步内容已保留。", 409);
    this.transact(() => this.setState("historyId", historyId));
  }
  bootstrapGroup(entity, row, key) {
    if (entity === "documents") return "bootstrap-document-" + row.id;
    if (entity === "revisions") return this.bootstrapCurrentRevisions?.get(row.document_id) === row.revision ? "bootstrap-document-" + row.document_id : "bootstrap-revision-" + row.document_id + "-" + row.revision;
    if (entity === "insights") return "bootstrap-insight-" + row.id;
    if (["references_map", "insight_reviews"].includes(entity)) return "bootstrap-insight-" + row.insight_id;
    if (entity === "reading_sessions") return "bootstrap-session-" + row.id;
    if (entity === "reading_activity") return "bootstrap-reading-" + row.session_id + "-" + Math.floor((row.sequence - 1) / 256);
    if (entity === "metadata" && ["plan", "planVersion"].includes(row.key)) return "bootstrap-plan";
    return "bootstrap-" + entity + "-" + hash(key);
  }
  compactCheckpointGroups() {
    // A checkpoint is an overwriteable position, while its command receipts
    // remain immutable facts. Repeated unsent checkpoints need one current
    // position plus every receipt, not one unbounded connected component.
    // Only detach groups containing exactly one reading key and receipts. Any
    // transaction involving another business entity retains its atomic edges.
    // Keep the earliest edge so the current position precedes detached receipts.
    this.db.exec(`WITH checkpoints AS (
      SELECT g.ordinal,g.entity,g.key FROM sync_dirty_groups g
      WHERE g.entity='reading'
        AND EXISTS (SELECT 1 FROM sync_dirty d WHERE d.entity=g.entity AND d.key=g.key)
        AND NOT EXISTS (SELECT 1 FROM sync_dirty_groups other WHERE other.group_id=g.group_id AND other.entity NOT IN ('reading','receipts'))
        AND (SELECT COUNT(*) FROM sync_dirty_groups other WHERE other.group_id=g.group_id AND other.entity='reading')=1
    ), ordered AS (
      SELECT ordinal,ROW_NUMBER() OVER (PARTITION BY key ORDER BY ordinal) AS occurrence FROM checkpoints
    ) DELETE FROM sync_dirty_groups WHERE ordinal IN (
      SELECT ordinal FROM ordered WHERE occurrence>1
    )`);
  }
  dirtyGroup(groupId) {
    const first = groupId ? { group_id: groupId } : this.db.prepare("SELECT group_id FROM sync_dirty_groups ORDER BY ordinal LIMIT 1").get();
    if (!first) return this.db.prepare("SELECT entity,key FROM sync_dirty LIMIT ?").all(SYNC_MAX_MUTATIONS + 1);
    const byGroup = this.db.prepare("SELECT g.entity,g.key FROM sync_dirty_groups g JOIN sync_dirty d ON d.entity=g.entity AND d.key=g.key WHERE g.group_id=?");
    const byKey = this.db.prepare("SELECT group_id FROM sync_dirty_groups WHERE entity=? AND key=?");
    const groups = new Set([first.group_id]), queue = [first.group_id], rows = new Map();
    // Traverse the indexed connected component, not the entire offline backlog.
    // Transactions sharing an edited identity still travel atomically together.
    for (let at = 0; at < queue.length; at++) for (const row of byGroup.all(queue[at])) {
      const key = stateKey(row.entity, row.key);
      if (rows.has(key)) continue;
      rows.set(key, row);
      check(rows.size <= SYNC_MAX_MUTATIONS, "SYNC_BATCH_TOO_LARGE", "离线修改批次过大，需要先缩小同步范围。", 413);
      for (const { group_id } of byKey.all(row.entity, row.key)) if (!groups.has(group_id)) { groups.add(group_id); queue.push(group_id); }
    }
    return [...rows.values()];
  }
  dirtyBatch() {
    this.compactCheckpointGroups();
    // Inspect only a bounded prefix of group identities. Connected transactions
    // can be larger, but are never split to meet these packing targets.
    const candidates = [...new Set(this.db.prepare("SELECT group_id FROM sync_dirty_groups ORDER BY ordinal LIMIT ?").all(SYNC_BATCH_TARGET_MUTATIONS * 2).map((row) => row.group_id))];
    if (!candidates.length) candidates.push(undefined);
    const selected = new Map(), mutations = [], atomicGroups = []; let size = 0;
    for (const groupId of candidates) {
      const group = this.dirtyGroup(groupId).filter((row) => !selected.has(stateKey(row.entity, row.key)));
      if (!group.length) continue;
      const additions = [];
      for (const dirty of group) {
        const value = this.row(dirty.entity, dirty.key), known = this.known(dirty.entity, dirty.key);
        if (rowHash(value) !== known.hash) additions.push({ ...dirty, expected: { version: known.version, hash: known.hash }, value });
      }
      const extra = Buffer.byteLength(json(additions));
      if (selected.size && (selected.size + group.length > SYNC_BATCH_TARGET_MUTATIONS || size + extra > SYNC_BATCH_TARGET_BYTES)) break;
      for (const dirty of group) selected.set(stateKey(dirty.entity, dirty.key), dirty);
      if (additions.length) atomicGroups.push(additions.map((_, index) => mutations.length + index));
      mutations.push(...additions); size += extra;
      if (selected.size >= SYNC_BATCH_TARGET_MUTATIONS || size >= SYNC_BATCH_TARGET_BYTES) break;
    }
    return { group: [...selected.values()], mutations, atomicGroups };
  }
  state(key) { return this.db.prepare("SELECT value FROM sync_state WHERE key=?").get(key)?.value; }
  setState(key, value) { this.db.prepare("INSERT INTO sync_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value IS NOT excluded.value").run(key, String(value)); }
  constraintTransaction(operation) {
    try { return this.transact(operation); }
    catch (error) {
      check(!constraintFailure(error), "SYNC_CONSTRAINT", "同步记录与已有记录冲突；本机内容已保留，请修改重复内容后重试。", 409);
      throw error;
    }
  }
  encode(value) {
    const serialized = json(value);
    if (Buffer.byteLength(serialized) <= 48000 && !serialized.includes('"$readerSyncPayload"')) return serialized;
    const digest = hash(serialized);
    if (!this.db.prepare("SELECT digest FROM sync_payloads WHERE digest=? LIMIT 1").get(digest)) {
      let part = 0;
      for (let at = 0; at < serialized.length;) {
        let end = Math.min(at + 16000, serialized.length);
        if (end < serialized.length && /[\uD800-\uDBFF]/.test(serialized[end - 1])) end--;
        this.db.prepare("INSERT INTO sync_payloads VALUES(?,?,?)").run(digest, part++, serialized.slice(at, end)); at = end;
      }
    }
    return json({ $readerSyncPayload: { digest, length: serialized.length } });
  }
  decode(value) {
    const parsed = parse(value), ref = parsed?.$readerSyncPayload;
    if (!ref) return parsed;
    check(/^[a-f0-9]{64}$/.test(ref.digest) && Number.isSafeInteger(ref.length), "SYNC_INTEGRITY", "同步日志引用无效。", 500);
    const serialized = this.db.prepare("SELECT value FROM sync_payloads WHERE digest=? ORDER BY part").all(ref.digest).map((row) => row.value).join("");
    check(serialized.length === ref.length && hash(serialized) === ref.digest, "SYNC_INTEGRITY", "同步日志完整性检查失败。", 500);
    return JSON.parse(serialized);
  }
  receiptTransfer(replicaId, requestId, actor = localActor) {
    this.workspace.authorize(actor); identifier(replicaId, "设备标识"); identifier(requestId, "请求标识");
    const row = this.db.prepare("SELECT payload FROM sync_receipts WHERE replica_id=? AND request_id=?").get(replicaId, requestId);
    check(row, "SYNC_RECEIPT_MISSING", "同步回执不存在。", 404);
    const ref = parse(row.payload)?.$readerSyncPayload;
    check(ref && /^[a-f0-9]{64}$/.test(ref.digest) && Number.isSafeInteger(ref.length) && ref.length > 0, "SYNC_INTEGRITY", "分块回执引用无效。", 500);
    const parts = this.db.prepare("SELECT COUNT(*) AS count FROM sync_payloads WHERE digest=?").get(ref.digest).count;
    return { replicaId, requestId, sha256: ref.digest, length: ref.length, parts };
  }
  receiptParts(replicaId, requestId, after = 0, actor = localActor) {
    const transfer = this.receiptTransfer(replicaId, requestId, actor);
    check(Number.isSafeInteger(after) && after >= 0 && after < transfer.parts, "SYNC_CURSOR", "回执分页位置无效。", 400);
    const rows = this.db.prepare("SELECT part,value FROM sync_payloads WHERE digest=? AND part>=? ORDER BY part LIMIT 64").all(transfer.sha256, after);
    check(rows.length && rows.every((row, index) => row.part === after + index), "SYNC_INTEGRITY", "回执分块不连续。", 500);
    return { ...transfer, after, nextPart: after + rows.length, chunks: rows.map((row) => row.value) };
  }
  get cursor() { return Number(this.state("cursor")); }
  get head() { return this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS head FROM sync_journal").get().head; }
  status() {
    const pendingBatches = this.db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE status='pending'").get().count, dirty = this.db.prepare("SELECT COUNT(*) AS count FROM sync_dirty").get().count;
    return { replicaId: this.replicaId, workspaceId: this.state("workspaceId"), ...(this.state("historyId") ? { historyId: this.state("historyId") } : {}), cursor: this.cursor, enrolled: this.state("enrolled") === "1", pending: pendingBatches + dirty, pendingBatches, dirty, conflicts: this.db.prepare("SELECT COUNT(*) AS count FROM sync_conflicts WHERE status='pending'").get().count };
  }
  known(entity, key) { const row = this.db.prepare("SELECT version,hash,value FROM sync_entities WHERE entity=? AND key=?").get(entity, key); return row ? { ...row, value: this.currentValues.read(entity, key, row) } : { ...empty }; }
  remember(entity, key, value) { this.db.prepare("INSERT INTO sync_entities VALUES(?,?,?,?,?) ON CONFLICT(entity,key) DO UPDATE SET version=excluded.version,hash=excluded.hash,value=excluded.value").run(entity, key, value.version, value.hash, value.value === null ? null : this.currentValues.reference(entity, key, value) || this.encode(value.value)); }
  row(entity, key) {
    const table = this.schema.get(entity), keys = JSON.parse(key);
    const row = this.db.prepare("SELECT * FROM " + sqlName(entity) + " WHERE " + table.keys.map((name) => sqlName(name) + "=?").join(" AND ")).get(...keys);
    return row ? normalizeRow(this.schema, entity, row) : null;
  }
  manifest(actor = localActor) { this.workspace.authorize(actor); this.capture(); return { protocolVersion: SYNC_PROTOCOL_VERSION, features: ["atomic-groups-v1"], workspaceId: this.state("workspaceId"), head: this.head }; }
  capture() {
    return this.transact(() => {
      this.refreshPendingConflicts();
      if (this.mode === "client" && this.db.prepare("SELECT request_id FROM sync_outbox LIMIT 1").get()) return { captured: false, ...this.status() };
      if (this.mode === "client" && this.db.prepare("SELECT id FROM sync_conflicts WHERE status='pending' LIMIT 1").get()) return { captured: false, ...this.status() };
      let captured = false, requestId;
      do {
      const { group, mutations, atomicGroups } = this.dirtyBatch();
      const grouping = atomicGroups.length > 1 ? { atomicGroups } : {};
      if (!group.length) break;
      for (const dirty of group) { this.db.prepare("DELETE FROM sync_dirty WHERE entity=? AND key=?").run(dirty.entity, dirty.key); this.db.prepare("DELETE FROM sync_dirty_groups WHERE entity=? AND key=?").run(dirty.entity, dirty.key); }
      if (!mutations.length) continue;
      check(mutations.length <= SYNC_MAX_MUTATIONS && Buffer.byteLength(json(mutations)) <= SYNC_MAX_BYTES, "SYNC_BATCH_TOO_LARGE", "离线修改批次过大，需要先缩小同步范围。", 413);
      requestId = "sync-" + randomUUID(); captured = true;
      if (this.mode === "server") this.publish(this.replicaId, requestId, mutations.map((mutation) => ({ entity: mutation.entity, key: mutation.key, value: mutation.value, version: mutation.expected.version + 1, hash: rowHash(mutation.value) })), grouping.atomicGroups);
      else {
        const initialImport = this.state("importComplete") !== "1";
        const batch = { protocolVersion: SYNC_PROTOCOL_VERSION, replicaId: this.replicaId, requestId, initialImport,
          initialImportComplete: initialImport && !this.db.prepare("SELECT entity FROM sync_dirty LIMIT 1").get(), mutations, objects: collectSyncObjects(mutations), ...grouping };
        check(Buffer.byteLength(json(batch)) <= SYNC_MAX_BYTES, "SYNC_BATCH_TOO_LARGE", "完整同步批次超过传输限制；修改仍保留在本机待同步队列。", 413);
        this.assertPullable({ replicaId: this.replicaId, requestId, mutations: mutations.map((mutation) => ({ entity: mutation.entity, key: mutation.key, value: mutation.value, version: mutation.expected.version + 1, hash: rowHash(mutation.value) })), ...grouping });
        this.db.prepare("INSERT INTO sync_outbox VALUES(?,?,?,?)").run(requestId, this.encode(batch), "pending", stamp());
      }
      } while (this.mode === "server" || !captured);
      return { captured, ...(requestId ? { requestId } : {}), ...this.status() };
    });
  }
  pending({ limit = 1 } = {}) { check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "VALIDATION_FAILED", "同步批次数无效。"); return { batches: this.db.prepare("SELECT payload FROM sync_outbox WHERE status='pending' ORDER BY created_at,request_id LIMIT ?").all(limit).map((row) => this.decode(row.payload)) }; }
  assertPullable(payload) {
    // Count the whole transport representation, including deduplicated object
    // descriptors. Reserving only mutation bytes can freeze an unsendable batch.
    const sequence = Number.MAX_SAFE_INTEGER;
    const page = { transactions: [{ sequence, ...payload }], nextCursor: sequence, hasMore: false, objects: collectSyncObjects(payload) };
    check(Buffer.byteLength(json(page)) <= SYNC_MAX_BYTES - 256, "SYNC_BATCH_TOO_LARGE", "此原子事务的同步响应超过传输限制；内容已保留。", 413);
  }
  publish(replicaId, requestId, mutations, atomicGroups) {
    if (atomicGroups) validateAtomicGroups(atomicGroups, mutations.length);
    const payload = { replicaId, requestId, mutations, ...(atomicGroups ? { atomicGroups } : {}) };
    this.assertPullable(payload);
    for (const mutation of mutations) this.remember(mutation.entity, mutation.key, mutation);
    this.db.prepare("INSERT INTO sync_journal(replica_id,request_id,payload,created_at) VALUES(?,?,?,?)").run(replicaId, requestId, this.encode(payload), stamp());
    return { sequence: this.head, ...payload };
  }
  enroll(actor, input) {
    this.workspace.authorize(actor, "write"); identifier(input.replicaId, "设备标识"); identifier(input.requestId, "请求标识");
    return this.transact(() => {
      const existing = this.db.prepare("SELECT payload FROM sync_devices WHERE id=?").get(input.replicaId);
      if (existing) return parse(existing.payload);
      const referenceRanges = {};
      for (const series of ["Q", "N", "R"]) {
        const previous = this.db.prepare("SELECT value FROM counters WHERE series=?").get(series)?.value || 0;
        const start = Math.floor(previous / referenceRangeSize + 1) * referenceRangeSize, end = start + referenceRangeSize - 1;
        check(Number.isSafeInteger(end), "REFERENCE_LIMIT", "编号预留空间不足。", 409);
        this.db.prepare("UPDATE counters SET value=? WHERE series=?").run(end, series);
        referenceRanges[series] = { start, end };
      }
      const result = { replicaId: input.replicaId, referenceRanges, cursor: this.head, workspaceId: this.state("workspaceId") };
      this.db.prepare("INSERT INTO sync_devices VALUES(?,?,?)").run(input.replicaId, input.requestId, json(result)); return result;
    });
  }
  acceptEnrollment(input) {
    check(input.replicaId === this.replicaId, "SYNC_DEVICE_CHANGED", "编号范围属于另一台设备。", 409);
    this.transact(() => {
      for (const series of ["Q", "N", "R"]) {
        const range = input.referenceRanges?.[series]; check(range && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start > 0 && range.end >= range.start, "SYNC_SCHEMA", "设备编号范围无效。", 400);
        const existing = this.db.prepare("SELECT start,end FROM sync_reference_ranges WHERE series=?").get(series);
        check(!existing || existing.start === range.start && existing.end === range.end, "SYNC_DEVICE_CHANGED", "设备编号范围不能被覆盖。", 409);
        this.db.prepare("INSERT OR IGNORE INTO sync_reference_ranges VALUES(?,?,?,?)").run(series, range.start, range.end, range.start);
      }
      this.setState("enrolled", "1");
    });
    return this.status();
  }
  allocateReference(series) {
    const range = this.db.prepare("SELECT * FROM sync_reference_ranges WHERE series=?").get(series);
    if (!range) return null;
    check(range.next <= range.end, "REFERENCE_LIMIT", "离线编号范围已用完，请连接工作台重新分配。", 409);
    this.db.prepare("UPDATE sync_reference_ranges SET next=next+1 WHERE series=?").run(series);
    return "#" + series + String(range.next).padStart(5, "0");
  }
  async ensureObjects(value) {
    const missing = [];
    for (const ref of collectSyncObjects(value)) {
      const present = ref.key.startsWith("objects/") ? await this.workspace.resources.hasObject?.(ref) : await this.workspace.resources.has?.(ref.sha256);
      if (!present) missing.push(ref);
    }
    check(!missing.length, "SYNC_OBJECTS_MISSING", "同步记录所需文件尚未传输。", 409, { objects: missing });
  }
  async prepareRows(mutations) {
    await this.ensureObjects(mutations);
    const rows = mutations.filter((mutation) => mutation.entity === "revisions" && mutation.value).map((mutation) => mutation.value);
    return rows.length ? await this.workspace.prepareImportedRevisionIndexes(rows) : [];
  }
  constraintConflictIndexes(mutations, atomicGroups, prepared) {
    if (atomicGroups.length === 1) return new Set(atomicGroups[0]);
    // The full write already rolled back. Probe original components inside
    // rollback-only savepoints to locate a constraint rejection without
    // misclassifying independent activity facts as conflicting deletions.
    // Keep earlier valid components visible to later dependent components.
    const rejected = new Set(), byKey = new Map(mutations.map((row, index) => [stateKey(row.entity, row.key), index]));
    this.db.exec("SAVEPOINT reader_sync_constraint_probe");
    try {
      for (const group of atomicGroups) {
        this.db.exec("SAVEPOINT reader_sync_component_probe");
        try { this.applyRows(group.map((index) => mutations[index]), prepared); }
        catch (error) {
          this.db.exec("ROLLBACK TO reader_sync_component_probe");
          // A dependent row can fail semantic preparation after its rejected
          // parent. It belongs to the affected component as well.
          for (const index of group) rejected.add(index);
        } finally { this.db.exec("RELEASE reader_sync_component_probe"); }
      }
      for (const violation of this.db.prepare("PRAGMA foreign_key_check").all()) {
        const table = this.schema.get(violation.table);
        const row = table && this.db.prepare("SELECT * FROM " + sqlName(violation.table) + " WHERE rowid=?").get(violation.rowid);
        const index = row && byKey.get(stateKey(violation.table, rowKey(table, row)));
        if (Number.isInteger(index)) rejected.add(index);
        // A blocked parent deletion can be referenced by an unchanged row.
        // Mark only deleted parents, never unrelated immutable additions.
        else for (let at = 0; at < mutations.length; at++) if (mutations[at].entity === violation.parent && mutations[at].value === null) rejected.add(at);
      }
    } finally {
      this.db.exec("ROLLBACK TO reader_sync_constraint_probe");
      this.db.exec("RELEASE reader_sync_constraint_probe");
    }
    check(rejected.size, "SYNC_CONSTRAINT_SCOPE", "无法确定同步约束冲突的事务范围；整批内容已保留，请重试。", 503);
    return rejected;
  }
  async push(actor, input) {
    this.workspace.authorize(actor, "write"); object(input); identifier(input.replicaId, "设备标识"); identifier(input.requestId, "请求标识");
    check(Array.isArray(input.mutations) && input.mutations.length > 0 && input.mutations.length <= SYNC_MAX_MUTATIONS && Buffer.byteLength(json(input.mutations)) <= SYNC_MAX_BYTES, "SYNC_SCHEMA", "同步修改批次无效。", 400);
    const mutations = input.mutations.map((mutation) => validateMutation(this.schema, mutation));
    const atomicGroups = validateAtomicGroups(input.atomicGroups, mutations.length);
    check(new Set(mutations.map((mutation) => stateKey(mutation.entity, mutation.key))).size === mutations.length, "SYNC_SCHEMA", "同步批次含重复记录。", 400);
    const digest = hash(canonical({ mutations, initialImport: Boolean(input.initialImport), initialImportComplete: Boolean(input.initialImportComplete), ...(input.atomicGroups === undefined ? {} : { atomicGroups }) })), previous = this.db.prepare("SELECT digest,payload FROM sync_receipts WHERE replica_id=? AND request_id=?").get(input.replicaId, input.requestId);
    if (previous) { check(previous.digest === digest, "IDEMPOTENCY_CONFLICT", "同步请求标识已用于另一份修改。", 409); return this.decode(previous.payload); }
    const enrolled = this.db.prepare("SELECT payload FROM sync_devices WHERE id=?").get(input.replicaId);
    check(enrolled, "SYNC_DEVICE_NOT_ENROLLED", "请先登记同步设备。", 403);
    const device = parse(enrolled.payload);
    for (const mutation of mutations) if (mutation.value && ["references_map", "change_requests"].includes(mutation.entity) && this.known(mutation.entity, mutation.key).version === 0) {
      const reference = mutation.value.reference, match = /^#([QNR])([0-9]+)$/.exec(reference || ""), range = match && device.referenceRanges[match[1]], value = match && Number(match[2]);
      const firstImport = input.initialImport === true && !device.importComplete;
      check(match && (firstImport || Number.isSafeInteger(value) && value >= range.start && value <= range.end), "SYNC_REFERENCE_RANGE", "新引用编号不属于此设备的预留范围。", 409);
    }
    const prepared = await this.prepareRows(mutations);
    this.capture();
    try { return this.transact(() => {
      // Object/index preparation awaits I/O. A concurrent identical request can
      // have committed while this attempt was preparing the same dependencies.
      const replay = this.db.prepare("SELECT digest,payload FROM sync_receipts WHERE replica_id=? AND request_id=?").get(input.replicaId, input.requestId);
      if (replay) { check(replay.digest === digest, "IDEMPOTENCY_CONFLICT", "同步请求标识已用于另一份修改。", 409); return this.decode(replay.payload); }
      const conflicts = [], states = [];
      for (const mutation of mutations) {
        const current = this.known(mutation.entity, mutation.key), nextHash = rowHash(mutation.value);
        // Equal-content initial rows can be adopted safely; no write or version
        // reset occurs. Every actual change requires both the version and hash.
        const initialAdoption = mutation.expected.version === 0 && current.version === 1 && current.hash === nextHash;
        const immutableConflict = immutableEntities.has(mutation.entity) && mutation.value !== null && current.value !== null && current.hash !== nextHash;
        if (immutableConflict || !initialAdoption && (current.version !== mutation.expected.version || current.hash !== mutation.expected.hash)) conflicts.push({ entity: mutation.entity, key: mutation.key, expected: mutation.expected, actual: current, localValue: mutation.value, ...(immutableConflict ? { reason: "immutable" } : {}) });
        states.push({ entity: mutation.entity, key: mutation.key, ...current });
      }
      let receipt;
      if (conflicts.length) receipt = { replicaId: input.replicaId, requestId: input.requestId, accepted: false, sequence: this.head, states, conflicts };
      else {
        const changed = mutations.filter((mutation, i) => rowHash(mutation.value) !== states[i].hash);
        if (changed.length) this.applyRows(changed, prepared);
        const updates = mutations.map((mutation, i) => ({ entity: mutation.entity, key: mutation.key, value: mutation.value, hash: rowHash(mutation.value), version: states[i].version + (rowHash(mutation.value) !== states[i].hash ? 1 : 0) }));
        const changedUpdates = [], changedIndexes = new Map();
        updates.forEach((update, index) => { if (update.version !== states[index].version) { changedIndexes.set(index, changedUpdates.length); changedUpdates.push(update); } });
        const changedGroups = input.atomicGroups === undefined ? undefined : atomicGroups.map((group) => group.filter((index) => changedIndexes.has(index)).map((index) => changedIndexes.get(index))).filter((group) => group.length);
        const transaction = changed.length ? this.publish(input.replicaId, input.requestId, changedUpdates, changedGroups) : { sequence: this.head };
        receipt = { replicaId: input.replicaId, requestId: input.requestId, accepted: true, sequence: transaction.sequence, states: updates, conflicts: [] };
        if (changed.length && this.mode === "server") {
          // Matching newly combined catalogs is a server-origin transaction,
          // never an invisible alteration of an accepted device mutation. The
          // original receipt still describes exactly what that device sent.
          this.workspace.relations.sync([]);
          this.capture();
        }
      }
      if (receipt.accepted) {
        const latestDevice = parse(this.db.prepare("SELECT payload FROM sync_devices WHERE id=?").get(input.replicaId).payload);
        const nextDevice = { ...latestDevice, hasPushed: true, importComplete: latestDevice.importComplete || input.initialImportComplete === true };
        if (canonical(nextDevice) !== canonical(latestDevice)) this.db.prepare("UPDATE sync_devices SET payload=? WHERE id=?").run(json(nextDevice), input.replicaId);
      }
      this.db.prepare("INSERT INTO sync_receipts VALUES(?,?,?,?)").run(input.replicaId, input.requestId, digest, this.encode(receipt)); return receipt;
    }); } catch (error) {
      if (!constraintFailure(error)) throw error;
      // The failed transaction has rolled back completely. Keep a deterministic
      // rejection receipt so a lost response cannot repeat a partially applied
      // write, and retain the whole atomic batch for correction on its device.
      return this.transact(() => {
        const replay = this.db.prepare("SELECT digest,payload FROM sync_receipts WHERE replica_id=? AND request_id=?").get(input.replicaId, input.requestId);
        if (replay) { check(replay.digest === digest, "IDEMPOTENCY_CONFLICT", "同步请求标识已用于另一份修改。", 409); return this.decode(replay.payload); }
        const states = mutations.map((mutation) => ({ entity: mutation.entity, key: mutation.key, ...this.known(mutation.entity, mutation.key) }));
        const rejected = this.constraintConflictIndexes(mutations, atomicGroups, prepared);
        const receipt = { replicaId: input.replicaId, requestId: input.requestId, accepted: false, code: "SYNC_CONSTRAINT", sequence: this.head, states,
          conflicts: mutations.flatMap((mutation, index) => rejected.has(index) ? [{ entity: mutation.entity, key: mutation.key, expected: mutation.expected, actual: states[index], localValue: mutation.value, reason: "constraint" }] : []) };
        this.db.prepare("INSERT INTO sync_receipts VALUES(?,?,?,?)").run(input.replicaId, input.requestId, digest, this.encode(receipt)); return receipt;
      });
    }
  }
  applyRows(mutations, prepared = []) {
    this.setState("applying", "1");
    try {
      this.db.exec("PRAGMA defer_foreign_keys=ON");
      const order = new Map([...this.schema.keys()].map((key, index) => [key, index]));
      const sorted = [...mutations].sort((a, b) => a.value === null && b.value !== null ? -1 : a.value !== null && b.value === null ? 1 : (a.value === null ? -1 : 1) * ((order.get(a.entity) || 0) - (order.get(b.entity) || 0)));
      for (const mutation of sorted) {
        const table = this.schema.get(mutation.entity), keys = JSON.parse(mutation.key);
        if (mutation.value === null) {
          if (table.name === "revisions") this.db.prepare("DELETE FROM revision_indexes WHERE document_id=? AND revision=?").run(...keys);
          this.db.prepare("DELETE FROM " + sqlName(table.name) + " WHERE " + table.keys.map((key) => sqlName(key) + "=?").join(" AND ")).run(...keys);
        }
        else {
          const value = { ...mutation.value };
          if (table.name === "reading_activity") value.accepted_ms = 0;
          if (table.name === "reading_sessions") { value.active_ms = 0; value.last_activity_ms = null; }
          const columns = Object.keys(value), derived = table.name === "reading_activity" ? ["accepted_ms"] : table.name === "reading_sessions" ? ["active_ms", "last_activity_ms"] : [];
          const updates = columns.filter((column) => !table.keys.includes(column) && !derived.includes(column));
          this.db.prepare("INSERT INTO " + sqlName(table.name) + "(" + columns.map(sqlName).join(",") + ") VALUES(" + columns.map(() => "?").join(",") + ") ON CONFLICT(" + table.keys.map(sqlName).join(",") + ") DO " + (updates.length ? "UPDATE SET " + updates.map((column) => sqlName(column) + "=excluded." + sqlName(column)).join(",") : "NOTHING")).run(...columns.map((column) => value[column]));
        }
      }
      const revisionKeys = new Set(mutations.filter((mutation) => mutation.entity === "revisions" && mutation.value).map((mutation) => mutation.key));
      if (revisionKeys.size) this.workspace.installImportedRevisionIndexes(prepared.filter((item) => revisionKeys.has(canonical([item.documentId, item.revision]))));
      if (mutations.some((mutation) => ["reading_sessions", "reading_activity"].includes(mutation.entity))) projectReadingChanges(this.db, { ...this.workspace.options.readingProjectionLimits, inTransaction: true });
      // Counters only grow. Existing counters already cover existing references;
      // deletions and unrelated state changes cannot require a historical scan.
      const maxima = new Map();
      for (const mutation of mutations) if (mutation.value && ["references_map", "change_requests"].includes(mutation.entity)) {
        const match = /^#([QNR])([0-9]+)$/.exec(mutation.value.reference || ""), value = match && Number(match[2]);
        if (match && Number.isSafeInteger(value)) maxima.set(match[1], Math.max(maxima.get(match[1]) || 0, value));
      }
      for (const [series, value] of maxima) this.db.prepare("UPDATE counters SET value=? WHERE series=? AND value<?").run(value, series, value);
      const revision = this.workspace.meta("revision") + 1; this.workspace.setMeta("revision", revision);
      this.db.prepare("INSERT INTO changes VALUES(?,?,?)").run(revision, json({ kind: "sync.apply" }), stamp());
      this.db.prepare("UPDATE flow_metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
    } finally { this.setState("applying", "0"); }
    if (this.mode === "client") this.workspace.relations.acceptRemoteProjection?.();
  }
  pull({ after = 0, limit = 50 } = {}, actor = localActor) {
    this.workspace.authorize(actor); check(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "SYNC_CURSOR", "同步游标或页大小无效。", 400);
    this.capture();
    check(after <= this.head, "SYNC_CURSOR_AHEAD", "本机游标超出远端历史，不能静默跳过恢复检查。", 409);
    const rows = this.db.prepare("SELECT sequence,payload FROM sync_journal WHERE sequence>? ORDER BY sequence LIMIT ?").all(after, limit), transactions = [];
    let bytes = 256, objects = new Map();
    for (const row of rows) {
      const transaction = { sequence: row.sequence, ...this.decode(row.payload) }, size = Buffer.byteLength(json(transaction));
      const added = collectSyncObjects(transaction).filter((ref) => !objects.has(ref.key));
      const extra = size + 1 + added.reduce((sum, ref) => sum + Buffer.byteLength(json(ref)) + 1, 0);
      if (transactions.length && bytes + extra > SYNC_MAX_BYTES) break;
      check(bytes + extra <= SYNC_MAX_BYTES, "SYNC_BATCH_TOO_LARGE", "历史同步事务超过传输限制；游标未推进，请检查迁移报告。", 413);
      transactions.push(transaction); bytes += extra; for (const ref of added) objects.set(ref.key, ref);
    }
    const nextCursor = transactions.at(-1)?.sequence ?? after;
    return { transactions, nextCursor, hasMore: nextCursor < this.head, objects: [...objects.values()].sort((a, b) => a.key.localeCompare(b.key)) };
  }
  conflict(local, remote, source, observedRemote = remote) {
    const observedRows = new Map(observedRemote.map((row) => [stateKey(row.entity, row.key), row]));
    const remoteState = (entity, key, fallback) => {
      let current = { entity, key, ...this.known(entity, key) };
      for (const candidate of [fallback, observedRows.get(stateKey(entity, key))]) if (candidate && candidate.version >= current.version) current = candidate;
      return current;
    };
    const localRows = new Map(local.map((row) => [stateKey(row.entity, row.key), row])), remoteRows = new Map(remote.map((row) => [stateKey(row.entity, row.key), remoteState(row.entity, row.key, row)])), supersedes = [];
    const requestIds = new Set(source.requestIds || []);
    if (source.requestId) requestIds.add(source.requestId);
    // A pull can await the network while a complete local business transaction
    // commits. Its dirty rows may not have a frozen outbox yet. Include that
    // entire connected transaction in the conflict, or choosing the remote
    // value could discard one part while silently keeping its other parts.
    this.compactCheckpointGroups();
    const groupIds = this.db.prepare("SELECT group_id FROM sync_dirty_groups WHERE entity=? AND key=?"), visitedGroups = new Set();
    const outboxes = this.db.prepare("SELECT request_id,payload FROM sync_outbox").all(), visitedOutboxes = new Map();
    const previousConflicts = this.db.prepare("SELECT id,payload FROM sync_conflicts WHERE status='pending'").all(), visitedConflicts = new Set();
    let previousSize;
    do {
    previousSize = localRows.size;
    for (const item of localRows.values()) for (const { group_id } of groupIds.all(item.entity, item.key)) {
      if (visitedGroups.has(group_id)) continue;
      visitedGroups.add(group_id);
      for (const dirty of this.dirtyGroup(group_id)) {
        // dirtyGroup already traverses the connected component; mark every
        // edge so dense repeated edits do not traverse it again for each row.
        for (const edge of groupIds.all(dirty.entity, dirty.key)) visitedGroups.add(edge.group_id);
        const key = stateKey(dirty.entity, dirty.key), known = this.known(dirty.entity, dirty.key);
        if (!localRows.has(key)) localRows.set(key, { ...dirty, value: this.row(dirty.entity, dirty.key), expected: known });
        if (!remoteRows.has(key)) remoteRows.set(key, remoteState(dirty.entity, dirty.key));
      }
    }
    for (const row of outboxes) {
      const batch = this.decode(row.payload);
      const visited = visitedOutboxes.get(row.request_id) || new Set(); visitedOutboxes.set(row.request_id, visited);
      for (const [index, component] of validateAtomicGroups(batch.atomicGroups, batch.mutations.length).entries()) {
      if (visited.has(index) || !component.some((at) => localRows.has(stateKey(batch.mutations[at].entity, batch.mutations[at].key)))) continue;
      visited.add(index); requestIds.add(batch.requestId);
      for (const at of component) {
        const item = batch.mutations[at];
        const key = stateKey(item.entity, item.key);
        localRows.set(key, { ...(localRows.get(key) || item), expected: item.expected, value: this.row(item.entity, item.key) });
        if (!remoteRows.has(key)) remoteRows.set(key, remoteState(item.entity, item.key));
      }
      }
    }
    for (const row of previousConflicts) {
      if (visitedConflicts.has(row.id)) continue;
      const previous = this.decode(row.payload);
      if (!previous.local.some((item) => localRows.has(stateKey(item.entity, item.key)))) continue;
      visitedConflicts.add(row.id);
      supersedes.push(previous.id);
      for (const requestId of previous.source.requestIds || []) requestIds.add(requestId);
      if (previous.source.requestId) requestIds.add(previous.source.requestId);
      for (const item of previous.local) {
        const key = stateKey(item.entity, item.key), next = localRows.get(key);
        localRows.set(key, { ...item, ...(next || {}), expected: item.expected, value: this.row(item.entity, item.key) });
      }
      for (const item of previous.remote) if (!remoteRows.has(stateKey(item.entity, item.key))) remoteRows.set(stateKey(item.entity, item.key), remoteState(item.entity, item.key, item));
      this.db.prepare("UPDATE sync_conflicts SET status='superseded' WHERE id=?").run(previous.id);
    }
    } while (localRows.size > previousSize);
    local = [...localRows.values()]; remote = [...remoteRows.values()];
    source = { ...source, requestIds: [...requestIds] };
    const value = { id: "conflict-" + randomUUID(), version: 1, local, remote, source, ...(supersedes.length ? { supersedes } : {}), createdAt: stamp() };
    this.db.prepare("INSERT INTO sync_conflicts VALUES(?,?,?,?,?)").run(value.id, 1, "pending", this.encode(value), value.createdAt);
    return value;
  }
  requeueBatch(batch, prefix) {
    // The transport request is immutable until it has a durable rejection or
    // explicit conflict resolution. Requeue its current local values using the
    // original business boundaries, not one new transaction spanning the pack.
    for (const [index, component] of validateAtomicGroups(batch.atomicGroups, batch.mutations.length).entries()) for (const at of component) {
      const item = batch.mutations[at];
      this.db.prepare("INSERT OR IGNORE INTO sync_dirty VALUES(?,?)").run(item.entity, item.key);
      this.db.prepare("INSERT OR IGNORE INTO sync_dirty_groups(entity,key,group_id) VALUES(?,?,?)").run(item.entity, item.key, prefix + "-" + index);
    }
  }
  refreshPendingConflicts() {
    for (const row of this.db.prepare("SELECT id,version,payload FROM sync_conflicts WHERE status='pending'").all()) {
      const conflict = this.decode(row.payload), local = conflict.local.map((item) => ({ ...item, value: this.row(item.entity, item.key) }));
      const changedWhileSending = conflict.source.code === "SYNC_CONSTRAINT" && conflict.source.receipt?.conflicts?.some((item) => rowHash(this.row(item.entity, item.key)) !== rowHash(item.localValue));
      if (!changedWhileSending && local.every((item, index) => rowHash(item.value) === rowHash(conflict.local[index].value))) continue;
      this.db.prepare("INSERT OR IGNORE INTO sync_conflict_history VALUES(?,?,?)").run(row.id, row.version, row.payload);
      if (conflict.source.code === "SYNC_CONSTRAINT") {
        // An explicit local edit is a correction, not permission to merge two
        // unrelated identities. Retry the current complete transaction once;
        // another rejection becomes a new visible conflict with its own receipt.
        const requestIds = new Set(conflict.source.requestIds || []); if (conflict.source.requestId) requestIds.add(conflict.source.requestId);
        for (const requestId of requestIds) {
          const pending = this.db.prepare("SELECT payload FROM sync_outbox WHERE request_id=?").get(requestId);
          if (pending) this.requeueBatch(this.decode(pending.payload), "constraint-retry-" + row.id + "-" + requestId);
          this.db.prepare("DELETE FROM sync_outbox WHERE request_id=?").run(requestId);
        }
        for (const item of local) {
          this.db.prepare("INSERT OR IGNORE INTO sync_dirty VALUES(?,?)").run(item.entity, item.key);
          this.db.prepare("INSERT OR IGNORE INTO sync_dirty_groups(entity,key,group_id) VALUES(?,?,?)").run(item.entity, item.key, "constraint-retry-" + row.id);
        }
        this.db.prepare("UPDATE sync_conflicts SET version=version+1,status='retrying',payload=? WHERE id=?").run(this.encode({ ...conflict, version: row.version + 1, retryingAt: stamp() }), row.id);
        continue;
      }
      this.db.prepare("UPDATE sync_conflicts SET version=version+1,payload=? WHERE id=?").run(this.encode({ ...conflict, local, version: row.version + 1, updatedAt: stamp() }), row.id);
    }
  }
  acknowledge(receipt) {
    object(receipt, "同步确认"); identifier(receipt.requestId, "同步请求标识");
    check(receipt.replicaId === this.replicaId, "SYNC_DEVICE_CHANGED", "同步回执属于其他设备。", 409);
    check(typeof receipt.accepted === "boolean" && Number.isSafeInteger(receipt.sequence) && receipt.sequence >= 0, "SYNC_SCHEMA", "同步回执状态无效。", 409);
    return this.transact(() => {
      const row = this.db.prepare("SELECT payload FROM sync_outbox WHERE request_id=?").get(receipt.requestId);
      if (!row) return this.status();
      const batch = this.decode(row.payload);
      check(Array.isArray(receipt.states) && receipt.states.length === batch.mutations.length, "SYNC_SCHEMA", "同步回执缺少记录状态。", 409);
      const expected = new Map(batch.mutations.map((item) => [stateKey(item.entity, item.key), item]));
      const states = receipt.states.map((state) => validateSyncState(this.schema, state));
      for (const state of states) {
        const key = stateKey(state.entity, state.key), mutation = expected.get(key);
        check(mutation, "SYNC_SCHEMA", "同步回执含重复或不属于此批次的记录。", 409); expected.delete(key);
        if (receipt.accepted) {
          const acceptedVersion = mutation.expected.version + (state.hash !== mutation.expected.hash ? 1 : 0);
          check(state.hash === rowHash(mutation.value) && state.version === acceptedVersion, "SYNC_INTEGRITY", "同步确认与已发送内容不一致。", 409);
        }
        const known = this.known(state.entity, state.key);
        check(state.version !== known.version || state.hash === known.hash, "SYNC_INTEGRITY", "同一同步版本出现不同内容。", 409);
        if (state.version > known.version) this.remember(state.entity, state.key, state);
      }
      if (receipt.accepted) { this.db.prepare("DELETE FROM sync_outbox WHERE request_id=?").run(receipt.requestId); this.setState("hasPushed", "1"); if (batch.initialImportComplete) this.setState("importComplete", "1"); }
      else {
        check(Array.isArray(receipt.conflicts) && receipt.conflicts.length > 0, "SYNC_SCHEMA", "同步拒绝回执缺少冲突记录。", 409);
        const keys = new Set(batch.mutations.map((item) => stateKey(item.entity, item.key))), rejected = new Set();
        for (const item of receipt.conflicts) {
          const key = stateKey(item.entity, item.key);
          check(keys.has(key) && !rejected.has(key), "SYNC_SCHEMA", "同步冲突含重复或不属于此批次的记录。", 409); rejected.add(key);
        }
        const affected = validateAtomicGroups(batch.atomicGroups, batch.mutations.length).filter((component) => component.some((at) => rejected.has(stateKey(batch.mutations[at].entity, batch.mutations[at].key)))).flat();
        const remote = new Map(receipt.states.map((state) => [stateKey(state.entity, state.key), state]));
        this.conflict(affected.map((at) => batch.mutations[at]), affected.map((at) => remote.get(stateKey(batch.mutations[at].entity, batch.mutations[at].key))), { type: "push", requestId: receipt.requestId, ...(receipt.code === "SYNC_CONSTRAINT" ? { code: "SYNC_CONSTRAINT", receipt } : {}) }, receipt.states);
        this.db.prepare("UPDATE sync_outbox SET status='conflict' WHERE request_id=?").run(receipt.requestId);
      }
      return this.status();
    });
  }
  async applyPull(batch) {
    object(batch, "同步变更");
    check(Array.isArray(batch.transactions) && batch.transactions.length <= 100 && Number.isSafeInteger(batch.nextCursor) && batch.nextCursor >= 0, "SYNC_CURSOR", "同步拉取游标无效。", 400);
    check(Buffer.byteLength(json(batch.transactions)) <= SYNC_MAX_BYTES + 65536, "SYNC_BATCH_TOO_LARGE", "同步响应超过大小限制。", 413);
    const transactions = batch.transactions.map((transaction) => {
      check(Number.isSafeInteger(transaction.sequence) && transaction.sequence > 0 && Array.isArray(transaction.mutations) && transaction.mutations.length > 0 && transaction.mutations.length <= SYNC_MAX_MUTATIONS, "SYNC_SCHEMA", "同步事务无效。", 400);
      const mutations = transaction.mutations.map((mutation) => validateMutation(this.schema, mutation, { incoming: true }));
      check(new Set(mutations.map((mutation) => stateKey(mutation.entity, mutation.key))).size === mutations.length, "SYNC_SCHEMA", "同步事务含重复记录。", 400);
      return { ...transaction, mutations, atomicGroups: validateAtomicGroups(transaction.atomicGroups, mutations.length) };
    });
    for (let i = 1; i < transactions.length; i++) check(transactions[i].sequence === transactions[i - 1].sequence + 1, "SYNC_CURSOR", "同步事务不连续。", 409);
    check(!transactions.length || transactions.at(-1).sequence === batch.nextCursor, "SYNC_CURSOR", "同步响应末尾游标不一致。", 409);
    const prepared = await this.prepareRows(transactions.filter((transaction) => transaction.sequence > this.cursor).flatMap((transaction) => transaction.mutations));
    return this.constraintTransaction(() => {
      let cursor = this.cursor;
      // An already applied page is an idempotent acknowledgement; concurrent
      // dependency downloads cannot move a receiving cursor backwards.
      if (batch.nextCursor < cursor) return this.status();
      for (const transaction of transactions) {
        if (transaction.sequence <= cursor) continue;
        check(transaction.sequence === cursor + 1, "SYNC_CURSOR", "同步事务不连续，不能跳过历史。", 409);
        const incoming = transaction.mutations;
        const local = incoming.map((mutation) => ({ entity: mutation.entity, key: mutation.key, value: this.row(mutation.entity, mutation.key), expected: this.known(mutation.entity, mutation.key) }));
        for (let i = 0; i < incoming.length; i++) check(incoming[i].version !== local[i].expected.version || incoming[i].hash === local[i].expected.hash, "SYNC_INTEGRITY", "同一同步版本出现不同内容。", 409);
        const deferred = new Set(), protectedKeys = new Set();
        for (const row of this.db.prepare("SELECT payload FROM sync_conflicts WHERE status='pending'").all()) for (const item of this.decode(row.payload).local) protectedKeys.add(stateKey(item.entity, item.key));
        const retainComponent = (index) => {
          const component = transaction.atomicGroups[index]; deferred.add(index);
          const conflict = this.conflict(component.map((i) => local[i]), component.map((i) => incoming[i]), { type: "pull", sequence: transaction.sequence }, incoming);
          for (const item of conflict.local) protectedKeys.add(stateKey(item.entity, item.key));
          for (const requestId of conflict.source.requestIds) this.db.prepare("UPDATE sync_outbox SET status='conflict' WHERE request_id=?").run(requestId);
        };
        for (const [index, component] of transaction.atomicGroups.entries()) {
          const conflicts = component.some((i) => {
            const mutation = incoming[i], known = local[i].expected, localHash = rowHash(local[i].value);
            return mutation.version > known.version && localHash !== known.hash && localHash !== mutation.hash;
          });
          if (conflicts) retainComponent(index);
        }
        // Local dirty transactions can connect distinct incoming components. A
        // companion that happens to equal its known value still belongs to the
        // saved local choice; do not overwrite it after expanding the conflict.
        if (protectedKeys.size) {
          let expanded;
          do {
            expanded = false;
            for (const [index, component] of transaction.atomicGroups.entries()) if (!deferred.has(index) && component.some((i) => incoming[i].version > local[i].expected.version && protectedKeys.has(stateKey(incoming[i].entity, incoming[i].key)))) { retainComponent(index); expanded = true; }
          } while (expanded);
        }
        const changed = transaction.atomicGroups.flatMap((component, index) => deferred.has(index) ? [] : component.filter((i) => incoming[i].version > local[i].expected.version && rowHash(local[i].value) !== incoming[i].hash).map((i) => incoming[i]));
        if (changed.length) this.applyRows(changed, prepared);
        for (const mutation of incoming) if (mutation.version >= this.known(mutation.entity, mutation.key).version) this.remember(mutation.entity, mutation.key, mutation);
        cursor = transaction.sequence;
      }
      check(cursor === batch.nextCursor, "SYNC_CURSOR", "同步响应末尾游标不一致。", 409);
      this.setState("cursor", cursor); return this.status();
    });
  }
  conflicts({ includeResolved = false } = {}) {
    this.transact(() => this.refreshPendingConflicts());
    return { conflicts: this.db.prepare("SELECT payload,status FROM sync_conflicts" + (includeResolved ? "" : " WHERE status='pending'") + " ORDER BY created_at,id").all().map((row) => ({ ...this.decode(row.payload), status: row.status })) };
  }
  rebaseMutable(mutations, remote) {
    const before = new Map(remote.map((row) => [stateKey(row.entity, row.key), row.value]));
    return mutations.map((mutation) => {
      if (!mutation.value) return mutation;
      const previous = before.get(stateKey(mutation.entity, mutation.key));
      if (!previous || rowHash(previous) === rowHash(mutation.value)) return mutation;
      const field = businessVersions[mutation.entity], value = { ...mutation.value };
      if (field) {
        value[field] = Math.max(Number(value[field]) || 0, (Number(previous[field]) || 0) + 1);
        if (typeof value.payload === "string") {
          const payload = JSON.parse(value.payload); payload[field] = value[field];
          if (typeof payload.updatedAt === "string") payload.updatedAt = stamp();
          value.payload = json(payload);
        }
        if (Object.hasOwn(value, "updated_at")) value.updated_at = stamp();
      } else if (mutation.entity === "metadata" && value.key === "planVersion") value.value = String(Math.max(Number(value.value) || 0, Number(previous.value) || 0) + 1);
      return { ...mutation, value };
    });
  }
  async resolveConflict({ id, choice, expectedVersion }, actor = localActor) {
    this.workspace.authorize(actor, "write"); identifier(id); check(["local", "remote"].includes(choice), "VALIDATION_FAILED", "请选择保留本机或远端修改。", 400);
    this.transact(() => this.refreshPendingConflicts());
    const row = this.db.prepare("SELECT * FROM sync_conflicts WHERE id=?").get(id);
    check(row && row.status === "pending" && row.version === expectedVersion, "REVISION_CONFLICT", "同步冲突已改变，请重新读取。", 409);
    const conflict = this.decode(row.payload);
    let resolution;
    if (choice === "local") {
      const immutableConflicts = conflict.local.filter((local) => local.value !== null && immutableEntities.has(local.entity) && conflict.remote.some((remote) => remote.entity === local.entity && remote.key === local.key && remote.value !== null && rowHash(remote.value) !== rowHash(local.value)));
      check(!immutableConflicts.some((item) => item.entity !== "revisions"), "SYNC_IMMUTABLE_CONFLICT", "原文件或同序号阅读事件不可被另一份内容覆盖；两份数据已保留。", 409);
      check(!immutableConflicts.length || typeof this.workspace.prepareSyncConflictResolution === "function", "SYNC_IMMUTABLE_CONFLICT", "此冲突需要保留原版本并创建新版本。", 409);
      if (typeof this.workspace.prepareSyncConflictResolution === "function") {
      await this.ensureObjects(conflict.remote);
      resolution = await this.workspace.prepareSyncConflictResolution(conflict);
      }
    }
    const desired = choice === "remote" ? conflict.remote : this.rebaseMutable(resolution?.mutations || conflict.local, conflict.remote);
    const prepared = await this.prepareRows(desired);
    return this.constraintTransaction(() => {
      const current = this.db.prepare("SELECT version,status FROM sync_conflicts WHERE id=?").get(id);
      check(current.version === expectedVersion && current.status === "pending", "REVISION_CONFLICT", "同步冲突已改变。", 409);
      check(resolution?.preparationRevision === undefined || resolution.preparationRevision === this.workspace.meta("revision"), "REVISION_CONFLICT", "关联内容在准备期间又有修改，请重新读取。", 409);
      check(resolution?.preparationActivityRevision === undefined || resolution.preparationActivityRevision === this.workspace.flow.revision, "REVISION_CONFLICT", "阅读记录在准备期间又有修改，请重新读取。", 409);
      for (const remote of conflict.remote) { const known = this.known(remote.entity, remote.key); check(known.version === remote.version && known.hash === remote.hash, "REVISION_CONFLICT", "远端内容在冲突产生后又有修改，请处理最新冲突。", 409); }
      const resolved = { ...conflict, version: conflict.version + 1, resolution: choice, ...(resolution?.mappings ? { mappings: resolution.mappings } : {}), resolvedAt: stamp() };
      // Preserve edits made after the conflict was presented. Resolving an old
      // dialog must never discard a newer local draft, for either choice.
      for (const local of conflict.local) check(rowHash(this.row(local.entity, local.key)) === rowHash(local.value), "REVISION_CONFLICT", "本机内容在冲突产生后又有修改，请重新读取。", 409);
      for (const guard of resolution?.guards || []) check(rowHash(this.row(guard.entity, guard.key)) === guard.hash, "REVISION_CONFLICT", "关联内容在冲突产生后又有修改，请重新读取。", 409);
      this.applyRows(desired, prepared);
      for (const local of desired) {
        this.db.prepare("INSERT OR IGNORE INTO sync_dirty VALUES(?,?)").run(local.entity, local.key);
        this.db.prepare("INSERT OR IGNORE INTO sync_dirty_groups(entity,key,group_id) VALUES(?,?,?)").run(local.entity, local.key, "resolution-" + id);
      }
      const requestIds = new Set(conflict.source.requestIds || []); if (conflict.source.requestId) requestIds.add(conflict.source.requestId);
      for (const requestId of requestIds) {
        const pending = this.db.prepare("SELECT payload FROM sync_outbox WHERE request_id=?").get(requestId);
        if (pending) this.requeueBatch(this.decode(pending.payload), "resolution-" + id + "-" + requestId);
        this.db.prepare("DELETE FROM sync_outbox WHERE request_id=?").run(requestId);
      }
      this.db.prepare("UPDATE sync_conflicts SET version=?,status='resolved',payload=? WHERE id=?").run(resolved.version, this.encode(resolved), id);
      return { conflict: resolved, ...this.status() };
    });
  }
}
