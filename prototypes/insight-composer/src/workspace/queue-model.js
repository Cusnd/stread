import { conversionRequest } from "../conversion-request.js";

export const queueTypes = Object.freeze([
  { id: "all", label: "全部任务" },
  { id: "conversion", label: "源文件转换" },
  { id: "correction", label: "内容纠错" },
  { id: "translation", label: "译文修改" },
  { id: "question", label: "问答" },
  { id: "instruction", label: "通用任务" },
]);
export const queueStatuses = Object.freeze([
  { id: "all", label: "全部" },
  { id: "pending", label: "待处理" },
  { id: "processing", label: "处理中" },
  { id: "needs_attention", label: "需处理" },
  { id: "completed", label: "已完成" },
  { id: "cancelled", label: "已撤回" },
]);
export const queueTypeLabel = (type) => queueTypes.find((item) => item.id === type)?.label || "任务";
export const queueStatusLabel = (status) => queueStatuses.find((item) => item.id === status)?.label || "待处理";

export function queueView(view = {}) {
  return {
    type: queueTypes.some((item) => item.id === view.type) ? view.type : "all",
    status: queueStatuses.some((item) => item.id === view.status) ? view.status : "pending",
    query: typeof view.query === "string" ? view.query : "",
    selectedId: typeof view.selectedId === "string" ? view.selectedId : null,
    limit: Number.isSafeInteger(view.limit) && view.limit >= 100 ? view.limit : 100,
  };
}

export function queueListUrl(view = {}, offset = 0, limit = 100) {
  const current = queueView(view);
  return "/api/queue?" + new URLSearchParams({ type: current.type, status: current.status, query: current.query.trim(), offset: String(offset), limit: String(limit) });
}

export async function readQueuePages(view, readPage) {
  const current = queueView(view);
  for (let attempt = 0; attempt < 3; attempt++) {
    const tasks = [];
    let result, revision, changed = false;
    try {
      for (let offset = 0; offset < current.limit; offset += 100) {
        result = await readPage(queueListUrl(current, offset, Math.min(100, current.limit - offset)));
        if (offset && result.revision !== revision) { changed = true; break; }
        revision = result.revision;
        tasks.push(...(result.tasks || []));
        if (!result.tasks?.length || tasks.length >= result.total) break;
      }
    } catch (error) {
      if (error.code !== "LIST_CHANGED") throw error;
      changed = true;
    }
    if (!changed) return { ...result, tasks: [...new Map(tasks.map((task) => [task.id, task])).values()] };
  }
  throw new Error("队列正在更新，请稍后重试。");
}

