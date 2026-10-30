import { randomUUID } from 'node:crypto';
import { check, identifier, json, normalized, text } from './errors.mjs';
import { translationCoverage } from './authoring-quality.mjs';

export const QUEUE_TYPES = ['conversion', 'correction', 'translation', 'question', 'instruction'];
export const QUEUE_STATUSES = ['pending', 'processing', 'needs_attention', 'completed', 'cancelled'];
export const QUEUE_BINDING = 'stread.queue';
const parsed = row => row ? JSON.parse(row.payload) : undefined;
const now = () => new Date().toISOString();
const resultUrl = (documentId, hash = '') => `/?document=${encodeURIComponent(documentId)}${hash}`;

export function queueRow(task) {
  return { id: task.id, reference: task.reference, version: task.version, type: task.type,
    document_id: task.documentId || null, source_id: task.sourceId || null, insight_id: task.insightId || null,
    change_request_id: task.changeRequestId || null, payload: json(task) };
}

function putChange(changes, entity, value, key = 'id') {
  const index = changes.findIndex(change => change.entity === entity && change.value?.[key] === value[key]);
  const change = { entity, value };
  if (index < 0) changes.push(change); else changes[index] = change;
}

export async function allocateTask(reads, changes, fields) {
  const current = changes.find(change => change.entity === 'counters' && change.value?.series === 'T')?.value
    || await reads.get("SELECT * FROM counters WHERE series='T'");
  const maximum = await reads.get("SELECT MAX(CAST(SUBSTR(reference,3) AS INTEGER)) AS value FROM queue_tasks WHERE reference LIKE '#T%'");
  const number = Math.max(current?.value || 0, maximum?.value || 0) + 1;
  check(Number.isSafeInteger(number), 'REFERENCE_LIMIT', '任务编号超出支持范围。', 409);
  putChange(changes, 'counters', { series: 'T', value: number }, 'series');
  const task = { ...fields, id: randomUUID(), reference: '#T' + String(number).padStart(5, '0'), version: 1,
    status: fields.status || 'pending', createdAt: fields.createdAt || now(), updatedAt: fields.updatedAt || now() };
  putChange(changes, 'queue_tasks', queueRow(task));
  return task;
}

