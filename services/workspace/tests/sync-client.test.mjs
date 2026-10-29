import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createWorkspaceSyncClient, syncOptions } from "../sync-client.mjs";
import { SyncTransportError } from "../sync-http-client.mjs";

const connection = { origin: "https://reader.example", token: "local-sync-test-token-only" };
function fixture(t) {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  const events = [], state = { replicaId: "device-one", enrolled: false, cursor: 0 }, outbox = [], conflicts = [], local = new Map();
  const engine = {
    status: () => ({ ...state, pendingCount: outbox.length, conflictCount: conflicts.length }),
    capture() { events.push("capture"); },
    pending: () => ({ batches: outbox.slice(0, 1) }),
    acceptEnrollment(value) { events.push("enroll-accept"); assert.equal(value.replicaId, state.replicaId); state.enrolled = true; },
    acknowledge(receipt) { events.push("ack"); assert.equal(receipt.requestId, outbox[0].requestId); outbox.shift(); if (!receipt.accepted) conflicts.push(...receipt.conflicts); },
    applyPull(value) { events.push("apply"); state.cursor = value.nextCursor; },
    conflicts: () => conflicts,
    resolveConflict(value) { events.push("resolve"); return value; },
  };
  const resources = {
    read: async (hash) => { assert.ok(local.has(hash)); return local.get(hash); },
    has: async (hash) => local.has(hash),
    hasObject: async (ref) => local.has(ref.key),
    openObject: async function* (ref) { yield local.get(ref.key); },
    importObject: async (ref, bytes) => { events.push("store-object"); local.set(ref.key, bytes); },
    put: async (bytes) => { events.push("store-blob"); const sha256 = createHash("sha256").update(bytes).digest("hex"); local.set(sha256, bytes); return { sha256, size: bytes.length }; },
  };
  const transport = {
    manifest: async () => ({ protocolVersion: 1, workspaceId: "cloud-one", head: 0 }),
    enroll: async ({ replicaId }) => { events.push("enroll"); return { replicaId, referenceRanges: {}, cursor: 100 }; },
    hasObject: async () => false,
    uploadObject: async () => { events.push("upload"); },
    push: async (batch) => { events.push("push"); return { replicaId: batch.replicaId, requestId: batch.requestId, accepted: true, states: [] }; },
    pull: async ({ after }) => { events.push("pull"); return { transactions: [], objects: [], nextCursor: after, hasMore: false }; },
  };
  const batch = (objects = []) => ({ replicaId: state.replicaId, requestId: "durable-operation-one", mutations: [{ entity: "collections", key: "one", expected: { version: 0, hash: null }, value: { id: "one", label: "Saved offline" } }], objects });
  const create = (options = {}) => createWorkspaceSyncClient({ db: database, resources }, { ...connection, engine, transport, ...options });
  return { create, engine, transport, events, state, outbox, conflicts, local, batch, database };
}

test("offline writes and a lost response retain the same operation ID across client restart", async (t) => {
  const h = fixture(t); h.outbox.push(h.batch()); const sent = [];
  h.transport.push = async (batch) => { sent.push(batch.requestId); if (sent.length === 1) throw new SyncTransportError("SYNC_OFFLINE", "Offline"); return { replicaId: batch.replicaId, requestId: batch.requestId, accepted: true }; };
  const first = await h.create();
  await assert.rejects(first.runOnce(), { code: "SYNC_OFFLINE" });
  assert.equal(h.outbox.length, 1); assert.equal(first.status().lastError.code, "SYNC_OFFLINE");
  await first.stop(); const second = await h.create(); await second.runOnce();
  assert.deepEqual(sent, ["durable-operation-one", "durable-operation-one"]); assert.equal(h.outbox.length, 0);
  assert.equal(second.status().lastError, null); assert.ok(second.status().lastSuccessAt);
  const stored = h.database.prepare("SELECT value FROM sync_client_state").all().map((row) => row.value).join(" ");
  assert.ok(!stored.includes(connection.token), "long-lived credentials never enter the local sync state");
  await second.stop();
});

