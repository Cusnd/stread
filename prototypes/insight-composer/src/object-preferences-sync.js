import { cacheObjectPreferences, normalizeObjectPreferences, readObjectPreferencesMap } from "./object-preferences.js";
import { requestJson } from "./workspace-api.js";

export const objectOutboxKey = (documentId) => "continuous-reader.objects.pending.v1:" + documentId;
const merge = (base, patches) => {
  const result = { ...base };
  for (const [id, patch] of Object.entries(patches || {})) result[id] = { ...normalizeObjectPreferences(result[id]), ...patch };
  return result;
};
const nonempty = (value) => Object.keys(value || {}).length > 0;
const browserStorage = (name) => { try { return globalThis[name]; } catch { return undefined; } };

// One serial queue per open document. Only deliberately edited fields are sent;
// the local cache is imported with INSERT-if-absent semantics, never as a replace.
export function createObjectPreferenceSync({ documentId, sessionKey = documentId, documentRevision, storage, pendingStorage, read, write, delay = 350 }) {
  storage ??= browserStorage("localStorage");
  pendingStorage ??= browserStorage("sessionStorage");
  read ??= () => requestJson("/api/documents/" + encodeURIComponent(documentId) + "/object-preferences", { signal: AbortSignal.timeout(10000) });
  write ??= (command) => requestJson("/api/commands", { method: "POST", body: command, keepalive: JSON.stringify(command).length < 60000, signal: AbortSignal.timeout(10000) });
  let candidates = { ...readObjectPreferencesMap(documentId, storage), ...readObjectPreferencesMap(sessionKey, storage) };
  let remote = candidates, pending = {}, inFlight = null, initialized = false, operation = null, timer = null;
  try {
    const saved = JSON.parse(pendingStorage?.getItem(objectOutboxKey(documentId)) || "null");
    if (saved?.documentId === documentId) {
      if (saved.pending && typeof saved.pending === "object" && !Array.isArray(saved.pending)) pending = saved.pending;
      if (saved.inFlight?.kind === "object_preferences.update" && saved.inFlight.documentId === documentId) inFlight = saved.inFlight;
    }
  } catch { /* A damaged optional cache must not prevent loading the server. */ }
  const listeners = new Set();
  const overlay = () => merge(merge(remote, inFlight?.onlyIfAbsent ? {} : inFlight?.objects), pending);
  let snapshot = { objects: overlay(), status: "loading", error: "" };
  function publish(status, error = "") {
    const next = { objects: overlay(), status, error };
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    cacheObjectPreferences(documentId, next.objects, storage);
    for (const listener of listeners) listener();
  }
  function persistQueue() {
    try { pendingStorage?.setItem(objectOutboxKey(documentId), JSON.stringify({ documentId, inFlight, pending })); } catch { /* In-memory retry remains possible. */ }
  }
  function command(objects, onlyIfAbsent = false) {
    return { kind: "object_preferences.update", documentId, documentRevision, objects, ...(onlyIfAbsent ? { onlyIfAbsent: true } : {}), requestId: crypto.randomUUID() };
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void sync(); }, delay);
  }
  async function perform() {
    try {
      if (!initialized) {
        remote = (await read()).objects;
        initialized = true;
      }
      if (!inFlight) {
        const missing = Object.fromEntries(Object.entries(candidates).filter(([id]) => !Object.hasOwn(remote, id)));
        if (nonempty(missing)) inFlight = command(missing, true);
        candidates = {};
      }
      while (inFlight || nonempty(pending)) {
        if (!inFlight) { inFlight = command(pending); pending = {}; }
        persistQueue(); publish("saving");
        const result = await write(inFlight);
        remote = result.objects;
        inFlight = null;
        persistQueue(); publish(nonempty(pending) ? "pending" : "saved");
      }
      // Refresh after receipts too: a retried idempotent receipt can predate another client.
      remote = (await read()).objects;
      publish(nonempty(pending) ? "pending" : "saved");
    } catch (error) {
      publish("error", error.message || "暂时无法连接服务端。");
    }
  }
  function sync() {
    clearTimeout(timer); timer = null;
    if (operation) return operation;
    operation = perform().finally(() => {
      operation = null;
      if (snapshot.status !== "error" && nonempty(pending)) schedule();
    });
    return operation;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    update(blockId, patch) {
      const values = normalizeObjectPreferences(patch);
      const changed = Object.fromEntries(Object.keys(patch).filter((key) => key === "widthPercent" || key === "fontSize").map((key) => [key, values[key]]));
      pending = { ...pending, [blockId]: { ...pending[blockId], ...changed } };
      persistQueue(); publish("pending"); schedule();
    },
    importLegacy(blockId, value) {
      if (Object.hasOwn(snapshot.objects, blockId)) return;
      candidates = { ...candidates, [blockId]: normalizeObjectPreferences(value) };
      // A pixel width is only a migration candidate, never a deliberate new edit.
      if (!initialized) remote = { ...remote, [blockId]: candidates[blockId] };
      publish(snapshot.status); schedule();
    },
    sync,
    start() {
      void sync();
      const refresh = () => { if (typeof document === "undefined" || document.visibilityState !== "hidden") void sync(); };
      const flush = () => { void sync(); };
      const interval = setInterval(refresh, 5000);
      globalThis.window?.addEventListener("focus", refresh);
      globalThis.window?.addEventListener("online", refresh);
      globalThis.window?.addEventListener("pagehide", flush);
      globalThis.document?.addEventListener("visibilitychange", flush);
      return () => {
        clearInterval(interval); clearTimeout(timer); timer = null;
        globalThis.window?.removeEventListener("focus", refresh);
        globalThis.window?.removeEventListener("online", refresh);
        globalThis.window?.removeEventListener("pagehide", flush);
        globalThis.document?.removeEventListener("visibilitychange", flush);
        if (inFlight || nonempty(pending)) void sync();
      };
    },
  };
}
