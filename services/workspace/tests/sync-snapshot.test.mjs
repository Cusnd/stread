import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { createWorkspace } from "../service.mjs";
import { createWorkspaceSync } from "../sync-engine.mjs";
import { createWorkspaceSyncClient } from "../sync-client.mjs";
import { SyncTransportError } from "../sync-http-client.mjs";
import { rowHash } from "../sync-schema.mjs";

const sha = (input) => createHash("sha256").update(input).digest("hex");
const connection = { origin: "https://snapshot.example", token: "synthetic-snapshot-token" };
const features = ["atomic-groups-v1", "history-archive-v1", "state-snapshot-v1"];
const defaults = () => [["plan", "[]"], ["planVersion", "1"], ["currentId", "null"]].map(([key, value]) => state("metadata", [key], { key, value }));
function state(entity, keys, value, version = 1) { return { entity, key: JSON.stringify(keys), value, version, hash: rowHash(value) }; }
const collection = (id, label = id) => state("collections", [id], { id, label, parent_id: null, version: 1 });

function snapshot(states, { pageSize = 256, sequence = 1, historyId = "history-one", snapshotId = "snapshot-one" } = {}) {
  const pages = [];
  for (let start = 0; start < states.length; start += pageSize) pages.push(Buffer.from(JSON.stringify({ format: "reader-sync-snapshot-chunk-1", snapshotId, historyId, sequence, index: pages.length, states: states.slice(start, start + pageSize) })));
  const manifest = { format: "reader-sync-snapshot-1", snapshotId, historyId, sequence, entityCount: states.length, chunks: pages.map((bytes, index) => ({ index, sha256: sha(bytes), size: bytes.length, rowCount: Math.min(pageSize, states.length - index * pageSize) })) };
  const bytes = Buffer.from(JSON.stringify(manifest));
  return { manifest, bytes, pages, reference: { snapshotId, sequence, sha256: sha(bytes), size: bytes.length }, states };
}

async function fixture(t, source, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reader-sync-snapshot-")), calls = { descriptor: 0, chunks: [], pushes: [], pulls: [], acks: [] };
  let workspace, engine, client;
  const transport = {
    manifest: async () => ({ protocolVersion: 1, workspaceId: "remote-workspace", head: source.reference.sequence, historyId: source.manifest.historyId, minAvailableCursor: 0, hotFloor: source.reference.sequence, features, snapshot: source.reference }),
    enroll: async ({ replicaId }) => ({ replicaId, cursor: source.reference.sequence, referenceRanges: Object.fromEntries(["Q", "N", "R"].map((series) => [series, { start: 1000000, end: 1999999 }])) }),
    snapshotDescriptor: async (reference) => { calls.descriptor++; assert.deepEqual(reference, source.reference); return source.bytes; },
    snapshotChunk: async (_id, reference) => { calls.chunks.push(reference.index); return source.pages[reference.index]; },
    acknowledgeApplied: async (input) => { assert.equal(engine.cursor, input.cursor, "confirmation follows the durable local cursor"); calls.acks.push(input); return input; },
    pull: async ({ after }) => { calls.pulls.push(after); throw new Error("unexpected archive replay"); },
    push: async (batch) => { calls.pushes.push(batch); throw new Error("unexpected bootstrap upload"); },
  };
  const open = async () => {
    workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
    engine = await createWorkspaceSync(workspace, { mode: "client", replicaId: "snapshot-device" });
    client = await createWorkspaceSyncClient(workspace, { ...connection, engine, transport, ...options });
  };
  await open();
  const h = { transport, calls, directory, get workspace() { return workspace; }, get engine() { return engine; }, get client() { return client; }, get db() { return workspace.db; },
    async restart() { await client.stop(); await workspace.close(); await open(); } };
  t.after(async () => { await client.stop(); await workspace.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "reader-sync-snapshot-")); await rm(directory, { recursive: true, force: true }); });
  return h;
}

