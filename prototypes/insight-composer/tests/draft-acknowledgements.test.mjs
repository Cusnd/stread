import test from "node:test";
import assert from "node:assert/strict";
import { createDraftAcknowledgements } from "../src/draft-acknowledgements.js";
import { createCommandIntentClient } from "../src/command-intents.js";

function memoryStorage(events = []) {
  const values = new Map();
  return { get length() { return values.size; }, key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { events.push(["session", key, value]); values.set(key, value); },
    removeItem: (key) => values.delete(key) };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise((done) => setImmediate(done));
const key = "reader-draft:document";
const draft = { clientIntentId: "draft-intent", id: null, body: "Keep this draft" };
const saved = { id: "insight-1", version: 1 };

test("a successful save is retained through the close animation, then acknowledged after desktop disk persistence", async () => {
  const events = [], storage = memoryStorage(events);
  const cleanup = createDraftAcknowledgements({ acknowledge: async (id, expected) => { events.push(["ack", id, expected]); return true; } });
  const desktop = { persistSessionNow() { events.push(["disk"]); return { ok: true }; } };
  cleanup.markSaved(draft.clientIntentId, saved);
  await cleanup.persist({ draft, storage, key, desktop });
  assert.equal(cleanup.pendingCount(), 1);
  assert.deepEqual(events.map(([kind]) => kind), ["session"]);
  await cleanup.persist({ draft: null, storage, key, desktop });
  assert.deepEqual(events.slice(1).map(([kind]) => kind), ["session", "disk", "ack"]);
  assert.deepEqual(events.at(-1), ["ack", draft.clientIntentId, saved]);
  assert.equal(storage.getItem(key), "null");
  assert.equal(cleanup.pendingCount(), 0);
});

test("editing during a save permits cleanup only after the saved entity id and version are durable", async () => {
  const calls = [], storage = memoryStorage();
  const cleanup = createDraftAcknowledgements({ acknowledge: async (...args) => { calls.push(args); return true; } });
  cleanup.markSaved(draft.clientIntentId, { ...saved, version: 2 });
  for (const current of [{ ...draft, body: "Edited" }, { ...draft, id: "wrong", version: 2 }, { ...draft, ...saved, body: "Edited" }]) {
    await cleanup.persist({ draft: current, storage, key });
    assert.equal(calls.length, 0);
  }
  const current = { ...draft, id: saved.id, version: 2, body: "Edited after save began" };
  await cleanup.persist({ draft: current, storage, key });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(storage.getItem(key)), current);
  assert.equal(cleanup.pendingCount(), 0);
});

test("a new draft can replace the saved draft without losing either body's identity", async () => {
  const storage = memoryStorage(), calls = [];
  const cleanup = createDraftAcknowledgements({ acknowledge: async (id) => { calls.push(id); return true; } });
  cleanup.markSaved(draft.clientIntentId, saved);
  const next = { ...draft, clientIntentId: "new-intent", body: "A separate unsaved thought" };
  await cleanup.persist({ draft: next, storage, key });
  assert.deepEqual(calls, [draft.clientIntentId]);
  assert.deepEqual(JSON.parse(storage.getItem(key)), next);
});

test("sessionStorage failure retains the command and does not attempt a desktop flush or acknowledgement", async () => {
  let calls = 0, flushes = 0;
  const cleanup = createDraftAcknowledgements({ acknowledge: async () => { calls++; return true; } });
  cleanup.markSaved(draft.clientIntentId, saved);
  const desktop = { persistSessionNow() { flushes++; return { ok: true }; } };
  assert.throws(() => cleanup.persist({ draft: null, key, desktop, storage: { setItem() { throw new Error("quota"); } } }), /quota/);
  assert.equal(calls, 0); assert.equal(flushes, 0); assert.equal(cleanup.pendingCount(), 1);
  await cleanup.persist({ draft: null, key, desktop, storage: memoryStorage() });
  assert.equal(calls, 1); assert.equal(flushes, 1); assert.equal(cleanup.pendingCount(), 0);
});

test("a failed or unavailable desktop disk acknowledgement retains the intent", async () => {
  const storage = memoryStorage();
  let calls = 0;
  const cleanup = createDraftAcknowledgements({ acknowledge: async () => { calls++; return true; } });
  cleanup.markSaved(draft.clientIntentId, saved);
  for (const desktop of [{}, { persistSessionNow() {} }, { persistSessionNow() { return { ok: false }; } }, { persistSessionNow() { throw new Error("disk full"); } }]) {
    assert.throws(() => cleanup.persist({ draft: null, storage, key, desktop }));
    assert.equal(calls, 0); assert.equal(cleanup.pendingCount(), 1);
  }
  await cleanup.persist({ draft: null, storage, key, desktop: { persistSessionNow: () => ({ ok: true }) } });
  assert.equal(calls, 1); assert.equal(cleanup.pendingCount(), 0);
});

