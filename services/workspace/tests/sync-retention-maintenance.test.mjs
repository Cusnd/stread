import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceSync } from "../sync-engine.mjs";
import { canonical, hash } from "../errors.mjs";
import { rowHash } from "../sync-schema.mjs";
import { maintainSyncRetention, SYNC_RETENTION_ROOTS } from "../sync-retention-maintenance.mjs";

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "reader-sync-retention-"));
  let workspace, engine;
  const open = async () => {
    workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
    engine = await createWorkspaceSync(workspace, { replicaId: "retention-replica", mode: "client", ...options });
  };
  await open();
  t.after(async () => {
    await workspace.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith("reader-sync-retention-"));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, get workspace() { return workspace; }, get engine() { return engine; }, get db() { return workspace.db; },
    async restart() { await workspace.close(); await open(); } };
}

function source(states, snapshotId = "retention-snapshot") {
  const historyId = "retention-history", sequence = 7;
  const page = Buffer.from(JSON.stringify({ format: "reader-sync-snapshot-chunk-1", snapshotId, historyId, sequence, index: 0, states }));
  const manifest = { format: "reader-sync-snapshot-1", snapshotId, historyId, sequence, entityCount: states.length,
    chunks: [{ index: 0, sha256: hash(page), size: page.length, rowCount: states.length }] };
  const bytes = Buffer.from(JSON.stringify(manifest));
  return { page, manifest, reference: { snapshotId, sequence, sha256: hash(bytes), size: bytes.length },
    transport: { snapshotDescriptor: async () => bytes, snapshotChunk: async () => page } };
}
const collection = (id, label = id) => { const value = { id, label, parent_id: null, version: 1 }; return { entity: "collections", key: JSON.stringify([id]), version: 1, hash: rowHash(value), value }; };
const restore = (h, value, options = {}) => h.engine.restoreSnapshot({ reference: value.reference, historyId: value.manifest.historyId,
  head: value.manifest.sequence, transport: value.transport, download: async () => {}, ...options });

async function stageSchema(h) {
  const value = source([collection("schema-only")]);
  await assert.rejects(restore(h, value, { transport: { snapshotDescriptor: async () => { throw new Error("schema initialized"); } } }), /schema initialized/);
}
const large = label => ({ label, text: "汉🙂".repeat(14000) });
const parts = h => h.db.prepare("SELECT digest,part,value FROM sync_payloads ORDER BY digest,part").all();
const persisted = h => canonical(Object.fromEntries(["receipts", "sync_outbox", "sync_entities", "sync_conflicts", "sync_conflict_history", "sync_receipts", "sync_journal", "collections", "reading_activity"].map(table => [table, h.db.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()])));

function insertRoot(h, root, payload, value) {
  const { db, engine } = h;
  switch (root.table) {
    case "sync_state": engine.setState("retention-test-root", payload); break;
    case "sync_client_state": db.exec("CREATE TABLE IF NOT EXISTS sync_client_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)"); db.prepare("INSERT INTO sync_client_state VALUES('test-root',?)").run(payload); break;
    case "sync_devices": db.prepare("INSERT INTO sync_devices VALUES('test-device','test-enroll',?)").run(payload); break;
    case "sync_entities": db.prepare("INSERT INTO sync_entities VALUES('collections','[\"test-root\"]',1,?,?)").run(rowHash(value), payload); break;
    case "sync_journal": db.prepare("INSERT INTO sync_journal VALUES(1,'device','test-push',?,'test-time')").run(payload); break;
    case "sync_receipts": db.prepare("INSERT INTO sync_receipts VALUES('device','test-push',?,?)").run(hash("request"), payload); break;
    case "sync_outbox": db.prepare("INSERT INTO sync_outbox VALUES('test-push',?,'pending','test-time')").run(payload); break;
    case "sync_conflicts": db.prepare("INSERT INTO sync_conflicts VALUES('test-conflict',1,'resolved',?,'test-time')").run(payload); break;
    case "sync_conflict_history": db.prepare("INSERT INTO sync_conflict_history VALUES('test-conflict',1,?)").run(payload); break;
    case "sync_snapshot_stages": db.prepare("INSERT INTO sync_snapshot_stages VALUES('test-stage','test-history',1,?,1,?,'receiving')").run(hash("descriptor"), payload); break;
    case "sync_snapshot_chunks": db.prepare("INSERT INTO sync_snapshot_chunks VALUES('test-stage',0,?,0)").run(payload); break;
    case "sync_snapshot_rows": db.prepare("INSERT INTO sync_snapshot_rows VALUES('test-stage','collections','[\"root\"]',0,?)").run(payload); break;
    case "sync_snapshot_indexes": db.prepare("INSERT INTO sync_snapshot_indexes VALUES('test-stage','test-document',1,?,?)").run(hash("index"), payload); break;
    default: assert.fail("Root fixture missing " + root.table);
  }
}