export function initializeQueue(workspace) {
  workspace.db.transaction(() => {
    const maximum = workspace.db.prepare("SELECT MAX(CAST(SUBSTR(reference,3) AS INTEGER)) AS value FROM queue_tasks WHERE reference LIKE '#T%'").get().value || 0;
    let counter = Math.max(maximum, workspace.db.prepare("SELECT value FROM counters WHERE series='T'").get()?.value || 0);
    const requests = workspace.db.prepare('SELECT r.payload FROM change_requests r LEFT JOIN queue_tasks q ON q.change_request_id=r.id WHERE q.id IS NULL ORDER BY r.rowid').all();
    for (const row of requests) {
      const request = parsed(row), timestamp = now();
      const task = { id: randomUUID(), reference: '#T' + String(++counter).padStart(5, '0'), version: 1,
        type: request.category || 'instruction', title: '', body: request.body || '', status: request.status || 'pending',
        documentId: request.documentId, changeRequestId: request.id, relatedReference: request.reference,
        revision: request.revision, ...(request.source ? { source: request.source } : {}),
        createdAt: request.createdAt || timestamp, updatedAt: request.updatedAt || timestamp };
      const value = queueRow(task);
      workspace.db.prepare('INSERT INTO queue_tasks(id,reference,version,type,document_id,source_id,insight_id,change_request_id,payload) VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(value));
    }
    workspace.db.prepare("INSERT INTO counters(series,value) VALUES('T',?) ON CONFLICT(series) DO UPDATE SET value=excluded.value").run(counter);
    if (requests.length) workspace.db.prepare("UPDATE metadata SET value=json(CAST(value AS INTEGER)+1) WHERE key='revision'").run();
  });
}

export async function taskRecord(reads, taskId) {
  text(taskId, '任务编号', 160, true);
  const reference = /^#?T\d{5,}$/.test(taskId) ? (taskId.startsWith('#') ? taskId : '#' + taskId) : null;
  if (!reference) identifier(taskId, '任务编号');
  const row = await reads.get(reference ? 'SELECT * FROM queue_tasks WHERE reference=?' : 'SELECT * FROM queue_tasks WHERE id=?', reference || taskId);
  check(row, 'NOT_FOUND', '没有找到这项任务。', 404);
  return parsed(row);
}

export async function taskView(workspace, reads, task) {
  const value = { ...task };
  const document = task.documentId ? await reads.get('SELECT metadata,current_revision,archived_at FROM documents WHERE id=?', task.documentId) : null;
  if (document) { value.documentTitle = JSON.parse(document.metadata).title || ''; value.documentRevision = document.current_revision; }
  if (task.sourceId) {
    const file = await reads.get('SELECT * FROM files WHERE id=?', task.sourceId);
    if (file) {
      value.sourceFilename = file.filename;
      value.uploadedSource = { sourceId: file.id, filename: file.filename, mediaType: file.media_type, size: file.size, sha256: file.sha256,
        url: `/api/sources/${encodeURIComponent(file.id)}/original` };
      value.sourceUrl = value.uploadedSource.url;
    }
  }
  if (task.changeRequestId) {
    const request = parsed(await reads.get('SELECT payload FROM change_requests WHERE id=?', task.changeRequestId));
    if (request) {
      value.body = request.body; value.type = request.category; value.revision = request.revision; value.source = request.source;
      value.relatedReference = request.reference; value.changeRequestVersion = request.version;
      value.status = request.status;
      if (request.status === 'completed') value.result = request.appliedRelationId
        ? { kind: 'relation', documentId: task.documentId, relationId: request.appliedRelationId, url: resultUrl(task.documentId) }
        : { kind: 'revision', documentId: task.documentId, revision: request.appliedRevision, url: resultUrl(task.documentId) };
      if (request.status === 'pending') {
        const proposals = await reads.all('SELECT payload FROM proposals WHERE document_id=? ORDER BY rowid DESC', task.documentId);
        for (const row of proposals) {
          const proposal = await workspace.storage.unpack(parsed(row));
          if (proposal.changeRequestId !== request.id || proposal.expectedChangeRequestVersion !== request.version) continue;
          if (proposal.status === 'pending') {
            value.status = 'needs_attention'; value.statusReason = '等待确认修改';
            value.proposal = { id: proposal.id, status: proposal.status, url: resultUrl(task.documentId) };
          }
          break;
        }
      }
    }
  }
  if (task.type === 'question' && task.insightId) {
    const row = await reads.get('SELECT payload,archived_at FROM insights WHERE id=?', task.insightId), insight = parsed(row);
    if (insight) {
      value.relatedReference = insight.reference; value.insightVersion = insight.version; value.questionBody = insight.body;
      value.source = task.source || insight.sources?.[0] || Object.fromEntries(['blockId','variant','field','itemId','nodeId','row','column','start','end','quote'].filter(key => insight[key] !== undefined).map(key => [key, insight[key]]));
      if (task.status !== 'cancelled' && insight.answer) {
        value.status = 'completed'; value.result = { kind: 'answer', documentId: task.documentId, insightId: task.insightId,
          url: `/?document=${encodeURIComponent(task.documentId)}&insight=${encodeURIComponent(task.insightId)}` };
      } else if (task.status !== 'cancelled' && (row.archived_at || insight.type !== 'question')) { value.status = 'needs_attention'; value.statusReason = '关联问题已移除'; }
    }
  }
  if (task.type === 'conversion') {
    const previews = await reads.all('SELECT p.payload,d.payload AS draft_payload FROM queue_task_previews p LEFT JOIN authoring_drafts d ON d.id=p.draft_id WHERE p.task_id=? AND p.task_version=? ORDER BY p.rowid DESC', task.id, task.version);
    const match = previews.find(row => JSON.parse(row.draft_payload || '{}').currentPreviewId === parsed(row).id);
    if (match && task.status === 'pending') {
      const preview = parsed(match), draft = JSON.parse(match.draft_payload || '{}');
      value.preview = preview;
      value.status = 'needs_attention'; value.statusReason = draft.lastError ? '最新候选需要修复' : '等待复审与发布';
      if (draft.lastError) value.error = { code: draft.lastError.code, message: draft.lastError.error || draft.lastError.message };
    }
  }
  return value;
}

export async function queryQueue(workspace, query = {}) {
  const type = query.type || 'all', status = query.status || 'all';
  check(type === 'all' || QUEUE_TYPES.includes(type), 'VALIDATION_FAILED', '任务类型无效。');
  check(status === 'all' || QUEUE_STATUSES.includes(status), 'VALIDATION_FAILED', '任务状态无效。');
  const offset = query.offset ?? 0, limit = query.limit ?? 100;
  check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, 'VALIDATION_FAILED', '任务分页范围无效。');
  const needle = normalized(text(query.query || '', '检索词', 500));
  const reads = { all: (sql, ...values) => workspace.sql.query(sql, values), get: async (sql, ...values) => (await workspace.sql.query(sql, values))[0] };
  const before = await workspace.meta('revision');
  const records = query.taskId ? [await taskRecord(reads, query.taskId)] : (await reads.all('SELECT payload FROM queue_tasks ORDER BY rowid DESC')).map(parsed);
  const tasks = await Promise.all(records.map(task => taskView(workspace, reads, task)));
  const after = await workspace.meta('revision');
  check(before === after, 'LIST_CHANGED', '任务列表已改变，请重新读取。', 409);
  const countStates = values => Object.fromEntries(['all', ...QUEUE_STATUSES].map(key => [key, key === 'all' ? values.length : values.filter(task => task.status === key).length]));
  const allCounts = countStates(tasks);
  const typeCounts = Object.fromEntries(['all', ...QUEUE_TYPES].map(key => [key, key === 'all' ? tasks.length : tasks.filter(task => task.type === key).length]));
  const matching = tasks.filter(task => (type === 'all' || task.type === type)
    && (!needle || normalized([task.reference, task.title, task.body, task.documentTitle, task.sourceFilename, task.relatedReference].filter(Boolean).join('\n')).includes(needle)));
  const counts = countStates(matching), selected = matching.filter(task => status === 'all' || task.status === status);
  return { tasks: selected.slice(offset, offset + limit), total: selected.length, counts, allCounts, typeCounts, revision: after,
    page: { offset, count: selected.slice(offset, offset + limit).length, total: selected.length, nextOffset: offset + limit < selected.length ? offset + limit : null } };
}