test("a genuinely empty workspace installs more than ten thousand snapshot identities atomically without a bootstrap outbox", async (t) => {
  const rows = [...defaults(), ...Array.from({ length: 11000 }, (_, i) => collection("collection-" + String(i).padStart(5, "0"))), state("collections", ["deleted"], null, 4)];
  const source = snapshot(rows, { sequence: 19 }), h = await fixture(t, source);
  assert.equal(h.engine.canInstallSnapshot(), true); assert.equal(h.engine.status().dirty, 3);
  await h.client.runOnce();
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM collections").get().n, 11000);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sync_entities").get().n, rows.length);
  assert.equal(h.engine.known("collections", '["deleted"]').version, 4); assert.equal(h.engine.known("collections", '["deleted"]').value, null);
  assert.equal(h.engine.cursor, 19); assert.equal(h.engine.status().pending, 0); assert.equal(h.engine.canInstallSnapshot(), false);
  assert.equal(h.calls.pushes.length, 0); assert.equal(h.calls.pulls.length, 0); assert.equal(h.calls.acks.length, 1);
  await h.client.runOnce(); assert.equal(h.calls.acks.length, 1, "idle probes do not repeat durable applied confirmations");
});

test("verified chunks survive shutdown and restart without freezing empty bootstrap defaults", async (t) => {
  const source = snapshot([...defaults(), ...Array.from({ length: 7 }, (_, i) => collection("remote-" + i))], { pageSize: 3 }), h = await fixture(t, source);
  const chunk = h.transport.snapshotChunk; let fail = true;
  h.transport.snapshotChunk = async (id, ref, options) => { if (ref.index === 1 && fail) { fail = false; throw new SyncTransportError("SYNC_OFFLINE", "offline"); } return chunk(id, ref, options); };
  await assert.rejects(h.client.runOnce(), { code: "SYNC_OFFLINE" });
  assert.equal(h.engine.cursor, 0); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM collections").get().n, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sync_snapshot_chunks WHERE ready=1").get().n, 1);
  await h.restart(); assert.equal(h.engine.status().pendingBatches, 0); assert.equal(h.engine.canInstallSnapshot(), true);
  await h.client.runOnce(); assert.equal(h.calls.descriptor, 1); assert.equal(h.calls.chunks.filter((index) => index === 0).length, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM collections").get().n, 7); assert.equal(h.engine.cursor, 1);
});