export function queueTaskMatches(task, view) {
  const current = queueView(view);
  if (!task || (current.type !== "all" && task.type !== current.type) || (current.status !== "all" && task.status !== current.status)) return false;
  const query = current.query.trim().toLocaleLowerCase();
  return !query || [task.reference, task.reference?.replace(/^#T0*/i, ""), task.title, task.body, task.sourceFilename, task.documentTitle, task.relatedReference].some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(query));
}

export function queueTaskReveal(task, view) {
  const current = queueView(view);
  if (!task || ![task.id, task.reference].includes(current.selectedId) || queueTaskMatches(task, current)) return null;
  return { type: task.type, status: task.status, query: "", scrollTop: 0 };
}

export function queueFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function queueOutputLabel(task) {
  const languages = task.outputLanguages || (task.sourceLanguage === "zh-CN" ? ["source"] : ["source", "zh-CN"]);
  const names = { source: "原文", "zh-CN": "简体中文", en: "English", ja: "日本語", fr: "Français", de: "Deutsch" };
  return languages.map((language) => names[language] || language).join(" + ");
}

export function queueTaskTitle(task) {
  if (task.type === "conversion") return task.sourceFilename || task.uploadedSource?.filename || task.title || "源文件转换";
  if (task.type === "question" && task.questionBody) return task.questionBody.split(/\r?\n/).find((line) => line.trim());
  return task.title || task.body?.split(/\r?\n/).find((line) => line.trim()) || task.documentTitle || queueTypeLabel(task.type);
}

export function queueTaskMeta(task) {
  if (task.type !== "conversion") return [task.documentTitle, queueTypeLabel(task.type)].filter(Boolean);
  const filename = task.sourceFilename || task.uploadedSource?.filename || "";
  const extension = filename.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase();
  return [extension || "源文件", queueFileSize(task.uploadedSource?.size), queueOutputLabel(task)].filter(Boolean);
}

export function queueSourceUrl(task) {
  return task.sourceId ? "/api/sources/" + encodeURIComponent(task.sourceId) + "/original" : null;
}

export function queueSourcePreview(task) {
  const filename = task.sourceFilename || task.uploadedSource?.filename || "";
  return task.sourceId && (task.uploadedSource?.mediaType === "application/pdf" || /\.pdf$/i.test(filename))
    ? "/api/sources/" + encodeURIComponent(task.sourceId) + "/pages/1.png?width=600" : null;
}

export function queueDocumentTarget(task, result = false) {
  const value = result ? task.result : task;
  if (!value?.documentId) return null;
  return { documentId: value.documentId, options: {
    ...(value.insightId ? { insightId: value.insightId } : {}),
    ...(!result && task.source?.blockId ? { hash: "#" + encodeURIComponent(task.source.blockId) } : {}),
    ...(result && Number.isInteger(value.revision) ? { revision: value.revision } : {}),
  } };
}

export function queueResultLabel(task) {
  return { document: "打开文章", revision: "查看修改", answer: "查看回答", relation: "查看引用" }[task.result?.kind] || "查看结果";
}

export function queueTimeLabel(value, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  if (day.format(date) === day.format(now)) return "今天 " + time;
  return new Intl.DateTimeFormat("zh-CN", { timeZone, month: "numeric", day: "numeric" }).format(date) + " " + time;
}

export function queueDraftFor(task) {
  return { taskId: task.id, reference: task.reference, expectedVersion: task.version, type: task.type, title: task.title || "", body: task.body || "", documentId: task.documentId || "", sourceId: task.sourceId || "", sourceFilename: task.sourceFilename || "", insightId: task.insightId || "", sourceLanguage: task.sourceLanguage || "", outputLanguages: task.outputLanguages ? [...task.outputLanguages] : undefined };
}

export function queueSaveCommand(draft, requestId) {
  if (draft.pendingCommand) return draft.pendingCommand;
  const type = draft.type || "conversion", body = (draft.body || "").trim(), title = (draft.title || "").trim();
  if (!queueTypes.some((item) => item.id === type && item.id !== "all")) throw new Error("请选择任务类型。");
  if (!body && (draft.taskId || (type !== "conversion" && type !== "question"))) throw new Error("请填写任务要求。");
  const fields = { body, title, ...(type === "conversion" ? { sourceLanguage: draft.sourceLanguage || "", ...(draft.outputLanguages ? { outputLanguages: draft.outputLanguages } : {}) } : {}) };
  if (draft.taskId) return { kind: "queue.update", taskId: draft.taskId, expectedVersion: draft.expectedVersion, patch: fields, requestId };
  if (type === "conversion" && !draft.sourceId) throw new Error("请选择源文件。");
  if (type !== "conversion" && !draft.documentId) throw new Error("请选择关联文章。");
  if (type === "question" && !draft.insightId) throw new Error("请选择交给 AI 的问题。");
  return { kind: "queue.create", task: { type, ...fields,
    ...(type === "conversion" ? { sourceId: draft.sourceId } : { documentId: draft.documentId }),
    ...(type === "question" ? { insightId: draft.insightId, ...(Number.isSafeInteger(draft.expectedInsightVersion) ? { expectedInsightVersion: draft.expectedInsightVersion } : {}) } : {}),
    ...(draft.source && type !== "conversion" ? { source: draft.source } : {}),
  }, requestId };
}

export function queueDraftAfterSaveError(draft, error) {
  const definitive = error?.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
  if (!definitive) return draft;
  return { ...draft, pendingCommand: null, conflict: Boolean(draft.taskId && error.status === 409),
    questionConflict: Boolean(!draft.taskId && draft.type === "question" && error.status === 409) };
}

export function queueHandoff(task) {
  const heading = [`请处理 Stread 任务 ${task.reference}。`, `task_id: ${task.id}`, `task_version: ${task.version}`, "先通过 MCP resolve_reference 读取该任务的最新内容与关联对象，再按当前版本操作。"];
  if (task.type === "conversion") return [...heading, conversionRequest({ ...task.uploadedSource, sourceId: task.sourceId, filename: task.sourceFilename || task.uploadedSource?.filename || task.title }, { title: task.title, language: task.sourceLanguage, task })].join("\n");
  return [...heading,
    ...(task.documentId ? [`document_id: ${task.documentId}`] : []),
    ...(task.changeRequestId ? [`change_request_id: ${task.changeRequestId}`] : []),
    ...(task.insightId ? [`insight_id: ${task.insightId}`] : []),
    ...(task.relatedReference ? [`关联编号：${task.relatedReference}`] : []),
    "任务要求：", task.body || task.title,
    "任务版本与文章、问题、更改请求的版本分别校验。结果应保存到关联对象；读取任务不代表完成。",
  ].join("\n");
}
