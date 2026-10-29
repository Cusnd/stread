import { ensureDraftIntent } from "../command-intents.js";

export const NOTE_BODY_LIMIT = 200000;
export const NOTE_TITLE_LIMIT = 200;
const content = (note) => JSON.stringify([note.title || "", note.body || ""]);
const failureText = (error) => error?.message || "保存未完成，草稿已保留。";
const isNote = (note, documentId) => note?.type === "note" && (!note.documentId || note.documentId === documentId) && !note.archivedAt && !note.deletedAt;
const mountedOwners = new WeakMap();
const freshCopy = (draft, createId) => {
  const { id, version, reference, references, createdAt, updatedAt, archivedAt, deletedAt, clientIntentId,
    answer, answerAuthorization, resolvedAt, review, documentTitle, ...value } = draft;
  return ensureDraftIntent(value, createId);
};

/** Per-note drafts retain their identity across autosaves, unknown outcomes and
 * navigation. Only a durable returned id/version permits receipt cleanup. */
export function createNoteDraftStore({ documentId, revision, notes = [], storage, desktop,
  save, acknowledge = async () => false, createId = () => crypto.randomUUID(), timers = globalThis,
  delay = 900, color = "amber", writable = true } = {}) {
  const storageKey = "reader-notes-drafts:v1:" + encodeURIComponent(documentId);
  const owner = {};
  const listeners = new Set(), records = new Map(), scheduled = new Map(), operations = new Map(), latest = new Map();
  let active = false, canWrite = writable, storageError = "", storageUnreadable = false, archived = [], snapshot;
  try {
    const raw = storage?.getItem(storageKey);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved?.version !== 1 || !Array.isArray(saved.records)) throw new Error("笔记草稿格式无法识别，原始记录已保留。");
      archived = Array.isArray(saved.archived) ? saved.archived.filter((note) => note?.id && note.documentId === documentId && note.archivedAt) : [];
      for (const record of saved.records) {
        if (typeof record?.key !== "string" || !isNote(record.draft, documentId)) continue;
        records.set(record.key, { ...record, draft: ensureDraftIntent(record.draft, createId), saving: false });
      }
    }
  } catch { storageUnreadable = true; storageError = "笔记草稿格式无法识别，原始记录已保留。"; }

  function emit() {
    snapshot = { records: [...records.values()], archived, storageError };
    for (const listener of listeners) listener();
  }
  function persist({ durable = false } = {}) {
    if (!storage || typeof storage.setItem !== "function") throw new Error("本机草稿暂时无法保存，请保留当前页面并重试。");
    const mounted = mountedOwners.get(storage)?.get(storageKey);
    if (mounted && mounted !== owner) throw new Error("笔记页已重新打开，保存回执将由当前页面确认。");
    // An unreadable original must not be replaced with an empty/new draft set.
    if (storageUnreadable) throw new Error(storageError);
    const retained = [...records.values()].filter((record) => !record.draft.id || record.dirty || record.unconfirmed || record.needsAck || record.error || record.conflict || record.suspended || record.archiving);
    storage.setItem(storageKey, JSON.stringify({ version: 1, archived, records: retained.map(({ saving, ...record }) => record) }));
    if (durable && desktop) {
      if (typeof desktop.persistSessionNow !== "function" || desktop.persistSessionNow()?.ok !== true) {
        throw new Error("本机草稿尚未确认写入磁盘，请保留当前页面并重试。");
      }
    } else desktop?.persistSession?.();
    storageError = "";
  }
  function persistQuietly() {
    try { persist(); } catch (error) { storageError = failureText(error); }
  }
  function clearTimer(key) {
    if (scheduled.has(key)) timers.clearTimeout(scheduled.get(key));
    scheduled.delete(key);
  }
  function schedule(key) {
    clearTimer(key);
    const record = records.get(key);
    if (!active || !canWrite || storageError || !record?.dirty || record.saving || record.error || record.conflict || record.suspended || record.archiving || !record.draft.body?.trim()) return;
    scheduled.set(key, timers.setTimeout(() => { scheduled.delete(key); void saveRecord(key); }, delay));
  }
  function install(note, key = note.id) {
    const draft = ensureDraftIntent({ ...note, documentId }, createId);
    records.set(key, { key, draft, savedContent: content(note), dirty: false, saving: false, error: "", conflict: false, suspended: false });
    return key;
  }
  function receive(incoming) {
    const valid = incoming.filter((note) => isNote(note, documentId));
    const creating = [...records.values()].some((record) => !record.draft.id && (record.saving || record.unconfirmed));
    latest.clear();
    for (const note of valid) {
      latest.set(note.id, note);
      const existing = [...records.values()].find((record) => record.draft.id === note.id);
      // An unknown create may already exist in this refresh. Keep all incoming
      // rows in latest, but wait for its exact receipt before assigning identity.
      if (!existing) { if (!creating) install(note); continue; }
      if (existing.saving || existing.unconfirmed || existing.archiving || (existing.draft.version || 0) > (note.version || 0)) continue;
      if (existing.dirty || existing.conflict) {
        if ((note.version || 0) > (existing.draft.version || 0)) {
          clearTimer(existing.key);
          records.set(existing.key, { ...existing, conflict: true, error: "这条笔记已在其他位置更新，当前草稿已保留。" });
        }
      } else records.set(existing.key, { ...existing, draft: { ...note, documentId, clientIntentId: existing.draft.clientIntentId }, savedContent: content(note), error: "", archiveError: "" });
    }
    for (const [key, record] of records) {
      if (!record.draft.id || latest.has(record.draft.id) || record.saving || record.unconfirmed || record.archiving) continue;
      if (record.dirty || record.conflict) records.set(key, { ...record, conflict: true, error: "这条笔记已移除或更改类型，当前草稿已保留。" });
      else records.delete(key);
    }
    archived = archived.filter((note) => !valid.some((item) => item.id === note.id && item.version > note.version));
    emit();
  }
  // Construction is read-only: React StrictMode may evaluate it twice.
  receive(notes);

  function create(seed = {}) {
    if (!canWrite) return null;
    const draft = ensureDraftIntent({ type: "note", body: "", title: "", color, documentId, revision, ...seed }, createId);
    const key = "draft:" + draft.clientIntentId;
    records.set(key, { key, draft, savedContent: null, dirty: true, saving: false, error: "", conflict: false, suspended: false });
    persistQuietly(); emit(); schedule(key);
    return key;
  }
  function edit(key, patch) {
    const record = records.get(key);
    if (!record || !canWrite || record.archiving) return;
    const draft = { ...record.draft, ...(typeof patch.title === "string" ? { title: patch.title } : {}), ...(typeof patch.body === "string" ? { body: patch.body } : {}) };
    const dirty = record.savedContent !== content(draft);
    // Errors remain until an explicit retry: typing must not start a retry loop
    // after a service/storage failure or write an older conflicted version.
    records.set(key, { ...record, draft, dirty });
    persistQuietly(); emit(); schedule(key);
  }
  function validate(record) {
    if ((record.draft.body || "").length > NOTE_BODY_LIMIT) throw new Error("笔记内容最多 200000 字，超出的输入仍保留在草稿中。");
    if ((record.draft.title || "").trim().length > NOTE_TITLE_LIMIT || /[\r\n\u0085\u2028\u2029]/u.test(record.draft.title || "")) throw new Error("标题需为 200 字以内的单行文本。");
  }
  async function settleReceipt(key) {
    const current = records.get(key);
    persist({ durable: true });
    if (!current?.needsAck) return;
    const { id, version, clientIntentId } = current.draft;
    if (await acknowledge(clientIntentId, { id, version })) {
      const acknowledged = records.get(key);
      if (acknowledged?.draft.id === id && acknowledged.draft.version === version) records.set(key, { ...acknowledged, needsAck: false });
      persist({ durable: true });
    }
  }
  function saveRecord(key, { resume = false } = {}) {
    clearTimer(key);
    if (operations.has(key)) return operations.get(key);
    let record = records.get(key);
    if (!record || !canWrite || record.conflict || record.archiving || record.suspended && !resume) return Promise.resolve(null);
    if (!record.dirty && !record.unconfirmed) {
      const operation = settleReceipt(key).catch((error) => { storageError = failureText(error); }).then(() => { emit(); return null; }).finally(() => { operations.delete(key); schedule(key); });
      operations.set(key, operation);
      return operation;
    }
    // First confirm the exact previous attempt even when the user has since
    // cleared the body or returned it to the old saved text. Later edits are a
    // separate save and must not prevent recovery of the created id/version.
    const attempt = record.unconfirmed && record.pendingAttempt ? record.pendingAttempt : record.draft;
    if (!attempt.body?.trim()) return Promise.resolve(null);
    try { validate({ draft: attempt }); }
    catch (error) { records.set(key, { ...record, error: failureText(error) }); persistQuietly(); emit(); return Promise.resolve(null); }
    record = { ...record, unconfirmed: true, pendingAttempt: attempt };
    records.set(key, record);
    try { persist({ durable: true }); }
    catch (error) { records.set(key, { ...record, error: failureText(error) }); storageError = failureText(error); emit(); return Promise.resolve(null); }
    if (resume) { record = { ...record, suspended: false }; records.set(key, record); }
    records.set(key, { ...record, saving: true, error: "" }); emit();
    const { clientIntentId, ...input } = attempt;
    const operation = Promise.resolve().then(() => save(input, { intentId: clientIntentId })).then(async (saved) => {
      if (!saved?.id || !Number.isInteger(saved.version) || saved.documentId && saved.documentId !== documentId) throw new Error("保存结果尚未确认，草稿已保留，请重试。");
      const current = records.get(key);
      if (!current) return saved;
      // A response only replaces server-owned fields. Input typed while that
      // response was in flight belongs to the next save, never to the receipt.
      const unchanged = content(current.draft) === content(attempt);
      const draft = { ...saved, clientIntentId, documentId, ...(!unchanged ? {
        body: current.draft.body, ...(current.draft.title === undefined ? {} : { title: current.draft.title }),
      } : {}) };
      const next = { ...current, draft, savedContent: content(saved), dirty: content(draft) !== content(saved), saving: false, error: "", conflict: false, unconfirmed: false, pendingAttempt: null, needsAck: true };
      // A workspace refresh may publish a newly created row before its save
      // callback returns. Keep this editor's stable key and remove that twin.
      for (const [otherKey, other] of records) if (otherKey !== key && other.draft.id === saved.id && !other.dirty && !other.saving) records.delete(otherKey);
      records.set(key, next); latest.set(saved.id, saved);
      // Keep the durable command receipt until the draft carries the confirmed
      // identity/version on disk. Failed persistence never discards that proof.
      try {
        await settleReceipt(key);
      } catch (error) { storageError = failureText(error); }
      receive([...latest.values()]);
      return saved;
    }).catch((error) => {
      const current = records.get(key);
      const definitive = error?.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
      if (current) records.set(key, { ...current, saving: false, error: failureText(error), unconfirmed: !definitive,
        pendingAttempt: definitive ? null : current.pendingAttempt, conflict: error?.code === "REVISION_CONFLICT" || current.conflict });
      if (definitive) receive([...latest.values()]);
      persistQuietly(); emit();
      return null;
    }).finally(() => {
      operations.delete(key);
      schedule(key);
    });
    operations.set(key, operation);
    return operation;
  }
  function copyAsNew(key, { suspended = false } = {}) {
    const record = records.get(key);
    if (!record || record.saving || !canWrite) return null;
    const draft = freshCopy(record.draft, createId), nextKey = "draft:" + draft.clientIntentId;
    records.set(nextKey, { key: nextKey, draft, savedContent: null, dirty: true, saving: false, error: "", conflict: false, suspended });
    persistQuietly(); emit();
    if (!suspended) void saveRecord(nextKey);
    return nextKey;
  }
  function useLatest(key, note) {
    const record = records.get(key);
    if (!record || record.saving || note?.id !== record.draft.id || !isNote(note, documentId)) throw new Error("最新笔记无法读取，当前草稿仍保留。");
    const backupKey = copyAsNew(key, { suspended: true });
    if (!backupKey || storageError) throw new Error(storageError || "无法保留当前草稿，请重试。");
    // Confirm the backup before replacing the visible editor contents.
    persist({ durable: true });
    install(note, key); latest.set(note.id, note);
    persistQuietly(); emit();
    return backupKey;
  }
  function beginArchive(key) {
    const record = records.get(key);
    if (!record?.draft.id || record.dirty || record.saving || record.unconfirmed || !canWrite) return false;
    clearTimer(key);
    records.set(key, { ...record, archiving: true, archiveError: "" });
    persist({ durable: true }); emit(); return true;
  }
  function archiveFailed(key, error) {
    const record = records.get(key);
    if (!record) return;
    const definitive = error?.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
    records.set(key, { ...record, archiving: !definitive, archiveError: failureText(error) });
    persistQuietly(); emit();
  }
  function remove(key, receipt) {
    if (receipt?.id && receipt.archivedAt) {
      // Undo needs the immutable entity/version guard; the full archived body
      // remains in SQLite and is returned by restore, not duplicated in storage.
      const { id, documentId: article, version, archivedAt, reference, title, type } = receipt;
      archived = [...archived.filter((note) => note.id !== id), { id, documentId: article, version, archivedAt, reference, title, type }];
    }
    clearTimer(key); records.delete(key); persistQuietly(); emit();
  }
  function restore(note) { archived = archived.filter((item) => item.id !== note.id); const key = install(note); latest.set(note.id, note); persistQuietly(); emit(); return key; }
  function flush() { persist({ durable: true }); }
  function start() {
    active = true;
    if (storage && typeof storage === "object") {
      if (!mountedOwners.has(storage)) mountedOwners.set(storage, new Map());
      mountedOwners.get(storage).set(storageKey, owner);
    }
    for (const key of records.keys()) schedule(key);
  }
  function stop() {
    active = false; for (const key of scheduled.keys()) clearTimer(key); persistQuietly();
    const owners = storage && mountedOwners.get(storage);
    if (owners?.get(storageKey) === owner) owners.delete(storageKey);
  }
  function setWritable(value) { canWrite = value; for (const key of records.keys()) schedule(key); }
  return { subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, getSnapshot: () => snapshot,
    create, edit, save: saveRecord, copyAsNew, useLatest, beginArchive, archiveFailed, remove, restore, receive, flush, start, stop, setWritable,
    get: (key) => records.get(key), storageKey };
}