test("objects precede publication and downloaded content precedes the cursor commit", async (t) => {
  const h = fixture(t), bytes = Buffer.from('{"blocks":[]}'), sha256 = createHash("sha256").update(bytes).digest("hex");
  const ref = { key: `objects/sha256/${sha256}`, sha256, size: bytes.length, version: 1 };
  const blobRef = { ...ref, key: `blobs/${sha256}` };
  h.local.set(ref.key, bytes); h.outbox.push(h.batch([ref]));
  h.transport.manifest = async () => ({ protocolVersion: 1, workspaceId: "cloud-one", head: 10 });
  h.transport.downloadObject = async () => { h.events.push("download"); return bytes; };
  h.transport.pull = async ({ after }) => { h.events.push("pull"); assert.equal(after, 0, "enrollment head must never skip existing cloud data"); return { transactions: [], objects: [blobRef], nextCursor: 10, hasMore: false }; };
  const client = await h.create(); await client.runOnce();
  for (const [before, after] of [["upload", "push"], ["push", "ack"], ["download", "store-blob"], ["store-blob", "apply"]]) assert.ok(h.events.indexOf(before) < h.events.indexOf(after), `${before} precedes ${after}`);
  assert.equal(h.state.cursor, 10); assert.deepEqual(h.local.get(sha256), bytes); await client.stop();
});

test("remote identity changes cannot enroll or upload to a different workspace", async (t) => {
  const h = fixture(t), client = await h.create(); await client.runOnce(); h.outbox.push(h.batch()); h.events.length = 0;
  h.transport.manifest = async () => ({ protocolVersion: 1, workspaceId: "someone-else", head: 4 });
  await assert.rejects(client.runOnce(), { code: "SYNC_WORKSPACE_MISMATCH" });
  assert.deepEqual(h.events, ["capture"]); assert.equal(h.outbox.length, 1);
  await assert.rejects(h.create({ origin: "https://another.example" }), { code: "SYNC_WORKSPACE_MISMATCH" }); await client.stop();
});

test("a conflict receipt is retained and is exposed for explicit resolution", async (t) => {
  const h = fixture(t); h.outbox.push(h.batch());
  h.transport.push = async (batch) => ({ replicaId: batch.replicaId, requestId: batch.requestId, accepted: false, conflicts: [{ id: "conflict-one", localValue: "offline", actual: { version: 2, value: "remote" } }] });
  const client = await h.create(); await client.runOnce();
  assert.equal(client.conflicts()[0].localValue, "offline"); assert.equal(client.status().conflictCount, 1);
  assert.deepEqual(await client.resolveConflict({ id: "conflict-one", choice: "remote", expectedVersion: 2 }), { id: "conflict-one", choice: "remote", expectedVersion: 2 }); await client.stop();
});

test("one cycle captures each next committed group after acknowledgement and does not mark partial progress complete", async (t) => {
  const h = fixture(t), groups = ["group-one", "group-two", "group-three"], sent = [];
  h.engine.capture = () => { if (!h.outbox.length && groups.length) h.outbox.push({ ...h.batch(), requestId: groups.shift() }); };
  h.transport.push = async (batch) => { sent.push(batch.requestId); return { replicaId: batch.replicaId, requestId: batch.requestId, accepted: true, states: [] }; };
  const client = await h.create({ maxBatches: 2 }); await client.runOnce();
  assert.deepEqual(sent, ["group-one", "group-two"]); assert.equal(h.outbox[0].requestId, "group-three"); assert.equal(client.status().lastSuccessAt, null);
  await client.runOnce(); assert.deepEqual(sent, ["group-one", "group-two", "group-three"]); assert.ok(client.status().lastSuccessAt); await client.stop();
});

