import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceSync } from "../sync-engine.mjs";
import { projectReadingChanges } from "../reading-projection.mjs";
import { reconcileReadingEvents } from "../sync-reading.mjs";
import { rebuildSyncedReading } from "../sync-reading.mjs";
import { measuredEvent, BASE } from "./reading-projection-fixture.mjs";

async function replica(t, name, mode = "client") {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-reading-sync-"));
  const workspace = await createWorkspace({ dataDir, bootstrap: false, glossaryPath: false });
  const sync = await createWorkspaceSync(workspace, { replicaId: name, mode });
  t.after(async () => { await workspace.close(); assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep)); await rm(dataDir, { recursive: true, force: true }); });
  return { workspace, sync, db: workspace.db };
}
async function pull(client, server) { await client.sync.applyPull(server.sync.pull({ after: client.sync.cursor })); }
async function align(client, server) {
  client.sync.acceptEnrollment(server.sync.enroll(localActor, { replicaId: client.sync.replicaId, requestId: "enroll-" + client.sync.replicaId }));
  await pull(client, server); client.sync.capture();
}
async function drain(client, server) {
  for (let attempt = 0; attempt < 20; attempt++) {
    client.sync.capture(); const batch = client.sync.pending().batches[0]; if (!batch) return;
    const receipt = await server.sync.push(localActor, batch); assert.equal(receipt.accepted, true); client.sync.acknowledge(receipt);
  }
  assert.fail("unexpectedly many reading sync batches");
}
function record(h, id, from, to) {
  h.db.transaction(() => {
    h.db.prepare(`INSERT INTO reading_sessions(id,actor_id,document_id,document_revision,started_ms,start_input,created_at)
      VALUES(?,'local','reading-fixture',1,?,'{}',?)`).run(id, BASE, new Date(BASE).toISOString());
    const row = measuredEvent(id, 1, from, to);
    h.db.prepare("INSERT INTO reading_activity VALUES(?,?,?,?,?,?,?)").run(row.session_id, row.sequence, row.started_ms, row.ended_ms, row.reported_ms, 0, row.input);
    projectReadingChanges(h.db, { inTransaction: true });
  });
}
function state(h) {
  const events = h.db.prepare("SELECT * FROM reading_activity ORDER BY session_id,sequence").all();
  const sessions = h.db.prepare("SELECT * FROM reading_sessions ORDER BY id").all();
  const oracle = reconcileReadingEvents(sessions, events);
  for (const row of oracle.sessions) assert.equal(sessions.find((item) => item.id === row.id).active_ms, row.activeMs);
  for (const row of oracle.accepted) assert.equal(events.find((item) => item.session_id === row.sessionId && item.sequence === row.sequence).accepted_ms, row.activeMs);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM reading_projection_dirty").get().n, 0);
  return { events: events.map((row) => ({ ...row })), sessions: sessions.map((row) => ({ id: row.id, activeMs: row.active_ms, lastActivityMs: row.last_activity_ms })) };
}

test("real sync push/pull converges overlapping offline reading and session updates preserve derived totals", async (t) => {
  const server = await replica(t, "reading-hub", "server"), laptop = await replica(t, "reading-laptop"), desktop = await replica(t, "reading-desktop");
  const timestamp = new Date(BASE).toISOString();
  server.db.prepare("INSERT INTO documents VALUES('reading-fixture',1,1,'{\"title\":\"Synthetic reading sync\"}',NULL,?,?)").run(timestamp, timestamp);
  await align(laptop, server); await align(desktop, server);
  record(laptop, "z-laptop-session", 10000, 25000);
  record(desktop, "a-desktop-session", 0, 15000);
  assert.equal(state(laptop).sessions[0].activeMs, 15000); assert.equal(state(desktop).sessions[0].activeMs, 15000);
  await drain(laptop, server); await drain(desktop, server);
  await pull(laptop, server); await pull(desktop, server);
  assert.deepEqual(state(laptop), state(server)); assert.deepEqual(state(desktop), state(server));
  assert.deepEqual(state(server).sessions.map((row) => row.activeMs), [15000, 10000]);
  laptop.db.transaction(() => laptop.db.prepare("UPDATE reading_sessions SET ended_ms=?,end_input='{}',end_reason='leave' WHERE id='z-laptop-session'").run(BASE + 30000));
  await drain(laptop, server); await pull(desktop, server); await pull(laptop, server);
  assert.deepEqual(state(laptop), state(server)); assert.deepEqual(state(desktop), state(server));
  assert.deepEqual(state(server).sessions.map((row) => row.activeMs), [15000, 10000], "a session close must not replace derived totals with insertion defaults");
  const previous = state(server);
  await pull(laptop, server); await pull(desktop, server);
  assert.deepEqual(state(server), previous);
  for (const h of [laptop, desktop]) {
    h.sync.capture(); assert.equal(h.sync.pending().batches.length, 0, "projection-only acceptance changes must not create a replicated mutation");
  }
});

test("a real dense sync push rolls back its entire receiver group and retains the exact sender outbox", async (t) => {
  const server = await replica(t, "dense-hub", "server"), client = await replica(t, "dense-offline");
  const timestamp = new Date(BASE).toISOString();
  server.db.prepare("INSERT INTO documents VALUES('reading-fixture',1,1,'{\"title\":\"Synthetic dense sync\"}',NULL,?,?)").run(timestamp, timestamp);
  await align(client, server);
  server.db.transaction(() => {
    server.db.prepare(`INSERT INTO reading_sessions(id,actor_id,document_id,document_revision,started_ms,start_input,created_at)
      VALUES('dense-existing','local','reading-fixture',1,?,'{}',?)`).run(BASE, timestamp);
    const insert = server.db.prepare("INSERT INTO reading_activity VALUES(?,?,?,?,?,?,?)");
    for (let sequence = 1; sequence <= 4096; sequence++) {
      const row = measuredEvent("dense-existing", sequence, 0, 15000);
      insert.run(row.session_id, row.sequence, row.started_ms, row.ended_ms, row.reported_ms, 0, row.input);
    }
    rebuildSyncedReading(server.db, { inTransaction: true });
  });
  record(client, "offline-pending", 10000, 25000);
  client.sync.capture(); const batch = client.sync.pending().batches[0]; assert.ok(batch);
  const head = server.sync.manifest().head;
  await assert.rejects(server.sync.push(localActor, batch), { code: "READING_PROJECTION_BUDGET", status: 503 });
  assert.deepEqual(client.sync.pending().batches[0], batch);
  assert.equal(server.sync.head, head, "the rejected event has no receiver journal acknowledgement");
  assert.equal(server.db.prepare("SELECT id FROM reading_sessions WHERE id='offline-pending'").get(), undefined);
  assert.equal(client.db.prepare("SELECT COUNT(*) AS n FROM reading_activity WHERE session_id='offline-pending'").get().n, 1);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM reading_activity").get().n, 4096);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM reading_projection_dirty").get().n, 0);
  assert.equal(server.db.prepare("SELECT active_ms FROM reading_sessions WHERE id='dense-existing'").get().active_ms, 15000);
  server.workspace.options.readingProjectionLimits = { windowLimit: 8192 };
  const receipt = await server.sync.push(localActor, batch);
  assert.equal(receipt.accepted, true); client.sync.acknowledge(receipt);
  assert.equal(server.db.prepare("SELECT active_ms FROM reading_sessions WHERE id='offline-pending'").get().active_ms, 10000);
  client.workspace.options.readingProjectionLimits = { windowLimit: 8192 };
  await pull(client, server);
  assert.deepEqual(state(client), state(server), "an explicitly raised bound retries the same immutable batch and converges");
});