test("failed command-record cleanup is retried on a later successful draft persistence", async () => {
  const storage = memoryStorage();
  let attempts = 0;
  const cleanup = createDraftAcknowledgements({ acknowledge: async () => {
    attempts++;
    if (attempts === 1) throw new Error("localStorage unavailable");
    return attempts > 2;
  } });
  cleanup.markSaved(draft.clientIntentId, saved);
  assert.equal((await cleanup.persist({ draft: null, storage, key })).pending, 1);
  assert.equal((await cleanup.persist({ draft: null, storage, key })).pending, 1);
  assert.equal((await cleanup.persist({ draft: null, storage, key })).pending, 0);
  assert.equal(attempts, 3);
});

test("a prior in-flight acknowledgement cannot remove a later save from the pending set", async () => {
  const gate = deferred(), storage = memoryStorage(), calls = [];
  const cleanup = createDraftAcknowledgements({ acknowledge: async (_intent, expected) => {
    calls.push(expected.version);
    if (expected.version === 1) await gate.promise;
    return true;
  } });
  cleanup.markSaved(draft.clientIntentId, saved);
  const first = cleanup.persist({ draft: null, storage, key });
  await tick();
  cleanup.markSaved(draft.clientIntentId, { ...saved, version: 2 });
  gate.resolve(); await first;
  assert.deepEqual(calls, [1]);
  assert.equal(cleanup.pendingCount(), 1);
  await cleanup.persist({ draft: { ...draft, ...saved, version: 2 }, storage, key });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(cleanup.pendingCount(), 0);
});

test("a newer version persisted during pending cleanup is acknowledged after the old attempt settles", async () => {
  const gate = deferred(), storage = memoryStorage(), calls = [];
  const cleanup = createDraftAcknowledgements({ acknowledge: async (_intent, expected) => {
    calls.push(expected.version);
    if (expected.version === 1) { await gate.promise; return false; }
    return true;
  } });
  cleanup.markSaved(draft.clientIntentId, saved);
  const first = cleanup.persist({ draft: null, storage, key });
  await tick();
  cleanup.markSaved(draft.clientIntentId, { ...saved, version: 2 });
  const next = cleanup.persist({ draft: { ...draft, ...saved, version: 2 }, storage, key });
  gate.resolve(); await Promise.all([first, next]);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(cleanup.pendingCount(), 0);
});

test("command acknowledgement checks expected identity/version after acquiring its lock", async () => {
  const storage = memoryStorage();
  let version = 0, holdNext = false, release;
  const client = createCommandIntentClient({ storage, send: async () => ({ insight: { ...saved, version: ++version } }),
    withLock: (_key, action) => {
      if (!holdNext) return action();
      holdNext = false;
      return new Promise((done) => { release = () => done(action()); });
    } });
  const input = { kind: "insight.save", documentId: "document", insight: { body: "first" } };
  await client.execute(input, { intentId: draft.clientIntentId });
  holdNext = true;
  const oldAck = client.acknowledgeDraft(draft.clientIntentId, saved);
  await client.execute({ ...input, insight: { body: "second" } }, { intentId: draft.clientIntentId });
  release();
  assert.equal(await oldAck, false);
  assert.equal(storage.length, 1);
  assert.equal(await client.acknowledgeDraft(draft.clientIntentId, { id: "other", version: 2 }), false);
  assert.equal(await client.acknowledgeDraft(draft.clientIntentId, { ...saved, version: 2 }), true);
  assert.equal(storage.length, 0);
});

test("ordinary successful draft saves remove their confirmed command records after persistence", async () => {
  const commandStorage = memoryStorage(), sessionStorage = memoryStorage();
  let serial = 0;
  const client = createCommandIntentClient({ storage: commandStorage,
    send: async () => ({ insight: { id: "saved-" + (++serial), version: 1 } }) });
  const cleanup = createDraftAcknowledgements({ acknowledge: client.acknowledgeDraft });
  for (let index = 0; index < 30; index++) {
    const intentId = "draft-" + index;
    const result = await client.execute({ kind: "insight.save", documentId: "document", insight: { body: "Thought " + index } }, { intentId });
    cleanup.markSaved(intentId, result.insight);
    await cleanup.persist({ draft: null, storage: sessionStorage, key });
    assert.equal(commandStorage.length, 0);
    assert.equal(cleanup.pendingCount(), 0);
  }
  assert.equal(serial, 30);
});
