const ENTRY_KEY = "continuous-reader:development-entry:v1";
const CHECKPOINT_KEY = "continuous-reader:reading-checkpoints:v1";
const OWNER_KEY = "continuousReaderDevelopmentState";

export function isDesktopDevelopment(bridge) {
  return bridge?.development === true;
}

export function developmentReadingState(entry, documentId, revision, fallback) {
  const state = entry?.readerPosition;
  return state?.documentId === documentId && state.revision === revision
    && typeof state.blockId === "string" && state.blockId
    ? state : fallback;
}

export function sameDevelopmentCheckpoint(left, right) {
  return Boolean(left && right) && JSON.stringify(left) === JSON.stringify(right);
}

// enqueue() intentionally retains an in-memory record when storage fails. A
// development reload must not mistake that fallback for a durable snapshot.
export function verifyDevelopmentCheckpoint(storage, documentId, position) {
  const saved = JSON.parse(storage.getItem(CHECKPOINT_KEY) || "null");
  const entry = saved?.v === 1 && saved.entries?.find((item) => item.documentId === documentId);
  if (!sameDevelopmentCheckpoint(entry?.pending || entry?.inFlight?.readingState, position)) {
    throw new Error("开发刷新前的阅读位置未写入本地待同步队列。");
  }
}

export function persistDevelopmentEntry(target) {
  target.sessionStorage.setItem(ENTRY_KEY, JSON.stringify({
    v: 1, url: target.location.href, state: target.history.state,
  }));
}

export function restoreDevelopmentEntry(target) {
  // A normal browser reload already preserves its current history entry. The
  // session copy is only for a new development window reopened at the same URL.
  if (target.history.state != null) return false;
  const saved = JSON.parse(target.sessionStorage.getItem(ENTRY_KEY) || "null");
  if (saved?.v !== 1 || saved.url !== target.location.href || !saved.state
    || typeof saved.state !== "object" || Array.isArray(saved.state)) return false;
  target.history.replaceState(saved.state, "");
  return true;
}

export function snapshotDevelopmentState(target, reason) {
  if (!isDesktopDevelopment(target.continuousReaderDesktop)) return { ok: true, skipped: true, errors: [] };
  const errors = [];
  // The Reader and Workspace handlers finish their local writes synchronously.
  // No network save is started here and an existing request keeps its identity.
  const detail = { development: true, enqueueOnly: true, reason, errors };
  try { target.dispatchEvent(new target.CustomEvent("continuous-reader:flush", { detail })); }
  catch (error) { errors.push(error); }
  try { persistDevelopmentEntry(target); } catch (error) { errors.push(error); }
  try {
    if (target.continuousReaderDesktop.persistSessionNow?.()?.ok !== true) {
      throw new Error("开发刷新前的桌面会话未确认写入磁盘。");
    }
  } catch (error) { errors.push(error); }
  if (errors.length) target.console?.error("开发刷新前的状态快照未完整保存；Vite 仍可能继续刷新。", ...errors);
  return { ok: errors.length === 0, errors };
}

export function installDevelopmentState(hot, target) {
  if (!hot || !isDesktopDevelopment(target.continuousReaderDesktop)) return () => {};
  hot.data[OWNER_KEY]?.();
  try { restoreDevelopmentEntry(target); }
  catch (error) { target.console?.error("开发窗口的上次导航状态未能恢复。", error); }
  const beforeUpdate = (payload) => {
    if (payload.updates?.some((update) => update.type === "js-update")) snapshotDevelopmentState(target, "update");
  };
  const beforeReload = () => snapshotDevelopmentState(target, "full-reload");
  // Vite also reloads directly after a WebSocket reconnection or error overlay.
  // This runs after preload's listener and snapshots the fresh local writes again.
  const beforeUnload = () => snapshotDevelopmentState(target, "beforeunload");
  hot.on("vite:beforeUpdate", beforeUpdate);
  hot.on("vite:beforeFullReload", beforeReload);
  target.addEventListener("beforeunload", beforeUnload);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    hot.off("vite:beforeUpdate", beforeUpdate);
    hot.off("vite:beforeFullReload", beforeReload);
    target.removeEventListener("beforeunload", beforeUnload);
    if (hot.data[OWNER_KEY] === dispose) delete hot.data[OWNER_KEY];
  };
  hot.data[OWNER_KEY] = dispose;
  hot.dispose(dispose);
  return dispose;
}