test("GC proves every persistent root, keeps shared digests, and only deletes unreferenced complete payloads", async t => {
  const h = await fixture(t); await stageSchema(h);
  const values = [];
  for (const root of SYNC_RETENTION_ROOTS) {
    const value = large(root.table), payload = h.engine.encode(value);
    assert.ok(JSON.parse(payload).$readerSyncPayload);
    insertRoot(h, root, payload, value); values.push({ root, payload, value });
  }
  const orphan = h.engine.encode(large("unreferenced")), orphanDigest = JSON.parse(orphan).$readerSyncPayload.digest;
  const before = persisted(h), result = maintainSyncRetention(h.engine, { maxPayloadParts: 1000 });
  assert.equal(result.payloads.proof, "complete"); assert.equal(result.payloads.liveDigests, values.length);
  assert.equal(result.payloads.digestsDeleted, 1); assert.ok(result.payloads.partsDeleted > 0);
  assert.equal(h.db.prepare("SELECT 1 FROM sync_payloads WHERE digest=?").get(orphanDigest), undefined);
  assert.equal(persisted(h), before);
  for (const { payload, value } of values) assert.deepEqual(h.engine.decode(payload), value);
  await h.restart();
  for (const { payload, value } of values) assert.deepEqual(h.engine.decode(payload), value);
});

test("terminal staging is bounded and restartable, retains shared live payloads and installation guards", async t => {
  const h = await fixture(t); await stageSchema(h);
  const sharedValue = large("shared live outbox"), shared = h.engine.encode(sharedValue), own = h.engine.encode(large("staging only"));
  h.db.prepare("INSERT INTO sync_outbox VALUES('frozen',?,'pending','test-time')").run(shared);
  h.db.prepare("INSERT INTO sync_snapshot_stages VALUES('done','history',5,?,1,?,'installed')").run(hash("descriptor"), own);
  h.db.prepare("INSERT INTO sync_snapshot_chunks VALUES('done',0,?,1)").run(shared);
  for (let i = 0; i < 5; i++) h.db.prepare("INSERT INTO sync_snapshot_rows VALUES('done','collections',?,0,?)").run(JSON.stringify([i]), own);
  h.engine.setState("snapshotInstalled", "done"); h.engine.setState("historyId", "history"); h.engine.setState("cursor", 5); h.engine.setState("importComplete", "1");
  const before = persisted(h), first = maintainSyncRetention(h.engine, { maxStageRows: 2, maxPayloadParts: 1000 });
  assert.equal(first.stages.rowsDeleted, 2); assert.equal(first.stages.stagesDeleted, 0); assert.equal(first.stages.hasMore, true);
  assert.deepEqual(h.engine.decode(shared), sharedValue); assert.equal(h.engine.state("snapshotInstalled"), "done");
  await h.restart();
  for (let i = 0; i < 5 && h.db.prepare("SELECT 1 FROM sync_snapshot_stages").get(); i++) maintainSyncRetention(h.engine, { maxStageRows: 2, maxPayloadParts: 1000 });
  assert.equal(h.db.prepare("SELECT 1 FROM sync_snapshot_stages").get(), undefined);
  assert.equal(h.db.prepare("SELECT 1 FROM sync_snapshot_rows").get(), undefined);
  assert.equal(h.engine.cursor, 5); assert.equal(h.engine.state("historyId"), "history"); assert.equal(h.engine.state("snapshotInstalled"), "done");
  assert.equal(h.engine.canInstallSnapshot(), false); assert.equal(persisted(h), before);
  assert.deepEqual(h.engine.decode(shared), sharedValue);
  assert.equal(h.db.prepare("SELECT 1 FROM sync_payloads WHERE digest=?").get(JSON.parse(own).$readerSyncPayload.digest), undefined);
});

