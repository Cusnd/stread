import { canonical, check, hash } from "./errors.mjs";
import { rowHash, sqlName } from "./sync-schema.mjs";

export const SYNC_CURRENT_VALUE_MARKER = "$readerSyncCurrent";
export const SYNC_CURRENT_VALUE_MAX_BYTES = 48000;
const markerPath = '$."' + SYNC_CURRENT_VALUE_MARKER + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const jsonRecord = (table, prefix) => "json_object(" + table.columns.flatMap(name => [literal(name), prefix + "." + sqlName(name)]).join(",") + ")";
const jsonKey = (table, prefix) => "json_array(" + table.keys.map(name => prefix + "." + sqlName(name)).join(",") + ")";
const legacyMarkers = ["$continuousReaderSqlValue", "$readerSyncPayload", SYNC_CURRENT_VALUE_MARKER];

/** The wire still contains complete values. Only a client replica's private
 * known-value copy may refer to its identical current business row. */
export class SyncCurrentValues {
  constructor(engine, { enabled = false } = {}) {
    this.engine = engine; this.db = engine.db; this.tables = new Map(); this.active = false;
    check(typeof enabled === "boolean", "SYNC_CONFIGURATION", "同步当前值去重选项无效。", 500);
    const version = engine.state("currentValuesVersion");
    check(version === undefined || version === "1", "SYNC_CURRENT_VALUES_VERSION", "当前值存储格式版本不受支持；已保留数据。", 409);
    if (!enabled && version === undefined) return;
    check(engine.mode === "client", "SYNC_CONFIGURATION", "当前值去重只能用于同步客户端副本。", 500);
    const schema = [];
    for (const table of engine.schema.values()) {
      const indexes = this.db.prepare("PRAGMA index_list(" + sqlName(table.name) + ")").all().filter(index => index.unique)
        .map(index => ({ name: index.name, origin: index.origin, partial: index.partial,
          columns: this.db.prepare("PRAGMA index_info(" + sqlName(index.name) + ")").all().map(column => column.name) }))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      schema.push({ ...table, uniqueIndexes: indexes });
      // REPLACE can remove a different row through any UNIQUE constraint. This
      // first format only borrows rows whose only uniqueness is their PK; all
      // other entities keep full known values, including partial/expression keys.
      if (indexes.some(index => index.origin !== "pk")) continue;
      this.tables.set(table.name, table);
    }
    const schemaHash = hash(canonical(schema));
    check(version === undefined || engine.state("currentValuesSchema") === schemaHash,
      "SYNC_CURRENT_VALUES_SCHEMA", "业务表结构已改变；必须先物化当前值引用再迁移。", 409);
    const triggers = this.triggers();
    engine.transact(() => {
      // Persisted activation also applies when a later caller omits the option.
      // Reinstall protection before permitting business work after a restart.
      for (const [name, sql] of triggers) {
        const existing = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
        if (existing?.sql?.replace(/;\s*$/, "") === sql.replace(/;\s*$/, "")) continue;
        this.db.exec("DROP TRIGGER IF EXISTS " + sqlName(name)); this.db.exec(sql);
      }
      engine.setState("currentValuesVersion", "1"); engine.setState("currentValuesSchema", schemaHash);
    });
    this.active = true;
  }

  triggers() {
    const result = [];
    for (const table of this.tables.values()) {
      const name = sqlName(table.name), entity = literal(table.name);
      const borrowed = "json_type(value," + literal(markerPath) + ")='object'";
      const old = `UPDATE sync_entities SET value=${jsonRecord(table, "OLD")}
        WHERE entity=${entity} AND key=${jsonKey(table, "OLD")} AND ${borrowed};`;
      // A BEFORE INSERT also runs for INSERT OR REPLACE/IGNORE. Materializing
      // the replaced PK first does not rely on recursive_triggers being enabled.
      const sameKey = table.keys.map(key => "current." + sqlName(key) + " IS NEW." + sqlName(key)).join(" AND ");
      const target = `UPDATE sync_entities SET value=(SELECT ${jsonRecord(table, "current")} FROM ${name} AS current WHERE ${sameKey})
        WHERE entity=${entity} AND key=${jsonKey(table, "NEW")} AND ${borrowed}
          AND EXISTS(SELECT 1 FROM ${name} AS current WHERE ${sameKey});`;
      const changed = table.columns.map(column => "OLD." + sqlName(column) + " IS NOT NEW." + sqlName(column)).join(" OR ");
      for (const [event, body, when] of [
        ["INSERT", target, ""],
        // Also preserve an existing target when UPDATE OR REPLACE changes a PK.
        ["UPDATE", old + "\n" + target, " WHEN " + changed],
        ["DELETE", old, ""],
      ]) {
        const trigger = "reader_sync_current_" + table.name + "_" + event.toLowerCase();
        result.push([trigger, `CREATE TRIGGER ${sqlName(trigger)} BEFORE ${event} ON ${name}${when} BEGIN ${body} END`]);
      }
    }
    return result;
  }

