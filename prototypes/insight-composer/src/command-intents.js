const PREFIX = "continuous-reader:command-intents:v1:";
const clone = (value) => JSON.parse(JSON.stringify(value));
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const browserStorage = () => { try { return globalThis.localStorage; } catch { return undefined; } };
const entityFields = { "insight.save": "insight", "change_request.save": "changeRequest" };
const definitive = (error) => error?.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);

function intentError(message, code) {
  return Object.assign(new Error(message), { code });
}

// A local draft identity is independent of the persisted insight/request ID.
// Keep it with the draft; do not add it to an author's document or insight data.
export function ensureDraftIntent(draft, createId = () => crypto.randomUUID()) {
  if (!draft) return draft;
  return typeof draft.clientIntentId === "string" && draft.clientIntentId
    ? draft : { ...draft, clientIntentId: createId() };
}

function cleanCommand(command) {
  const copy = clone(command);
  const field = entityFields[copy.kind];
  if (field && copy[field]) delete copy[field].clientIntentId;
  return copy;
}

/**
 * Keeps immutable, unacknowledged commands across a reload. Draft saves have an
 * explicit identity: after an unknown result, replay the original command first,
 * then apply any changed input to the returned entity using its write version.
 * Call acknowledgeDraft only after the caller has durably removed the draft or
 * recorded the returned entity ID/version. Unknown commands are never discarded.
 */
