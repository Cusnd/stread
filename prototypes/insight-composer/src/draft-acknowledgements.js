const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * A confirmed command is disposable only after the corresponding draft either
 * disappears or durably carries the returned entity ID and version. Desktop
 * persistence must acknowledge the disk write as well as sessionStorage.
 */
export function createDraftAcknowledgements({ acknowledge } = {}) {
  if (typeof acknowledge !== "function") throw new TypeError("acknowledge is required");
  const pending = new Map();
  let persisted = null, draining = null;
  const eligible = (intentId, saved, draft) => !draft || draft.clientIntentId !== intentId
    || (draft.id === saved.id && Number.isInteger(draft.version) && draft.version >= saved.version);

  function markSaved(intentId, saved) {
    if (typeof intentId !== "string" || !intentId || !saved?.id || !Number.isInteger(saved.version) || saved.version < 1) return false;
    const previous = pending.get(intentId);
    if (previous && (previous.id !== saved.id || previous.version > saved.version)) return false;
    pending.set(intentId, { id: saved.id, version: saved.version });
    // An earlier durable null/draft snapshot is not evidence for a later save.
    persisted = null;
    return true;
  }

  function drain() {
    if (draining) return draining;
    const attempted = new Set();
    draining = Promise.resolve().then(async () => {
      while (persisted) {
        const candidate = [...pending].find(([intentId, saved]) => !attempted.has(saved) && eligible(intentId, saved, persisted.draft));
        if (!candidate) break;
        const [intentId, saved] = candidate;
        attempted.add(saved);
        let acknowledged = false;
        try { acknowledged = await acknowledge(intentId, saved); } catch { /* Keep safe retry state on any cleanup failure. */ }
        if (acknowledged && pending.get(intentId) === saved) pending.delete(intentId);
      }
      return { pending: pending.size };
    }).finally(() => { draining = null; });
    return draining;
  }

  function persist({ draft, storage, key, desktop } = {}) {
    // Invalidate the old proof even if either write below fails. In particular,
    // a later successful acknowledgement must not authorize a failed new write.
    persisted = null;
    if (!storage || typeof storage.setItem !== "function") throw new Error("本机草稿暂时无法保存，请保留当前页面并重试。");
    const serialized = JSON.stringify(draft ?? null);
    storage.setItem(key, serialized);
    if (![...pending].some(([intentId, saved]) => eligible(intentId, saved, draft))) return Promise.resolve({ pending: pending.size });
    if (desktop) {
      if (typeof desktop.persistSessionNow !== "function" || desktop.persistSessionNow()?.ok !== true) {
        throw new Error("本机草稿尚未确认写入磁盘，保存请求记录将继续保留。");
      }
    }
    persisted = { draft: clone(draft ?? null) };
    return drain();
  }

  return { markSaved, persist, pendingCount: () => pending.size };
}