test("bounded download cycles never publish partial rows or turn bootstrap defaults into an outgoing request", async (t) => {
  const source = snapshot([...defaults(), collection("remote")], { pageSize: 2 }), h = await fixture(t, source, { maxBatches: 1 });
  await h.client.runOnce(); assert.equal(h.engine.cursor, 0); assert.equal(h.engine.status().pendingBatches, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM collections").get().n, 0); assert.equal(h.calls.acks.length, 0);
  await h.client.runOnce(); assert.equal(h.engine.cursor, 1); assert.equal(h.calls.descriptor, 1); assert.equal(h.calls.pushes.length, 0);
});

test("a local edit during snapshot download abandons installation and replays archived transactions without overwriting it", async (t) => {
  const source = snapshot([...defaults(), collection("shared", "remote"), collection("remote-only")], { pageSize: 3 }), h = await fixture(t, source);
  const chunk = h.transport.snapshotChunk; let edited = false;
  h.transport.snapshotChunk = async (...args) => {
    if (!edited) { edited = true; h.db.transaction(() => h.db.prepare("INSERT INTO collections VALUES('shared','local edit',NULL,1)").run()); }
    return chunk(...args);
  };
  h.transport.pull = async ({ after }) => { h.calls.pulls.push(after); return { transactions: [{ sequence: 1, replicaId: "remote", requestId: "archived-import", mutations: source.states, atomicGroups: source.states.map((_state, index) => [index]) }], nextCursor: 1, hasMore: false, objects: [] }; };
  await h.client.runOnce();
  assert.equal(h.engine.state("snapshotInstalled"), undefined); assert.equal(h.db.prepare("SELECT status FROM sync_snapshot_stages").get().status, "abandoned");
  assert.equal(h.db.prepare("SELECT label FROM collections WHERE id='shared'").get().label, "local edit");
  assert.ok(h.db.prepare("SELECT id FROM collections WHERE id='remote-only'").get());
  assert.equal(h.engine.conflicts().conflicts.length, 1); assert.equal(h.engine.cursor, 1); assert.deepEqual(h.calls.pulls, [0]);
});

test("descriptor or chunk corruption cannot expose a partial library or advance the cursor", async (t) => {
  for (const kind of ["descriptor", "chunk"]) await t.test(kind, async (t) => {
    const source = snapshot([...defaults(), collection("remote")]), h = await fixture(t, source);
    if (kind === "descriptor") h.transport.snapshotDescriptor = async () => Buffer.from(source.bytes.toString().replace("reader-sync-snapshot-1", "reader-sync-snapshot-2"));
    else h.transport.snapshotChunk = async () => Buffer.from(source.pages[0].toString().replace('"remote"', '"mutant"'));
    await assert.rejects(h.client.runOnce(), { code: "SYNC_SNAPSHOT_INVALID" });
    assert.equal(h.engine.cursor, 0); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM collections").get().n, 0); assert.equal(h.calls.acks.length, 0);
    assert.equal(h.engine.status().pendingBatches, 0);
  });
});

test("an application failure rolls back every baseline row and resumes from verified staging", async (t) => {
  const source = snapshot([...defaults(), ...Array.from({ length: 260 }, (_, i) => collection("remote-" + i))]), h = await fixture(t, source);
  const apply = h.engine.applyRows.bind(h.engine); let groups = 0;
  h.engine.applyRows = (...args) => { if (++groups === 2) throw new Error("simulated installation interruption"); return apply(...args); };
  await assert.rejects(h.client.runOnce(), /simulated installation interruption/);
  assert.equal(h.engine.cursor, 0); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM collections").get().n, 0); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sync_entities").get().n, 0);
  h.engine.applyRows = apply; const downloaded = h.calls.chunks.length; await h.client.runOnce();
  assert.equal(h.calls.chunks.length, downloaded); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM collections").get().n, 260);
});

test("a changed history identity blocks uploads while preserving the exact frozen local request", async (t) => {
  const source = snapshot([...defaults(), collection("remote")]), h = await fixture(t, source); await h.client.runOnce();
  h.db.transaction(() => h.db.prepare("INSERT INTO collections VALUES('offline','offline edit',NULL,1)").run()); h.engine.capture();
  const frozen = h.engine.pending().batches[0];
  h.transport.manifest = async () => ({ protocolVersion: 1, workspaceId: "remote-workspace", head: 100, historyId: "different-history", features });
  await assert.rejects(h.client.runOnce(), { code: "SYNC_HISTORY_CHANGED" });
  assert.deepEqual(h.engine.pending().batches[0], frozen); assert.equal(h.calls.pushes.length, 0); assert.equal(h.client.status().blockedReason, "SYNC_HISTORY_CHANGED");
});

test("a lost applied confirmation retries after the durable baseline without downloading or applying it again", async (t) => {
  const source = snapshot([...defaults(), collection("remote")]), h = await fixture(t, source), ack = h.transport.acknowledgeApplied; let fail = true;
  h.transport.acknowledgeApplied = async (input) => { const result = await ack(input); if (fail) { fail = false; throw new SyncTransportError("SYNC_OFFLINE", "lost confirmation"); } return result; };
  await assert.rejects(h.client.runOnce(), { code: "SYNC_OFFLINE" }); assert.equal(h.engine.cursor, 1);
  const count = h.calls.chunks.length; await h.client.runOnce();
  assert.equal(h.calls.chunks.length, count); assert.equal(h.calls.acks.length, 2); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM collections").get().n, 1);
  await h.client.runOnce(); assert.equal(h.calls.acks.length, 2);
});
