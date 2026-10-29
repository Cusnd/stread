import { createHash } from "node:crypto";
import { canonical, check } from "./errors.mjs";
import { applySchemaMigrations } from "./schema-migrations.mjs";
import { collectSyncObjects, sqlName, validateSyncState, SYNC_MAX_BYTES } from "./sync-schema.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const invalid = (condition, message = "同步快照不完整或校验失败；本地资料未被替换。") => check(condition, "SYNC_SNAPSHOT_INVALID", message, 409);
const cancelled = (signal) => check(!signal?.aborted, "SYNC_CANCELLED", "同步已停止。", 409);
const defaults = new Map([["plan", "[]"], ["planVersion", "1"], ["currentId", "null"]]);

/** A baseline is only an optimization for a genuinely empty receiver. */
export function canInstallSyncSnapshot(engine) {
  if (engine.cursor !== 0 || engine.state("hasPushed") === "1" || engine.state("snapshotInstalled")) return false;
  for (const table of ["sync_entities", "sync_outbox", "sync_conflicts"]) if (engine.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return false;
  for (const entity of engine.schema.keys()) {
    if (entity === "metadata") {
      for (const row of engine.db.prepare("SELECT key,value FROM metadata WHERE key IN ('plan','planVersion','currentId')").all()) if (row.value !== defaults.get(row.key)) return false;
    } else if (engine.db.prepare("SELECT 1 FROM " + sqlName(entity) + " LIMIT 1").get()) return false;
  }
  // Even a create/delete performed before the first sync is real local work.
  if (engine.db.prepare("SELECT 1 FROM sync_dirty WHERE entity<>'metadata' LIMIT 1").get()) return false;
  return true;
}

function bytesAndJson(input, reference) {
  invalid(input instanceof Uint8Array && positive(reference.size) && reference.size <= SYNC_MAX_BYTES && /^[a-f0-9]{64}$/.test(reference.sha256));
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  invalid(bytes.length === reference.size && digest(bytes) === reference.sha256);
  let text, value;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); value = JSON.parse(text); }
  catch { invalid(false); }
  invalid(value && typeof value === "object" && !Array.isArray(value));
  return { text, value };
}

function descriptor(input, reference, historyId, head) {
  invalid(reference && identifier(reference.snapshotId) && identifier(historyId) && Number.isSafeInteger(reference.sequence) && reference.sequence >= 0 && reference.sequence <= head);
  const parsed = bytesAndJson(input, reference), value = parsed.value;
  invalid(value.format === "reader-sync-snapshot-1" && value.snapshotId === reference.snapshotId && value.historyId === historyId && value.sequence === reference.sequence);
  invalid(Number.isSafeInteger(value.entityCount) && value.entityCount >= 0 && Array.isArray(value.chunks));
  let rows = 0;
  for (const [index, chunk] of value.chunks.entries()) {
    invalid(chunk && chunk.index === index && /^[a-f0-9]{64}$/.test(chunk.sha256) && positive(chunk.size) && chunk.size <= SYNC_MAX_BYTES && positive(chunk.rowCount) && chunk.rowCount <= 256);
    rows += chunk.rowCount; invalid(Number.isSafeInteger(rows));
  }
  invalid(rows === value.entityCount);
  return parsed;
}

function chunkValue(engine, input, manifest, reference) {
  const parsed = bytesAndJson(input, reference), value = parsed.value;
  invalid(value.format === "reader-sync-snapshot-chunk-1" && value.snapshotId === manifest.snapshotId && value.historyId === manifest.historyId && value.sequence === manifest.sequence && value.index === reference.index);
  invalid(Array.isArray(value.states) && value.states.length === reference.rowCount);
  const states = value.states.map((state) => {
    const checked = validateSyncState(engine.schema, state);
    invalid(checked.version >= 1); return checked;
  });
  invalid(new Set(states.map((state) => state.entity + "\n" + state.key)).size === states.length);
  return { ...parsed, states };
}

