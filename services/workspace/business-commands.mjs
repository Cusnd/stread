import { randomUUID } from 'node:crypto';
import { canonical, check, clone, fail, hash, identifier, json, normalized, object, text, version } from './errors.mjs';
import { applyOperations, resolveSource, validateAnswer } from './documents.mjs';
import { cloudSyncSchema } from './sync-table-definitions.mjs';
import { prepareDocumentCommand } from './document-commands.mjs';
import { prepareRelationChanges } from './relations.mjs';

const now = () => new Date().toISOString();
const parsed = row => row ? JSON.parse(row.payload) : undefined;
const referencePattern = /^#([QN])([0-9]{5,})$/;
const extraKeys = { counters: ['series'], sync_reference_ranges: ['series'], migrations: ['key'], preview_metadata: ['preview_id'], relation_match_state: ['key'] };
const transient = new Set(['top', 'left', 'width', 'height', 'position', 'screenX', 'screenY', 'pending', 'editing', 'composerPosition', 'review', 'documentTitle']);

// This is a list of final rows, not an executable database or a repository.
// Each operation below reads its actual dependencies and computes its result.
export function operationRows() {
  const rows = new Map(), statements = [];
  const identity = (entity, key) => entity + '\n' + canonical(key);
  return {
    statements,
    put(entity, value, key) {
      const keys = cloudSyncSchema.get(entity)?.keys || extraKeys[entity];
      key ||= keys.map(column => value[column]);
      rows.set(identity(entity, key), { entity, key: canonical(key), value });
      return value;
    },
    pending(entity, key) { return rows.get(identity(entity, key)); },
    get changes() { return [...rows.values()]; },
    finish(result, extra = {}) { return { changes: [...rows.values()], statements, result, ...extra }; },
  };
}

