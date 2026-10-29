import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceSync, collectSyncObjects } from "../sync-engine.mjs";
import { handleWorkspaceSync } from "../sync-http.mjs";

async function fixture(t, name, mode = "client", beforeSync) {
  const directory = await mkdtemp(join(tmpdir(), "reader-sync-"));
  const workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  if (beforeSync) await beforeSync(workspace);
  const sync = await createWorkspaceSync(workspace, { replicaId: name, mode });
  t.after(async () => { await workspace.close(); await rm(directory, { recursive: true, force: true }); });
  return { workspace, sync, db: workspace.db, directory };
}
const addCollection = (h, id, label, parent = null) => h.db.prepare("INSERT INTO collections VALUES(?,?,?,1)").run(id, label, parent);
const editCollection = (h, id, label) => h.db.prepare("UPDATE collections SET label=?,version=version+1 WHERE id=?").run(label, id);
const collection = (h, id) => h.db.prepare("SELECT * FROM collections WHERE id=?").get(id);
async function push(client, server) {
  client.sync.capture();
  const batch = client.sync.pending().batches[0]; assert.ok(batch);
  const receipt = await server.sync.push(localActor, batch); client.sync.acknowledge(receipt);
  return { batch, receipt };
}
async function pull(client, server) { const batch = server.sync.pull({ after: client.sync.cursor }); await client.sync.applyPull(batch); return batch; }
async function align(client, server) { client.sync.acceptEnrollment(server.sync.enroll(localActor, { replicaId: client.sync.replicaId, requestId: "enroll-" + client.sync.replicaId })); await pull(client, server); client.sync.capture(); }

test("durable outbox preserves offline edits after capture and pushes once with stable identities", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop");
  await align(client, server);
  addCollection(client, "collection-offline", "First title");
  client.sync.capture();
  const first = client.sync.pending().batches[0];
  editCollection(client, "collection-offline", "Second title while offline");
  assert.equal(client.sync.capture().captured, false);
  const result = await server.sync.push(localActor, first);
  assert.equal(result.accepted, true); assert.equal(collection(server, "collection-offline").label, "First title");
  assert.deepEqual(await server.sync.push(localActor, first), result);
  client.sync.acknowledge(result);
  const next = await push(client, server);
  assert.equal(next.receipt.accepted, true); assert.notEqual(next.batch.requestId, first.requestId);
  assert.equal(next.batch.mutations.find((item) => item.entity === "collections").expected.version, 1);
  assert.equal(collection(server, "collection-offline").label, "Second title while offline");
  await pull(client, server); assert.equal(client.sync.status().conflicts, 0);
  assert.equal(client.sync.cursor, server.sync.head);
  const restart = await createWorkspaceSync(client.workspace, { replicaId: "laptop", mode: "client" });
  assert.equal(restart.cursor, server.sync.head); assert.equal(restart.status().pending, 0);
});

test("CAS detects ABA, keeps both conflict versions and requires an explicit resolution", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop");
  addCollection(server, "shared", "A"); await align(client, server);
  editCollection(client, "shared", "Local proposal"); client.sync.capture(); const batch = client.sync.pending().batches[0];
  editCollection(server, "shared", "B"); server.sync.capture(); editCollection(server, "shared", "A"); server.sync.capture();
  const rejected = await server.sync.push(localActor, batch); assert.equal(rejected.accepted, false);
  assert.ok(rejected.conflicts[0].actual.version > rejected.conflicts[0].expected.version);
  client.sync.acknowledge(rejected);
  await pull(client, server);
  assert.equal(collection(client, "shared").label, "Local proposal"); assert.equal(collection(server, "shared").label, "A");
  const conflict = client.sync.conflicts().conflicts[0];
  await client.sync.resolveConflict({ id: conflict.id, expectedVersion: conflict.version, choice: "local" });
  const resolved = await push(client, server); assert.equal(resolved.receipt.accepted, true);
  assert.equal(collection(server, "shared").label, "Local proposal");
  assert.equal(client.sync.conflicts({ includeResolved: true }).conflicts[0].resolution, "local");
});

test("tombstones survive pulls and reject an old offline edit instead of reviving deleted rows", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop"), second = await fixture(t, "second");
  addCollection(server, "removed", "Remove me"); await align(client, server); await align(second, server);
  editCollection(client, "removed", "Old offline title"); client.sync.capture();
  server.db.prepare("DELETE FROM collections WHERE id=?").run("removed");
  await pull(second, server); assert.equal(collection(second, "removed"), undefined);
  const known = second.sync.known("collections", '["removed"]'); assert.equal(known.value, null); assert.equal(known.version, 2);
  const rejected = await push(client, server); assert.equal(rejected.receipt.accepted, false); assert.equal(collection(server, "removed"), undefined);
  const conflict = client.sync.conflicts().conflicts[0];
  await client.sync.resolveConflict({ id: conflict.id, expectedVersion: 1, choice: "remote" });
  assert.equal(collection(client, "removed"), undefined);
});

