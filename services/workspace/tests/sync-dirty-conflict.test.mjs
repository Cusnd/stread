import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceSync } from "../sync-engine.mjs";
import { createWorkspaceSyncClient } from "../sync-client.mjs";
import { canonical, hash } from "../errors.mjs";
import { projectReadingChanges } from "../reading-projection.mjs";

async function fixture(t, id, mode = "client") {
  const directory = await mkdtemp(join(tmpdir(), "reader-sync-dirty-conflict-"));
  const workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  const sync = await createWorkspaceSync(workspace, { replicaId: id, mode });
  t.after(async () => {
    await workspace.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "reader-sync-dirty-conflict-"));
    await rm(directory, { recursive: true, force: true });
  });
  return { workspace, sync, db: workspace.db };
}

async function setup(t) {
  const server = await fixture(t, "conflict-hub", "server"), local = await fixture(t, "conflict-local");
  server.db.transaction(() => {
    for (const id of ["a", "b", "c", "d"]) server.db.prepare("INSERT INTO collections VALUES(?,?,NULL,1)").run(id, "original-" + id);
  });
  local.sync.acceptEnrollment(server.sync.enroll(localActor, { replicaId: local.sync.replicaId, requestId: "enroll-local" }));
  await local.sync.applyPull(server.sync.pull({ after: local.sync.cursor })); local.sync.capture();
  assert.equal(local.sync.status().pending, 0);
  return { server, local };
}

function edit(h, ids, label) {
  h.db.transaction(() => {
    for (const id of ids) h.db.prepare("UPDATE collections SET label=?,version=version+1 WHERE id=?").run(label + "-" + id, id);
  });
}
const keys = (rows) => rows.filter((row) => row.entity === "collections").map((row) => JSON.parse(row.key)[0]).sort();
const labels = (h) => Object.fromEntries(h.db.prepare("SELECT id,label FROM collections ORDER BY id").all().map((row) => [row.id, row.label]));

test("a local atomic edit committed while pull waits is preserved as one complete conflict", async (t) => {
  const { server, local } = await setup(t); edit(server, ["a"], "remote");
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const runner = await createWorkspaceSyncClient(local.workspace, {
    origin: "https://dirty-conflict.example", token: "synthetic-sync-token", engine: local.sync,
    transport: {
      manifest: async () => server.sync.manifest(),
      pull: async ({ after, limit }) => { enter(); await new Promise((resolve) => { release = resolve; }); return server.sync.pull({ after, limit }); },
    },
  });
  const syncing = runner.runOnce(); await entered;
  edit(local, ["a", "b"], "local");
  assert.equal(local.sync.pending().batches.length, 0, "the edit happened after the cycle captured its outgoing work");
  release(); await syncing;
  const [conflict] = local.sync.conflicts().conflicts;
  assert.deepEqual(keys(conflict.local), ["a", "b"]); assert.deepEqual(keys(conflict.remote), ["a", "b"]);
  assert.equal(conflict.remote.find((row) => row.key === '["b"]').value.label, "original-b");
  assert.equal(local.sync.cursor, server.sync.head, "the conflict is retained while the receiving cursor progresses");
  await local.sync.resolveConflict({ id: conflict.id, choice: "remote", expectedVersion: conflict.version });
  assert.deepEqual(labels(local), { a: "remote-a", b: "original-b", c: "original-c", d: "original-d" });
  await runner.stop();
});

test("dirty conflict expansion follows transitive atomic edges and the frozen retry without absorbing unrelated edits", async (t) => {
  const { server, local } = await setup(t);
  edit(local, ["a", "c"], "frozen"); local.sync.capture(); const frozen = local.sync.pending().batches[0];
  edit(local, ["a", "b"], "fresh"); edit(local, ["d"], "unrelated"); edit(server, ["a"], "remote");
  await local.sync.applyPull(server.sync.pull({ after: local.sync.cursor }));
  const [conflict] = local.sync.conflicts().conflicts;
  assert.deepEqual(keys(conflict.local), ["a", "b", "c"]); assert.deepEqual(keys(conflict.remote), ["a", "b", "c"]);
  assert.deepEqual(conflict.source.requestIds, [frozen.requestId]);
  assert.deepEqual(local.sync.decode(local.db.prepare("SELECT payload FROM sync_outbox WHERE request_id=?").get(frozen.requestId).payload), frozen);
  await local.sync.resolveConflict({ id: conflict.id, choice: "remote", expectedVersion: conflict.version });
  assert.deepEqual(labels(local), { a: "remote-a", b: "original-b", c: "original-c", d: "unrelated-d" });
  assert.equal(local.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get().n, 0);
  local.sync.capture(); const remaining = local.sync.pending().batches[0];
  assert.deepEqual(keys(remaining.mutations), ["d"]);
});