export function createCommandIntentClient({ send, storage, createId = () => crypto.randomUUID(), withLock } = {}) {
  if (typeof send !== "function") throw new TypeError("send is required");
  const getStorage = () => typeof storage === "function" ? storage() : storage === undefined ? browserStorage() : storage;
  const pending = new Map(), requests = new Map(), drafts = new Map(), operations = new Map();
  const lock = withLock || ((key, action) => globalThis.navigator?.locks?.request
    ? globalThis.navigator.locks.request(PREFIX + key, action) : action());

  function read(key) {
    try {
      const value = JSON.parse(getStorage()?.getItem(PREFIX + key) || "null");
      return value?.v === 1 ? value : null;
    } catch { return null; }
  }
  function write(key, value, required = false) {
    try {
      const target = getStorage();
      if (!target) { if (required) throw new Error("Persistent storage is unavailable"); return false; }
      target.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch (error) {
      if (required) throw intentError("无法保留本次保存请求，请检查本地存储后重试。输入内容仍保留。", "COMMAND_INTENT_STORAGE");
      return false;
    }
  }
  function remove(key) {
    try { const target = getStorage(); if (!target) return false; target.removeItem(PREFIX + key); return true; } catch { return false; }
  }
  function findPending(key) {
    if (pending.has(key)) return pending.get(key);
    try {
      const target = getStorage();
      for (let index = 0; index < (target?.length || 0); index++) {
        const itemKey = target.key(index);
        if (!itemKey?.startsWith(PREFIX + "request:")) continue;
        const value = read(itemKey.slice(PREFIX.length));
        if (value?.key === key && typeof value.command?.requestId === "string") {
          pending.set(key, value.command);
          return value.command;
        }
      }
    } catch { /* The current page still retains its in-memory retry command. */ }
    return null;
  }

  function executeOrdinary(input) {
    const command = cleanCommand(input), key = canonical(command);
    const existing = findPending(key);
    const immutable = existing || { ...command, requestId: command.requestId || createId() };
    if (requests.has(immutable.requestId)) return requests.get(immutable.requestId);
    pending.set(key, immutable);
    write("request:" + immutable.requestId, { v: 1, key, command: immutable });
    const operation = Promise.resolve().then(() => send(clone(immutable))).then((result) => {
      pending.delete(key); remove("request:" + immutable.requestId);
      return result;
    }, (error) => {
      if (definitive(error)) { pending.delete(key); remove("request:" + immutable.requestId); }
      throw error;
    }).finally(() => requests.delete(immutable.requestId));
    requests.set(immutable.requestId, operation);
    return operation;
  }

  function loadDraft(intentId) {
    let raw;
    try { raw = getStorage()?.getItem(PREFIX + "draft:" + intentId); }
    catch { throw intentError("无法读取草稿的保存记录，请检查本地存储后重试。", "COMMAND_INTENT_STORAGE"); }
    if (raw == null) return drafts.get(intentId) || null;
    try {
      const value = JSON.parse(raw), field = entityFields[value?.kind];
      if (value?.v !== 1 || value.intentId !== intentId || !field || typeof value.documentId !== "string"
        || (value.pending && (typeof value.pending.desiredKey !== "string" || typeof value.pending.command?.requestId !== "string"
          || value.pending.command.kind !== value.kind || value.pending.command.documentId !== value.documentId))
        || (value.confirmed && (typeof value.confirmed.desiredKey !== "string" || !value.confirmed.result?.[field]?.id
          || !Number.isInteger(value.confirmed.result[field].version)))) throw new Error("Invalid record");
      return value;
    } catch {
      // Do not turn an unreadable unknown outcome into a new create command.
      throw intentError("草稿的保存记录无法识别，原始记录和输入均已保留，请恢复本地记录后重试。", "COMMAND_INTENT_STORAGE_RECORD");
    }
  }
  function storeDraft(intentId, value, required = false) {
    // Write before changing the in-memory record when durability is required.
    // Otherwise a failed preflight could accidentally send on the next retry.
    const persisted = write("draft:" + intentId, value, required);
    drafts.set(intentId, value);
    return persisted;
  }
  async function saveDraft(intentId, input) {
    const desired = cleanCommand(input); delete desired.requestId;
    const field = entityFields[desired.kind];
    if (!field || !desired.documentId || !desired[field]) throw new TypeError("A draft save command is required");
    const desiredKey = canonical(desired);
    let record = loadDraft(intentId) || { v: 1, intentId, kind: desired.kind, documentId: desired.documentId, pending: null, confirmed: null };
    if (record.kind !== desired.kind || record.documentId !== desired.documentId) {
      throw intentError("此草稿保存请求属于其他内容，请重新打开草稿。", "COMMAND_INTENT_CONFLICT");
    }
    const confirm = async () => {
      const attempt = record.pending;
      let result;
      try { result = await send(clone(attempt.command)); }
      catch (error) {
        if (definitive(error)) {
          record = { ...record, pending: null };
          storeDraft(intentId, record);
        }
        throw error;
      }
      if (!result?.[field]?.id || !Number.isInteger(result[field].version)) {
        throw intentError("保存结果尚未确认，请重试；本次请求和输入已保留。", "COMMAND_INTENT_UNKNOWN");
      }
      record = { ...record, pending: null, confirmed: { desiredKey: attempt.desiredKey, result } };
      // If this write fails, the durable original pending command can still be
      // replayed safely. Do not replace a successful server result with failure.
      storeDraft(intentId, record);
      return result;
    };
    if (record.pending) await confirm();
    if (record.confirmed?.desiredKey === desiredKey) return clone(record.confirmed.result);

    const command = clone(desired), saved = record.confirmed?.result?.[field];
    if (saved) {
      if (command[field].id && command[field].id !== saved.id) {
        throw intentError("此草稿已经保存为另一条内容，请重新打开后编辑。", "COMMAND_INTENT_CONFLICT");
      }
      command[field].id = saved.id;
      command.expectedVersion = Math.max(command.expectedVersion || 0, saved.version);
    }
    command.requestId = createId();
    record = { ...record, pending: { desiredKey, command } };
    storeDraft(intentId, record, true);
    return confirm();
  }

  function execute(command, { intentId } = {}) {
    if (!intentId) return executeOrdinary(command);
    if (typeof intentId !== "string" || intentId.length > 200) throw new TypeError("Invalid draft intent ID");
    const input = cleanCommand(command);
    const previous = operations.get(intentId);
    const operation = Promise.resolve(previous).catch(() => {}).then(() => lock("draft:" + intentId, () => saveDraft(intentId, input)));
    operations.set(intentId, operation);
    return operation.finally(() => { if (operations.get(intentId) === operation) operations.delete(intentId); });
  }
  async function acknowledgeDraft(intentId, expected) {
    if (!intentId || operations.has(intentId)) return false;
    return lock("draft:" + intentId, () => {
      const record = loadDraft(intentId);
      if (!record?.confirmed || record.pending || operations.has(intentId)) return false;
      const saved = record.confirmed.result?.[entityFields[record.kind]];
      // A cleanup waiting on another window's lock must not remove a newer save
      // whose returned identity/version has not yet been durably acknowledged.
      if (expected && (saved?.id !== expected.id || saved?.version !== expected.version)) return false;
      if (!remove("draft:" + intentId)) return false;
      drafts.delete(intentId);
      return true;
    });
  }
  async function settle() {
    const errors = [];
    while (requests.size || operations.size) {
      const results = await Promise.allSettled([...requests.values(), ...operations.values()]);
      errors.push(...results.filter((result) => result.status === "rejected").map((result) => result.reason));
    }
    return { pending: requests.size + operations.size, errors };
  }
  return { execute, acknowledgeDraft, settle };
}