test("receiving stages and installed stages without matching durable guards remain intact", async t => {
  const h = await fixture(t); await stageSchema(h);
  for (const status of ["receiving", "installed"]) {
    const payload = h.engine.encode(large(status));
    h.db.prepare("INSERT INTO sync_snapshot_stages VALUES(?, 'history',5,?,1,?,?)").run(status, hash(status), payload, status);
    h.db.prepare("INSERT INTO sync_snapshot_chunks VALUES(?,0,?,1)").run(status, payload);
  }
  const before = canonical(parts(h)), result = maintainSyncRetention(h.engine);
  assert.equal(result.stages.rowsDeleted, 0); assert.equal(result.stages.blocked[0].code, "SYNC_RETENTION_STAGE_GUARD");
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sync_snapshot_stages").get().n, 2);
  assert.equal(canonical(parts(h)), before);
});

test("unknown tables, columns and markers or exhausted proof budgets fail closed", async t => {
  for (const kind of ["table", "column", "marker", "malformed", "array_digest", "rows", "bytes"]) await t.test(kind, async t => {
    const h = await fixture(t); h.engine.encode(large("orphan"));
    let options = {};
    if (kind === "table") h.db.exec("CREATE TABLE sync_future(payload TEXT)");
    if (kind === "column") h.db.exec("ALTER TABLE sync_outbox ADD COLUMN future_payload TEXT");
    if (kind === "marker" || kind === "malformed") h.db.prepare("INSERT INTO sync_outbox VALUES('unknown',?,'pending','time')").run(kind === "marker" ? '{"$readerSyncFuture":{"digest":"unknown"}}' : '{"$readerSyncPayload":');
    if (kind === "array_digest") h.db.prepare("INSERT INTO sync_outbox VALUES('unknown',?,'pending','time')").run(JSON.stringify({ $readerSyncPayload: { digest: [parts(h)[0].digest], length: 1 } }));
    if (kind === "rows") options = { maxRootRows: 1 };
    if (kind === "bytes") options = { maxRootBytes: 1 };
    const before = canonical(parts(h)), result = maintainSyncRetention(h.engine, options);
    assert.equal(result.payloads.proof, "blocked"); assert.equal(result.payloads.partsDeleted, 0);
    assert.equal(canonical(parts(h)), before);
  });
});

test("large orphan digests are never partially deleted or later mistaken for complete payloads", async t => {
  const h = await fixture(t), value = large("indivisible"), encoded = h.engine.encode(value), before = canonical(parts(h));
  const result = maintainSyncRetention(h.engine, { maxPayloadParts: 1 });
  assert.equal(result.payloads.partsDeleted, 0); assert.equal(result.payloads.blocked.reason, "indivisible_payload");
  assert.equal(canonical(parts(h)), before); assert.equal(h.engine.encode(value), encoded); assert.deepEqual(h.engine.decode(encoded), value);
  const complete = maintainSyncRetention(h.engine, { maxPayloadParts: 100 });
  assert.equal(complete.payloads.digestsDeleted, 1); assert.equal(parts(h).length, 0);
  assert.deepEqual(h.engine.decode(h.engine.encode(value)), value);
});

test("maintenance rolls back staging cleanup and prior digest deletions when storage fails", async t => {
  const h = await fixture(t); await stageSchema(h);
  h.db.prepare("INSERT INTO sync_snapshot_stages VALUES('abandoned','history',1,?,1,'{}','abandoned')").run(hash("stage"));
  h.db.prepare("INSERT INTO sync_snapshot_chunks VALUES('abandoned',0,'{}',0)").run();
  h.engine.encode(large("one")); h.engine.encode(large("two"));
  const before = canonical(parts(h)), prepare = h.db.prepare.bind(h.db); let deletions = 0;
  h.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql === "DELETE FROM sync_payloads WHERE digest=?") return { ...statement, run: (...args) => { if (++deletions === 2) throw new Error("simulated storage failure"); return statement.run(...args); } };
    return statement;
  };
  assert.throws(() => maintainSyncRetention(h.engine, { maxPayloadParts: 1000 }), /simulated storage failure/);
  h.db.prepare = prepare;
  assert.equal(canonical(parts(h)), before); assert.ok(h.db.prepare("SELECT 1 FROM sync_snapshot_stages").get()); assert.ok(h.db.prepare("SELECT 1 FROM sync_snapshot_chunks").get());
  await h.restart(); assert.equal(canonical(parts(h)), before);
  const retried = maintainSyncRetention(h.engine, { maxPayloadParts: 1000 });
  assert.equal(retried.payloads.digestsDeleted, 2); assert.equal(retried.stages.stagesDeleted, 1);
});