const started = Date.parse("2026-10-20T12:00:00Z"), timestamp = new Date(started).toISOString();
function commandReceipt(h, requestId, payload) {
  const text = JSON.stringify(payload);
  h.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?)").run(requestId, hash(text), text, "local", timestamp);
}
function checkpoint(h, requestId, position) {
  h.db.transaction(() => {
    h.db.prepare("INSERT INTO reading VALUES('reading-doc',?) ON CONFLICT(document_id) DO UPDATE SET payload=excluded.payload").run(JSON.stringify({ documentId: "reading-doc", revision: 1, position }));
    commandReceipt(h, requestId, { position });
  });
}
function activity(h, session) {
  h.db.transaction(() => {
    h.db.prepare("INSERT INTO reading_activity VALUES(?,1,?,?,15000,0,?)").run(session, started, started + 15000, canonical({ startedAt: timestamp, endedAt: new Date(started + 15000).toISOString(), activeMs: 15000 }));
    projectReadingChanges(h.db, { inTransaction: true }); commandReceipt(h, "activity-" + session, { sequence: 1, activeMs: 15000 });
  });
}
async function readingSetup(t) {
  const h = await setup(t);
  h.server.db.transaction(() => {
    h.server.db.prepare("INSERT INTO documents VALUES('reading-doc',1,1,'{\"title\":\"Packed conflict fixture\"}',NULL,?,?)").run(timestamp, timestamp);
    for (const session of ["local-session", "remote-session"]) h.server.db.prepare("INSERT INTO reading_sessions(id,actor_id,document_id,document_revision,started_ms,start_input,created_at) VALUES(?,?,'reading-doc',1,?,'{}',?)").run(session, session, started, timestamp);
  });
  checkpoint(h.server, "initial-checkpoint", 0);
  await h.local.sync.applyPull(h.server.sync.pull({ after: h.local.sync.cursor })); h.local.sync.capture();
  assert.equal(h.local.sync.status().pending, 0); return h;
}
async function flush(h) {
  h.local.sync.capture(); const batch = h.local.sync.pending().batches[0]; assert.ok(batch);
  const receipt = await h.server.sync.push(localActor, batch); h.local.sync.acknowledge(receipt);
  return { batch, receipt };
}
async function chooseRemote(h) {
  const [conflict] = h.local.sync.conflicts().conflicts;
  assert.equal(conflict.local.some((row) => row.entity === "reading_activity"), false, "an unrelated measured fact is outside the conflict");
  assert.equal(conflict.local.some((row) => row.entity === "receipts" && row.value?.request_id === "activity-local-session"), false);
  await h.local.sync.resolveConflict({ id: conflict.id, choice: "remote", expectedVersion: conflict.version }); return conflict;
}

test("rejecting one packed checkpoint preserves unrelated measured activity through remote choice and retry", async (t) => {
  const h = await readingSetup(t);
  checkpoint(h.local, "local-checkpoint", 1); activity(h.local, "local-session");
  h.local.sync.capture(); const frozen = h.local.sync.pending().batches[0]; assert.equal(frozen.atomicGroups.length, 2);
  checkpoint(h.server, "remote-checkpoint", 2);
  const rejection = await h.server.sync.push(localActor, frozen); assert.equal(rejection.accepted, false); h.local.sync.acknowledge(rejection);
  await chooseRemote(h);
  assert.equal(h.local.db.prepare("SELECT COUNT(*) AS n FROM reading_activity").get().n, 1);
  const retried = await flush(h); assert.equal(retried.receipt.accepted, true); assert.notEqual(retried.batch.requestId, frozen.requestId);
  assert.equal(retried.batch.mutations.some((row) => row.entity === "reading_activity"), true);
  await h.local.sync.applyPull(h.server.sync.pull({ after: h.local.sync.cursor }));
  for (const peer of [h.local, h.server]) {
    assert.equal(peer.db.prepare("SELECT active_ms FROM reading_sessions WHERE id='local-session'").get().active_ms, 15000);
    assert.ok(peer.db.prepare("SELECT request_id FROM receipts WHERE request_id='activity-local-session'").get());
    assert.equal(JSON.parse(peer.db.prepare("SELECT payload FROM reading WHERE document_id='reading-doc'").get().payload).position, 2);
  }
});