test("shutdown cancels network work and coalesces concurrent synchronization calls", async (t) => {
  const h = fixture(t);
  h.transport.manifest = ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new SyncTransportError("SYNC_CANCELLED", "Stopped")), { once: true }));
  const client = await h.create(), first = client.runOnce(); assert.equal(client.runOnce(), first);
  const rejected = assert.rejects(first, { code: "SYNC_CANCELLED" });
  await new Promise((done) => setImmediate(done)); await client.stop(); await rejected;
  assert.equal(client.status().lastError, null); assert.equal(h.events.filter((value) => value === "capture").length, 2);
  await assert.rejects(client.runOnce(), { code: "SYNC_CANCELLED" });
});

test("environment configuration is explicit and does not silently convert a partial setup", () => {
  assert.equal(syncOptions({}), null);
  assert.deepEqual(syncOptions({ CONTINUOUS_READER_SYNC_URL: connection.origin, CONTINUOUS_READER_SYNC_TOKEN: connection.token }), connection);
  assert.throws(() => syncOptions({ CONTINUOUS_READER_SYNC_URL: connection.origin }), { code: "SYNC_INVALID_CONFIGURATION" });
});

function scheduler() {
  let id = 0, now = Date.UTC(2025, 0, 1); const timers = new Map();
  const earliest = () => [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
  return { timers, now: () => now, random: () => 0.5,
    setTimer(fn, delay) { const key = ++id; timers.set(key, { fn, delay, at: now + delay }); return key; },
    clearTimer(key) { timers.delete(key); },
    async step() { const [key, value] = earliest(); timers.delete(key); const delay = value.at - now; now = value.at; await value.fn(); return delay; },
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (timers.size && earliest()[1].at <= target) { const [key, value] = earliest(); timers.delete(key); now = value.at; await value.fn(); }
      now = target;
    },
  };
}

test("minute receive probes and fixed send deadlines stay independent without durable scheduler writes", async (t) => {
  const h = fixture(t), clock = scheduler(); let probes = 0, wake;
  h.transport.manifest = async () => { probes++; return { protocolVersion: 1, workspaceId: "cloud-one", head: 0 }; };
  h.engine.onLocalCommit = (callback) => { wake = callback; return () => { wake = null; }; };
  const client = await h.create(clock); client.start();
  assert.equal(await clock.step(), 0); assert.equal(await clock.step(), 60000); assert.equal(await clock.step(), 60000); assert.equal(await clock.step(), 60000);
  assert.equal([...clock.timers.values()][0].delay, 60000);
  assert.equal(h.events.includes("pull"), false); assert.equal(probes, 4);
  const before = h.database.prepare("SELECT total_changes() AS n").get().n;
  await clock.step(); assert.equal(h.database.prepare("SELECT total_changes() AS n").get().n, before, "idle operational timestamps do not become durable writes");
  wake(); assert.equal([...clock.timers.values()][0].delay, 60000);
  const deadline = client.status().nextAttemptAt;
  await clock.advance(500); wake();
  assert.equal(client.status().nextAttemptAt, deadline, "another commit cannot postpone the original deadline");
  assert.equal([...clock.timers.values()][0].delay, 59500);
  assert.equal(h.database.prepare("SELECT total_changes() AS n").get().n, before, "commit notifications do not write cloud scheduler state");
  await client.stop(); assert.equal(wake, null); assert.equal(clock.timers.size, 0);
});

function recordingFixture(t, clock) {
  const h = fixture(t), start = clock.now(), sent = [], dirtyEvents = []; let checkpoint, wake, serial = 0, head = 0;
  h.state.enrolled = true;
  const originalStatus = h.engine.status;
  h.engine.status = () => ({ ...originalStatus(), dirty: dirtyEvents.length + Number(checkpoint !== undefined) });
  h.engine.onLocalCommit = (callback) => { wake = callback; return () => { wake = undefined; }; };
  h.engine.capture = () => {
    h.events.push("capture");
    if (h.outbox.length || (!dirtyEvents.length && checkpoint === undefined)) return;
    h.outbox.push({ ...h.batch(), requestId: "recording-" + ++serial, facts: dirtyEvents.splice(0), checkpoint });
    checkpoint = undefined;
  };
  h.transport.manifest = async () => ({ protocolVersion: 1, workspaceId: "cloud-one", head });
  h.transport.push = async (batch) => {
    sent.push({ at: clock.now() - start, ...batch }); head++;
    return { replicaId: batch.replicaId, requestId: batch.requestId, accepted: true, sequence: head };
  };
  h.transport.pull = async ({ after }) => ({ transactions: Array.from({ length: head - after }, (_, i) => ({ sequence: after + i + 1 })), objects: [], nextCursor: head, hasMore: false });
  const commit = (kind, value) => { if (kind === "activity") dirtyEvents.push(value); else checkpoint = value; wake?.(); };
  return { ...h, sent, commit, publishRemote() { head++; } };
}

