import { createCommandIntentClient } from "./command-intents.js";
const representations = new Map();
let representationSequence = 0;
let representationBytes = 0;
const representationBudget = 32 * 1024 * 1024;

export class WorkspaceError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = "WorkspaceError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function requestJson(path, options = {}) {
  const { conditional = false, ...fetchOptions } = options;
  options = fetchOptions;
  const headers = new Headers(options.headers);
  const cached = conditional ? representations.get(path) : null;
  const sequence = ++representationSequence;
  if (cached?.etag) headers.set("If-None-Match", cached.etag);
  if (options.body && !(options.body instanceof Blob) && typeof options.body !== "string") {
    options = { ...options, body: JSON.stringify(options.body) };
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  if (response.status === 304 && cached) return cached.value;
  const contentType = response.headers.get("Content-Type") || "";
  const result = contentType.includes("json") ? await response.json() : null;
  if (!response.ok) throw new WorkspaceError(result?.error || "服务暂时不可用，请重试。", response.status, result?.code, result?.details);
  if (!result) throw new WorkspaceError("服务返回了无法识别的数据。", response.status, "invalid_response");
  if (conditional && response.headers.get("ETag") && !options.signal?.aborted && (representations.get(path)?.sequence || 0) < sequence) {
    representationBytes -= representations.get(path)?.bytes || 0;
    representations.delete(path);
    const bytes = JSON.stringify(result).length * 2;
    if (bytes <= representationBudget) {
      representations.set(path, { etag: response.headers.get("ETag"), value: result, sequence, bytes }); representationBytes += bytes;
    }
    while (representations.size > 48 || representationBytes > representationBudget) {
      const key = representations.keys().next().value;
      representationBytes -= representations.get(key).bytes; representations.delete(key);
    }
  }
  return result;
}

const commandClient = createCommandIntentClient({
  send: (command) => requestJson("/api/commands", { method: "POST", body: command, signal: AbortSignal.timeout(10000) }),
});

export const executeCommand = (command, options) => commandClient.execute(command, options);
export const acknowledgeDraftCommand = (intentId, expected) => commandClient.acknowledgeDraft(intentId, expected);
export const settlePendingCommands = () => commandClient.settle();

export function parseRoute(search) {
  const query = new URLSearchParams(search);
  if (query.has("example") || query.has("paper")) return { page: "legacy" };
  if (query.get("view") === "notes" && query.get("document")) return { page: "notes", documentId: query.get("document") };
  if (query.get("document")) return { page: "reader", documentId: query.get("document"), insightId: query.get("insight") || null, ...(/^[1-9]\d*$/.test(query.get("revision")) ? { revision: Number(query.get("revision")) } : {}) };
  if (query.get("view") === "flow") return { page: "flow", section: ["overview", "insights", "plan", "history"].includes(query.get("section")) ? query.get("section") : "overview" };
  if (query.get("view") === "queue") return { page: "queue", ...(query.get("task") && query.get("task").length <= 160 ? { taskId: query.get("task") } : {}) };
  return { page: "collection" };
}

export function routeUrl(route) {
  const query = new URLSearchParams();
  if (route.page === "notes") {
    query.set("view", "notes");
    query.set("document", route.documentId);
  } else if (route.page === "reader") {
    query.set("document", route.documentId);
    if (route.insightId) query.set("insight", route.insightId);
    if (route.revision) query.set("revision", String(route.revision));
  } else if (route.page === "flow") {
    query.set("view", "flow");
    if (route.section && route.section !== "overview" && ["insights", "plan", "history"].includes(route.section)) query.set("section", route.section);
  } else if (route.page === "queue") {
    query.set("view", "queue");
    if (route.taskId) query.set("task", route.taskId);
  } else query.set("view", "collection");
  return "?" + query;
}

function normalizedViewState(value, preferredPage = "collection") {
  const object = (candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
  const collection = { ...object(value?.collection) }, flow = { ...object(value?.flow) }, queue = { ...object(value?.queue) };
  const legacy = preferredPage === "queue" ? [queue.navigationExpanded, collection.navigationExpanded, flow.navigationExpanded]
    : preferredPage === "flow" ? [flow.navigationExpanded, collection.navigationExpanded] : [collection.navigationExpanded, flow.navigationExpanded];
  const navigationExpanded = [value?.navigationExpanded, ...legacy].find((candidate) => typeof candidate === "boolean");
  delete collection.navigationExpanded; delete flow.navigationExpanded; delete queue.navigationExpanded;
  return { collection, flow, ...(value?.queue === undefined ? {} : { queue }), ...(navigationExpanded === undefined ? {} : { navigationExpanded }) };
}

export function readViewState(storage, preferredPage = "collection") {
  try { return normalizedViewState(JSON.parse(storage.getItem("continuous-reader:views")), preferredPage); }
  catch { return { collection: {}, flow: {} }; }
}

export function writeViewState(storage, value) {
  try { storage.setItem("continuous-reader:views", JSON.stringify(normalizedViewState(value))); return true; }
  catch { return false; }
}

export function accessibleLegacySessions(snapshot, storage) {
  const sessions = [];
  for (const document of snapshot.documents) {
    for (const suffix of ["", ":html-table3"]) {
      const sessionKey = document.id + suffix;
      try {
        const raw = storage.getItem("reader-session:" + sessionKey);
        if (!raw) continue;
        const saved = JSON.parse(raw);
        if (Array.isArray(saved.notes)) sessions.push({ documentId: document.id, sessionKey, notes: saved.notes, draft: saved.draft || null, rawSession: saved });
      } catch { }
    }
  }
  return sessions;
}

export function referenceDestination(value) {
  const text = value.trim();
  if (/^#?[QNRT]\d{5,}$/i.test(text)) return { reference: "#" + text.replace(/^#/, "").toUpperCase() };
  try {
    const url = new URL(text, "http://reader.local");
    if (url.searchParams.get("view") === "queue" && url.searchParams.get("task")) return { taskId: url.searchParams.get("task") };
    const documentId = url.searchParams.get("document");
    if (documentId) return { documentId, insightId: url.searchParams.get("insight") || null, hash: url.hash, ...(/^[1-9]\d*$/.test(url.searchParams.get("revision")) ? { revision: Number(url.searchParams.get("revision")) } : {}) };
    if (text.startsWith("{")) {
      const address = JSON.parse(text);
      const documentId = address.documentId || address.document_id;
      const blockId = address.blockId || address.block_id;
      if (documentId) return { documentId, insightId: address.insightId || address.insight_id || null, hash: blockId ? "#" + encodeURIComponent(blockId) : "", ...(Number.isInteger(address.revision) && address.revision > 0 ? { revision: address.revision } : {}) };
    }
  } catch { return null; }
  return null;
}