test("pull groups are atomic and cursor gaps cannot skip cloud history", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop");
  await align(client, server);
  server.db.transaction(() => { addCollection(server, "parent", "Parent"); addCollection(server, "child", "Child", "parent"); });
  const page = server.sync.pull({ after: client.sync.cursor, limit: 1 });
  assert.equal(page.transactions.length, 1); assert.equal(page.transactions[0].mutations.length, 2);
  await assert.rejects(client.sync.applyPull({ ...page, transactions: page.transactions.map((item) => ({ ...item, sequence: item.sequence + 1 })), nextCursor: page.nextCursor + 1 }), { code: "SYNC_CURSOR" });
  assert.equal(collection(client, "parent"), undefined);
  await client.sync.applyPull(page); assert.equal(collection(client, "child").parent_id, "parent");
  editCollection(client, "parent", "Local parent");
  server.db.transaction(() => { editCollection(server, "parent", "Cloud parent"); editCollection(server, "child", "Cloud child"); });
  await pull(client, server); assert.equal(collection(client, "parent").label, "Local parent"); assert.equal(collection(client, "child").label, "Child", "a conflicting transaction cannot partially apply");
  const conflict = client.sync.conflicts().conflicts[0];
  await client.sync.resolveConflict({ id: conflict.id, expectedVersion: 1, choice: "remote" });
  assert.equal(collection(client, "parent").label, "Cloud parent"); assert.equal(collection(client, "child").label, "Cloud child");
});

test("each enrolled device receives disjoint persistent reference ranges without skipping initial pull", async (t) => {
  const server = await fixture(t, "server", "server"), first = await fixture(t, "one"), second = await fixture(t, "two");
  const one = server.sync.enroll(localActor, { replicaId: "one", requestId: "enroll-one" }), two = server.sync.enroll(localActor, { replicaId: "two", requestId: "enroll-two" });
  first.sync.acceptEnrollment(one); second.sync.acceptEnrollment(two);
  assert.equal(first.sync.cursor, 0); assert.equal(second.sync.cursor, 0);
  for (const series of ["Q", "N", "R"]) assert.ok(one.referenceRanges[series].end < two.referenceRanges[series].start);
  assert.equal(first.sync.allocateReference("Q"), "#Q" + one.referenceRanges.Q.start);
  first.sync.acceptEnrollment(one);
  assert.equal(first.sync.allocateReference("Q"), "#Q" + (one.referenceRanges.Q.start + 1));
  assert.deepEqual(server.sync.enroll(localActor, { replicaId: "one", requestId: "retry-enroll" }), one);
  assert.equal(first.sync.status().enrolled, true);
});

test("immutable dependencies must arrive before metadata publication and are recursively enumerated", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop"); await align(client, server);
  const source = await client.workspace.upload(localActor, Buffer.from("preserved source bytes"), { filename: "source.txt", mediaType: "text/plain" });
  client.sync.capture(); const batch = client.sync.pending().batches[0];
  assert.equal(batch.objects.length, 1); assert.equal(batch.objects[0].sha256, source.sha256);
  await assert.rejects(server.sync.push(localActor, batch), { code: "SYNC_OBJECTS_MISSING" });
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM files").get().count, 0);
  await server.workspace.resources.put(await client.workspace.resources.read(source.sha256), { filename: "source.txt", mediaType: "text/plain" });
  const accepted = await server.sync.push(localActor, batch); assert.equal(accepted.accepted, true);
  const ref = await client.workspace.resources.putObject({ deep: { immutable: true } });
  assert.deepEqual(collectSyncObjects({ payload: JSON.stringify({ nested: [{ $readerObject: ref }] }) }).map((item) => item.sha256), [ref.sha256]);
});

