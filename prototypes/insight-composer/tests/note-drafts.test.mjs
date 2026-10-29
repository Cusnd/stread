import test from "node:test";
import assert from "node:assert/strict";
import { createNoteDraftStore, NOTE_BODY_LIMIT } from "../src/notes/note-drafts.js";
import { createCommandIntentClient } from "../src/command-intents.js";

const note = (id = "note-a", extra = {}) => ({ id, documentId: "article-a", type: "note", title: "A note", body: "Original body", color: "amber", version: 1, revision: 1, reference: "#N00001", ...extra });
function memory(initial = []) {
  const values = new Map(initial);
  return { values, get length() { return values.size; }, key: (index) => [...values.keys()][index], getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
function clock() {
  let id = 0; const pending = new Map();
  return { setTimeout(fn) { const key = ++id; pending.set(key, fn); return key; }, clearTimeout(key) { pending.delete(key); }, run() { const tasks = [...pending.values()]; pending.clear(); tasks.forEach((fn) => fn()); }, get size() { return pending.size; } };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  let id = 0; const storage = options.storage || memory(), timers = clock(), calls = [], acknowledgements = [];
  const store = createNoteDraftStore({ documentId: "article-a", revision: 1, notes: [note()], storage, timers, createId: () => "intent-" + ++id,
    save: async (input, opts) => { calls.push({ input, opts }); return { ...input, id: input.id || "created-note", version: (input.version || 0) + 1, reference: input.reference || "#N00002" }; },
    acknowledge: async (intent, saved) => { acknowledgements.push({ intent, saved }); return true; }, ...options });
  return { store, storage, timers, calls, acknowledgements };
}

test("blank new notes remain drafts; clean articles do not duplicate all bodies in session storage", async () => {
  const h = fixture({ notes: Array.from({ length: 30 }, (_, index) => note("note-" + index, { body: "x".repeat(NOTE_BODY_LIMIT) })) });
  h.store.start(); h.store.flush();
  assert.ok(h.storage.getItem(h.store.storageKey).length < 100);
  const key = h.store.create();
  h.store.edit(key, { title: "Only a title" });
  assert.equal(await h.store.save(key), null);
  h.timers.run();
  assert.equal(h.calls.length, 0);
  const restored = fixture({ storage: h.storage, notes: [] }).store;
  assert.equal(restored.get(key).draft.title, "Only a title");
  assert.equal(restored.get(key).draft.clientIntentId, h.store.get(key).draft.clientIntentId);
});

test("a response never overwrites input typed in flight and the next save uses the returned version", async () => {
  const pending = deferred(), calls = [];
  const h = fixture({ save: async (input, options) => { calls.push({ input, options }); return calls.length === 1 ? pending.promise : { ...input, version: 3 }; } });
  h.store.start(); h.store.edit("note-a", { body: "First edit" });
  const saving = h.store.save("note-a");
  await Promise.resolve();
  h.store.edit("note-a", { body: "Continued typing" });
  pending.resolve(note("note-a", { body: "First edit", version: 2 }));
  await saving;
  assert.equal(h.store.get("note-a").draft.body, "Continued typing");
  assert.equal(h.store.get("note-a").draft.version, 2);
  assert.equal(h.store.get("note-a").dirty, true);
  assert.equal(h.timers.size, 1);
  await h.store.save("note-a");
  assert.equal(calls[1].input.version, 2);
  assert.equal(calls[1].input.body, "Continued typing");
  assert.equal(calls[0].options.intentId, calls[1].options.intentId);
  assert.equal(h.store.get("note-a").dirty, false);
});

test("normalization of an unchanged title settles instead of creating an endless autosave", async () => {
  const h = fixture({ save: async (input) => ({ ...input, title: input.title.trim(), version: 2 }) });
  h.store.start(); h.store.edit("note-a", { title: "  New title  " });
  await h.store.save("note-a");
  assert.equal(h.store.get("note-a").draft.title, "New title");
  assert.equal(h.store.get("note-a").dirty, false);
  assert.equal(h.timers.size, 0);
});

test("refresh before a new save receipt preserves one editor and releases external notes afterwards", async () => {
  const pending = deferred();
  const h = fixture({ notes: [], save: () => pending.promise });
  const key = h.store.create(); h.store.edit(key, { body: "A new note" });
  const operation = h.store.save(key); await Promise.resolve();
  const saved = note("new-id", { body: "A new note", title: "" });
  h.store.receive([saved, note("external-id")]);
  assert.equal(h.store.getSnapshot().records.length, 1);
  pending.resolve(saved); await operation;
  assert.equal(h.store.get(key).draft.id, "new-id");
  assert.equal(h.store.getSnapshot().records.filter((record) => record.draft.id === "new-id").length, 1);
  assert.equal(h.store.getSnapshot().records.some((record) => record.draft.id === "external-id"), true);
});

test("unknown create outcome survives refresh/reload and exact retry creates only one server note", async () => {
  const storage = memory(), receipts = new Map(); let serverNote, sent = 0, lost = true, requestId = 0;
  const client = createCommandIntentClient({ storage, createId: () => "request-" + ++requestId, withLock: (_key, task) => task(), send: async (command) => {
    sent++;
    if (receipts.has(command.requestId)) return receipts.get(command.requestId);
    serverNote = { ...command.insight, id: "server-id", version: 1, reference: "#N00001" };
    const result = { insight: serverNote }; receipts.set(command.requestId, result);
    if (lost) { lost = false; throw new Error("Lost response"); }
    return result;
  } });
  const options = { storage, notes: [], save: (insight, opts) => client.execute({ kind: "insight.save", documentId: "article-a", insight, ...(insight.version ? { expectedVersion: insight.version } : {}) }, opts).then((result) => result.insight), acknowledge: client.acknowledgeDraft };
  let h = fixture(options);
  const key = h.store.create(); h.store.edit(key, { body: "Durable note" });
  await h.store.save(key);
  h.store.receive([serverNote]);
  assert.equal(h.store.get(key).conflict, false);
  assert.equal(h.store.get(key).unconfirmed, true);
  assert.equal(h.store.getSnapshot().records.length, 1);
  h = fixture({ ...options, notes: [serverNote] });
  await h.store.save(key);
  assert.equal(receipts.size, 1);
  assert.equal(sent, 2);
  assert.equal(h.store.getSnapshot().records.length, 1);
  assert.equal(h.store.get(key).draft.id, "server-id");
  assert.equal(h.store.get(key).dirty, false);
});

test("unknown update outcome is not mistaken for an external version conflict", async () => {
  let attempts = 0;
  const h = fixture({ save: async (input) => { if (++attempts === 1) throw new Error("Unknown result"); return { ...input, version: 2 }; } });
  h.store.edit("note-a", { body: "Changed" }); await h.store.save("note-a");
  h.store.receive([note("note-a", { body: "Changed", version: 2 })]);
  assert.equal(h.store.get("note-a").conflict, false);
  await h.store.save("note-a");
  assert.equal(attempts, 2);
  assert.equal(h.store.get("note-a").draft.version, 2);
});

test("latest conflict content never replaces local text without a durable retained draft", async () => {
  const h = fixture();
  h.store.edit("note-a", { body: "My local words" });
  const updated = note("note-a", { body: "External version", version: 2 });
  h.store.receive([updated]);
  assert.equal(h.store.get("note-a").conflict, true);
  assert.equal(await h.store.save("note-a"), null);
  const backupKey = h.store.useLatest("note-a", updated);
  assert.equal(h.store.get("note-a").draft.body, "External version");
  assert.equal(h.store.get(backupKey).draft.body, "My local words");
  assert.equal(h.store.get(backupKey).draft.id, undefined);
  assert.equal(h.store.get(backupKey).suspended, true);
  h.store.start(); h.timers.run(); assert.equal(h.calls.length, 0);
  h.store.stop();
  const reloaded = fixture({ notes: [updated], storage: h.storage }).store;
  reloaded.start();
  assert.equal(reloaded.get(backupKey).draft.body, "My local words");
  await reloaded.save(backupKey, { resume: true });
  assert.equal(reloaded.get(backupKey).draft.id, "created-note");
});

test("confirmed receipts are retained until the returned identity/version is durable", async () => {
  let diskWrites = 0, failAfterSave = true; const acknowledged = [];
  const storage = memory();
  const h = fixture({ storage, notes: [], desktop: { persistSession() {}, persistSessionNow() { diskWrites++; if (diskWrites > 1 && failAfterSave) throw new Error("Disk unavailable"); return { ok: true }; } },
    acknowledge: async (intent, saved) => { const retained = JSON.parse(storage.getItem(h.store.storageKey)); assert.equal(retained.records[0].draft.id, saved.id); assert.equal(retained.records[0].draft.version, saved.version); acknowledged.push(intent); return true; } });
  const key = h.store.create(); h.store.edit(key, { body: "Durable identity" });
  await h.store.save(key);
  assert.equal(acknowledged.length, 0);
  assert.equal(h.store.get(key).needsAck, true);
  assert.match(h.store.getSnapshot().storageError, /Disk unavailable/);
  failAfterSave = false;
  await h.store.save(key);
  assert.equal(acknowledged.length, 1);
  assert.equal(h.store.get(key).needsAck, false);
  assert.equal(h.store.getSnapshot().storageError, "");
});

test("an old mounted store cannot replace new inputs after leaving and reentering during a save", async () => {
  const storage = memory(), pending = deferred(); let acknowledgements = 0;
  const old = fixture({ storage, save: () => pending.promise, acknowledge: async () => { acknowledgements++; return true; } });
  old.store.start(); old.store.edit("note-a", { body: "Old in-flight text" });
  const operation = old.store.save("note-a"); await Promise.resolve(); old.store.stop();
  const current = fixture({ storage }); current.store.start();
  current.store.edit("note-a", { body: "New page text" });
  pending.resolve(note("note-a", { body: "Old in-flight text", version: 2 }));
  await operation;
  const persisted = JSON.parse(storage.getItem(current.store.storageKey));
  assert.equal(persisted.records[0].draft.body, "New page text");
  assert.equal(current.store.get("note-a").draft.body, "New page text");
  assert.equal(acknowledgements, 0);
  current.store.stop();
});

test("unknown outcomes still confirm identity when the current editor is empty or restored to its baseline", async () => {
  let calls = 0;
  const h = fixture({ notes: [], save: async (input) => { if (++calls === 1) throw new Error("Lost reply"); return { ...input, id: "created-id", version: 1, reference: "#N00001" }; } });
  const key = h.store.create(); h.store.edit(key, { body: "Text that reached the server" });
  await h.store.save(key);
  h.store.edit(key, { body: "" });
  await h.store.save(key);
  assert.equal(calls, 2);
  assert.equal(h.store.get(key).draft.id, "created-id");
  assert.equal(h.store.get(key).draft.body, "");
  assert.equal(h.store.get(key).dirty, true);
  assert.equal(h.store.get(key).unconfirmed, false);

  let updates = 0;
  const existing = fixture({ save: async (input) => { if (++updates === 1) throw new Error("Lost reply"); return { ...input, version: 2 }; } });
  existing.store.edit("note-a", { body: "Submitted update" }); await existing.store.save("note-a");
  existing.store.edit("note-a", { body: "Original body" });
  assert.equal(existing.store.get("note-a").dirty, false);
  await existing.store.save("note-a");
  assert.equal(updates, 2);
  assert.equal(existing.store.get("note-a").draft.version, 2);
  assert.equal(existing.store.get("note-a").draft.body, "Original body");
  assert.equal(existing.store.get("note-a").dirty, true);
});

test("continuous archives retain every undo receipt across reloads", () => {
  const h = fixture({ notes: [note(), note("note-b")] });
  h.store.remove("note-a", note("note-a", { version: 2, archivedAt: "2026-10-25T00:00:00Z" }));
  h.store.remove("note-b", note("note-b", { version: 2, archivedAt: "2026-10-25T00:00:01Z" }));
  const reopened = fixture({ notes: [], storage: h.storage }).store;
  assert.deepEqual(reopened.getSnapshot().archived.map((item) => item.id), ["note-a", "note-b"]);
  reopened.restore(note("note-b", { version: 3 }));
  assert.deepEqual(reopened.getSnapshot().archived.map((item) => item.id), ["note-a"]);
});

test("an unknown archive stays retryable across refresh/reload and cannot discard new input", () => {
  const h = fixture();
  assert.equal(h.store.beginArchive("note-a"), true);
  h.store.edit("note-a", { body: "Typing after archive began" });
  assert.equal(h.store.get("note-a").draft.body, "Original body");
  h.store.archiveFailed("note-a", new Error("Lost archive response"));
  h.store.receive([]);
  assert.equal(h.store.get("note-a").archiving, true);
  const reopened = fixture({ notes: [], storage: h.storage }).store;
  assert.equal(reopened.get("note-a").draft.version, 1);
  assert.equal(reopened.beginArchive("note-a"), true);
  reopened.remove("note-a", note("note-a", { version: 2, archivedAt: "2026-10-25T00:00:00Z" }));
  assert.equal(reopened.getSnapshot().records.length, 0);
  assert.equal(reopened.getSnapshot().archived[0].version, 2);
  assert.equal(reopened.getSnapshot().archived[0].body, undefined);
});

test("unreadable persisted drafts are preserved rather than replaced", async () => {
  const storage = memory([["reader-notes-drafts:v1:article-a", "{malformed"]]);
  const h = fixture({ storage });
  h.store.edit("note-a", { body: "Still editable in memory" });
  await h.store.save("note-a");
  assert.equal(storage.getItem(h.store.storageKey), "{malformed");
  assert.equal(h.calls.length, 0);
  assert.match(h.store.getSnapshot().storageError, /原始记录已保留/);
});

test("body limits preserve input and read-only mode never submits autosaves", async () => {
  const h = fixture();
  h.store.start(); h.store.edit("note-a", { body: "x".repeat(NOTE_BODY_LIMIT + 1) });
  await h.store.save("note-a"); assert.equal(h.calls.length, 0);
  assert.equal(h.store.get("note-a").draft.body.length, NOTE_BODY_LIMIT + 1);
  h.store.edit("note-a", { body: "Valid body" }); await h.store.save("note-a");
  assert.equal(h.calls.length, 1);
  h.store.edit("note-a", { body: "A new draft" }); h.store.setWritable(false); h.timers.run();
  assert.equal(await h.store.save("note-a"), null);
  assert.equal(h.store.create(), null);
  assert.equal(h.calls.length, 1);
});