test("default minute windows coalesce only positions and retain every fact during continuous writes", async (t) => {
  const clock = scheduler(), h = recordingFixture(t, clock), client = await h.create(clock); client.start(); await clock.step();
  for (let second = 1; second <= 180; second++) {
    await clock.advance(1000); h.commit("checkpoint", second);
    if (second % 15 === 0) h.commit("activity", second);
  }
  await clock.advance(1000);
  assert.deepEqual(h.sent.map((batch) => batch.at), [61000, 121000, 181000]);
  assert.deepEqual(h.sent.map((batch) => batch.checkpoint), [60, 120, 180]);
  assert.deepEqual(h.sent.flatMap((batch) => batch.facts), Array.from({ length: 12 }, (_, index) => (index + 1) * 15));
  assert.equal(new Set(h.sent.map((batch) => batch.requestId)).size, h.sent.length);
  const count = h.sent.length; await clock.advance(60000); assert.equal(h.sent.length, count);
  assert.equal(h.state.cursor, count); await client.stop();
});

test("receiving never freezes a not-yet-due send and sending never postpones the next receive", async (t) => {
  const clock = scheduler(), h = recordingFixture(t, clock), start = clock.now(), client = await h.create(clock); client.start(); await clock.step();
  await clock.advance(1000); h.commit("activity", "unsent-fact"); h.publishRemote();
  const captured = h.events.filter(value => value === "capture").length;
  await clock.advance(59000);
  assert.equal(h.state.cursor, 1, "the periodic receive runs even with pending local work");
  assert.equal(h.sent.length, 0); assert.equal(h.engine.status().dirty, 1);
  assert.equal(h.events.filter(value => value === "capture").length, captured, "receive does not freeze an early outbox");
  await clock.advance(1000);
  assert.deepEqual(h.sent.map(batch => batch.at), [61000]);
  assert.equal(h.state.cursor, 2, "the acknowledged local journal is applied without skipping the remote entry");
  assert.equal(client.status().nextAttemptAt, new Date(start + 120000).toISOString(), "an upload does not move the existing receive clock");
  await client.stop();
});

test("a longer configured send window does not disable minute receiving or lose activity facts", async (t) => {
  const clock = scheduler(), h = recordingFixture(t, clock), client = await h.create({ ...clock, batchingWindowMs: 120000 }); client.start(); await clock.step();
  for (let second = 1; second <= 240; second++) {
    await clock.advance(1000); h.commit("checkpoint", second);
    if (second % 15 === 0) h.commit("activity", second);
  }
  assert.equal(h.sent.length, 1, "receive ticks do not upload before the send deadline");
  await clock.advance(1000);
  assert.deepEqual(h.sent.map((batch) => batch.at), [121000, 241000]);
  assert.deepEqual(h.sent.flatMap((batch) => batch.facts), Array.from({ length: 16 }, (_, i) => (i + 1) * 15));
  assert.deepEqual(h.sent.map((batch) => batch.checkpoint), [120, 240]);
  assert.equal(h.state.cursor, 2, "acknowledged writes still pass through the independent pull cursor");
  await client.stop();
});