export async function augmentQueueCommit(workspace, reads, prepared) {
  const changes = prepared.changes ||= [];
  const original = [...changes];
  for (const change of original) {
    if (change.entity === 'change_requests' && change.value) {
      const request = parsed(change.value);
      const pending = changes.find(item => item.entity === 'queue_tasks' && item.value?.change_request_id === request.id)?.value;
      const stored = pending || await reads.get('SELECT * FROM queue_tasks WHERE change_request_id=?', request.id);
      const fields = { type: request.category, body: request.body, status: request.status, documentId: request.documentId,
        changeRequestId: request.id, relatedReference: request.reference, revision: request.revision, source: request.source };
      let task;
      if (!stored) task = await allocateTask(reads, changes, { title: '', createdAt: request.createdAt, updatedAt: request.updatedAt, ...fields });
      else {
        task = { ...parsed(stored), ...fields, version: stored.version + (pending ? 0 : 1), updatedAt: request.updatedAt || now() };
        putChange(changes, 'queue_tasks', queueRow(task));
      }
      if (prepared.queueTaskId === task.id) prepared.result.task = task;
    }
    if (change.entity === 'insights' && change.value) {
      const insight = parsed(change.value);
      const stored = await reads.all('SELECT * FROM queue_tasks WHERE insight_id=?', insight.id);
      const pending = changes.filter(item => item.entity === 'queue_tasks' && item.value?.insight_id === insight.id).map(item => item.value);
      const tasks = new Map([...stored, ...pending].map(row => [row.id, row]));
      for (const row of tasks.values()) {
        const task = parsed(row), isPending = pending.some(value => value.id === row.id);
        if (task.status === 'completed') continue;
        const next = { ...task, version: task.version + (isPending ? 0 : 1), updatedAt: insight.updatedAt || now(),
          insightVersion: insight.version, questionBody: insight.body, ...(task.bodyFromQuestion ? { body: insight.body } : {}) };
        if (task.status === 'pending' && insight.answer) {
          next.status = 'completed';
          next.result = { kind: 'answer', documentId: task.documentId, insightId: task.insightId, url: `/?document=${encodeURIComponent(task.documentId)}&insight=${encodeURIComponent(task.insightId)}` };
        }
        putChange(changes, 'queue_tasks', queueRow(next));
        if (prepared.queueTaskId === next.id) prepared.result.task = next;
      }
    }
  }
  if (changes.some(change => change.entity === 'queue_tasks' || change.entity === 'queue_task_previews')) prepared.workspaceChange = true;
}