test("real business receipts and immutable outboxes replay exactly after maintenance and restart", async t => {
  const h = await fixture(t, { currentValues: true });
  const command = { kind: "collection.create", requestId: "exact-business-request", label: "Preserved exact receipt" };
  const receipt = await h.workspace.execute(localActor, command);
  h.engine.capture(); const frozen = h.engine.pending().batches[0], before = persisted(h), revision = h.workspace.meta("revision");
  h.engine.encode(large("orphan"));
  assert.equal(maintainSyncRetention(h.engine).payloads.proof, "complete");
  assert.equal(persisted(h), before); assert.deepEqual(h.engine.pending().batches[0], frozen);
  await h.restart();
  assert.deepEqual(await h.workspace.execute(localActor, command), receipt);
  assert.deepEqual(h.engine.pending().batches[0], frozen); assert.equal(h.workspace.meta("revision"), revision);
  await assert.rejects(h.workspace.execute(localActor, { ...command, label: "Changed input" }), { code: "IDEMPOTENCY_CONFLICT" });
});

test("a lost accepted response replays its exact chunked sync receipt after both replicas are maintained and restarted", async t => {
  const server = await fixture(t, { replicaId: "retention-authority", mode: "server" }), client = await fixture(t, { currentValues: true });
  server.engine.capture();
  client.engine.acceptEnrollment(server.engine.enroll(localActor, { replicaId: client.engine.replicaId, requestId: "retention-enrollment" }));
  await client.engine.applyPull(server.engine.pull({ after: 0 }));
  const command = { kind: "collection.create", requestId: "lost-response-business", label: "Exact original label" };
  const business = await client.workspace.execute(localActor, command);
  // A synthetic large scalar exercises the existing wire/chunk path. The
  // business receipt remains the exact original small command response.
  client.db.prepare("UPDATE collections SET label=?,version=version+1 WHERE id=?").run(large("wire").text, business.collection.id);
  client.engine.capture(); const frozen = client.engine.pending().batches[0];
  const accepted = await server.engine.push(localActor, frozen), head = server.engine.head;
  assert.equal(accepted.accepted, true);
  assert.ok(JSON.parse(server.db.prepare("SELECT payload FROM sync_receipts WHERE request_id=?").get(frozen.requestId).payload).$readerSyncPayload);
  const beforeServer = persisted(server), beforeClient = persisted(client);
  for (const h of [server, client]) {
    h.engine.encode(large("unreferenced-" + h.engine.replicaId));
    assert.equal(maintainSyncRetention(h.engine, { maxPayloadParts: 1000 }).payloads.proof, "complete");
  }
  assert.equal(persisted(server), beforeServer); assert.equal(persisted(client), beforeClient);
  await server.restart(); await client.restart();
  assert.deepEqual(client.engine.pending().batches[0], frozen);
  const replay = await server.engine.push(localActor, frozen);
  assert.deepEqual(replay, accepted); assert.equal(server.engine.head, head);
  client.engine.acknowledge(replay); await client.engine.applyPull(server.engine.pull({ after: client.engine.cursor }));
  assert.equal(client.engine.cursor, head); assert.equal(client.engine.pending().batches.length, 0);
  assert.deepEqual(await client.workspace.execute(localActor, command), business);
  assert.deepEqual(await server.workspace.execute(localActor, command), business);
});

