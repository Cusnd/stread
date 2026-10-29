import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceSync, SYNC_BATCH_TARGET_MUTATIONS, SYNC_BATCH_TARGET_BYTES } from "../sync-engine.mjs";
import { projectReadingChanges } from "../reading-projection.mjs";
import { canonical, hash } from "../errors.mjs";

const base = Date.parse("2026-10-20T12:00:00Z"), timestamp = new Date(base).toISOString();
async function fixture(t, id, mode = "client") {
  const directory = await mkdtemp(join(tmpdir(), "reader-sync-batching-"));
  const workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  const sync = await createWorkspaceSync(workspace, { replicaId: id, mode });
  t.after(async () => { await workspace.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "reader-sync-batching-")); await rm(directory, { recursive: true, force: true }); });
  return { workspace, sync, db: workspace.db };
}
async function align(client, server) {
  client.sync.acceptEnrollment(server.sync.enroll(localActor, { replicaId: client.sync.replicaId, requestId: "enroll-" + client.sync.replicaId }));
  await client.sync.applyPull(server.sync.pull({ after: client.sync.cursor })); client.sync.capture();
}
async function flush(client, server) {
  client.sync.capture(); const batch = client.sync.pending().batches[0]; if (!batch) return null;
  const receipt = await server.sync.push(localActor, batch); assert.equal(receipt.accepted, true);
  client.sync.acknowledge(receipt); return { batch, receipt };
}
function document(h) {
  h.db.prepare("INSERT INTO documents VALUES('doc-batch',1,1,'{\"title\":\"Sync batching fixture\"}',NULL,?,?)").run(timestamp, timestamp);
}
function receipt(h, requestId, payload) {
  const value = JSON.stringify(payload);
  h.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?)").run(requestId, hash(value), value, "local", timestamp);
}
const receiptsHash = (h) => hash(JSON.stringify(h.db.prepare("SELECT * FROM receipts ORDER BY request_id").all()));

test("one cloud batch retains four measured events, the latest unsent position and all six command receipts", async (t) => {
  const server = await fixture(t, "batch-hub", "server"), client = await fixture(t, "batch-writer"), observer = await fixture(t, "batch-reader");
  server.db.transaction(() => {
    document(server);
    server.db.prepare("INSERT INTO reading_sessions(id,actor_id,document_id,document_revision,started_ms,start_input,created_at) VALUES('session-batch','local','doc-batch',1,?,'{}',?)").run(base, timestamp);
  });
  await align(client, server); await align(observer, server);
  for (let i = 1; i <= 4; i++) {
    client.db.transaction(() => {
      const start = base + (i - 1) * 15000, end = base + i * 15000;
      const input = canonical({ startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), activeMs: 15000 });
      client.db.prepare("INSERT INTO reading_activity VALUES('session-batch',?,?,?,?,?,?)").run(i, start, end, 15000, 0, input);
      projectReadingChanges(client.db, { inTransaction: true }); receipt(client, "activity-" + i, { sequence: i });
    });
    if (i % 2 === 0) client.db.transaction(() => {
      client.db.prepare("INSERT INTO reading VALUES('doc-batch',?) ON CONFLICT(document_id) DO UPDATE SET payload=excluded.payload").run(JSON.stringify({ documentId: "doc-batch", revision: 1, offsetRatio: i / 10 }));
      receipt(client, "checkpoint-" + i, { offsetRatio: i / 10 });
    });
  }
  const before = receiptsHash(client), { batch, receipt: accepted } = await flush(client, server);
  assert.equal(batch.mutations.length, 11); assert.equal(batch.mutations.filter((row) => row.entity === "reading_activity").length, 4);
  assert.equal(batch.mutations.filter((row) => row.entity === "reading").length, 1);
  assert.equal(JSON.parse(batch.mutations.find((row) => row.entity === "reading").value.payload).offsetRatio, 0.4);
  assert.deepEqual(await server.sync.push(localActor, batch), accepted);
  assert.equal(await flush(client, server), null);
  for (const h of [client, observer]) await h.sync.applyPull(server.sync.pull({ after: h.sync.cursor }));
  for (const h of [server, client, observer]) {
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM reading_activity").get().n, 4);
    assert.equal(h.db.prepare("SELECT active_ms FROM reading_sessions WHERE id='session-batch'").get().active_ms, 60000);
    assert.equal(receiptsHash(h), before);
    assert.equal(JSON.parse(h.db.prepare("SELECT payload FROM reading WHERE document_id='doc-batch'").get().payload).offsetRatio, 0.4);
  }
});

test("more than ten thousand offline checkpoints drain in bounded batches without losing receipts or replacing a frozen retry", async (t) => {
  const server = await fixture(t, "offline-hub", "server"), client = await fixture(t, "offline-writer");
  document(server); await align(client, server);
  const write = client.db.prepare("INSERT INTO reading VALUES('doc-batch',?) ON CONFLICT(document_id) DO UPDATE SET payload=excluded.payload");
  for (let i = 0; i < 10050; i++) client.db.transaction(() => {
    write.run(JSON.stringify({ documentId: "doc-batch", revision: 1, checkpoint: i })); receipt(client, "offline-checkpoint-" + i, { checkpoint: i });
  });
  const before = receiptsHash(client); client.sync.capture();
  const frozen = client.sync.pending().batches[0]; assert.ok(frozen.mutations.length <= SYNC_BATCH_TARGET_MUTATIONS);
  assert.ok(frozen.mutations.some((row) => row.entity === "reading"), "current position arrives before detached receipts");
  client.db.transaction(() => write.run(JSON.stringify({ documentId: "doc-batch", revision: 1, checkpoint: 10050 })));
  assert.equal(client.sync.capture().captured, false); assert.deepEqual(client.sync.pending().batches[0], frozen);
  let batches = 0;
  for (; batches < 100; batches++) {
    const sent = await flush(client, server); if (!sent) break;
    assert.ok(sent.batch.mutations.length <= SYNC_BATCH_TARGET_MUTATIONS);
    assert.ok(Buffer.byteLength(JSON.stringify(sent.batch.mutations)) <= SYNC_BATCH_TARGET_BYTES);
  }
  assert.ok(batches > 1 && batches < 100); assert.equal(client.sync.status().dirty, 0);
  assert.equal(receiptsHash(server), before); assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM receipts").get().n, 10050);
  assert.equal(JSON.parse(server.db.prepare("SELECT payload FROM reading WHERE document_id='doc-batch'").get().payload).checkpoint, 10050);
});

test("checkpoint packing never splits a mixed business transaction or trims its receipt", async (t) => {
  const h = await fixture(t, "mixed-writer");
  document(h);
  h.db.transaction(() => {
    h.db.prepare("INSERT INTO reading VALUES('doc-batch','{\"position\":1}')").run();
    h.db.prepare("INSERT INTO collections VALUES('atomic-category','Atomic',NULL,1)").run(); receipt(h, "mixed-command", { position: 1 });
  });
  h.db.transaction(() => {
    h.db.prepare("UPDATE reading SET payload='{\"position\":2}' WHERE document_id='doc-batch'").run(); receipt(h, "checkpoint-command", { position: 2 });
  });
  h.sync.capture(); const batch = h.sync.pending().batches[0];
  assert.ok(batch.mutations.some((row) => row.entity === "collections"));
  assert.equal(batch.mutations.filter((row) => row.entity === "receipts").length, 2);
  assert.equal(h.sync.status().dirty, 0);
});