test("sync HTTP exposes bounded authenticated manifests, receipts and conflict controls", async (t) => {
  const h = await fixture(t, "server", "server");
  const result = await handleWorkspaceSync(new Request("https://reader.test/api/sync/manifest"), { sync: h.sync, actor: localActor });
  assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store");
  const manifest = await result.json(); assert.equal(manifest.protocolVersion, 1); assert.ok(manifest.workspaceId.startsWith("workspace-"));
  await assert.rejects(handleWorkspaceSync(new Request("https://reader.test/api/sync/manifest"), { sync: h.sync, actor: { workspaceId: "other", scopes: ["read"] } }), { code: "FORBIDDEN" });
  await assert.rejects(handleWorkspaceSync(new Request("https://reader.test/api/sync/pull?after=-1"), { sync: h.sync, actor: localActor }), { code: "SYNC_CURSOR" });
  assert.equal(await handleWorkspaceSync(new Request("https://reader.test/api/sync/objects/abc"), { sync: h.sync, actor: localActor }), null);
});

test("large initial libraries are split into dependency groups rather than one permanently oversized snapshot", async (t) => {
  const client = await fixture(t, "large-library", "client", (workspace) => workspace.db.transaction(() => {
    const insert = workspace.db.prepare("INSERT INTO collections VALUES(?,?,NULL,1)");
    for (let i = 0; i < 10050; i++) insert.run("category-" + i, "Category " + i);
  }));
  assert.ok(client.sync.status().dirty > 10000);
  const captured = client.sync.capture(); assert.equal(captured.captured, true);
  assert.equal(client.sync.pending().batches[0].mutations.length, 256);
  assert.ok(client.sync.status().dirty > 9000, "status includes uncaptured committed rows");
});

test("multi-megabyte atomic sync groups keep every SQLite metadata row below the Workers row budget", async (t) => {
  const client = await fixture(t, "laptop"), server = await fixture(t, "server", "server"); await align(client, server);
  client.db.transaction(() => {
    const insert = client.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?)");
    for (let i = 0; i < 140; i++) insert.run("bulk-receipt-" + i, "a".repeat(64), JSON.stringify({ id: i, value: "verified text ".repeat(1600) }), "local", "2026-10-20T12:00:00.000Z");
  });
  const { batch, receipt } = await push(client, server); assert.equal(receipt.accepted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) > 2 * 1024 * 1024);
  assert.equal(batch.mutations.length, 140);
  for (const h of [client, server]) {
    assert.ok(h.db.prepare("SELECT COUNT(*) AS count FROM sync_payloads").get().count > 100);
    assert.ok(h.db.prepare("SELECT MAX(length(value)) AS size FROM sync_payloads").get().size <= 16000);
    for (const table of ["sync_journal", "sync_outbox", "sync_conflicts", "sync_receipts"]) assert.ok((h.db.prepare("SELECT MAX(length(payload)) AS size FROM " + table).get().size || 0) < 2 * 1024 * 1024);
  }
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE request_id LIKE 'bulk-receipt-%'").get().count, 140);
});

test("new writes require enrollment and a reserved reference while user prose never becomes an object dependency", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop");
  addCollection(client, "unregistered", "Not yet registered"); client.sync.capture();
  await assert.rejects(server.sync.push(localActor, client.sync.pending().batches[0]), { code: "SYNC_DEVICE_NOT_ENROLLED" });
  assert.equal(collection(server, "unregistered"), undefined);
  const quote = JSON.stringify({ sha256: "a".repeat(64), size: 12 });
  assert.deepEqual(collectSyncObjects({ payload: JSON.stringify({ body: quote, title: "A hash in quoted source text" }) }), []);
});

test("editing a conflicted row preserves the old snapshot and invalidates an open resolution dialog", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop");
  addCollection(server, "shared", "Original"); await align(client, server);
  editCollection(client, "shared", "Local first"); editCollection(server, "shared", "Cloud"); await pull(client, server);
  const first = client.sync.conflicts().conflicts[0];
  editCollection(client, "shared", "Local second");
  const current = client.sync.conflicts().conflicts[0];
  assert.equal(current.id, first.id); assert.equal(current.version, first.version + 1);
  assert.equal(current.local[0].value.label, "Local second");
  assert.equal(client.db.prepare("SELECT COUNT(*) AS count FROM sync_conflict_history WHERE conflict_id=?").get(first.id).count, 1);
  await assert.rejects(client.sync.resolveConflict({ id: first.id, expectedVersion: first.version, choice: "remote" }), { code: "REVISION_CONFLICT" });
  assert.equal(collection(client, "shared").label, "Local second");
  await client.sync.resolveConflict({ id: current.id, expectedVersion: current.version, choice: "local" });
  assert.equal((await push(client, server)).receipt.accepted, true); assert.equal(collection(server, "shared").label, "Local second");
});

