import { CONVERSION_REQUIREMENTS } from "./conversion-request.js";

export const PENDING_IMPORT_KEY = "continuous-reader:pending-import";
const languages = ["", "en", "zh-CN", "ja", "fr", "de"];
const validOutput = value => Array.isArray(value) && value.length > 0 && value.includes("source") && value.every(item => ["source", "zh-CN"].includes(item));

export function readPendingImport(storage) {
  try {
    const saved = JSON.parse(storage.getItem(PENDING_IMPORT_KEY));
    if (typeof saved?.source?.sourceId !== "string" || typeof saved.source.filename !== "string" || !Number.isFinite(saved.source.size) || saved.source.size < 0) return null;
    const value = { source: saved.source, title: typeof saved.title === "string" ? saved.title : "", language: languages.includes(saved.language) ? saved.language : "",
      body: typeof saved.body === "string" ? saved.body : CONVERSION_REQUIREMENTS,
      ...(validOutput(saved.outputLanguages) ? { outputLanguages: saved.outputLanguages } : {}) };
    const pending = saved.queueCommand;
    if (pending?.kind === "queue.create" && typeof pending.requestId === "string" && pending.task?.type === "conversion" && pending.task.sourceId === value.source.sourceId && typeof pending.task.body === "string") {
      value.queueCommand = { kind: "queue.create", requestId: pending.requestId, task: { type: "conversion", sourceId: value.source.sourceId,
        title: typeof pending.task.title === "string" ? pending.task.title : value.title, body: pending.task.body,
        sourceLanguage: languages.includes(pending.task.sourceLanguage) ? pending.task.sourceLanguage : "",
        ...(validOutput(pending.task.outputLanguages) ? { outputLanguages: pending.task.outputLanguages } : {}) } };
      value.title = value.queueCommand.task.title;
      value.language = value.queueCommand.task.sourceLanguage;
      value.body = value.queueCommand.task.body;
      value.outputLanguages = value.queueCommand.task.outputLanguages;
    }
    return value;
  } catch { return null; }
}

export function savePendingImport(storage, value) {
  try { if (value) storage.setItem(PENDING_IMPORT_KEY, JSON.stringify(value)); else storage.removeItem(PENDING_IMPORT_KEY); return true; }
  catch { return false; }
}

export function importQueueCommand(pending, { title = "", language = "", body = CONVERSION_REQUIREMENTS, outputLanguages, requestId }) {
  if (pending.queueCommand) return pending.queueCommand;
  return { kind: "queue.create", requestId, task: { type: "conversion", sourceId: pending.source.sourceId,
    title: title.trim() || pending.source.filename.replace(/\.[^.]+$/, ""), body: body.trim() || CONVERSION_REQUIREMENTS, sourceLanguage: language,
    ...(validOutput(outputLanguages) ? { outputLanguages } : {}) } };
}

export function definiteImportRejection(error) {
  return error?.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
}