test("manual synchronization flushes immediately and shutdown preserves the unsent batch for startup", async (t) => {
  const clock = scheduler(), h = recordingFixture(t, clock), first = await h.create(clock); first.start(); await clock.step();
  await clock.advance(1000); h.commit("activity", "first"); h.commit("checkpoint", "first-position");
  await clock.advance(1000); await first.runOnce();
  assert.deepEqual(h.sent.map((batch) => batch.at), [2000]);
  h.commit("activity", "saved-before-close"); h.commit("checkpoint", "saved-position"); await first.stop();
  assert.equal(h.sent.length, 1, "closing captures durable work without forcing a network upload");
  assert.equal(h.outbox.length, 1); const frozenId = h.outbox[0].requestId;
  const restarted = await h.create(clock); restarted.start(); assert.equal(await clock.step(), 0);
  assert.equal(h.sent[1].requestId, frozenId); assert.deepEqual(h.sent[1].facts, ["saved-before-close"]);
  assert.equal(h.sent[1].checkpoint, "saved-position"); assert.equal(h.outbox.length, 0); await restarted.stop();
});

test("a fresh commit during a slow upload waits for its own deadline instead of extending the active drain", async (t) => {
  const clock = scheduler(), h = recordingFixture(t, clock), client = await h.create(clock); client.start(); await clock.step();
  await clock.advance(1000); h.commit("activity", "already-frozen");
  const push = h.transport.push; let release, entered;
  const pushing = new Promise((resolve) => { entered = resolve; });
  h.transport.push = async (batch) => { entered(); await new Promise((resolve) => { release = resolve; }); return push(batch); };
  const active = client.runOnce(); await pushing;
  await clock.advance(10000); h.commit("activity", "recorded-during-upload");
  release(); await active; h.transport.push = push;
  assert.equal(h.sent.length, 1); assert.equal(h.engine.status().dirty, 1);
  assert.equal(client.status().nextAttemptAt, new Date(clock.now() + 60000).toISOString());
  await clock.advance(59999); assert.equal(h.sent.length, 1);
  await clock.advance(1); assert.deepEqual(h.sent[1].facts, ["recorded-during-upload"]); await client.stop();
});

test("local notifications cannot postpone a server retry horizon and configuration bounds the batch window", async (t) => {
  const clock = scheduler(), h = recordingFixture(t, clock);
  h.transport.manifest = async () => { throw new SyncTransportError("SYNC_RATE_LIMITED", "Quota", { status: 429, retryAfterMs: 120000 }); };
  const client = await h.create(clock); client.start(); await clock.step(); const horizon = client.status().nextAttemptAt;
  for (let i = 0; i < 5; i++) { await clock.advance(15000); h.commit("activity", i); assert.equal(client.status().nextAttemptAt, horizon); }
  assert.equal(h.sent.length, 0); await client.stop(); assert.equal(h.outbox[0].facts.length, 5);
  for (const batchingWindowMs of [0, 99, 300001, NaN]) await assert.rejects(h.create({ ...clock, batchingWindowMs }), { code: "SYNC_INVALID_CONFIGURATION" });
});

test("online recovery retries immediately but preserves identity pauses and server retry horizons", async (t) => {
  const h = fixture(t), clock = scheduler(); let attempts = 0, failure = new SyncTransportError("SYNC_OFFLINE", "Offline");
  h.transport.manifest = async () => { attempts++; if (failure) throw failure; return { protocolVersion: 1, workspaceId: "cloud-one", head: 0 }; };
  const client = await h.create(clock); client.start(); await clock.step();
  assert.equal(attempts, 1);
  failure = null; await client.runOnce({ resume: true }); assert.equal(attempts, 2);
  failure = new SyncTransportError("SYNC_RATE_LIMITED", "Quota", { status: 429, retryAfterMs: 120000 });
  await assert.rejects(client.runOnce(), { code: "SYNC_RATE_LIMITED" });
  const deadline = client.status().nextAttemptAt;
  failure = null; await client.runOnce({ resume: true });
  assert.equal(attempts, 3); assert.equal(client.status().nextAttemptAt, deadline);
  await clock.advance(119999); assert.equal(attempts, 3);
  await clock.advance(1); assert.equal(attempts, 4);
  failure = new SyncTransportError("SYNC_UNAUTHORIZED", "Credentials");
  await assert.rejects(client.runOnce(), { code: "SYNC_UNAUTHORIZED" });
  failure = null; await client.runOnce({ resume: true });
  assert.equal(attempts, 5); assert.equal(client.status().blockedReason, "SYNC_UNAUTHORIZED"); assert.equal(clock.timers.size, 0);
  await client.runOnce(); assert.equal(attempts, 6); assert.equal(client.status().blockedReason, null);
  await client.stop();
});