  parse(value) {
    if (typeof value !== "string" || !value.includes(SYNC_CURRENT_VALUE_MARKER)) return null;
    let parsed; try { parsed = JSON.parse(value); } catch { return null; }
    if (!parsed || typeof parsed !== "object" || !Object.hasOwn(parsed, SYNC_CURRENT_VALUE_MARKER)) return null;
    const ref = parsed[SYNC_CURRENT_VALUE_MARKER];
    check(Object.keys(parsed).length === 1 && ref && typeof ref === "object" && !Array.isArray(ref)
      && Object.keys(ref).sort().join(",") === "entity,hash,key,version" && ref.version === 1
      && typeof ref.entity === "string" && typeof ref.key === "string" && /^[a-f0-9]{64}$/.test(ref.hash),
      "SYNC_CURRENT_VALUES_INTEGRITY", "同步当前值引用格式损坏；已保留数据。", 409);
    return ref;
  }

  read(entity, key, stored) {
    const ref = this.parse(stored.value);
    if (ref) {
      check(this.active && this.tables.has(entity) && ref.entity === entity && ref.key === key && ref.hash === stored.hash,
        "SYNC_CURRENT_VALUES_INTEGRITY", "同步当前值引用与身份或摘要不一致；已保留数据。", 409);
      const value = this.engine.row(entity, key);
      check(value !== null && rowHash(value) === ref.hash,
        "SYNC_CURRENT_VALUES_INTEGRITY", "同步当前值内容缺失或摘要不符；已保留数据。", 409);
      return value;
    }
    const value = this.engine.decode(stored.value);
    // COW SQL cannot call SHA-256. Verify its complete preimage at the same
    // logical read boundary as borrowed values, so corruption never becomes null.
    if (this.active) check(rowHash(value) === stored.hash, "SYNC_CURRENT_VALUES_INTEGRITY", "同步已知值摘要不符；已保留数据。", 409);
    return value;
  }

  reference(entity, key, state) {
    if (!this.active || state.value === null || !this.tables.has(entity) || rowHash(state.value) !== state.hash) return null;
    const serialized = JSON.stringify(state.value);
    if (Buffer.byteLength(serialized) > SYNC_CURRENT_VALUE_MAX_BYTES || legacyMarkers.some(marker => serialized.includes(marker))) return null;
    const table = this.tables.get(entity), keys = JSON.parse(key);
    // SQL must inspect the physical scalars: legacy adapters may decode an old
    // chunk marker before row() sees it, but a SQL OLD preimage cannot do that.
    const hasLegacy = table.columns.map(column => legacyMarkers.map(marker => "instr(CAST(" + sqlName(column) + " AS TEXT)," + literal(marker) + ")>0").join(" OR ")).join(" OR ");
    if (this.db.prepare("SELECT 1 AS legacy FROM " + sqlName(entity) + " WHERE " + table.keys.map(column => sqlName(column) + "=?").join(" AND ") + " AND (" + hasLegacy + ") LIMIT 1").get(...keys)) return null;
    const current = this.engine.row(entity, key);
    if (current === null || rowHash(current) !== state.hash) return null;
    const encoded = JSON.stringify({ [SYNC_CURRENT_VALUE_MARKER]: { version: 1, entity, key, hash: state.hash } });
    return Buffer.byteLength(encoded) < Buffer.byteLength(serialized) ? encoded : null;
  }

  compact({ limit = 256, after } = {}) {
    check(this.active, "SYNC_CURRENT_VALUES_DISABLED", "当前副本尚未启用当前值去重。", 409);
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000
      && (after === undefined || Array.isArray(after) && after.length === 2 && after.every(value => typeof value === "string")),
      "VALIDATION_FAILED", "当前值维护游标或批次大小无效。", 400);
    return this.engine.transact(() => {
      const rows = this.db.prepare("SELECT entity,key,version,hash,value FROM sync_entities" + (after ? " WHERE (entity,key)>(?,?)" : "") + " ORDER BY entity,key LIMIT ?")
        .all(...(after || []), limit + 1);
      const selected = rows.slice(0, limit); let compacted = 0;
      for (const row of selected) {
        if (this.parse(row.value)) { this.read(row.entity, row.key, row); continue; }
        const value = this.read(row.entity, row.key, row), ref = this.reference(row.entity, row.key, { ...row, value });
        if (ref) {
          const changed = this.db.prepare("UPDATE sync_entities SET value=? WHERE entity=? AND key=? AND version=? AND hash IS ? AND value IS ?")
            .run(ref, row.entity, row.key, row.version, row.hash, row.value);
          check(changed.changes === 1, "SYNC_CURRENT_VALUES_CHANGED", "同步已知值在维护期间改变；未提交去重。", 409); compacted++;
        }
      }
      return { scanned: selected.length, compacted, nextKey: selected.length ? [selected.at(-1).entity, selected.at(-1).key] : after || null, hasMore: rows.length > limit };
    });
  }
}