class SnapshotStage {
  constructor(engine) {
    this.engine = engine; this.db = engine.db;
    engine.transact(() => applySchemaMigrations(this.db, "replication-snapshot", [{ version: 1, name: "resumable-empty-device-baselines", sql: `
      CREATE TABLE IF NOT EXISTS sync_snapshot_stages (
        snapshot_id TEXT PRIMARY KEY, history_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        sha256 TEXT NOT NULL, size INTEGER NOT NULL, descriptor TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_snapshot_chunks (
        snapshot_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, payload TEXT NOT NULL,
        ready INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(snapshot_id,chunk_index));
      CREATE TABLE IF NOT EXISTS sync_snapshot_rows (
        snapshot_id TEXT NOT NULL, entity TEXT NOT NULL, key TEXT NOT NULL,
        chunk_index INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(snapshot_id,entity,key));
      CREATE TABLE IF NOT EXISTS sync_snapshot_indexes (
        snapshot_id TEXT NOT NULL, document_id TEXT NOT NULL, revision INTEGER NOT NULL,
        sha256 TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(snapshot_id,document_id,revision));
      CREATE INDEX IF NOT EXISTS sync_snapshot_stage_status ON sync_snapshot_stages(status,history_id,sequence);
    ` }, { version: 2, name: "hash-persisted-revision-indexes", sql: `
      UPDATE sync_snapshot_chunks SET ready=0
      WHERE snapshot_id IN (SELECT snapshot_id FROM sync_snapshot_stages WHERE status='receiving')
        AND EXISTS (SELECT 1 FROM sync_snapshot_rows AS staged
          WHERE staged.snapshot_id=sync_snapshot_chunks.snapshot_id
            AND staged.chunk_index=sync_snapshot_chunks.chunk_index AND staged.entity='revisions');
    ` }]));
  }
  pending(historyId) { return this.db.prepare("SELECT * FROM sync_snapshot_stages WHERE history_id=? AND status='receiving' ORDER BY sequence DESC LIMIT 1").get(historyId); }
  // Call inside engine.transact. Network/object preparation can finish after a
  // local command abandons this stage or explicit maintenance removes it.
  receiving(manifest) {
    const row = this.db.prepare("SELECT history_id,sequence,status FROM sync_snapshot_stages WHERE snapshot_id=?").get(manifest.snapshotId);
    if (!row || row.status !== "receiving") return false;
    invalid(row.history_id === manifest.historyId && row.sequence === manifest.sequence);
    if (!canInstallSyncSnapshot(this.engine)) {
      this.db.prepare("UPDATE sync_snapshot_stages SET status='abandoned' WHERE snapshot_id=? AND status='receiving'").run(manifest.snapshotId);
      return false;
    }
    return true;
  }
  readManifest(row, head) {
    const reference = { snapshotId: row.snapshot_id, sequence: row.sequence, sha256: row.sha256, size: row.size };
    return { reference, ...descriptor(Buffer.from(this.engine.decode(row.descriptor)), reference, row.history_id, head) };
  }
  begin(text, manifest, reference) {
    return this.engine.transact(() => {
      if (!canInstallSyncSnapshot(this.engine)) return false;
      const saved = this.db.prepare("SELECT sha256,size,history_id,status FROM sync_snapshot_stages WHERE snapshot_id=?").get(manifest.snapshotId);
      invalid(!saved || saved.sha256 === reference.sha256 && saved.size === reference.size && saved.history_id === manifest.historyId);
      if (saved && saved.status !== "receiving") return false;
      if (!saved) this.db.prepare("INSERT INTO sync_snapshot_stages VALUES(?,?,?,?,?,?,'receiving')").run(manifest.snapshotId, manifest.historyId, manifest.sequence, reference.sha256, reference.size, this.engine.encode(text));
      return true;
    });
  }
  chunk(manifest, reference) {
    const row = this.db.prepare("SELECT payload,ready FROM sync_snapshot_chunks WHERE snapshot_id=? AND chunk_index=?").get(manifest.snapshotId, reference.index);
    if (!row) return null;
    return { ...chunkValue(this.engine, Buffer.from(this.engine.decode(row.payload)), manifest, reference), ready: Boolean(row.ready) };
  }
  saveChunk(manifest, reference, parsed) {
    return this.engine.transact(() => {
      if (!this.receiving(manifest)) return false;
      const saved = this.db.prepare("SELECT payload FROM sync_snapshot_chunks WHERE snapshot_id=? AND chunk_index=?").get(manifest.snapshotId, reference.index);
      if (saved) { invalid(this.engine.decode(saved.payload) === parsed.text); return true; }
      for (const state of parsed.states) {
        invalid(!this.db.prepare("SELECT 1 FROM sync_snapshot_rows WHERE snapshot_id=? AND entity=? AND key=?").get(manifest.snapshotId, state.entity, state.key), "同步快照含重复身份；本地资料未被替换。");
        this.db.prepare("INSERT INTO sync_snapshot_rows VALUES(?,?,?,?,?)").run(manifest.snapshotId, state.entity, state.key, reference.index, this.engine.encode(state));
      }
      this.db.prepare("INSERT INTO sync_snapshot_chunks VALUES(?,?,?,0)").run(manifest.snapshotId, reference.index, this.engine.encode(parsed.text));
      return true;
    });
  }
  async prepare(manifest, reference, states) {
    if (!this.engine.transact(() => this.receiving(manifest))) return false;
    await this.engine.ensureObjects(states);
    // Prepare one document at a time, then persist its derived indexes before
    // the final synchronous transaction. Network/filesystem awaits never expose
    // a half-installed library or require retaining every document in memory.
    for (const state of states) if (state.entity === "revisions" && state.value) {
      const [prepared] = await this.engine.prepareRows([state]);
      invalid(prepared);
      const stored = this.engine.transact(() => {
        if (!this.receiving(manifest)) return false;
        // JSON persistence omits optional undefined fields (for example a
        // heading's translations). Hash exactly the representation that a
        // restarted installer will decode, retaining full integrity checks.
        const payload = this.engine.encode(prepared), persisted = this.engine.decode(payload);
        this.db.prepare("INSERT OR REPLACE INTO sync_snapshot_indexes VALUES(?,?,?,?,?)")
          .run(manifest.snapshotId, prepared.documentId, prepared.revision, digest(canonical(persisted)), payload);
        return true;
      });
      if (!stored) return false;
    }
    return this.engine.transact(() => {
      if (!this.receiving(manifest)) return false;
      invalid(this.db.prepare("SELECT 1 FROM sync_snapshot_chunks WHERE snapshot_id=? AND chunk_index=?").get(manifest.snapshotId, reference.index));
      this.db.prepare("UPDATE sync_snapshot_chunks SET ready=1 WHERE snapshot_id=? AND chunk_index=?").run(manifest.snapshotId, reference.index);
      return true;
    });
  }
  abandon(snapshotId) { this.engine.transact(() => this.db.prepare("UPDATE sync_snapshot_stages SET status='abandoned' WHERE snapshot_id=? AND status='receiving'").run(snapshotId)); }
  install(manifest, signal) {
    return this.engine.constraintTransaction(() => {
      cancelled(signal);
      if (!this.receiving(manifest)) return { installed: false, abandoned: true };
      invalid(this.db.prepare("SELECT COUNT(*) AS n FROM sync_snapshot_chunks WHERE snapshot_id=? AND ready=1").get(manifest.snapshotId).n === manifest.chunks.length);
      invalid(this.db.prepare("SELECT COUNT(*) AS n FROM sync_snapshot_rows WHERE snapshot_id=?").get(manifest.snapshotId).n === manifest.entityCount);
      // Check staging against the exact immutable chunk bytes, including pages
      // recovered after a restart, before publishing a single business row.
      for (const ref of manifest.chunks) {
        const chunk = this.chunk(manifest, ref); invalid(chunk?.ready);
        for (const state of chunk.states) {
          const staged = this.db.prepare("SELECT payload FROM sync_snapshot_rows WHERE snapshot_id=? AND entity=? AND key=?").get(manifest.snapshotId, state.entity, state.key);
          invalid(staged && canonical(this.engine.decode(staged.payload)) === canonical(state));
        }
      }
      for (const entity of this.engine.schema.keys()) {
        const rows = this.db.prepare("SELECT payload FROM sync_snapshot_rows WHERE snapshot_id=? AND entity=? ORDER BY key").iterate(manifest.snapshotId, entity);
        let group = [], bytes = 0;
        const apply = () => {
          if (!group.length) return;
          const prepared = [];
          if (entity === "revisions") for (const state of group) if (state.value) {
            const row = this.db.prepare("SELECT sha256,payload FROM sync_snapshot_indexes WHERE snapshot_id=? AND document_id=? AND revision=?").get(manifest.snapshotId, state.value.document_id, state.value.revision);
            invalid(row); const value = this.engine.decode(row.payload); invalid(digest(canonical(value)) === row.sha256); prepared.push(value);
          }
          this.engine.applyRows(group, prepared);
          for (const state of group) this.engine.remember(state.entity, state.key, state);
          group = []; bytes = 0;
        };
        for (const row of rows) {
          const state = validateSyncState(this.engine.schema, this.engine.decode(row.payload)), size = Buffer.byteLength(JSON.stringify(state));
          if (group.length && (group.length >= 128 || bytes + size > 256 * 1024 || entity === "revisions")) apply();
          group.push(state); bytes += size;
        }
        apply();
      }
      // The eligibility check proved these are only untouched bootstrap defaults.
      this.db.prepare("DELETE FROM sync_dirty").run(); this.db.prepare("DELETE FROM sync_dirty_groups").run();
      this.engine.setState("cursor", manifest.sequence); this.engine.setState("historyId", manifest.historyId);
      this.engine.setState("importComplete", "1"); this.engine.setState("snapshotInstalled", manifest.snapshotId);
      this.db.prepare("UPDATE sync_snapshot_stages SET status='installed' WHERE snapshot_id=?").run(manifest.snapshotId);
      return { installed: true, sequence: manifest.sequence, entityCount: manifest.entityCount };
    });
  }
}

