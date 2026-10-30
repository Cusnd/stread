import { check, identifier, json, object, text, version } from './errors.mjs';
import { allocateTask, QUEUE_TYPES, queueRow, taskRecord, taskView } from './queue-data.mjs';

const now = () => new Date().toISOString();
const parsed = row => row ? JSON.parse(row.payload) : undefined;
const strict = (value, keys, label) => {
  object(value, label);
  for (const key of Object.keys(value)) check(keys.includes(key), 'VALIDATION_FAILED', label + '含未知字段。', 400, { field: key });
  return value;
};
const titleValue = value => {
  const title = text(value ?? '', '任务标题', 500).trim();
  check(!/[\r\n\u0085\u2028\u2029]/u.test(title), 'VALIDATION_FAILED', '任务标题必须是单行文本。');
  return title;
};
const language = value => {
  check(typeof value === 'string' && (!value || /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)), 'VALIDATION_FAILED', '原文语言无效。');
  return value;
};
const languages = (value, sourceLanguage) => {
  if (value === undefined) return /^zh(?:-|$)/i.test(sourceLanguage) ? ['source'] : ['source', 'zh-CN'];
  check(Array.isArray(value) && value.length >= 1 && value.length <= 2 && value[0] === 'source' && new Set(value).size === value.length,
    'VALIDATION_FAILED', '输出语言必须保留完整原文。');
  for (const item of value.slice(1)) { check(Boolean(item), 'VALIDATION_FAILED', '输出语言无效。'); language(item); }
  return [...value];
};

