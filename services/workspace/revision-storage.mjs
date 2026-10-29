import { check, hash, json } from "./errors.mjs";
import { OBJECT_MARKER, objectReference } from "./immutable-objects.mjs";
import { applySchemaMigrations } from "./schema-migrations.mjs";
import { mapRead, sqliteAccess } from "./sql-commit.mjs";

const fields = { content: "document", fingerprints: "fingerprints", resources: "resourceMap", report: "report", authoring: "authoring", identity: "identity" };
const encode = (ref) => json({ [OBJECT_MARKER]: ref });

export const revisionSchemaMigrations = [{ version: 1, name: "Adopt immutable revision query indexes", sql: `CREATE TABLE IF NOT EXISTS revision_indexes (
      document_id TEXT NOT NULL REFERENCES documents(id), revision INTEGER NOT NULL,
      kind TEXT NOT NULL, part INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(document_id,revision,kind,part));` }];

// Object writes deliberately happen before the database transaction. A failed
// CAS leaves an unreferenced immutable object, never a partially visible revision.
export class RevisionStorage {
  constructor(database, resources, { sql } = {}) {
    this.db = database; this.resources = resources; this.sql = sql || sqliteAccess(database);
    this.prepared = new WeakMap(); this.references = new WeakMap();
  }
  initialize() {
    applySchemaMigrations(this.db, "revision-storage", revisionSchemaMigrations);
  }
  async stage(value) {
    const ref = await this.resources.putObject(value);
    if (value && typeof value === "object") this.references.set(value, ref);
    return ref;
  }
  pack(value) {
    return JSON.stringify(value, (key, current) => {
      const ref = current && typeof current === "object" && this.references.get(current);
      if (ref) check(hash(json(current)) === ref.sha256, "OBJECT_PREPARATION_CHANGED", "已准备的内容对象发生改变，不能保存旧对象引用。", 409);
      return ref ? { [OBJECT_MARKER]: ref } : current;
    });
  }
  async unpack(value) {
    const ref = objectReference(value);
    if (ref) {
      const loaded = await this.resources.readObject(ref);
      if (loaded && typeof loaded === "object") this.references.set(loaded, ref);
      return loaded;
    }
    if (Array.isArray(value)) return Promise.all(value.map((entry) => this.unpack(entry)));
    if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await this.unpack(entry)])));
    return value;
  }
  async prepare(validated, resourceMap, { authoring, identity } = {}) {
    const values = { ...validated, resourceMap, authoring, identity }, refs = {};
    // Sequential staging caps transient buffers to one serialized artifact.
    for (const [field, name] of Object.entries(fields)) refs[field] = values[name] === undefined ? null : await this.stage(values[name]);
    refs.text_index = await this.stage(validated.index);
    this.prepared.set(validated, refs);
    return refs;
  }
  indexStatements(documentId, revision, kind, value) {
    const encoded = json(value);
    const statements = [{ sql: "DELETE FROM revision_indexes WHERE document_id=? AND revision=? AND kind=?", values: [documentId, revision, kind] }];
    let part = 0;
    for (let at = 0; at < encoded.length;) {
      let end = Math.min(at + 16384, encoded.length);
      if (end < encoded.length && /[\uD800-\uDBFF]/.test(encoded[end - 1])) end--;
      statements.push({ sql: "INSERT INTO revision_indexes VALUES(?,?,?,?,?)", values: [documentId, revision, kind, part++, encoded.slice(at, end)] });
      at = end;
    }
    return statements;
  }
  writeIndex(documentId, revision, kind, value) {
    for (const { sql, values } of this.indexStatements(documentId, revision, kind, value)) this.db.prepare(sql).run(...values);
  }
  readIndex(documentId, revision, kind, expected) {
    return mapRead(this.sql.query("SELECT part,payload FROM revision_indexes WHERE document_id=? AND revision=? AND kind=? ORDER BY part", [documentId, revision, kind]), (rows) => {
      if (!rows.length) return null;
      check(rows.every((row, index) => row.part === index), "OBJECT_INDEX_CORRUPT", "正文索引片段不完整。", 409);
      const encoded = rows.map((row) => row.payload).join("");
      if (expected) check(hash(encoded) === expected.sha256 && Buffer.byteLength(encoded) === expected.size,
        "OBJECT_INDEX_CORRUPT", "正文索引与不可变对象摘要不一致。", 409);
      try { return JSON.parse(encoded); }
      catch { check(false, "OBJECT_INDEX_CORRUPT", "正文索引格式损坏。", 409); }
    });
  }
  navigation(document) {
    return { id: document.id, revision: document.revision, blocks: document.blocks.map((block) => ({ id: block.id, type: block.type,
      ...(block.source ? { source: block.source } : {}), ...(block.type === "heading" ? { text: block.text, translations: block.translations } : {}) })) };
  }
  preparedChanges(validated, resourceMap, { actor = "local", authoring, identity } = {}) {
    const refs = this.prepared.get(validated), d = validated.document;
    check(refs, "OBJECT_NOT_PREPARED", "内容对象必须在发布事务前上传。", 500);
    const values = { ...validated, resourceMap, authoring, identity };
    for (const [field, name] of Object.entries(fields)) {
      const value = values[name];
      check(refs[field] ? value !== undefined && hash(json(value)) === refs[field].sha256 : value === undefined,
        "OBJECT_PREPARATION_CHANGED", "上传后内容对象发生改变，请重新准备发布。", 409);
    }
    check(hash(json(validated.index)) === refs.text_index.sha256, "OBJECT_PREPARATION_CHANGED", "上传后正文索引发生改变。", 409);
    const row = { document_id: d.id, revision: d.revision, content: encode(refs.content), text_index: encode(refs.text_index), fingerprints: encode(refs.fingerprints), resources: encode(refs.resources), report: encode(refs.report), authoring: refs.authoring ? encode(refs.authoring) : null, identity: refs.identity ? encode(refs.identity) : null, read_only: validated.readOnly ? 1 : 0, created_at: new Date().toISOString(), actor };
    return { changes: [{ entity: "revisions", value: row }], statements: [...this.indexStatements(d.id, d.revision, "text", validated.index), ...this.indexStatements(d.id, d.revision, "navigation", this.navigation(d))] };
  }
  save(validated, resourceMap, options = {}) {
    const prepared = this.preparedChanges(validated, resourceMap, options), row = prepared.changes[0].value;
    this.db.prepare("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(...Object.values(row));
    for (const { sql, values } of prepared.statements) this.db.prepare(sql).run(...values);
  }
  index(row) {
    const inline = JSON.parse(row.text_index);
    return mapRead(this.readIndex(row.document_id, row.revision, "text", objectReference(inline)), (saved) => {
      if (saved) return saved;
      check(Array.isArray(inline), "OBJECT_INDEX_MISSING", "正文索引尚未同步。", 409);
      return inline;
    });
  }
  nav(row) {
    return mapRead(this.readIndex(row.document_id, row.revision, "navigation"), (value) => {
      if (value) {
        check(value.id === row.document_id && value.revision === row.revision && Array.isArray(value.blocks), "OBJECT_INDEX_CORRUPT", "导航索引与正文版本不一致。", 409);
        return value;
      }
      const inline = JSON.parse(row.content);
      check(!objectReference(inline), "OBJECT_INDEX_MISSING", "内容索引尚未同步。", 409);
      return this.navigation(inline);
    });
  }
  async load(row) {
    const value = { index: await this.index(row), readOnly: Boolean(row.read_only) };
    for (const [field, name] of Object.entries(fields)) if (row[field] !== null) {
      const stored = JSON.parse(row[field]); value[name] = await this.unpack(stored);
      const ref = objectReference(stored); if (ref && value[name] && typeof value[name] === "object") this.references.set(value[name], ref);
    }
    check(value.document?.id === row.document_id && value.document?.revision === row.revision && Array.isArray(value.document.blocks),
      "OBJECT_REVISION_MISMATCH", "内容对象与正文版本不一致。", 409);
    return value;
  }
  async prepareImported(rows) {
    const prepared = [];
    for (const row of rows) {
      const document = await this.unpack(JSON.parse(row.content)), index = await this.unpack(JSON.parse(row.text_index));
      check(document.id === row.document_id && document.revision === row.revision && Array.isArray(document.blocks) && Array.isArray(index),
        "OBJECT_REVISION_MISMATCH", "内容对象与版本记录不一致。", 409);
      prepared.push({ documentId: row.document_id, revision: row.revision, index, navigation: this.navigation(document) });
    }
    return prepared;
  }
  installImported(prepared) {
    for (const item of prepared) {
      this.writeIndex(item.documentId, item.revision, "text", item.index);
      this.writeIndex(item.documentId, item.revision, "navigation", item.navigation);
    }
  }
  async migrate({ repair = false } = {}) {
    // A completed migration is permanent. Ordinary DO cold starts must not walk
    // every document/index or download immutable objects just to serve a list.
    if (!repair && this.db.prepare("SELECT value FROM metadata WHERE key='immutableStorageVersion'").get()?.value === "1") return;
    const revisions = this.db.prepare("SELECT document_id,revision FROM revisions").all();
    for (const key of revisions) {
      const row = this.db.prepare("SELECT * FROM revisions WHERE document_id=? AND revision=?").get(key.document_id, key.revision);
      const complete = Object.keys(fields).every((field) => row[field] === null || objectReference(JSON.parse(row[field]))) && objectReference(JSON.parse(row.text_index));
      if (!repair && complete && this.readIndex(row.document_id, row.revision, "text", objectReference(JSON.parse(row.text_index))) && this.readIndex(row.document_id, row.revision, "navigation")) continue;
      // A previous process may have published objects but not its derivative
      // indexes. Recover from the immutable index, not from an index-only read.
      const saved = { index: await this.unpack(JSON.parse(row.text_index)), readOnly: Boolean(row.read_only) };
      for (const [field, name] of Object.entries(fields)) if (row[field] !== null) saved[name] = await this.unpack(JSON.parse(row[field]));
      check(saved.document?.id === row.document_id && saved.document?.revision === row.revision && Array.isArray(saved.document.blocks) && Array.isArray(saved.index),
        "OBJECT_REVISION_MISMATCH", "迁移内容对象与正文版本不一致。", 409);
      const refs = await this.prepare(saved, saved.resourceMap, saved);
      this.db.transaction(() => {
        const current = this.db.prepare("SELECT * FROM revisions WHERE document_id=? AND revision=?").get(key.document_id, key.revision);
        check(current && Object.keys(row).every((field) => current[field] === row[field]), "REVISION_CONFLICT", "迁移期间正文版本改变。", 409);
        this.db.prepare("UPDATE revisions SET content=?,text_index=?,fingerprints=?,resources=?,report=?,authoring=?,identity=? WHERE document_id=? AND revision=?")
          .run(encode(refs.content), encode(refs.text_index), encode(refs.fingerprints), encode(refs.resources), encode(refs.report), refs.authoring ? encode(refs.authoring) : null, refs.identity ? encode(refs.identity) : null, key.document_id, key.revision);
        this.writeIndex(key.document_id, key.revision, "text", saved.index);
        this.writeIndex(key.document_id, key.revision, "navigation", this.navigation(saved.document));
        const document = this.db.prepare("SELECT metadata,current_revision FROM documents WHERE id=?").get(key.document_id);
        const metadata = JSON.parse(document.metadata);
        if (!metadata.title && document.current_revision === key.revision) { metadata.title = saved.document.meta.title; this.db.prepare("UPDATE documents SET metadata=? WHERE id=?").run(json(metadata), key.document_id); }
      });
    }
    for (const row of this.db.prepare("SELECT id,payload FROM authoring_previews").all()) {
      if (objectReference(JSON.parse(row.payload))) continue;
      const ref = await this.stage(JSON.parse(row.payload));
      this.db.prepare("UPDATE authoring_previews SET payload=? WHERE id=? AND payload=?").run(encode(ref), row.id, row.payload);
    }
    this.db.prepare("INSERT INTO metadata(key,value) VALUES('immutableStorageVersion','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  }
}
