import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceSync } from "../sync-engine.mjs";
import { createWorkspaceSyncClient } from "../sync-client.mjs";
import { canonical } from "../errors.mjs";
import { projectReadingChanges } from "../reading-projection.mjs";
import { createVisiblePoller } from "../../../prototypes/insight-composer/src/visible-poller.js";

const connection = { origin: "https://cadence.example", token: "synthetic-cadence-only" };
const settle = () => new Promise(resolve => setImmediate(resolve));
function scheduler() {
  let time = Date.UTC(2026, 9, 24, 12), serial = 0; const timers = new Map();
  const first = () => [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
  return {
    timers, now: () => time, random: () => 0.5,
    setTimer(fn, delay) { const id = ++serial; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    // Deterministic network/processing time, independent of the scheduling
    // deadline. This is a latency-budget test, not a real-cloud benchmark.
    elapse(ms) { time += ms; },
    async advance(ms) {
      const until = time + ms;
      while (timers.size && first()[1].at <= until) {
        const [id, timer] = first(); timers.delete(id); time = Math.max(time, timer.at);
        await timer.fn(); await settle();
      }
      time = Math.max(time, until);
    },
  };
}
async function replica(t, id, mode = "client") {
  const directory = await mkdtemp(join(tmpdir(), "reader-sync-cadence-"));
  const workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  const engine = await createWorkspaceSync(workspace, { replicaId: id, mode });
  const result = { workspace, engine, directory, db: workspace.db };
  t.after(async () => {
    await result.client?.stop();
    await workspace.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "reader-sync-cadence-"));
    await rm(directory, { recursive: true, force: true });
  });
  return result;
}
async function align(replica, server) {
  replica.engine.acceptEnrollment(server.engine.enroll(localActor, { replicaId: replica.engine.replicaId, requestId: "enroll-" + replica.engine.replicaId }));
  await replica.engine.applyPull(server.engine.pull({ after: replica.engine.cursor })); replica.engine.capture();
}

test("durable facts and exact receipts reach another replica within two minute windows plus transfer and view time", async t => {
  const clock = scheduler(), server = await replica(t, "cadence-server", "server");
  const source = await replica(t, "cadence-source"), destination = await replica(t, "cadence-destination");
  const measuredStart = clock.now() - 15000, created = new Date(measuredStart).toISOString();
  server.db.transaction(() => {
    server.db.prepare("INSERT INTO documents VALUES('cadence-doc',1,1,'{\"title\":\"Cadence fixture\"}',NULL,?,?)").run(created, created);
    server.db.prepare("INSERT INTO reading_sessions(id,actor_id,document_id,document_revision,started_ms,start_input,created_at) VALUES('cadence-session','local','cadence-doc',1,?,'{}',?)").run(measuredStart, created);
  });
  await align(source, server); await align(destination, server);
  const requests = [], pushTimes = [];
  function transport(name) {
    const request = async (kind, operation) => { requests.push({ name, kind, at: clock.now() }); clock.elapse(100); return operation(); };
    return {
      manifest: () => request("manifest", () => server.engine.manifest()),
      push: batch => request("push", async () => { const result = await server.engine.push(localActor, batch); pushTimes.push(clock.now()); return result; }),
      pull: ({ after, limit }) => request("pull", () => server.engine.pull({ after, limit })),
    };
  }
  const clients = [];
  for (const [replica, name] of [[source, "source"], [destination, "destination"]]) {
    const client = await createWorkspaceSyncClient(replica.workspace, { ...connection, ...clock, engine: replica.engine, transport: transport(name) });
    clients.push(client); replica.client = client; client.start();
  }
  let visibleAt, visibleRevision = await destination.workspace.meta("revision");
  const poller = createVisiblePoller({ ...clock, intervalMs: 2000, maxIntervalMs: 2000, isVisible: () => true,
    run: async () => {
      const revision = await destination.workspace.meta("revision");
      if (revision === visibleRevision) return false;
      visibleRevision = revision;
      if (destination.db.prepare("SELECT id FROM collections WHERE label='Visible promptly'").get()
        && destination.db.prepare("SELECT sequence FROM reading_activity WHERE session_id='cadence-session'").get()) visibleAt ??= clock.now();
      return true;
    },
  });
  poller.start(); t.after(() => poller.dispose());
  await clock.advance(180000);
  assert.equal(requests.filter(request => request.kind !== "manifest").length, 0, "long idle performs no empty upload or empty pull");
  const committedAt = clock.now();
  const command = { kind: "collection.create", requestId: "cadence-command", label: "Visible promptly" };
  const receipt = await source.workspace.execute(localActor, command);
  source.db.transaction(() => {
    source.db.prepare("INSERT INTO reading_activity VALUES('cadence-session',1,?,?,15000,0,?)")
      .run(measuredStart, measuredStart + 15000, canonical({ startedAt: created, endedAt: new Date(measuredStart + 15000).toISOString(), activeMs: 15000 }));
    projectReadingChanges(source.db, { inTransaction: true });
  });
  // A second physical connection sees committed business data, facts and the
  // durable dirty queue before any scheduled network timer has run.
  const disk = new DatabaseSync(join(source.directory, "workspace.sqlite"), { readOnly: true });
  try {
    assert.equal(disk.prepare("SELECT COUNT(*) AS n FROM collections WHERE label='Visible promptly'").get().n, 1);
    assert.equal(disk.prepare("SELECT COUNT(*) AS n FROM reading_activity").get().n, 1);
    assert.ok(disk.prepare("SELECT COUNT(*) AS n FROM sync_dirty").get().n > 0);
    assert.equal(JSON.parse(disk.prepare("SELECT payload FROM receipts WHERE request_id='cadence-command'").get().payload).requestId, receipt.requestId);
  } finally { disk.close(); }
  assert.equal(pushTimes.length, 0);
  await clock.advance(123000);
  assert.equal(pushTimes.length, 1); assert.ok(pushTimes[0] - committedAt <= 60300);
  assert.ok(visibleAt !== undefined && visibleAt - committedAt <= 123000, "two 60-second schedule windows plus measured synthetic requests and the 2-second view poll fit the target");
  assert.deepEqual(await destination.workspace.execute(localActor, command), receipt, "the receiving device has the exact original business receipt");
  assert.equal(destination.db.prepare("SELECT active_ms FROM reading_sessions WHERE id='cadence-session'").get().active_ms, 15000);
  assert.equal(destination.engine.cursor, server.engine.head);
  const count = pushTimes.length; await clock.advance(30000); assert.equal(pushTimes.length, count);
  t.diagnostic(`Synthetic latency: durable commit to upload ${pushTimes[0] - committedAt} ms; visible receiver ${visibleAt - committedAt} ms; each cloud request assumes 100 ms.`);
});