/** Existing replicas always replay exact archived transactions. Never reset them. */
export async function restoreEmptySyncSnapshot(engine, { reference, historyId, head, transport, download, signal, maxChunks = 100 } = {}) {
  if (!canInstallSyncSnapshot(engine)) return { installed: false, abandoned: true };
  invalid(Number.isSafeInteger(maxChunks) && maxChunks >= 1 && maxChunks <= 1000);
  const stage = new SnapshotStage(engine), pending = stage.pending(historyId);
  let manifest;
  if (pending) {
    invalid(reference.snapshotId !== pending.snapshot_id || reference.sha256 === pending.sha256 && reference.size === pending.size && reference.sequence === pending.sequence, "同一快照身份出现不同内容；本地资料未被替换。");
    ({ reference, value: manifest } = stage.readManifest(pending, head));
  }
  else {
    const parsed = descriptor(await transport.snapshotDescriptor(reference, { signal, historyId }), reference, historyId, head);
    manifest = parsed.value;
    if (!stage.begin(parsed.text, manifest, reference)) return { installed: false, abandoned: true };
  }
  let completed = 0;
  for (const ref of manifest.chunks) {
    cancelled(signal);
    if (!canInstallSyncSnapshot(engine)) { stage.abandon(manifest.snapshotId); return { installed: false, abandoned: true }; }
    let chunk = stage.chunk(manifest, ref);
    if (chunk?.ready) continue;
    if (completed >= maxChunks) return { installed: false, pending: true };
    if (!chunk) {
      chunk = chunkValue(engine, await transport.snapshotChunk(manifest.snapshotId, ref, { signal, historyId }), manifest, ref);
      if (!stage.saveChunk(manifest, ref, chunk)) return { installed: false, abandoned: true };
    }
    await download({ objects: collectSyncObjects(chunk.states) }, signal, historyId);
    if (!await stage.prepare(manifest, ref, chunk.states)) return { installed: false, abandoned: true };
    completed++;
  }
  // Stored objects can disappear/corrupt between process runs. Verify/recover
  // them again before making their references visible in the new baseline.
  for (const ref of manifest.chunks) {
    cancelled(signal);
    if (!canInstallSyncSnapshot(engine)) { stage.abandon(manifest.snapshotId); return { installed: false, abandoned: true }; }
    const chunk = stage.chunk(manifest, ref); invalid(chunk?.ready);
    await download({ objects: collectSyncObjects(chunk.states) }, signal, historyId);
    await engine.ensureObjects(chunk.states);
  }
  cancelled(signal); return stage.install(manifest, signal);
}
