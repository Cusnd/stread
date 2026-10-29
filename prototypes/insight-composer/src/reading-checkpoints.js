const STORAGE_KEY = "continuous-reader:reading-checkpoints:v1";
const clone = (value) => JSON.parse(JSON.stringify(value));
const browserStorage = () => { try { return globalThis.sessionStorage; } catch { return undefined; } };
const definitive = (error) => error?.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);

/**
 * Each document has a serial lane: an unknown write is replayed with its original
 * request ID before the latest queued position is sent. New positions coalesce
 * only in the not-yet-sent slot. A delayed failure can never resurrect an older
 * position after a newer position has been acknowledged.
 */
export function createReadingCheckpointQueue({ send, storage = browserStorage(), createId = () => crypto.randomUUID() } = {}) {
  if (typeof send !== "function") throw new TypeError("send is required");
  const entries = new Map(), operations = new Map();
  let storageError = null;
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || "null");
    if (saved?.v === 1 && Array.isArray(saved.entries)) {
      for (const entry of saved.entries) {
        if (typeof entry?.documentId !== "string" || !(entry.pending || entry.inFlight)) continue;
        if (entry.inFlight && (entry.inFlight.kind !== "reading.checkpoint" || entry.inFlight.documentId !== entry.documentId || typeof entry.inFlight.requestId !== "string")) continue;
        entries.set(entry.documentId, entry);
      }
    }
  } catch (error) { storageError = error; }
  function persist() {
    try {
      if (!storage) throw new Error("浏览器存储不可用，阅读位置尚未写入待保存记录。");
      if (entries.size) storage?.setItem(STORAGE_KEY, JSON.stringify({ v: 1, entries: [...entries.values()] }));
      else storage?.removeItem(STORAGE_KEY);
      storageError = null;
    } catch (error) { storageError = error; }
  }
  function enqueue(documentId, readingState) {
    if (typeof documentId !== "string" || !documentId || !readingState) return;
    const entry = entries.get(documentId) || { documentId, pending: null, inFlight: null };
    const state = clone({ ...readingState, documentId });
    const previous = entry.pending || entry.inFlight?.readingState;
    if (JSON.stringify(previous) === JSON.stringify(state)) return;
    entry.pending = state;
    entries.set(documentId, entry);
    persist();
  }
  function drain(documentId) {
    if (operations.has(documentId)) return operations.get(documentId);
    const operation = Promise.resolve().then(async () => {
      let entry = entries.get(documentId);
      while (entry?.inFlight || entry?.pending) {
        if (!entry.inFlight) {
          entry.inFlight = { kind: "reading.checkpoint", documentId, readingState: entry.pending, requestId: createId() };
          entry.pending = null;
          persist();
        }
        try { await send(clone(entry.inFlight)); }
        catch (error) {
          // A definitive rejection did not commit. Let a newer valid position
          // replace it; keep the rejected value if there is no newer intent.
          if (definitive(error) && entry.pending) { entry.inFlight = null; persist(); continue; }
          throw error;
        }
        entry.inFlight = null;
        if (!entry.pending) entries.delete(documentId);
        persist();
        entry = entries.get(documentId);
      }
    }).finally(() => operations.delete(documentId));
    operations.set(documentId, operation);
    return operation;
  }
  async function flush(documentId) {
    const ids = documentId ? [documentId] : [...entries.keys()];
    const results = await Promise.allSettled(ids.map(drain));
    return { pending: documentId ? Number(entries.has(documentId)) : entries.size, errors: results.filter((result) => result.status === "rejected").map((result) => result.reason), storageError };
  }
  function position(documentId) {
    const entry = entries.get(documentId);
    return entry?.pending || entry?.inFlight?.readingState || null;
  }
  return { enqueue, flush, position, hasPending: () => entries.size > 0 };
}
