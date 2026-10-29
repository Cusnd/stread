import { commitBusiness, commitAuxiliary } from "./business-commit.mjs";
import { prepareBusinessCommand } from "./business-commands.mjs";
import { createPreview, publishPreview, publishAuthoringInput } from "./publication-commands.mjs";
import { workspaceSchemaMigrations } from "./workspace-schema.mjs";
import { sqliteAccess, mapRead, businessAssertionSchema } from "./sql-commit.mjs";
import { randomUUID } from "node:crypto";
import { check, clone, fail, hash, identifier, json, normalized, object, text, version } from "./errors.mjs";
import { resolveSource, validateDocument } from "./documents.mjs";
import { authoringArtifact, authoringArtifactManifest, authoringContract, prepareAuthoring, uploadedSourceDescriptor, verifyAuthoringFile } from "./authoring-core.mjs";
import { previewDescriptor, verifyPreviewSnapshot } from "./authoring-preview.mjs";
import { collectQualityEvidence, previewQualityReport } from "./authoring-quality.mjs";
import { DocumentRelations } from "./relations.mjs";
import { FlowData } from "./flow.mjs";
import { localActor } from "./actor.mjs";
import { RevisionStorage } from "./revision-storage.mjs";
import { prepareRevisionConflict } from "./revision-conflicts.mjs";
import { applySchemaMigrations } from "./schema-migrations.mjs";
import { documentSourceRegions } from "./document-sources.mjs";
import { createAuthoringEditPackage, editingPackageDescriptor } from "./authoring-edit-package.mjs";