export async function prepareBusinessCommand(workspace, actor, command, reads) {
  if (command.kind.startsWith('reading.session.') || command.kind.startsWith('insight.review.')) return workspace.flow.prepareCommand(actor, command, reads);
  const rows = operationRows(), kind = command.kind;
  const getDocument = async id => {
    identifier(id, '文档 ID'); const row = rows.pending('documents', [id])?.value || await reads.get('SELECT * FROM documents WHERE id=?', id);
    check(row, 'NOT_FOUND', '没有找到这份文档。', 404); return row;
  };
  const getMeta = async key => JSON.parse((rows.pending('metadata', [key])?.value || await reads.get('SELECT * FROM metadata WHERE key=?', key)).value);
  const setMeta = (key, value) => rows.put('metadata', { key, value: json(value) });
  const expected = (row, value) => workspace.expected(row, value);
  const revision = async (id, number) => {
    const document = await getDocument(id), row = await reads.get('SELECT * FROM revisions WHERE document_id=? AND revision=?', id, number ?? document.current_revision);
    check(row, 'NOT_FOUND', '没有找到这个正文版本。', 404);
    return workspace.storage.load(row);
  };
  const material = async row => {
    const summary = await reads.get(`SELECT COUNT(*) AS insight_count,
      (SELECT json_extract(payload,'$.body') FROM insights WHERE document_id=? AND archived_at IS NULL AND json_extract(payload,'$.type')='question'
       AND (json_extract(payload,'$.answer') IS NULL OR json_extract(payload,'$.answer') IN (0,'')) ORDER BY rowid LIMIT 1) AS question
      FROM insights WHERE document_id=? AND archived_at IS NULL`, row.id, row.id);
    const reading = rows.pending('reading', [row.id]);
    const savedReading = reading ? reading.value : await reads.get('SELECT payload FROM reading WHERE document_id=?', row.id);
    return workspace.material({ ...row, ...summary, reading_payload: savedReading?.payload || null });
  };
  const metadataRow = (row, metadata, archived = row.archived_at) => rows.put('documents', { ...row, version: row.version + 1, metadata: json(metadata), archived_at: archived, updated_at: now() });
  const reconcile = async () => {
    const current = await getMeta('currentId');
    const row = current && (rows.pending('documents', [current])?.value || await reads.get('SELECT * FROM documents WHERE id=?', current));
    if (row && !row.archived_at && JSON.parse(row.metadata).status === 'reading') return;
    const original = await reads.all('SELECT * FROM documents WHERE archived_at IS NULL ORDER BY updated_at DESC');
    const candidates = new Map(original.map(value => [value.id, value]));
    for (const change of rows.changes) if (change.entity === 'documents') candidates.set(change.value.id, change.value);
    const next = [...candidates.values()].filter(value => !value.archived_at && JSON.parse(value.metadata).status === 'reading').sort((a,b) => b.updated_at.localeCompare(a.updated_at))[0];
    setMeta('currentId', next?.id || null);
  };
  const allocate = async (series, preferred) => {
    const match = preferred && referencePattern.exec(preferred);
    const counter = rows.pending('counters', [series])?.value || await reads.get('SELECT * FROM counters WHERE series=?', series);
    if (match?.[1] === series && Number.isSafeInteger(Number(match[2])) && !rows.pending('references_map', [preferred]) && !await reads.get('SELECT reference FROM references_map WHERE reference=?', preferred)) {
      rows.put('counters', { ...counter, value: Math.max(counter.value, Number(match[2])) }); return preferred;
    }
    if (workspace.localOnly) {
      // A retired replica may have issued references from a reserved range
      // without advancing its ordinary counter. Keep every existing identity
      // and continue locally even after that historical range was exhausted.
      const saved = await reads.get(series === 'R'
        ? "SELECT MAX(CAST(SUBSTR(reference,3) AS INTEGER)) AS value FROM change_requests WHERE reference LIKE ?"
        : "SELECT MAX(CAST(SUBSTR(reference,3) AS INTEGER)) AS value FROM references_map WHERE reference LIKE ?", '#' + series + '%');
      const hasRanges = await reads.get("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_reference_ranges'");
      const oldRange = hasRanges && await reads.get('SELECT next FROM sync_reference_ranges WHERE series=?', series);
      const count = Math.max(counter.value, saved?.value || 0, (oldRange?.next || 1) - 1) + 1;
      check(Number.isSafeInteger(count), 'REFERENCE_LIMIT', '编号超出支持范围。', 409);
      rows.put('counters', { ...counter, value: count }); return '#' + series + String(count).padStart(5, '0');
    }
    const range = workspace.sync && (rows.pending('sync_reference_ranges', [series])?.value || await reads.get('SELECT * FROM sync_reference_ranges WHERE series=?', series));
    if (range) {
      check(range.next <= range.end, 'REFERENCE_LIMIT', '离线编号范围已用完，请连接工作台重新分配。', 409);
      rows.put('sync_reference_ranges', { ...range, next: range.next + 1 }); return '#' + series + String(range.next).padStart(5, '0');
    }
    const count = counter.value + 1; check(Number.isSafeInteger(count), 'REFERENCE_LIMIT', '编号超出支持范围。', 409);
    rows.put('counters', { ...counter, value: count }); return '#' + series + String(count).padStart(5, '0');
  };
  const storeInsight = insight => rows.put('insights', { id: insight.id, document_id: insight.documentId, version: insight.version, payload: json(insight), archived_at: insight.archivedAt || null });
  const storeRequest = request => rows.put('change_requests', { id: request.id, document_id: request.documentId, version: request.version, reference: request.reference, payload: json(request) });
  const insightRow = async (id, documentId) => {
    const row = rows.pending('insights', [id])?.value || await reads.get('SELECT * FROM insights WHERE id=? AND document_id=?', identifier(id, '洞见 ID'), identifier(documentId));
    check(row, 'NOT_FOUND', '洞见不存在。', 404); return row;
  };
  const saveInsight = async (operation, { legacy = false, forcedId } = {}) => {
    const doc = await getDocument(operation.documentId);
    const incoming = Object.fromEntries(Object.entries(clone(object(operation.insight, '洞见'))).filter(([key]) => !transient.has(key)));
    if (incoming.title !== undefined) {
      check(typeof incoming.title === 'string', 'VALIDATION_FAILED', '洞见标题必须是文本。'); incoming.title = text(incoming.title.trim(), '洞见标题', 200);
      check(!/[\r\n\u0085\u2028\u2029]/u.test(incoming.title), 'VALIDATION_FAILED', '洞见标题必须是单行文本，不能包含换行。');
    } else delete incoming.title;
    for (const key of legacy ? ['answerAuthorization'] : ['archivedAt','createdAt','updatedAt','resolvedAt','answerAuthorization']) delete incoming[key];
    const supplied = forcedId || incoming.id, row = supplied ? rows.pending('insights', [supplied])?.value || await reads.get('SELECT * FROM insights WHERE id=?', identifier(supplied)) : null;
    if (row) { check(row.document_id === operation.documentId, 'VALIDATION_FAILED', '洞见属于其他文章。'); check(!row.archived_at, 'NOT_FOUND', '洞见已移除。', 404); expected(row, operation.expectedVersion); }
    const previous = parsed(row), insight = { ...previous, ...incoming, id: row?.id || supplied || 'insight-' + randomUUID(), documentId: operation.documentId, version: (row?.version || 0) + 1 };
    delete insight.review; delete insight.documentTitle;
    check(['annotation','question','note'].includes(insight.type), 'VALIDATION_FAILED', '洞见类型无效。');
    text(insight.body, '洞见内容', 200000, insight.type !== 'annotation');
    check(typeof insight.color === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(insight.color), 'VALIDATION_FAILED', '高亮颜色标识无效。');
    const number = insight.revision || doc.current_revision; version(number, '来源正文版本'); insight.revision = number;
    const saved = await revision(doc.id, number);
    if (insight.blockId) Object.assign(insight, resolveSource(saved.index, insight, { allowUnresolved: legacy }));
    if (insight.sources) {
      check(Array.isArray(insight.sources) && insight.sources.length <= 100, 'VALIDATION_FAILED', '洞见来源列表无效。');
      insight.sources = await Promise.all(insight.sources.map(async source => {
        object(source, '洞见来源'); identifier(source.blockId, '来源内容块'); check(!source.documentId || source.documentId === doc.id, 'VALIDATION_FAILED', '洞见来源属于其他文章。');
        return resolveSource((await revision(doc.id, source.revision || number)).index, source, { allowUnresolved: legacy });
      }));
    }
    check(insight.type !== 'annotation' || insight.blockId || insight.sources?.length, 'VALIDATION_FAILED', '批注和高亮需要原文位置。');
    if (!legacy && incoming.answer !== undefined) check(previous && canonical(incoming.answer) === canonical(previous.answer), 'APPROVAL_REQUIRED', '请通过授权回答操作保存新回答。', 403);
    if (legacy && insight.answer) insight.answer.sourceLabel ||= '导入的旧回答';
    insight.references = { ...(previous?.references || {}) };
    const series = insight.type === 'question' ? 'Q' : 'N';
    insight.references[series] ||= await allocate(series, legacy ? incoming.references?.[series] || incoming.reference : undefined);
    insight.reference = insight.references[series]; insight.createdAt ||= now(); insight.updatedAt = now(); storeInsight(insight);
    for (const reference of Object.values(insight.references)) {
      const existing = rows.pending('references_map', [reference])?.value || await reads.get('SELECT * FROM references_map WHERE reference=?', reference);
      if (!existing) rows.put('references_map', { reference, insight_id: insight.id });
    }
    return insight;
  };

  if (kind === 'insight.save') return rows.finish({ insight: await saveInsight(command) });
  if (['insight.archive','insight.restore','insight.answer'].includes(kind)) {
    const row = await insightRow(command.insightId, command.documentId); expected(row, command.expectedVersion); const insight = parsed(row);
    if (kind === 'insight.answer') {
      check(!row.archived_at && insight.type === 'question', 'VALIDATION_FAILED', '只有有效问题可以保存回答。');
      check(command.authorized === true, 'APPROVAL_REQUIRED', '回答须在用户明确授权后保存。', 403);
      insight.answer = validateAnswer(command.answer); insight.answer.sourceLabel ||= '已保存回答'; insight.resolvedAt = now();
      insight.answerAuthorization = { subjectId: actor.subjectId, requestId: command.requestId, savedAt: now() };
    } else if (kind === 'insight.archive') insight.archivedAt = now(); else delete insight.archivedAt;
    insight.version++; insight.updatedAt = now(); storeInsight(insight); return rows.finish({ insight });
  }
  if (kind === 'change_request.save') {
    const doc = await getDocument(command.documentId); let input = object(command.changeRequest, '更改请求');
    const row = input.id ? await reads.get('SELECT * FROM change_requests WHERE id=? AND document_id=?', identifier(input.id), doc.id) : null;
    if (input.id) { check(row, 'NOT_FOUND', '更改请求不存在。', 404); expected(row, command.expectedVersion); }
    const previous = parsed(row); if (command.partial && previous) input = { ...previous, ...input };
    check(!previous || previous.status === 'pending', 'REVISION_CONFLICT', '请先恢复已撤回的请求。', 409);
    check(['correction','translation','instruction'].includes(input.category), 'VALIDATION_FAILED', '更改类型无效。');
    const body = text(input.body, '修改要求', 20000, true).trim(); version(input.revision, '来源正文版本');
    const saved = await revision(doc.id, input.revision); check(!saved.readOnly && !(await revision(doc.id)).readOnly, 'READ_ONLY', '此文档仅支持只读查看。', 409);
    let source;
    if (input.source) {
      object(input.source, '更改位置'); identifier(input.source.blockId, '内容块 ID');
      const keys = ['blockId','variant','field','nodeId','itemId','row','column','start','end','quote','prefix','suffix','sourceType','equationNumber'];
      source = resolveSource(saved.index, Object.fromEntries(keys.filter(key => input.source[key] !== undefined).map(key => [key,input.source[key]])));
    }
    const request = { id: row?.id || 'change-' + randomUUID(), documentId: doc.id, revision: input.revision, reference: previous?.reference || await allocate('R'),
      version: (row?.version || 0) + 1, category: input.category, body, ...(source ? { source } : {}), status: 'pending', createdAt: previous?.createdAt || now(), updatedAt: now() };
    storeRequest(request); return rows.finish({ changeRequest: request });
  }
  if (['change_request.cancel','change_request.reopen'].includes(kind)) {
    const row = await reads.get('SELECT * FROM change_requests WHERE id=? AND document_id=?', identifier(command.changeRequestId), identifier(command.documentId));
    check(row, 'NOT_FOUND', '更改请求不存在。', 404); expected(row, command.expectedVersion);
    check(parsed(row).status !== 'completed', 'REVISION_CONFLICT', '此请求已有对应的正文修订。', 409);
    const request = { ...parsed(row), status: kind.endsWith('cancel') ? 'cancelled' : 'pending', version: row.version + 1, updatedAt: now() };
    storeRequest(request); return rows.finish({ changeRequest: request });
  }
  if (kind.startsWith('collection.')) {
    if (kind === 'collection.create') {
      const label = text(command.label, '分类名称', 200, true).trim(), parentId = command.parentId || null;
      if (parentId) check(await reads.get('SELECT id FROM collections WHERE id=?', identifier(parentId)), 'NOT_FOUND', '父分类不存在。', 404);
      const collection = { id: 'collection-' + randomUUID(), label, parentId, version: 1 };
      rows.put('collections', { id: collection.id, label, parent_id: parentId, version: 1 }); return rows.finish({ collection });
    }
    const row = await reads.get('SELECT id,label,parent_id AS parentId,version FROM collections WHERE id=?', identifier(command.collectionId));
    check(row, 'NOT_FOUND', '分类不存在。', 404); expected(row, command.expectedVersion);
    if (kind === 'collection.remove') {
      const children = await reads.all('SELECT id FROM collections WHERE parent_id=?', row.id);
      const documents = await reads.all("SELECT id FROM documents WHERE EXISTS(SELECT 1 FROM json_each(metadata,'$.collectionIds') WHERE value=?)", row.id);
      check(!children.length && !documents.length, 'COLLECTION_NOT_EMPTY', '先移动子分类及资料，再移除此分类。', 409);
      rows.put('collections', null, [row.id]); return rows.finish({ collection: row });
    }
    check(kind === 'collection.update', 'VALIDATION_FAILED', '不支持的分类操作。'); object(command.patch);
    const label = command.patch.label === undefined ? row.label : text(command.patch.label, '分类名称', 200, true).trim();
    const parentId = command.patch.parentId === undefined ? row.parentId : command.patch.parentId || null;
    let at = parentId; const seen = new Set([row.id]);
    while (at) { check(!seen.has(at), 'COLLECTION_CYCLE', '分类不能成为自己的上级。', 409); seen.add(at); const parent = await reads.get('SELECT parent_id FROM collections WHERE id=?', identifier(at)); check(parent, 'NOT_FOUND', '父分类不存在。', 404); at = parent.parent_id; }
    const collection = { id: row.id, label, parentId, version: row.version + 1 };
    rows.put('collections', { id: row.id, label, parent_id: parentId, version: collection.version }); return rows.finish({ collection });
  }
  if (kind.startsWith('plan.')) {
    const row = await getDocument(command.documentId); check(!row.archived_at || kind === 'plan.remove', 'NOT_FOUND', '资料已归档。', 404);
    const planVersion = await getMeta('planVersion');
    if (command.expectedPlanVersion !== undefined) check(command.expectedPlanVersion === planVersion, 'REVISION_CONFLICT', '阅读计划已改变，请重新读取。', 409, { currentVersion: planVersion });
    const plan = await getMeta('plan'), previous = json(plan), index = plan.indexOf(row.id);
    if (kind === 'plan.add' && index < 0) plan.push(row.id);
    else if (kind === 'plan.remove' && index >= 0) plan.splice(index, 1);
    else if (kind === 'plan.move') {
      check(command.expectedPlanVersion === planVersion, 'REVISION_CONFLICT', '阅读计划已改变，请重新读取。', 409);
      check([-1,1].includes(command.direction) && index >= 0, 'VALIDATION_FAILED', '计划移动参数无效。'); const next = index + command.direction;
      if (next >= 0 && next < plan.length) [plan[index],plan[next]] = [plan[next],plan[index]];
    } else check(['plan.add','plan.remove'].includes(kind), 'VALIDATION_FAILED', '不支持的计划操作。');
    const nextVersion = planVersion + (json(plan) !== previous ? 1 : 0);
    if (nextVersion !== planVersion) { setMeta('plan', plan); setMeta('planVersion', nextVersion); }
    return rows.finish({ planIds: plan, planVersion: nextVersion });
  }
  if (kind.startsWith('glossary.')) {
    const action = kind.split('.')[1], input = command.input || {}; let entry;
    if (action === 'create') entry = { id: randomUUID(), ...workspace.glossaryFields(input), revision: 1, createdAt: now(), updatedAt: now(), origin: 'user' };
    else {
      const row = await reads.get('SELECT payload,deleted_at FROM glossary WHERE id=?', identifier(command.id));
      check(row && Boolean(row.deleted_at) === (action === 'restore'), 'NOT_FOUND', '没有找到这条术语。', 404); entry = parsed(row);
      check(entry.revision === command.expectedRevision, 'REVISION_CONFLICT', '这条术语已在其他窗口更新，请重新打开后编辑。', 409);
      if (action === 'update') Object.assign(entry, workspace.glossaryFields(command.partial ? { ...entry,...input } : input));
      else if (action === 'remove') entry.deletedAt = now(); else if (action === 'restore') delete entry.deletedAt; else fail('VALIDATION_FAILED', '不支持的术语操作。');
      entry.revision++; entry.updatedAt = now();
    }
    if (!entry.deletedAt) check(!await reads.get('SELECT id FROM glossary WHERE normalized_name=? AND deleted_at IS NULL AND id<>?', normalized(entry.term), entry.id), 'DUPLICATE_TERM', '这条术语已存在，可以直接编辑。', 409);
    rows.put('glossary', { id: entry.id, revision: entry.revision, normalized_name: normalized(entry.term), payload: json(entry), deleted_at: entry.deletedAt || null });
    const glossaryRevision = await getMeta('glossaryRevision') + 1; setMeta('glossaryRevision', glossaryRevision); return rows.finish({ entry, glossaryRevision });
  }
  if (kind === 'reading.open' || kind === 'reading.checkpoint') {
    let row = await getDocument(command.documentId); check(!row.archived_at, 'NOT_FOUND', '资料已归档。', 404);
    if (kind === 'reading.open') {
      const metadata = JSON.parse(row.metadata);
      // Revisiting a source or editing an insight does not undo completion.
      // Only the explicit restart action begins another read of a done article.
      const status = metadata.status === 'done' && !command.restart ? 'done' : 'reading';
      row = metadataRow(row, { ...metadata, status });
      if (status === 'reading') setMeta('currentId', row.id);
      else await reconcile();
      if (command.restart) rows.put('reading', null, [row.id]);
    } else {
      const state = clone(object(command.readingState, '阅读位置')); check(state.documentId === undefined || state.documentId === row.id, 'VALIDATION_FAILED', '阅读位置属于其他文章。');
      state.documentId = row.id; version(state.revision, '位置引用版本'); const saved = await revision(row.id, state.revision);
      if (state.blockId) check(saved.document.blocks.some(block => block.id === state.blockId), 'ANCHOR_UNRESOLVED', '阅读位置不存在。', 409);
      if (state.offsetRatio !== undefined) check(Number.isFinite(state.offsetRatio) && state.offsetRatio >= 0 && state.offsetRatio <= 1, 'VALIDATION_FAILED', '阅读偏移无效。');
      if (state.mode) check(['source','translation','bilingual'].includes(state.mode), 'VALIDATION_FAILED', '阅读模式无效。');
      if (state.targetLanguage) text(state.targetLanguage, '目标语言', 64, true);
      rows.put('reading', { document_id: row.id, payload: json(state) });
    }
    return rows.finish({ record: await material(row) });
  }
  if (['document.update','document.archive','document.restore'].includes(kind)) {
    const original = await getDocument(command.documentId); expected(original, command.expectedVersion); const metadata = JSON.parse(original.metadata);
    let preparedTitle, saved;
    if (kind === 'document.update') {
      object(command.patch, '资料修改');
      for (const [key,value] of Object.entries(command.patch)) {
        check(['title','kind','summary','collectionIds','tags','status'].includes(key), 'VALIDATION_FAILED', '不可修改的资料字段。', 400, { key });
        if (['title','kind','summary'].includes(key)) metadata[key] = text(value,key,key === 'summary' ? 10000 : 2000,key === 'title').trim();
        if (key === 'status') { check(['unread','reading','done'].includes(value), 'VALIDATION_FAILED', '阅读状态无效。'); metadata.status = value; }
        if (key === 'collectionIds') { check(Array.isArray(value) && value.length <= 100, 'VALIDATION_FAILED', '分类列表无效。'); for (const id of value) check(await reads.get('SELECT id FROM collections WHERE id=?', identifier(id)), 'NOT_FOUND', '分类不存在。',404); metadata.collectionIds = [...new Set(value)]; }
        if (key === 'tags') { check(Array.isArray(value) && value.length <= 100, 'VALIDATION_FAILED', '标签列表无效。'); metadata.tags = [...new Set(value.map(tag => text(tag,'标签',100,true).trim()))]; }
      }
      if (command.patch.title !== undefined) {
        saved = await revision(original.id); check(!saved.readOnly, 'READ_ONLY', '此文档仅支持只读查看。',409);
        if (metadata.title !== saved.document.meta.title) { const next = clone(saved.document); next.meta.title = metadata.title; next.revision++;
          preparedTitle = await workspace.validateCandidate(next,saved); await workspace.prepareRevision(preparedTitle,saved.resourceMap,saved);
          const revisionChanges = workspace.storage.preparedChanges(preparedTitle,saved.resourceMap,{...saved,actor:actor.subjectId});
          for (const change of revisionChanges.changes) rows.put(change.entity,change.value); rows.statements.push(...revisionChanges.statements);
        }
      }
    }
    let row = metadataRow(original,metadata,kind === 'document.archive' ? now() : kind === 'document.restore' ? null : original.archived_at);
    if (preparedTitle) row = rows.put('documents', {...row,current_revision:preparedTitle.document.revision});
    await reconcile();
    const prepared = rows.finish({record:await material(row),...(preparedTitle ? {document:preparedTitle.document} : {})});
    const relations = await prepareRelationChanges({reads,documents:preparedTitle ? [preparedTitle.document] : [],documentRows:[row]});
    prepared.changes.push(...relations.changes); prepared.statements.push(...relations.statements);
    return prepared;
  }
  // Document revision/publication and legacy import keep their own preparation
  // functions below; they share this same final-row and commit representation.
  return prepareDocumentCommand({ workspace, actor, command, reads, rows, getDocument, getMeta, setMeta, revision, material, allocate, saveInsight, storeInsight, storeRequest });
}