export async function queuePreviewBinding(workspace, reads, snapshot) {
  // Published authoring keeps the original task binding as provenance. A later
  // document revision must not reopen or complete that historical conversion.
  if (snapshot.revisionTarget) return null;
  const binding = snapshot.compiled.authoring.extensions?.[QUEUE_BINDING];
  if (binding === undefined) return null;
  check(binding && typeof binding === 'object' && !Array.isArray(binding) && Object.keys(binding).every(key => ['taskId', 'taskVersion'].includes(key)), 'VALIDATION_FAILED', '队列转换绑定无效。');
  const task = await taskRecord(reads, binding.taskId);
  check(task.type === 'conversion', 'QUEUE_BINDING_MISMATCH', '此任务不是原文件转换。', 409);
  check(task.version === binding.taskVersion && task.status === 'pending', 'REVISION_CONFLICT', '转换要求已改变、撤回或完成，请重新读取任务。', 409);
  const original = snapshot.resourceMap[snapshot.compiled.authoring.source?.path];
  check(original?.id === task.sourceId, 'QUEUE_BINDING_MISMATCH', '候选原文件与转换任务不一致。', 409);
  return task;
}

export function queuePreviewChange(task, snapshot) {
  const preview = { id: snapshot.id, draftId: snapshot.draftId, hash: snapshot.hash, url: `/?draft=${encodeURIComponent(snapshot.draftId)}`,
    createdAt: snapshot.createdAt };
  return { entity: 'queue_task_previews', value: { preview_id: snapshot.id, task_id: task.id, task_version: task.version,
    source_id: task.sourceId, draft_id: snapshot.draftId, payload: json(preview) } };
}

export function completeConversion(task, document) {
  return { entity: 'queue_tasks', value: queueRow({ ...task, status: 'completed', version: task.version + 1, updatedAt: now(),
    result: { kind: 'document', documentId: document.id, revision: document.revision, url: resultUrl(document.id) } }) };
}

export function checkQueueDelivery(task, prepared) {
  if (!task) return;
  const target = task.outputLanguages?.find(value => value !== 'source') || 'source';
  const completion = prepared.validated.report.previewSubmission?.quality?.workflow?.completion;
  check(completion?.targetLanguage === target, 'QUEUE_DELIVERY_MISMATCH', '复审的交付语言与当前任务要求不一致。', 409, { targetLanguage: target });
  if (target !== 'source') check(translationCoverage(prepared.validated.document, target).missingFieldCount === 0,
    'QUEUE_DELIVERY_MISMATCH', '当前任务要求的译文尚未完整保存。', 409, { targetLanguage: target });
}