test("a newer remote edit supersedes a conflict without leaving an unresolvable stale lock", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop");
  addCollection(server, "shared", "Original"); await align(client, server);
  editCollection(client, "shared", "Local"); editCollection(server, "shared", "Cloud first"); await pull(client, server);
  const first = client.sync.conflicts().conflicts[0];
  editCollection(server, "shared", "Cloud second"); await pull(client, server);
  const current = client.sync.conflicts().conflicts;
  assert.equal(current.length, 1); assert.notEqual(current[0].id, first.id); assert.deepEqual(current[0].supersedes, [first.id]);
  assert.equal(current[0].remote[0].value.label, "Cloud second");
  await assert.rejects(client.sync.resolveConflict({ id: first.id, expectedVersion: first.version, choice: "remote" }), { code: "REVISION_CONFLICT" });
  await client.sync.resolveConflict({ id: current[0].id, expectedVersion: current[0].version, choice: "local" });
  assert.equal((await push(client, server)).receipt.accepted, true); assert.equal(collection(server, "shared").label, "Local");
});

test("resolving a pulled conflict leaves an unrelated captured batch available to push", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop");
  addCollection(server, "shared", "Original"); await align(client, server);
  addCollection(client, "unrelated", "Unrelated offline work"); client.sync.capture();
  const pending = client.sync.pending().batches[0];
  editCollection(client, "shared", "Local"); editCollection(server, "shared", "Cloud"); await pull(client, server);
  const conflict = client.sync.conflicts().conflicts[0]; assert.deepEqual(conflict.source.requestIds, []);
  assert.equal(client.sync.pending().batches[0].requestId, pending.requestId);
  await client.sync.resolveConflict({ id: conflict.id, expectedVersion: conflict.version, choice: "remote" });
  assert.equal(client.sync.pending().batches[0].requestId, pending.requestId);
  assert.equal((await push(client, server)).receipt.accepted, true);
  assert.equal(collection(server, "unrelated").label, "Unrelated offline work"); assert.equal(collection(client, "shared").label, "Cloud");
});

test("a conflict touching one row retains the remaining rows of its atomic pending batch", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop");
  server.db.transaction(() => { addCollection(server, "shared", "Original"); addCollection(server, "sibling", "Sibling original"); }); await align(client, server);
  client.db.transaction(() => { editCollection(client, "shared", "Local"); editCollection(client, "sibling", "Sibling offline"); }); client.sync.capture();
  const pending = client.sync.pending().batches[0];
  editCollection(server, "shared", "Cloud"); await pull(client, server);
  const conflict = client.sync.conflicts().conflicts[0]; assert.deepEqual(conflict.source.requestIds, [pending.requestId]);
  assert.equal(conflict.local.length, 2); assert.equal(client.sync.pending().batches.length, 0);
  await client.sync.resolveConflict({ id: conflict.id, expectedVersion: conflict.version, choice: "local" });
  const result = await push(client, server); assert.equal(result.receipt.accepted, true); assert.equal(result.batch.mutations.length, 2);
  assert.equal(collection(server, "shared").label, "Local"); assert.equal(collection(server, "sibling").label, "Sibling offline");
});