export async function prepareQueueCommand(workspace, actor, command, reads, prepareBusiness) {
  const action = command.kind.slice('queue.'.length);
  check(['create', 'update', 'cancel', 'reopen'].includes(action), 'VALIDATION_FAILED', '队列操作无效。');
  strict(command, ['kind', 'requestId', 'authorized', ...(action === 'create' ? ['task'] : ['taskId', 'expectedVersion', ...(action === 'update' ? ['patch'] : [])])], '队列操作');
  if (action === 'create') {
    const input = strict(command.task, ['type', 'title', 'body', 'sourceId', 'documentId', 'insightId', 'expectedInsightVersion', 'source', 'revision', 'sourceLanguage', 'outputLanguages'], '任务');
    check(QUEUE_TYPES.includes(input.type), 'VALIDATION_FAILED', '任务类型无效。');
    const fields = { type: input.type, title: titleValue(input.title), body: '', status: 'pending' };
    let prepared = { changes: [], statements: [], result: {} };
    if (input.type === 'conversion') {
      check(!input.documentId && !input.insightId && input.expectedInsightVersion === undefined && input.source === undefined && input.revision === undefined, 'VALIDATION_FAILED', '原文件转换不接受文章或选区目标。');
      const file = await reads.get('SELECT * FROM files WHERE id=?', identifier(input.sourceId, '原文件 ID'));
      check(file, 'NOT_FOUND', '原文件不存在。', 404);
      check(/\.(?:pdf|html?|md|txt|json)$/i.test(file.filename) || ['application/pdf', 'text/html', 'text/markdown', 'text/plain', 'application/json'].includes(file.media_type),
        'UNSUPPORTED_FORMAT', '请选择 PDF、HTML、Markdown、文本或结构化 JSON 原文件。');
      fields.sourceId = file.id; fields.sourceLanguage = language(input.sourceLanguage ?? '');
      fields.outputLanguages = languages(input.outputLanguages, fields.sourceLanguage);
      const body = input.body === undefined ? '' : text(input.body, '任务内容', 20000).trim();
      fields.body = body || '转换为可阅读文档，保留完整原文，并按输出语言要求提供完整译文。';
    } else {
      check(input.sourceId === undefined && input.sourceLanguage === undefined && input.outputLanguages === undefined, 'VALIDATION_FAILED', '此任务不接受原文件转换参数。');
      const document = await reads.get('SELECT * FROM documents WHERE id=?', identifier(input.documentId, '文章 ID'));
      check(document, 'NOT_FOUND', '没有找到这份文章。', 404);
      fields.documentId = document.id;
      if (input.type === 'question') {
        check(input.source === undefined && input.revision === undefined, 'VALIDATION_FAILED', '问答任务使用已保存问题的范围。');
        const row = await reads.get('SELECT * FROM insights WHERE id=? AND document_id=?', identifier(input.insightId, '问题 ID'), document.id), insight = parsed(row);
        check(insight && insight.type === 'question' && !row.archived_at, 'NOT_FOUND', '没有找到可用的问题。', 404);
        if (input.expectedInsightVersion !== undefined) workspace.expected(row, input.expectedInsightVersion);
        check(!insight.answer, 'REVISION_CONFLICT', '此问题已有回答。', 409);
        const duplicate = await reads.get("SELECT id FROM queue_tasks WHERE insight_id=? AND json_extract(payload,'$.status')='pending'", insight.id);
        check(!duplicate, 'QUEUE_TASK_EXISTS', '此问题已在队列中。', 409, { taskId: duplicate?.id });
        fields.insightId = insight.id; fields.relatedReference = insight.reference; fields.revision = insight.revision;
        const body = input.body === undefined ? '' : text(input.body, '任务内容', 20000).trim();
        fields.body = body || text(insight.body, '任务内容', 20000, true).trim();
        fields.bodyFromQuestion = !body || body === insight.body; fields.questionBody = insight.body;
        fields.insightVersion = insight.version + 1;
        const fenced = { ...insight, version: fields.insightVersion, updatedAt: now() };
        prepared.changes.push({ entity: 'insights', value: { ...row, version: fenced.version, payload: json(fenced) } });
      } else {
        check(input.insightId === undefined && input.expectedInsightVersion === undefined, 'VALIDATION_FAILED', '此任务不接受问题目标。');
        fields.body = text(input.body, '任务内容', 20000, true).trim();
        prepared = await prepareBusiness(workspace, actor, { kind: 'change_request.save', documentId: document.id,
          changeRequest: { category: input.type, body: fields.body, revision: input.revision ?? document.current_revision,
            ...(input.source ? { source: input.source } : {}) } }, reads);
        const request = prepared.result.changeRequest;
        Object.assign(fields, { changeRequestId: request.id, relatedReference: request.reference, revision: request.revision,
          ...(request.source ? { source: request.source } : {}) });
      }
    }
    const task = await allocateTask(reads, prepared.changes, fields);
    prepared.result.task = task; prepared.queueTaskId = task.id;
    return prepared;
  }

  const task = await taskRecord(reads, command.taskId);
  version(command.expectedVersion, '预期任务版本');
  check(task.version === command.expectedVersion, 'REVISION_CONFLICT', '任务已改变，请重新读取。', 409, { currentVersion: task.version });
  const current = await taskView(workspace, reads, task);
  check(current.status !== 'completed', 'REVISION_CONFLICT', '已完成任务不能编辑或恢复。', 409);
  if (action === 'reopen') check(current.status === 'cancelled', 'REVISION_CONFLICT', '只能恢复已撤回的任务。', 409);
  else check(current.status !== 'cancelled', 'REVISION_CONFLICT', '请先恢复已撤回的任务。', 409);
  let prepared = { changes: [], statements: [], result: {} }, next = { ...task, version: task.version + 1, updatedAt: now() };
  if (action === 'update') {
    const patch = strict(command.patch, ['title', 'body', ...(task.type === 'conversion' ? ['sourceLanguage', 'outputLanguages'] : [])], '任务修改');
    check(Object.keys(patch).length > 0, 'VALIDATION_FAILED', '请提供任务修改内容。');
    if (patch.title !== undefined) next.title = titleValue(patch.title);
    if (patch.body !== undefined) next.body = text(patch.body, '任务内容', 20000, true).trim();
    if (patch.sourceLanguage !== undefined) next.sourceLanguage = language(patch.sourceLanguage);
    if (patch.outputLanguages !== undefined) next.outputLanguages = languages(patch.outputLanguages, next.sourceLanguage);
    else if (patch.sourceLanguage !== undefined) next.outputLanguages = languages(undefined, next.sourceLanguage);
  } else next.status = action === 'cancel' ? 'cancelled' : 'pending';
  if (task.changeRequestId) {
    const request = parsed(await reads.get('SELECT payload FROM change_requests WHERE id=?', task.changeRequestId));
    check(request, 'NOT_FOUND', '关联请求不存在。', 404);
    const input = action === 'update'
      ? { kind: 'change_request.save', documentId: task.documentId, expectedVersion: request.version, partial: true,
        changeRequest: { id: request.id, body: next.body } }
      : { kind: 'change_request.' + action, documentId: task.documentId, changeRequestId: request.id, expectedVersion: request.version };
    prepared = await prepareBusiness(workspace, actor, input, reads);
  }
  if (task.type === 'question') {
    const row = await reads.get('SELECT * FROM insights WHERE id=? AND document_id=?', task.insightId, task.documentId), insight = parsed(row);
    check(insight && insight.type === 'question' && !row.archived_at, 'NOT_FOUND', '没有找到可用的问题。', 404);
    check(!insight.answer, 'REVISION_CONFLICT', '此问题已有回答。', 409);
    if (action === 'reopen') {
      const active = await reads.get("SELECT id FROM queue_tasks WHERE insight_id=? AND id<>? AND json_extract(payload,'$.status')='pending'", task.insightId, task.id);
      check(!active, 'QUEUE_TASK_EXISTS', '此问题已有待处理任务。', 409, { taskId: active?.id });
    }
    next.insightVersion = insight.version + 1; next.questionBody = insight.body;
    if (action === 'update' && command.patch.body !== undefined) next.bodyFromQuestion = next.body === insight.body;
    const fenced = { ...insight, version: next.insightVersion, updatedAt: now() };
    prepared.changes.push({ entity: 'insights', value: { ...row, version: fenced.version, payload: json(fenced) } });
  }
  prepared.changes.push({ entity: 'queue_tasks', value: queueRow(next) });
  prepared.result.task = next; prepared.queueTaskId = next.id;
  return prepared;
}