test("pulling a packed checkpoint conflict still applies independent remote events and retains local frozen events", async (t) => {
  const h = await readingSetup(t);
  checkpoint(h.local, "local-checkpoint", 1); activity(h.local, "local-session"); h.local.sync.capture();
  checkpoint(h.server, "remote-checkpoint", 2); activity(h.server, "remote-session");
  const incoming = h.server.sync.pull({ after: h.local.sync.cursor }); assert.equal(incoming.transactions[0].atomicGroups.length, 2);
  await h.local.sync.applyPull(incoming);
  assert.equal(h.local.db.prepare("SELECT COUNT(*) AS n FROM reading_activity").get().n, 2, "the unrelated incoming activity applies before conflict resolution");
  await chooseRemote(h);
  assert.equal(h.local.db.prepare("SELECT COUNT(*) AS n FROM reading_activity").get().n, 2);
  assert.equal((await flush(h)).receipt.accepted, true);
  await h.local.sync.applyPull(h.server.sync.pull({ after: h.local.sync.cursor }));
  for (const peer of [h.local, h.server]) {
    assert.equal(peer.db.prepare("SELECT SUM(active_ms) AS n FROM reading_sessions").get().n, 30000);
    assert.equal(peer.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE request_id LIKE 'activity-%'").get().n, 2);
  }
});

test("a packed glossary uniqueness rejection leaves unrelated measured activity intact", async (t) => {
  const h = await readingSetup(t);
  h.server.db.prepare("INSERT INTO glossary VALUES('remote-term',1,'same-term','{\"term\":\"same-term\"}',NULL)").run();
  h.local.db.transaction(() => {
    h.local.db.prepare("INSERT INTO glossary VALUES('local-term',1,'same-term','{\"term\":\"same-term\"}',NULL)").run();
    commandReceipt(h.local, "local-glossary-command", { id: "local-term" });
  });
  activity(h.local, "local-session");
  const { receipt } = await flush(h); assert.equal(receipt.code, "SYNC_CONSTRAINT");
  assert.equal(receipt.conflicts.some((row) => row.entity === "reading_activity"), false);
  await chooseRemote(h); assert.equal((await flush(h)).receipt.accepted, true);
  await h.local.sync.applyPull(h.server.sync.pull({ after: h.local.sync.cursor }));
  for (const peer of [h.local, h.server]) {
    assert.equal(peer.db.prepare("SELECT active_ms FROM reading_sessions WHERE id='local-session'").get().active_ms, 15000);
    assert.ok(peer.db.prepare("SELECT request_id FROM receipts WHERE request_id='activity-local-session'").get());
  }
});

test("a dirty atomic companion reverted to its known value still waits with its conflict instead of being overwritten", async (t) => {
  const h = await readingSetup(t);
  h.server.db.transaction(() => {
    for (const block of ["a", "b"]) h.server.db.prepare("INSERT INTO object_preferences VALUES('reading-doc',?,'{\"width\":0}')").run(block);
  });
  await h.local.sync.applyPull(h.server.sync.pull({ after: h.local.sync.cursor })); h.local.sync.capture();
  h.local.db.transaction(() => {
    h.local.db.prepare("UPDATE object_preferences SET payload='{\"width\":1}' WHERE document_id='reading-doc'").run();
  });
  h.local.db.transaction(() => h.local.db.prepare("UPDATE object_preferences SET payload='{\"width\":0}' WHERE block_id='b'").run());
  for (const block of ["a", "b"]) h.server.db.transaction(() => h.server.db.prepare("UPDATE object_preferences SET payload='{\"width\":2}' WHERE block_id=?").run(block));
  const incoming = h.server.sync.pull({ after: h.local.sync.cursor }); assert.equal(incoming.transactions[0].atomicGroups.length, 2);
  await h.local.sync.applyPull(incoming);
  const [conflict] = h.local.sync.conflicts().conflicts;
  assert.equal(h.local.db.prepare("SELECT payload FROM object_preferences WHERE block_id='b'").get().payload, '{"width":0}');
  assert.equal(conflict.local.find((row) => row.key === '["reading-doc","b"]').value.payload, '{"width":0}');
  await h.local.sync.resolveConflict({ id: conflict.id, choice: "local", expectedVersion: conflict.version });
  // The existing explicit local-branch resolution retains remotely changed
  // siblings whose local value equals the base. That choice occurs only here.
  assert.equal(h.local.db.prepare("SELECT payload FROM object_preferences WHERE block_id='b'").get().payload, '{"width":2}');
});