const now = () => new Date().toISOString();
const parsed = (row) => row ? JSON.parse(row.payload) : undefined;
const readValues = (values) => values.some(value => value && typeof value.then === "function") ? Promise.all(values) : values;
const referencePattern = /^#([QN])([0-9]{5,})$/;
const documentSummary = row => {
  const metadata = JSON.parse(row.metadata);
  return { id: row.id, title: metadata.title || "", status: metadata.status || "unread", revision: row.current_revision, version: row.version,
    tags: metadata.tags || [], kind: metadata.kind || "文档", summary: metadata.summary || "", collectionIds: metadata.collectionIds || [],
    readingState: JSON.parse(row.reading_payload || "null"), archivedAt: row.archived_at || null };
};
function documentSelection({ includeArchived = false, documentId, collectionId, status, tag } = {}) {
  const clauses = [], values = [];
  if (documentId) { clauses.push('d.id=?'); values.push(documentId); }
  else if (!includeArchived) clauses.push('d.archived_at IS NULL');
  if (collectionId) { clauses.push("EXISTS(SELECT 1 FROM json_each(d.metadata,'$.collectionIds') WHERE type='text' AND value=?)"); values.push(collectionId); }
  if (status) { clauses.push("COALESCE(NULLIF(json_extract(d.metadata,'$.status'),''),'unread')=?"); values.push(status); }
  if (tag !== undefined) { clauses.push("EXISTS(SELECT 1 FROM json_each(d.metadata,'$.tags') WHERE type='text' AND value=?)"); values.push(tag); }
  return { where: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', values };
}

export class Workspace {
  constructor(options) {
    this.options = options;
    this.dataDir = options.dataDir;
    this.db = options.database;
    this.sql = options.sql || sqliteAccess(this.db);
    this.resources = options.resources;
    this.storage = new RevisionStorage(this.db, this.resources, { sql: this.sql });
    this.exampleSignatures = new Set();
  }
  async initialize() {
    await this.resources.initialize();
    applySchemaMigrations(this.db, "workspace", workspaceSchemaMigrations);
    this.db.exec(businessAssertionSchema);
    this.storage.initialize();
    await this.storage.migrate({ repair: this.options.repairStorage === true });
    this.relations = new DocumentRelations(this.db);
    this.flow = new FlowData(this.db, {
      navigation: (id, revision) => mapRead(this.revisionState(id, revision), saved => saved.document),
      meta: key => this.meta(key),
    }, { sql: this.sql, now: this.options.flowNow, readingProjectionLimits: this.options.readingProjectionLimits });
    for (const [key, value] of Object.entries({ revision: 0, plan: [], planVersion: 1, currentId: null, glossaryRevision: 0 })) this.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)").run(key, json(value));
    for (const series of ["Q", "N", "R"]) this.db.prepare("INSERT OR IGNORE INTO counters(series,value) VALUES(?,0)").run(series);
    if (this.options.initializeData) await this.options.initializeData(this);
    if (this.options.refreshRelations !== false) await this.refreshRelations();
    // The conversions table is retained as history; retired extraction jobs never resume.
  }
  meta(key) { return mapRead(this.sql.query("SELECT value FROM metadata WHERE key=?", [key]), rows => JSON.parse(rows[0].value)); }
  async readListVersionState(name, input = {}) {
    if (name === 'list_collections') return this.sql.query('SELECT id,label,parent_id,version FROM collections ORDER BY id');
    if (name === 'query_uploaded_sources') return this.sql.query('SELECT id,filename,media_type,sha256,size,created_at FROM files ORDER BY id');
    if (name === 'get_reading_plan') {
      const [metadata, rows] = await this.sql.batch([
        {sql:"SELECT key,value FROM metadata WHERE key IN ('plan','planVersion','currentId')",values:[]},
        {sql:`SELECT d.id,d.version,d.current_revision,d.archived_at,r.document_id AS reading_id,r.payload
          FROM json_each((SELECT value FROM metadata WHERE key='plan')) p
          LEFT JOIN documents d ON d.id=p.value LEFT JOIN reading r ON r.document_id=p.value ORDER BY CAST(p.key AS INTEGER)`,values:[]},
      ]);
      const saved = Object.fromEntries(metadata.rows.map(row => [row.key, JSON.parse(row.value)]));
      return {planVersion:saved.planVersion,ids:saved.plan,currentId:saved.currentId,documents:rows.rows.map(row => [
        row.id === null ? undefined : {id:row.id,version:row.version,current_revision:row.current_revision,archived_at:row.archived_at},
        row.reading_id === null ? undefined : {payload:row.payload},
      ])};
    }
    const state = { workspace: await this.meta('revision') };
    if (['query_insights', 'query_reading_activity'].includes(name)) state.activity = await this.flow.getRevision();
    if (name === 'query_glossary') state.glossary = await this.meta('glossaryRevision');
    if (name === 'query_reading_activity') {
      try { state.day = new Intl.DateTimeFormat('en-CA', { timeZone: input.timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(this.flow.now())); }
      catch { check(false, 'VALIDATION_FAILED', 'The activity timezone must be a valid IANA timezone.'); }
    }
    return state;
  }
  setMeta(key, value) { this.db.prepare("UPDATE metadata SET value=? WHERE key=?").run(json(value), key); }
  authorize(actor = localActor, scope = "read") {
    check(actor?.workspaceId === "local" && Array.isArray(actor.scopes) && actor.scopes.includes(scope), "FORBIDDEN", "没有此工作台的访问权限。", 403);
    return actor;
  }
  row(documentId) { identifier(documentId, "文档 ID"); return mapRead(this.sql.query("SELECT * FROM documents WHERE id=?", [documentId]), ([row]) => { check(row, "NOT_FOUND", "没有找到这份文档。", 404); return row; }); }
  revisionRow(documentId, revision) {
    return mapRead(this.row(documentId), row => mapRead(this.sql.query("SELECT * FROM revisions WHERE document_id=? AND revision=?", [documentId, revision ?? row.current_revision]), ([result]) => {
      check(result, "NOT_FOUND", "没有找到这个正文版本。", 404); return result;
    }));
  }
  async revision(documentId, revision) { return this.storage.load(await this.revisionRow(documentId, revision)); }
  revisionIndex(documentId, revision) { return mapRead(this.revisionRow(documentId, revision), row => this.storage.index(row)); }
  revisionNavigation(documentId, revision) { return mapRead(this.revisionRow(documentId, revision), row => this.storage.nav(row)); }
  revisionState(documentId, revision) {
    return mapRead(this.revisionRow(documentId, revision), row => mapRead(readValues([this.storage.nav(row), this.storage.index(row)]), ([document, index]) => ({ document, index, readOnly: Boolean(row.read_only) })));
  }
  prepareRevision(validated, resourceMap, options) { return this.storage.prepare(validated, resourceMap, options); }
  prepareImportedRevisionIndexes(rows) { return this.storage.prepareImported(rows); }
  installImportedRevisionIndexes(prepared) { return this.storage.installImported(prepared); }
  prepareSyncConflictResolution(conflict) { return prepareRevisionConflict(this, conflict); }
  material(row) {
    const metadata = JSON.parse(row.metadata);
    const summary = row.insight_count !== undefined ? row : mapRead(this.sql.query(`SELECT COUNT(*) AS insight_count,
      (SELECT json_extract(payload,'$.body') FROM insights WHERE document_id=? AND archived_at IS NULL AND json_extract(payload,'$.type')='question'
        AND (json_extract(payload,'$.answer') IS NULL OR json_extract(payload,'$.answer') IN (0,'')) ORDER BY rowid LIMIT 1) AS question
      FROM insights WHERE document_id=? AND archived_at IS NULL`, [row.id, row.id]), rows => rows[0]);
    const reading = row.reading_payload !== undefined ? JSON.parse(row.reading_payload || "null") : mapRead(this.sql.query("SELECT payload FROM reading WHERE document_id=?", [row.id]), rows => parsed(rows[0]) || null);
    return mapRead(readValues([summary, reading]), ([summary, readingState]) => ({ id: row.id, title: metadata.title || "", kind: metadata.kind || "文档", summary: metadata.summary || "", collectionIds: metadata.collectionIds || [], tags: metadata.tags || [], status: metadata.status || "unread", revision: row.current_revision, version: row.version, assetBase: `/api/documents/${encodeURIComponent(row.id)}/assets/`, readingState, insightCount: summary.insight_count, ...(summary.question ? { question: summary.question } : {}), archivedAt: row.archived_at || null, diagnostics: metadata.diagnostics || [] }));
  }
  snapshot({ includeArchived = false } = {}) {
    const documentsSql = `WITH summary AS (
      SELECT document_id,COUNT(*) AS insight_count,MIN(CASE WHEN json_extract(payload,'$.type')='question'
        AND (json_extract(payload,'$.answer') IS NULL OR json_extract(payload,'$.answer') IN (0,'')) THEN rowid END) AS question_row
      FROM insights WHERE archived_at IS NULL GROUP BY document_id)
      SELECT d.*,r.payload AS reading_payload,COALESCE(s.insight_count,0) AS insight_count,json_extract(q.payload,'$.body') AS question
      FROM documents d LEFT JOIN reading r ON r.document_id=d.id LEFT JOIN summary s ON s.document_id=d.id LEFT JOIN insights q ON q.rowid=s.question_row` +
      (includeArchived ? "" : " WHERE d.archived_at IS NULL") + " ORDER BY d.created_at,d.id";
    // The revision is a delivery watermark. A read batch must bind it to the
    // exact rows; old rows tagged with a new watermark would suppress refresh.
    return mapRead(this.sql.batch([{sql:documentsSql,values:[]},
      {sql:'SELECT id,label,parent_id AS parentId,version FROM collections ORDER BY label,id',values:[]},
      {sql:"SELECT key,value FROM metadata WHERE key IN ('revision','plan','planVersion','currentId')",values:[]}]),
    ([documents,collections,metadata])=>{
      const saved=Object.fromEntries(metadata.rows.map(row=>[row.key,JSON.parse(row.value)]));
      return mapRead(readValues(documents.rows.map(row=>this.material(row))),rows=>({revision:saved.revision,documents:rows,
        collections:collections.rows,planIds:saved.plan,planVersion:saved.planVersion,currentId:saved.currentId}));
    });
  }
  // MCP discovery must not materialize document bodies or insight answers.
  documentSummaries(input = {}) {
    const {where,values} = documentSelection(input), paged = input.limit !== undefined;
    return mapRead(input.documentId ? this.row(input.documentId) : null, () => mapRead(this.sql.query(
      'SELECT d.*,r.payload AS reading_payload FROM documents d LEFT JOIN reading r ON r.document_id=d.id' + where +
      ' ORDER BY d.created_at,d.id' + (paged ? ' LIMIT ? OFFSET ?' : ''),
      paged ? [...values,input.limit,input.offset || 0] : values), rows => rows.map(documentSummary)));
  }
  documentList(input = {}) {
    const {where,values} = documentSelection(input), offset=input.offset || 0,limit=input.limit || 10;
    return mapRead(input.documentId ? this.row(input.documentId) : null, () => mapRead(this.sql.batch([
      {sql:'SELECT COUNT(*) AS total FROM documents d' + where,values},
      {sql:'SELECT d.*,r.payload AS reading_payload FROM documents d LEFT JOIN reading r ON r.document_id=d.id' + where + ' ORDER BY d.created_at,d.id LIMIT ? OFFSET ?',values:[...values,limit,offset]},
    ]), ([count,rows]) => ({total:count.rows[0].total,items:rows.rows.map(documentSummary)})));
  }
  insights(documentId, includeArchived = false) { return mapRead(this.sql.query("SELECT payload FROM insights WHERE document_id=?" + (includeArchived ? "" : " AND archived_at IS NULL") + " ORDER BY rowid", [documentId]), rows => rows.map(parsed)); }
  changeRequests(documentId) {
    return mapRead(documentId ? this.row(documentId) : null, () => mapRead(this.sql.query("SELECT payload FROM change_requests" + (documentId ? " WHERE document_id=?" : "") + " ORDER BY rowid DESC", documentId ? [documentId] : []), rows => rows.map(parsed)));
  }
  async refreshRelations() {
    const rows = this.db.prepare("SELECT d.id,d.current_revision FROM documents d LEFT JOIN bibliographic_documents b ON b.document_id=d.id WHERE b.document_id IS NULL OR b.revision<>d.current_revision").all();
    for (const row of rows) { const saved = await this.revision(row.id, row.current_revision); this.db.transaction(() => this.relations.sync([saved.document], { rematch: false })); }
    this.db.transaction(() => this.relations.sync([]));
  }
  documentRelations(documentId, revision) {
    const read = attempt => mapRead(this.meta('revision'), before => mapRead(this.row(documentId), row => {
      const result=revision&&revision!==row.current_revision
        ? mapRead(this.revisionRow(documentId,revision),()=>({documentId,revision,currentRevision:row.current_revision,readOnly:true,outgoing:[],incoming:[]}))
        : this.relations.query(documentId,row.current_revision);
      return mapRead(result,value=>mapRead(this.meta('revision'),after=>{
        if(after===before)return value;
        check(attempt<3,'BUSINESS_READ_CHANGED','读取期间工作台已改变，请重新读取。',503,{retryable:true});
        return read(attempt+1);
      }));
    }));
    return read(0);
  }
  objectPreferences(documentId) {
    identifier(documentId,'文档 ID');
    return mapRead(this.sql.batch([{sql:'SELECT current_revision FROM documents WHERE id=?',values:[documentId]},
      {sql:"SELECT value FROM metadata WHERE key='revision'",values:[]},
      {sql:'SELECT block_id,payload FROM object_preferences WHERE document_id=?',values:[documentId]}]),
    ([document,revision,objects])=>{
      check(document.rows[0],'NOT_FOUND','没有找到这份文档。',404);
      return {documentId,workspaceRevision:JSON.parse(revision.rows[0].value),documentRevision:document.rows[0].current_revision,
        objects:Object.fromEntries(objects.rows.map(row=>[row.block_id,parsed(row)]))};
    });
  }
  async envelope(documentId, revision) {
    const row = await this.row(documentId), saved = await this.revision(documentId, revision ?? row.current_revision);
    const insights = await Promise.all((await this.insights(documentId)).map(async (insight) => {
      const resolve = (source) => source.blockId ? resolveSource(saved.index, source, { allowUnresolved: true }) : source;
      const resolved = resolve(insight);
      if (insight.sources) resolved.sources = insight.sources.map(resolve);
      resolved.review = await this.flow.reviewFor(insight.id);
      return resolved;
    }));
    return { document: saved.document, assetBase: `/api/documents/${encodeURIComponent(documentId)}/assets/`, insights, changeRequests: await this.changeRequests(documentId), readingState: parsed((await this.sql.query("SELECT payload FROM reading WHERE document_id=?", [documentId]))[0]) || null, record: await this.material(row), readOnly: saved.readOnly, fingerprints: saved.fingerprints, report: saved.report };
  }
  async query(actor, query) {
    if (query === undefined) { query = actor; actor = localActor; } this.authorize(actor);
    object(query, "查询");
    if (query.kind?.startsWith("flow.")) return this.flow.query(actor, query);
    if (query.kind === "workspace") return this.snapshot(query);
    if (query.kind === "collections") {
      const paged=query.limit!==undefined||query.offset!==undefined,where=query.parentId===undefined?'':' WHERE parent_id IS ?',values=query.parentId===undefined?[]:[query.parentId];
      const [collections,revision,count]=await this.sql.batch([
        {sql:'SELECT id,label,parent_id AS parentId,version FROM collections'+where+' ORDER BY label,id'+(paged?' LIMIT ? OFFSET ?':''),values:paged?[...values,query.limit||10,query.offset||0]:values},
        {sql:"SELECT value FROM metadata WHERE key='revision'",values:[]},
        ...(paged?[{sql:'SELECT COUNT(*) AS total FROM collections'+where,values}]:[])]);
      return {collections:collections.rows,workspaceRevision:JSON.parse(revision.rows[0].value),...(paged?{total:count.rows[0].total}:{})};
    }
    if (query.kind === "reading_plan") {
      const values=Object.fromEntries((await this.sql.query("SELECT key,value FROM metadata WHERE key IN ('plan','planVersion','currentId','revision')")).map(row=>[row.key,JSON.parse(row.value)]));
      return {planIds:values.plan,planVersion:values.planVersion,currentId:values.currentId,workspaceRevision:values.revision};
    }
    if (query.kind === "document") return this.envelope(query.documentId, query.revision);
    if (query.kind === "object_preferences") return this.objectPreferences(query.documentId);
    if (query.kind === "document_relations") return this.documentRelations(query.documentId, query.revision);
    if (query.kind === "reference") return this.reference(query.reference, query.documentId);
    if (query.kind === "insights") { await this.row(query.documentId); return { insights: await this.insights(query.documentId, query.includeArchived) }; }
    if (query.kind === "change_requests") {
      if(query.documentId)await this.row(query.documentId);
      const paged=query.limit!==undefined||query.offset!==undefined,clauses=[],values=[];
      if(query.documentId){clauses.push('document_id=?');values.push(query.documentId);}
      if(query.status){clauses.push("(CASE WHEN json_valid(payload) THEN json_extract(payload,'$.status') ELSE NULL END)=?");values.push(query.status);}
      const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
      const [rows,count]=await this.sql.batch([
        {sql:'SELECT payload FROM change_requests'+where+' ORDER BY rowid DESC'+(paged?' LIMIT ? OFFSET ?':''),values:paged?[...values,query.limit||10,query.offset||0]:values},
        ...(paged?[{sql:'SELECT COUNT(*) AS total FROM change_requests'+where,values}]:[])]);
      return {changeRequests:rows.rows.map(parsed),...(paged?{total:count.rows[0].total}:{})};
    }
    if (query.kind === "proposals") {
      const paged=query.limit!==undefined||query.offset!==undefined,where=query.documentId?' WHERE document_id=?':'',values=query.documentId?[query.documentId]:[];
      const [rows,count]=await this.sql.batch([
        {sql:'SELECT payload FROM proposals'+where+' ORDER BY rowid DESC'+(paged?' LIMIT ? OFFSET ?':''),values:paged?[...values,query.limit||10,query.offset||0]:values},
        ...(paged?[{sql:'SELECT COUNT(*) AS total FROM proposals'+where,values}]:[])]);
      return {proposals:await Promise.all(rows.rows.map(row=>this.storage.unpack(parsed(row)))),...(paged?{total:count.rows[0].total}:{})};
    }
    if (query.kind === "changes") {
      const [revision,changes]=await this.sql.batch([{sql:"SELECT value FROM metadata WHERE key='revision'",values:[]},
        {sql:'SELECT cursor,payload FROM changes WHERE cursor>? ORDER BY cursor LIMIT 200',values:[Number(query.after)||0]}]);
      return {revision:JSON.parse(revision.rows[0].value),changes:changes.rows.map(row=>({cursor:row.cursor,...parsed(row)}))};
    }
    if (query.kind === "search") {
      const needle = normalized(text(query.query || "", "检索词", 500));
      const candidates = (await this.snapshot(query)).documents;
      const matched = await Promise.all(candidates.map(async document => normalized([document.title, document.summary, ...document.tags].join("\n")).includes(needle) || (await this.revisionIndex(document.id)).some(entry => normalized(entry.text).includes(needle))));
      const documents = candidates.filter((_, index) => matched[index]);
      return { documents: documents.slice(0, query.limit || 100), total: documents.length };
    }
    if (query.kind === "read_document") return this.readDocument(query);
    if (query.kind === "glossary.list") return this.glossaryList(query);
    if (query.kind === "glossary.get") return { entry: await this.glossaryGet(query.id, query.includeDeleted ? null : query.deleted === true) };
    fail("VALIDATION_FAILED", "不支持的查询。");
  }
  async readDocument(query) {
    const saved = await this.revision(query.documentId, query.revision), document = saved.document;
    const offset = Math.max(0, Number.isInteger(query.offset) ? query.offset : 0), limit = Math.min(100, Math.max(1, Number.isInteger(query.limit) ? query.limit : 20));
    let blocks;
    if (query.blockId) {
      const at = document.blocks.findIndex((b) => b.id === query.blockId); check(at >= 0, "ANCHOR_UNRESOLVED", "指定内容块不存在。", 404);
      const context = Math.min(5, Math.max(0, Number.isInteger(query.context) ? query.context : 0)); blocks = document.blocks.slice(Math.max(0, at - context), at + context + 1);
    } else blocks = document.blocks.slice(offset, offset + limit);
    const ids = new Set(blocks.map((b) => b.id));
    const entries = saved.index.filter((entry) => ids.has(entry.blockId) && (!query.variant || entry.variant === query.variant) && (!query.field || entry.field === query.field) && (!query.nodeId || entry.nodeId === query.nodeId) && (!query.itemId || entry.itemId === query.itemId) && (query.row === undefined || entry.row === query.row) && (query.column === undefined || entry.column === query.column));
    const fingerprints = Object.fromEntries(Object.entries(saved.fingerprints).filter(([id]) => ids.has(id) || blocks.some((b) => b.items?.some((i) => i.id === id))));
    return { documentId: document.id, revision: document.revision, title: document.meta.title, source: document.source, blocks, text: entries, sourceHashes: fingerprints, readOnly: saved.readOnly, coverage: { offset: document.blocks.indexOf(blocks[0]), count: blocks.length, total: document.blocks.length }, readerUrl: `/?document=${encodeURIComponent(document.id)}` };
  }
  reference(value, documentId) {
    text(value, "引用编号", 64, true); const reference = value.startsWith("#") ? value : "#" + value;
    if (/^#R[0-9]{5,}$/.test(reference)) {
      return mapRead(this.sql.query("SELECT payload FROM change_requests WHERE reference=?", [reference]), rows => {
        const request = parsed(rows[0]);
        check(request && (!documentId || request.documentId === documentId), "NOT_FOUND", "更改请求不存在。", 404);
        return { documentId: request.documentId, changeRequest: request, readerUrl: `/?document=${encodeURIComponent(request.documentId)}` + (request.source?.blockId ? "#" + encodeURIComponent(request.source.blockId) : "") };
      });
    }
    check(referencePattern.test(reference), "VALIDATION_FAILED", "引用编号格式应为 #Q00001 或 #N00001。");
    return mapRead(readValues([this.sql.query("SELECT insight_id FROM references_map WHERE reference=?", [reference]), this.sql.query("SELECT insight_id,document_id FROM legacy_aliases WHERE reference=?", [reference])]), ([canonicalRows, legacy]) => {
      const ids = new Set([...canonicalRows.map(row => row.insight_id), ...legacy.map(row => row.insight_id)]);
      return mapRead(readValues([...ids].map(id => mapRead(this.sql.query("SELECT * FROM insights WHERE id=?", [id]), rows => rows[0]))), rows => {
        const results = rows.filter(row => row && (!documentId || row.document_id === documentId));
        check(results.length <= 1, "AMBIGUOUS_REFERENCE", "旧编号对应多份资料，请提供文章标识。", 409, { documentIds: [...new Set(results.map((row) => row.document_id))] });
        check(results.length === 1 && !results[0].archived_at, "NOT_FOUND", "引用不存在或内容已移除。", 404);
        return { documentId: results[0].document_id, insight: parsed(results[0]) };
      });
    });
  }
  expected(row, expectedVersion) { version(expectedVersion, "预期版本"); check(row.version === expectedVersion, "REVISION_CONFLICT", "内容已被更新，请重新读取后重试。", 409, { expectedVersion, currentVersion: row.version }); }
  recordFile(descriptor, id = "file-" + randomUUID()) {
    this.db.prepare("INSERT OR IGNORE INTO files VALUES(?,?,?,?,?,?)").run(id, descriptor.filename, descriptor.mediaType, descriptor.sha256, descriptor.size, now());
    return { id, ...descriptor };
  }
  file(id) { return mapRead(this.sql.query("SELECT * FROM files WHERE id=?", [id]), ([row]) => { check(row, "NOT_FOUND", "来源文件不存在。", 404); return { id: row.id, filename: row.filename, mediaType: row.media_type, sha256: row.sha256, size: row.size }; }); }
  files(ids) {
    if (!ids.length) return [];
    return mapRead(this.sql.query("SELECT * FROM files WHERE id IN (SELECT value FROM json_each(?))", [JSON.stringify([...new Set(ids)])]), rows => {
      const byId = new Map(rows.map(row => [row.id, row]));
      return ids.map(id => {
        const row = byId.get(id);
        return row ? { id: row.id, filename: row.filename, mediaType: row.media_type, sha256: row.sha256, size: row.size } : null;
      });
    });
  }
  saveRevision(validated, resourceMap, options = {}) {
    this.storage.save(validated, resourceMap, options);
    this.relations.sync([validated.document], { rematch: false });
  }
  async validateCandidate(document, saved, options = {}) {
    let pageCount;
    const source = document.source && saved.resourceMap[document.source.path];
    if (source && (source.mediaType === "application/pdf" || document.source.media_type === "application/pdf" || document.source.path.toLowerCase().endsWith(".pdf"))) pageCount = (await this.resources.manifest(source)).pages.length;
    const validated = await validateDocument(document, { resourceMap: saved.resourceMap, pageCount, knownDanglingLinks: saved.report?.danglingLinks || [], ...options });
    if (saved.report?.authoringSubmission) validated.report.authoringSubmission = clone(saved.report.authoringSubmission);
    return validated;
  }
  async execute(actor, command) {
    if (command === undefined) { command = actor; actor = localActor; }
    this.authorize(actor, 'write'); command = clone(object(command, '操作'));
    if (command.kind?.startsWith('reading.session.')) await this.flow.authorizeCommandAsync(actor, command);
    return commitBusiness(this, actor, command, reads => prepareBusinessCommand(this, actor, command, reads));
  }
  insightRow(id, documentId) { return mapRead(this.sql.query("SELECT * FROM insights WHERE id=? AND document_id=?", [identifier(id, "洞见 ID"), identifier(documentId)]), ([row]) => { check(row, "NOT_FOUND", "洞见不存在。", 404); return row; }); }
  proposal(id) { return mapRead(this.sql.query("SELECT payload FROM proposals WHERE id=?", [identifier(id)]), ([row]) => { check(row, "NOT_FOUND", "修订提案不存在。", 404); return parsed(row); }); }
  glossaryList({ query = "", offset = 0, limit = 100, documentId = "", includeDeleted = false, deleted = false } = {}) {
    const needle = normalized(text(query, "检索词", 200)),clauses=[],values=[];
    const start=Math.max(0,offset),count=Math.min(1000,Math.max(1,limit));
    if(!includeDeleted){clauses.push('(deleted_at IS NULL)=?');values.push(deleted?0:1);}
    if(documentId){clauses.push("(CASE WHEN json_valid(payload) THEN json_extract(payload,'$.documentId') ELSE NULL END)=?");values.push(documentId);}
    const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
    if(!needle)return mapRead(this.sql.batch([
      {sql:"SELECT value FROM metadata WHERE key='glossaryRevision'",values:[]},
      {sql:'SELECT COUNT(*) AS total FROM glossary'+where,values},
      {sql:'SELECT payload FROM glossary'+where+' ORDER BY rowid DESC LIMIT ? OFFSET ?',values:[...values,count,start]},
    ]),([revision,total,rows])=>({revision:JSON.parse(revision.rows[0].value),total:total.rows[0].total,entries:rows.rows.map(parsed)}));
    // NFKC and locale lowercase semantics remain JavaScript's. Scan only the
    // selected document/deletion range in fixed pages; retain only this page's
    // matches while counting the complete range for the established total.
    return (async()=>{
      const revision=await this.meta('glossaryRevision'),entries=[];let total=0,after;
      for(;;){
        const rows=await this.sql.query('SELECT rowid AS position,payload FROM glossary'+where+
          (after===undefined?'':(where?' AND ':' WHERE ')+'rowid<?')+' ORDER BY rowid DESC LIMIT 64',after===undefined?values:[...values,after]);
        for(const row of rows){const entry=parsed(row);if(normalized([entry.term,...entry.aliases,entry.definition].join('\n')).includes(needle)){
          if(total>=start&&entries.length<count)entries.push(entry);total++;
        }}
        if(rows.length<64)break;after=rows.at(-1).position;
      }
      return {revision,total,entries};
    })();
  }
  glossaryGet(id, deleted = false) { return mapRead(this.sql.query("SELECT payload,deleted_at FROM glossary WHERE id=?", [identifier(id)]), ([row]) => { check(row && (deleted === null || Boolean(row.deleted_at) === deleted), "NOT_FOUND", "没有找到这条术语。", 404); return parsed(row); }); }
  glossaryFields(input) {
    const aliases = input.aliases || []; check(Array.isArray(aliases) && aliases.length <= 8, "VALIDATION_FAILED", "别名最多 8 个。");
    return { term: text(input.term, "术语", 120, true).trim(), definition: text(input.definition, "解释", 5000, true).trim(), aliases: [...new Set(aliases.map((value) => text(value, "别名", 120).trim()).filter(Boolean))], documentId: text(input.documentId || "", "文章标识", 160), documentTitle: text(input.documentTitle || "", "文章名称", 200) };
  }
  async upload(actor, input, metadata) {
    if (metadata === undefined && actor !== localActor && !actor?.workspaceId) { metadata = input; input = actor; actor = localActor; }
    this.authorize(actor, "write");
    const file = await this.resources.put(input, metadata), id = 'file-' + randomUUID();
    await commitAuxiliary(this, { changes: [{ entity: 'files', value: { id, filename: file.filename, media_type: file.mediaType,
      sha256: file.sha256, size: file.size, created_at: now() } }], requestId: 'source-upload:' + id });
    return { sourceId: id, filename: file.filename, mediaType: file.mediaType, sha256: file.sha256, size: file.size };
  }
  uploadedSource(actor, sourceId) {
    this.authorize(actor); return mapRead(this.file(identifier(sourceId, "来源文件标识")), uploadedSourceDescriptor);
  }
  uploadedSourceResource(actor, sourceId) {
    this.authorize(actor); return mapRead(this.file(identifier(sourceId, "来源文件标识")), file => this.resources.descriptor(file));
  }
  uploadedSources(actor, input = {}) {
    this.authorize(actor); object(input, "来源文件查询");
    const offset = input.offset ?? 0, limit = input.limit ?? 10;
    check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 20, "VALIDATION_FAILED", "来源文件分页范围无效。");
    const clauses = [], parameters = [];
    if (input.filename !== undefined) { clauses.push("filename=?"); parameters.push(text(input.filename, "文件名", 240, true)); }
    if (input.query !== undefined) {
      const query = text(input.query, "文件检索词", 240).trim();
      if (query) {
        const pattern = "%" + query.replace(/[\\%_]/g, (value) => "\\" + value) + "%";
        // D1 limits LIKE patterns to 50 bytes. Match SQLite LIKE's ASCII fold,
        // NUL termination in legacy names, and UTF-8 decoding of FFFE/FFFF.
        if (Buffer.byteLength(pattern) > 50) {
          clauses.push("instr(lower(replace(replace(substr(filename,1,length(filename)),char(65534),char(65533)),char(65535),char(65533))),lower(?)) > 0");
          parameters.push(query.replace(/[\uFFFE\uFFFF]/g, "\uFFFD"));
        }
        else { clauses.push("filename LIKE ? ESCAPE '\\'"); parameters.push(pattern); }
      }
    }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    return mapRead(this.sql.batch([
      {sql:"SELECT COUNT(*) AS count FROM files" + where,values:parameters},
      {sql:"SELECT id,filename,media_type AS mediaType,sha256,size,created_at AS createdAt FROM files" + where + " ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",values:[...parameters,limit,offset]},
    ]), ([count, rows]) => {
      const total = count.rows[0].count;
      return { sources: rows.rows.map(file => ({ ...uploadedSourceDescriptor(file), createdAt: file.createdAt })),
        page: { offset, count: rows.rows.length, total, nextOffset: offset + rows.rows.length < total ? offset + rows.rows.length : null } };
    });
  }
  getAuthoringContract(actor, sourceId) {
    this.authorize(actor); return mapRead(sourceId === undefined ? undefined : this.uploadedSource(actor, sourceId), authoringContract);
  }
  getAuthoringDocumentation(actor, name) { this.authorize(actor); return this.options.documentation(name); }
  async validateAuthoring(actor, input) {
    if (input === undefined) { input = actor; actor = localActor; }
    this.authorize(actor); return (await prepareAuthoring(this, input)).validation;
  }
  async publishAuthoring(actor, input) {
    if (input === undefined) { input = actor; actor = localActor; }
    return publishAuthoringInput(this, actor, input);
  }
  previewRow(id) {
    return mapRead(this.sql.query("SELECT * FROM authoring_previews WHERE id=?", [identifier(id, "草稿快照标识")]), ([row]) => { check(row, "NOT_FOUND", "草稿快照不存在。", 404); return row; });
  }
  async previewMetadata(id) {
    const row = await this.previewRow(id), [cached] = await this.sql.query("SELECT * FROM preview_metadata WHERE preview_id=?", [id]);
    if (cached?.payload_hash === hash(row.payload)) return { id, draftId: cached.draft_id, hash: cached.preview_hash };
    const snapshot = verifyPreviewSnapshot(await this.storage.unpack(parsed(row)));
    check(snapshot.id === row.id, "PREVIEW_HASH_MISMATCH", "草稿对象与保存的快照标识不一致。", 409);
    // Only cache the version actually read; a concurrent sync can replace a
    // reference while its object is being fetched. Its hash will miss next time.
    await this.cachePreviewMetadata(snapshot, row.payload);
    return { id: snapshot.id, draftId: snapshot.draftId, hash: snapshot.hash };
  }
  async cachePreviewMetadata(snapshot, expectedPayload) {
    // A replacement received while the object was fetched must never get a
    // cache entry for the old candidate. This conditional write is atomic.
    await this.sql.batch([{ sql: `INSERT INTO preview_metadata(preview_id,draft_id,preview_hash,payload_hash)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM authoring_previews WHERE id=? AND payload=?)
      ON CONFLICT(preview_id) DO UPDATE SET draft_id=excluded.draft_id,preview_hash=excluded.preview_hash,payload_hash=excluded.payload_hash
      WHERE preview_metadata.payload_hash IS NOT excluded.payload_hash`,
      values: [snapshot.id, snapshot.draftId, snapshot.hash, hash(expectedPayload), snapshot.id, expectedPayload] }]);
  }
  async previewSnapshot(id) {
    const row = await this.previewRow(id), snapshot = verifyPreviewSnapshot(await this.storage.unpack(parsed(row)));
    check(snapshot.id === row.id, "PREVIEW_HASH_MISMATCH", "草稿对象与保存的快照标识不一致。", 409);
    await this.cachePreviewMetadata(snapshot, row.payload); return snapshot;
  }
  draft(id) {
    return mapRead(this.sql.query("SELECT payload FROM authoring_drafts WHERE id=?", [identifier(id, "草稿标识")]), rows => { const value = parsed(rows[0]); check(value, "NOT_FOUND", "草稿不存在。", 404); return value; });
  }
  async createAuthoringPreview(actor, input) { return createPreview(this, actor, input); }
  async getAuthoringPreview(actor, id) {
    this.authorize(actor); const row = await this.previewRow(id), snapshot = await this.previewSnapshot(id);
    const publicationQuality = row.published_document_id ? (await this.revision(row.published_document_id, snapshot.validated.document.revision)).report?.previewSubmission?.quality : null;
    return { preview: previewDescriptor(snapshot, row.published_document_id, publicationQuality), document: snapshot.validated.document,
      assetBase: `/api/authoring/previews/${encodeURIComponent(id)}/assets/`, validation: snapshot.validation, readOnly: true };
  }
  async getAuthoringDraft(actor, id) {
    this.authorize(actor); const draft = await this.draft(id);
    return { draft, ...await this.getAuthoringPreview(actor, draft.currentPreviewId) };
  }
  async getPreviewArtifact(actor, id, kind, evidenceSourceIds) {
    this.authorize(actor); const snapshot = await this.previewSnapshot(id);
    check(["authoring", "document", "identity", "report", "index", "manifest"].includes(kind), "NOT_FOUND", "草稿产物不存在。", 404);
    check(evidenceSourceIds === undefined || kind === "report", "VALIDATION_FAILED", "质量证据查询只适用于预览报告。", 400);
    if (kind === "authoring") return { resource: { ...await this.uploadedSourceResource(actor, snapshot.authoringFile.id), filename: "authoring.json", mediaType: "application/json" } };
    const qualityEvidence = kind === "report" && evidenceSourceIds !== undefined ? await collectQualityEvidence(this, snapshot, evidenceSourceIds, verifyAuthoringFile) : undefined;
    let retainedQuality = null;
    if (kind === "report" && evidenceSourceIds === undefined) {
      const row = await this.previewRow(id);
      if (row.published_document_id) {
        const saved = await this.revision(row.published_document_id, snapshot.validated.document.revision);
        const quality = saved.report?.previewSubmission?.quality;
        if (quality?.preview?.id === snapshot.id && quality.preview.hash === snapshot.hash && quality.document?.sha256 === snapshot.manifest.documentHash) retainedQuality = quality;
      }
    }
    const values = { document: snapshot.validated.document, identity: snapshot.compiled.identity, index: snapshot.validated.index,
      report: { compiler: snapshot.compiled.report, validation: snapshot.validation, quality: kind === "report" ? retainedQuality || previewQualityReport(snapshot, qualityEvidence) : undefined,
        ...(retainedQuality ? { qualityBasis: "retained-exact-publication" } : {}),
        ...(snapshot.revisionTarget ? { revisionTarget: snapshot.revisionTarget } : {}) }, manifest: snapshot.manifest };
    return { value: values[kind], filename: `${kind}.json` };
  }
  async previewResource(actor, id, request) {
    this.authorize(actor); const snapshot = await this.previewSnapshot(id);
    return this.resourceForSaved({ ...snapshot.validated, resourceMap: snapshot.resourceMap }, request, `/api/authoring/previews/${encodeURIComponent(id)}`);
  }
  async publishAuthoringPreview(actor, input, execution) { return publishPreview(this, actor, input, execution); }
  async getAuthoringArtifacts(actor, documentId, revision) {
    this.authorize(actor); return authoringArtifactManifest(await this.revision(documentId, revision));
  }
  async getAuthoringEditPackage(actor, documentId, revision) {
    this.authorize(actor); return editingPackageDescriptor(await createAuthoringEditPackage(await this.revision(documentId, revision)));
  }
  async getAuthoringEditPackageArtifact(actor, documentId, revision) {
    this.authorize(actor); return { filename: "editing.json", value: await createAuthoringEditPackage(await this.revision(documentId, revision)) };
  }
  async getAuthoringArtifact(actor, documentId, revision, kind) {
    this.authorize(actor); const saved = await this.revision(documentId, revision), value = authoringArtifact(saved, kind);
    const sourceId = kind === "authoring" && saved.report.authoringSubmission?.sourceId;
    return sourceId ? { resource: { ...await this.uploadedSourceResource(actor, sourceId), filename: "authoring.json", mediaType: "application/json" } } : { value, filename: `${kind}.json` };
  }
  async resource(actor, request) {
    if (request === undefined) { request = actor; actor = localActor; } this.authorize(actor);
    const saved = await this.revision(request.documentId, request.revision);
    return this.resourceForSaved(saved, request, `/api/documents/${encodeURIComponent(saved.document.id)}`, `?revision=${saved.document.revision}`);
  }
  async resourceForSaved(saved, request, base, query = "") {
    const document = saved.document;
    if (request.kind === "asset-by-hash") {
      check(typeof request.sha256 === "string" && /^[a-f0-9]{64}$/.test(request.sha256), "FORBIDDEN", "资源摘要无效。", 403);
      const resource = Object.values(saved.resourceMap || {}).find((file) => file.sha256 === request.sha256);
      check(resource, "NOT_FOUND", "没有找到此版本的文档资源。", 404);
      await verifyAuthoringFile(resource, this.resources);
      return { ...this.resources.descriptor(resource), mediaType: "application/vnd.continuous-reader.source" };
    }
    if (request.kind === "pdf" || request.kind === "page") {
      const source = document.source && saved.resourceMap[document.source.path]; check(source && (source.mediaType === "application/pdf" || document.source.path.toLowerCase().endsWith(".pdf")), "PDF_UNAVAILABLE", "这份资料没有 PDF 原文件。", 404);
      if (request.kind === "page") {
        const page = await this.resources.page(source, request.page, request.width || 1200);
        return { ...(typeof page === "string" ? { path: page } : page), mediaType: "image/png", sha256: `${source.sha256}-${request.page}-${request.width || 1200}` };
      }
      const manifest = await this.resources.manifest(source), regions = documentSourceRegions(document);
      return { sourceHash: source.sha256, sourceUrl: `${base}/assets/${document.source.path.split("/").map(encodeURIComponent).join("/")}${query}`, regions, pages: manifest.pages.map((page) => ({ ...page, imageUrl: `${base}/pages/${page.page}.png${query}` })) };
    }
    check(typeof request.path === "string" && !request.path.startsWith("/") && !/[\\%:?#]/.test(request.path) && request.path.split("/").every((part) => part && part !== "." && part !== ".."), "FORBIDDEN", "资源路径无效。", 403);
    const resource = saved.resourceMap[request.path]; check(resource, "NOT_FOUND", "没有找到文档资源。", 404);
    return this.resources.descriptor(resource);
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => { this.db?.close(); })();
    return this.closing;
  }
}