test("bad credentials pause automatic retry durably while manual retry can recover without losing offline work", async (t) => {
  const h = fixture(t), clock = scheduler(); h.outbox.push(h.batch());
  const healthy = h.transport.manifest;
  h.transport.manifest = async () => { throw new SyncTransportError("SYNC_UNAUTHORIZED", "Credentials expired", { status: 401 }); };
  const first = await h.create(clock); first.start(); await clock.step();
  assert.equal(first.status().blockedReason, "SYNC_UNAUTHORIZED"); assert.equal(clock.timers.size, 0); assert.equal(h.outbox.length, 1);
  await first.stop();
  h.transport.manifest = healthy;
  const second = await h.create(clock); second.start(); assert.equal(clock.timers.size, 0);
  await second.runOnce(); assert.equal(second.status().blockedReason, null); assert.equal(h.outbox.length, 0); assert.equal(clock.timers.size, 1);
  await second.stop();
});

test("a packed batch stays frozen and automatic uploads pause until the server supports its atomic boundaries", async (t) => {
  const h = fixture(t), clock = scheduler(), batch = h.batch();
  batch.mutations.push({ ...batch.mutations[0], key: "two", value: { id: "two", label: "Another offline operation" } });
  batch.atomicGroups = [[0], [1]]; const frozen = structuredClone(batch); h.outbox.push(batch);
  const client = await h.create(clock); client.start(); await clock.step();
  assert.equal(client.status().blockedReason, "SYNC_UPGRADE_REQUIRED"); assert.equal(clock.timers.size, 0);
  assert.deepEqual(h.outbox, [frozen]); assert.equal(h.events.includes("push"), false); assert.equal(h.events.includes("upload"), false);
  h.transport.manifest = async () => ({ protocolVersion: 1, workspaceId: "cloud-one", head: 0, features: ["atomic-groups-v1"] });
  await client.runOnce(); assert.equal(h.outbox.length, 0); assert.equal(client.status().blockedReason, null); await client.stop();
});

test("server retry horizons survive a client restart and do not turn into frequent quota probes", async (t) => {
  const h = fixture(t), clock = scheduler();
  h.transport.manifest = async () => { throw new SyncTransportError("SYNC_RATE_LIMITED", "Quota", { status: 429, retryAfterMs: 3600000 }); };
  const first = await h.create(clock); first.start(); await clock.step();
  assert.equal([...clock.timers.values()][0].delay, 3600000); await first.stop();
  const restarted = await h.create(clock); restarted.start(); assert.equal([...clock.timers.values()][0].delay, 3600000); await restarted.stop();
});

test("a bounded pull cycle cannot mark success before its independent cursor reaches the observed head", async (t) => {
  const h = fixture(t);
  h.transport.manifest = async () => ({ protocolVersion: 1, workspaceId: "cloud-one", head: 2 });
  h.transport.pull = async ({ after }) => ({ transactions: [{ sequence: after + 1 }], objects: [], nextCursor: after + 1, hasMore: after < 1 });
  const client = await h.create({ maxBatches: 1 });
  await client.runOnce(); assert.equal(h.state.cursor, 1); assert.equal(client.status().lastSuccessAt, null);
  await client.runOnce(); assert.equal(h.state.cursor, 2); assert.ok(client.status().lastSuccessAt); await client.stop();
});