test("current-row markers are accepted only at their matching known-state root without hydrating them", async t => {
  const h = await fixture(t, { currentValues: true });
  const state = collection("borrowed", "Long enough current state ".repeat(50));
  h.db.prepare("INSERT INTO collections VALUES(?,?,NULL,1)").run(state.value.id, state.value.label);
  h.engine.remember(state.entity, state.key, state);
  const stored = h.db.prepare("SELECT value FROM sync_entities WHERE entity=? AND key=?").get(state.entity, state.key).value;
  assert.ok(JSON.parse(stored).$readerSyncCurrent);
  h.engine.encode(large("orphan"));
  assert.equal(maintainSyncRetention(h.engine).payloads.proof, "complete"); assert.deepEqual(h.engine.known(state.entity, state.key).value, state.value);
  h.engine.encode(large("second orphan"));
  h.db.prepare("INSERT INTO sync_outbox VALUES('invalid-place',?,'pending','time')").run(stored);
  const before = canonical(parts(h)), result = maintainSyncRetention(h.engine);
  assert.equal(result.payloads.proof, "blocked"); assert.equal(canonical(parts(h)), before);
});

test("local work during a snapshot download survives abandonment, maintenance and late completion", async t => {
  const h = await fixture(t), value = source([collection("remote")]);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const chunk = value.transport.snapshotChunk;
  value.transport.snapshotChunk = async (...args) => { entered(); await gate; return chunk(...args); };
  const attempt = restore(h, value); await waiting;
  const command = { kind: "collection.create", requestId: "concurrent-local", label: "Keep my local work" };
  const receipt = await h.workspace.execute(localActor, command); h.engine.capture(); const frozen = h.engine.pending().batches[0];
  h.db.prepare("UPDATE sync_snapshot_stages SET status='abandoned' WHERE status='receiving'").run();
  assert.equal(maintainSyncRetention(h.engine).stages.stagesDeleted, 1);
  release(); assert.deepEqual(await attempt, { installed: false, abandoned: true });
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sync_snapshot_chunks").get().n, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM collections").get().n, 1);
  assert.deepEqual(h.engine.pending().batches[0], frozen); assert.equal(h.engine.cursor, 0);
  await h.restart(); assert.deepEqual(await h.workspace.execute(localActor, command), receipt); assert.deepEqual(h.engine.pending().batches[0], frozen);
});

test("late object preparation cannot revive chunks of a cleaned terminal snapshot", async t => {
  const h = await fixture(t), value = source([collection("remote")]);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  h.engine.ensureObjects = async () => { entered(); await gate; };
  const attempt = restore(h, value); await waiting;
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sync_snapshot_chunks").get().n, 1);
  const command = { kind: "collection.create", requestId: "local-while-preparing", label: "Keep prepared local work" };
  await h.workspace.execute(localActor, command);
  h.db.prepare("UPDATE sync_snapshot_stages SET status='abandoned' WHERE status='receiving'").run();
  const cleaned = maintainSyncRetention(h.engine); assert.equal(cleaned.stages.stagesDeleted, 1);
  release(); assert.deepEqual(await attempt, { installed: false, abandoned: true });
  for (const table of ["sync_snapshot_stages", "sync_snapshot_rows", "sync_snapshot_chunks", "sync_snapshot_indexes"]) assert.equal(h.db.prepare("SELECT COUNT(*) n FROM " + table).get().n, 0);
  assert.equal(h.engine.cursor, 0); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM collections").get().n, 1);
});

test("completed snapshots keep all installed state and reject reinstallation after explicit cleanup and restart", async t => {
  const h = await fixture(t), value = source([collection("remote", "Original snapshot row")]);
  assert.equal((await restore(h, value)).installed, true);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sync_snapshot_stages").get().n, 1, "local defaults do not automatically clean staging");
  const before = persisted(h), revision = h.workspace.meta("revision");
  assert.equal(maintainSyncRetention(h.engine).stages.stagesDeleted, 1);
  assert.equal(persisted(h), before); await h.restart();
  assert.deepEqual(await restore(h, value), { installed: false, abandoned: true });
  assert.equal(h.workspace.meta("revision"), revision); assert.equal(h.engine.cursor, value.manifest.sequence);
  assert.equal(h.engine.state("snapshotInstalled"), value.manifest.snapshotId); assert.equal(persisted(h), before);
});
