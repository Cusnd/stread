import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceSync } from "../sync-engine.mjs";
import { rowHash } from "../sync-schema.mjs";

async function fixture(t, id, mode = "client") {
  const directory = await mkdtemp(join(tmpdir(), "reader-sync-reliability-"));
  const workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  const sync = await createWorkspaceSync(workspace, { replicaId: id, mode });
  t.after(async () => { await workspace.close(); await rm(directory, { recursive: true, force: true }); });
  return { workspace, sync, db: workspace.db };
}
async function align(client, server) {
  client.sync.acceptEnrollment(server.sync.enroll(localActor, { replicaId: client.sync.replicaId, requestId: "enroll-" + client.sync.replicaId }));
  await client.sync.applyPull(server.sync.pull({ after: client.sync.cursor })); client.sync.capture();
}
const add = (h, id, label) => h.db.transaction(() => h.db.prepare("INSERT INTO collections VALUES(?,?,NULL,1)").run(id, label));
const edit = (h, id, label) => h.db.transaction(() => h.db.prepare("UPDATE collections SET label=?,version=version+1 WHERE id=?").run(label, id));
const changes = (h) => h.db.prepare("SELECT total_changes() AS count").get().count;

test("100 idle manifest/pull/conflict reads produce no logical SQLite writes and keep journal identity", async (t) => {
  const h = await fixture(t, "idle-server", "server"); h.sync.capture();
  const before = changes(h), head = h.sync.head;
  for (let i = 0; i < 100; i++) { h.sync.manifest(); h.sync.pull({ after: head }); h.sync.conflicts(); }
  assert.equal(changes(h) - before, 0); assert.equal(h.sync.head, head);
});

test("identical business updates do not become replication facts", async (t) => {
  const h = await fixture(t, "local", "server");
  add(h, "entry", "Stable"); h.sync.capture();
  h.db.prepare("UPDATE collections SET label=label,version=version WHERE id='entry'").run();
  assert.equal(h.sync.status().dirty, 0);
});

test("concurrent duplicate pushes return one immutable receipt after awaited preparation", async (t) => {
  const client = await fixture(t, "laptop"), server = await fixture(t, "server", "server"); await align(client, server);
  add(client, "entry", "One fact"); client.sync.capture(); const batch = client.sync.pending().batches[0], before = server.sync.head;
  const [one, two] = await Promise.all([server.sync.push(localActor, batch), server.sync.push(localActor, batch)]);
  assert.deepEqual(two, one); assert.equal(one.accepted, true); assert.equal(server.sync.head, before + 1);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM sync_receipts WHERE request_id=?").get(batch.requestId).n, 1);
});

test("a delayed valid acknowledgement cannot roll an independently pulled entity back", async (t) => {
  const client = await fixture(t, "laptop"), server = await fixture(t, "server", "server"); await align(client, server);
  add(client, "entry", "First"); client.sync.capture(); const batch = client.sync.pending().batches[0];
  const receipt = await server.sync.push(localActor, batch);
  edit(server, "entry", "Newer remote edit");
  await client.sync.applyPull(server.sync.pull({ after: client.sync.cursor }));
  const before = client.sync.known("collections", '["entry"]'); assert.equal(before.version, 2);
  client.sync.acknowledge(receipt);
  assert.deepEqual(client.sync.known("collections", '["entry"]'), before);
  assert.equal(client.db.prepare("SELECT label FROM collections WHERE id='entry'").get().label, "Newer remote edit");
  assert.equal(client.sync.pending().batches.length, 0);
});

test("forged, duplicate and content-mismatched receipt states leave the outbox and known versions intact", async (t) => {
  const client = await fixture(t, "laptop"), server = await fixture(t, "server", "server"); await align(client, server);
  client.db.transaction(() => { add(client, "one", "First"); add(client, "two", "Second"); });
  client.sync.capture(); const batch = client.sync.pending().batches[0], receipt = await server.sync.push(localActor, batch);
  assert.equal(receipt.states.length, 2);
  const changed = { ...receipt.states[0], value: { ...receipt.states[0].value, label: "Not sent" } }; changed.hash = rowHash(changed.value);
  for (const bad of [
    { ...receipt, states: [receipt.states[0], receipt.states[0]] },
    { ...receipt, states: [changed, receipt.states[1]] },
    { ...receipt, states: [{ ...receipt.states[0], key: '["foreign"]' }, receipt.states[1]] },
    { ...receipt, states: [{ ...receipt.states[0], version: 99 }, receipt.states[1]] },
  ]) {
    assert.throws(() => client.sync.acknowledge(bad));
    assert.equal(client.sync.pending().batches[0].requestId, batch.requestId);
    assert.equal(client.sync.known("collections", '["one"]').version, 0);
    assert.equal(client.sync.known("collections", '["two"]').version, 0);
  }
  client.sync.acknowledge(receipt); assert.equal(client.sync.pending().batches.length, 0);
});

test("malformed pull transactions fail before object hydration and cannot advance the cursor", async (t) => {
  const client = await fixture(t, "laptop"), server = await fixture(t, "server", "server"); await align(client, server);
  add(server, "entry", "One"); const page = server.sync.pull({ after: client.sync.cursor }), before = client.sync.cursor;
  let prepared = 0; const original = client.sync.prepareRows.bind(client.sync);
  client.sync.prepareRows = (...args) => { prepared++; return original(...args); };
  const transaction = page.transactions[0];
  await assert.rejects(client.sync.applyPull({ ...page, transactions: [{ ...transaction, mutations: [...transaction.mutations, transaction.mutations[0]] }] }), { code: "SYNC_SCHEMA" });
  assert.equal(prepared, 0); assert.equal(client.sync.cursor, before);
  await client.sync.applyPull(page); assert.equal(client.sync.cursor, page.nextCursor);
  const after = changes(client); await client.sync.applyPull(page); assert.equal(changes(client), after);
});

test("sync bookkeeping does not notify local-write listeners; committed commands do, rollbacks do not", async (t) => {
  const h = await fixture(t, "local"); let notifications = 0;
  const release = h.sync.onLocalCommit(() => { notifications++; });
  h.sync.capture(); h.sync.manifest(); assert.equal(notifications, 0);
  add(h, "entry", "Saved"); assert.equal(notifications, 1);
  assert.throws(() => h.db.transaction(() => { add(h, "rolled-back", "Unsaved"); throw new Error("rollback"); }));
  assert.equal(notifications, 1); assert.equal(h.db.prepare("SELECT id FROM collections WHERE id='rolled-back'").get(), undefined);
  release(); add(h, "next", "Saved again"); assert.equal(notifications, 1);
});