test("different glossary identities with one active name retain their rejected transaction and recover after a local rename", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop"); await align(client, server);
  const add = (h, id, term) => h.db.prepare("INSERT INTO glossary VALUES(?,1,?,?,NULL)").run(id, term, JSON.stringify({ id, revision: 1, term, definition: "An independently authored definition" }));
  add(server, "cloud-term", "attention"); add(client, "local-term", "attention");
  const transaction = server.db.transaction.bind(server.db); let messageOnlyFailures = 0;
  server.db.transaction = (operation) => { try { return transaction(operation); } catch (error) { if (/constraint failed/i.test(error.message)) { messageOnlyFailures++; throw new Error(error.message); } throw error; } };
  const { batch, receipt } = await push(client, server);
  assert.equal(receipt.accepted, false); assert.equal(receipt.code, "SYNC_CONSTRAINT"); assert.equal(receipt.conflicts[0].reason, "constraint");
  assert.equal(messageOnlyFailures, 1, "Workers-style SQL errors have no Node-specific code");
  assert.deepEqual(await server.sync.push(localActor, batch), receipt, "the rejected request retains an immutable receipt");
  assert.equal(client.db.prepare("SELECT normalized_name FROM glossary WHERE id='local-term'").get().normalized_name, "attention");
  assert.equal(server.db.prepare("SELECT normalized_name FROM glossary WHERE id='cloud-term'").get().normalized_name, "attention");
  assert.equal(server.db.prepare("SELECT id FROM glossary WHERE id='local-term'").get(), undefined);
  const conflict = client.sync.conflicts().conflicts[0]; assert.equal(conflict.source.code, "SYNC_CONSTRAINT");
  assert.equal(client.sync.capture().captured, false, "an unchanged rejection never busy-loops");
  const before = client.sync.cursor;
  await assert.rejects(pull(client, server), { code: "SYNC_CONSTRAINT" }); assert.equal(client.sync.cursor, before);
  client.db.prepare("UPDATE glossary SET normalized_name=?,revision=2,payload=? WHERE id=?").run("self-attention", JSON.stringify({ id: "local-term", revision: 2, term: "self-attention", definition: "An independently authored definition" }), "local-term");
  const result = await push(client, server); assert.equal(result.receipt.accepted, true); assert.notEqual(result.batch.requestId, batch.requestId);
  await pull(client, server);
  for (const h of [client, server]) assert.deepEqual(h.db.prepare("SELECT id,normalized_name FROM glossary ORDER BY id").all().map((row) => ({ ...row })), [{ id: "cloud-term", normalized_name: "attention" }, { id: "local-term", normalized_name: "self-attention" }]);
  assert.equal(client.sync.conflicts().conflicts.length, 0);
  const preserved = client.sync.conflicts({ includeResolved: true }).conflicts.find((item) => item.id === conflict.id);
  assert.equal(preserved.status, "retrying"); assert.equal(preserved.source.receipt.requestId, batch.requestId);
  assert.equal(client.db.prepare("SELECT COUNT(*) AS count FROM sync_conflict_history WHERE conflict_id=?").get(conflict.id).count, 1);
});

test("a correction made while a rejected request is in flight is retried from its latest values", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop"); await align(client, server);
  for (const [h, id] of [[server, "cloud-term"], [client, "local-term"]]) h.db.prepare("INSERT INTO glossary VALUES(?,1,'attention',?,NULL)").run(id, JSON.stringify({ id, revision: 1, term: "attention" }));
  client.sync.capture(); const original = client.sync.pending().batches[0];
  const receipt = await server.sync.push(localActor, original); assert.equal(receipt.code, "SYNC_CONSTRAINT");
  client.db.prepare("UPDATE glossary SET normalized_name='self-attention',revision=2 WHERE id='local-term'").run();
  client.sync.acknowledge(receipt);
  const result = await push(client, server); assert.equal(result.receipt.accepted, true); assert.notEqual(result.batch.requestId, original.requestId);
  assert.equal(server.db.prepare("SELECT normalized_name FROM glossary WHERE id='local-term'").get().normalized_name, "self-attention");
});

test("immutable payload rows still accept explicit CAS-checked tombstones", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop"); await align(client, server);
  const file = await client.workspace.upload(localActor, Buffer.from("source bytes retained in object storage"), { filename: "retained.txt", mediaType: "text/plain" });
  await server.workspace.resources.put(await client.workspace.resources.read(file.sha256), { filename: "retained.txt", mediaType: "text/plain" });
  assert.equal((await push(client, server)).receipt.accepted, true);
  client.db.prepare("DELETE FROM files WHERE id=?").run(file.sourceId);
  const result = await push(client, server); assert.equal(result.receipt.accepted, true);
  assert.equal(server.sync.known("files", JSON.stringify([file.sourceId])).value, null);
  assert.equal(await server.workspace.resources.has(file.sha256), true, "deleting a catalog reference does not erase immutable bytes");
});

test("message-only deferred foreign-key failures return a rejection receipt after the full transaction rolls back", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "laptop"); await align(client, server);
  client.db.transaction(() => { addCollection(client, "missing-parent", "Local parent"); addCollection(client, "child", "Local child", "missing-parent"); }); client.sync.capture();
  const original = client.sync.pending().batches[0], batch = { ...original, requestId: "missing-dependency", mutations: original.mutations.filter((item) => item.key === '["child"]') };
  const transaction = server.db.transaction.bind(server.db);
  server.db.transaction = (operation) => { try { return transaction(operation); } catch (error) { if (/constraint failed/i.test(error.message)) throw new Error(error.message + ": SQLITE_CONSTRAINT"); throw error; } };
  const receipt = await server.sync.push(localActor, batch); assert.equal(receipt.accepted, false); assert.equal(receipt.code, "SYNC_CONSTRAINT");
  assert.equal(collection(server, "child"), undefined); assert.equal(server.sync.known("collections", '["child"]').version, 0);
  assert.deepEqual(await server.sync.push(localActor, batch), receipt);
});
