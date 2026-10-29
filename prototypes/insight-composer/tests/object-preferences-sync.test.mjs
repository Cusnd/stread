import test from "node:test";
import assert from "node:assert/strict";
import { createObjectPreferenceSync, objectOutboxKey } from "../src/object-preferences-sync.js";
import { objectPreferencesKey } from "../src/object-preferences.js";

function storage() {
  const map = new Map();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}
function harness(initial = {}) {
  let objects = structuredClone(initial);
  const receipts = new Map(), calls = [], local = storage(), pending = storage();
  const read = async () => ({ documentId: "paper", objects: structuredClone(objects) });
  const write = async (command) => {
    calls.push(structuredClone(command));
    if (receipts.has(command.requestId)) return receipts.get(command.requestId);
    for (const [id, patch] of Object.entries(command.objects)) {
      if (command.onlyIfAbsent && Object.hasOwn(objects, id)) continue;
      objects[id] = { widthPercent: null, fontSize: null, ...objects[id], ...patch };
    }
    const result = await read(); receipts.set(command.requestId, result); return result;
  };
  return { local, pending, calls, read, write, remote: (id, patch) => { objects[id] = { ...objects[id], ...patch }; },
    create: (options = {}) => createObjectPreferenceSync({ documentId: "paper", sessionKey: "paper:html-table3", documentRevision: 2, storage: local, pendingStorage: pending, read, write, ...options }) };
}

test("legacy imports only fill missing objects and cannot resurrect a server reset", async () => {
  const h = harness({ table: { widthPercent: null, fontSize: null } });
  h.local.setItem(objectPreferencesKey("paper:html-table3"), JSON.stringify({ table: { widthPercent: 160, fontSize: 25 }, image: { widthPercent: 130, fontSize: 18 } }));
  const sync = h.create(); await sync.sync();
  assert.deepEqual(sync.getSnapshot().objects, { table: { widthPercent: null, fontSize: null }, image: { widthPercent: 130, fontSize: 18 } });
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].onlyIfAbsent, true); assert.deepEqual(Object.keys(h.calls[0].objects), ["image"]);
  const cleanBrowser = h.create({ storage: storage(), pendingStorage: storage() }); await cleanBrowser.sync();
  assert.deepEqual(cleanBrowser.getSnapshot().objects, sync.getSnapshot().objects);
});

test("an edit made during initial loading survives hydration and sends only the edited field", async () => {
  const h = harness({ table: { widthPercent: 110, fontSize: 18 } });
  let finishRead;
  const sync = h.create({ read: async () => { if (!finishRead) await new Promise((resolve) => { finishRead = resolve; }); return h.read(); } });
  const loading = sync.sync(); sync.update("table", { widthPercent: 145 }); finishRead(); await loading;
  assert.deepEqual(sync.getSnapshot().objects.table, { widthPercent: 145, fontSize: 18 });
  assert.deepEqual(h.calls[0].objects.table, { widthPercent: 145 });
});

test("edits coalesce, width and font merge across clients, and reset stores explicit defaults", async () => {
  const h = harness({ table: { widthPercent: 110, fontSize: 18 }, other: { widthPercent: 90, fontSize: 14 } });
  const sync = h.create(); await sync.sync();
  sync.update("table", { widthPercent: 120 }); sync.update("table", { widthPercent: 125 });
  h.remote("table", { fontSize: 22 }); await sync.sync();
  assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].objects, { table: { widthPercent: 125 } });
  assert.deepEqual(sync.getSnapshot().objects.table, { widthPercent: 125, fontSize: 22 });
  sync.update("table", { widthPercent: null, fontSize: null }); await sync.sync();
  assert.deepEqual(sync.getSnapshot().objects.table, { widthPercent: null, fontSize: null });
  assert.deepEqual(sync.getSnapshot().objects.other, { widthPercent: 90, fontSize: 14 });
});

test("lost responses retain an idempotent outbox through reload without replaying over later remote edits", async () => {
  const h = harness({ table: { widthPercent: 100, fontSize: 18 } });
  const sync = h.create({ write: async (command) => { await h.write(command); throw new Error("Connection lost"); } });
  await sync.sync(); sync.update("table", { widthPercent: 125 }); await sync.sync();
  assert.equal(sync.getSnapshot().status, "error");
  assert.ok(JSON.parse(h.pending.getItem(objectOutboxKey("paper"))).inFlight.requestId);
  h.remote("table", { fontSize: 23, widthPercent: 140 });
  const resumed = h.create(); await resumed.sync();
  assert.equal(h.calls[0].requestId, h.calls[1].requestId);
  assert.deepEqual(resumed.getSnapshot().objects.table, { widthPercent: 140, fontSize: 23 });
  assert.equal(resumed.getSnapshot().status, "saved");
  assert.equal(JSON.parse(h.pending.getItem(objectOutboxKey("paper"))).inFlight, null);
});

test("a newer edit remains visible while an older write is in flight", async () => {
  const h = harness({ table: { widthPercent: 100, fontSize: 18 } });
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const sync = h.create({ write: async (command) => { if (!release) { entered(); await new Promise((resolve) => { release = resolve; }); } return h.write(command); } });
  await sync.sync(); sync.update("table", { widthPercent: 120 }); const saving = sync.sync(); await started;
  sync.update("table", { widthPercent: 150, fontSize: 16 });
  assert.deepEqual(sync.getSnapshot().objects.table, { widthPercent: 150, fontSize: 16 });
  release(); await saving;
  assert.deepEqual(sync.getSnapshot().objects.table, { widthPercent: 150, fontSize: 16 });
  assert.equal(h.calls.length, 2);
});

test("blocked browser storage still permits server saves and fresh remote reads", async () => {
  const h = harness();
  const blocked = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } };
  const sync = h.create({ storage: blocked, pendingStorage: blocked }); await sync.sync();
  sync.update("image", { widthPercent: 140 }); await sync.sync();
  assert.equal(sync.getSnapshot().status, "saved");
  h.remote("image", { fontSize: 20 }); await sync.sync();
  assert.deepEqual(sync.getSnapshot().objects.image, { widthPercent: 140, fontSize: 20 });
});
