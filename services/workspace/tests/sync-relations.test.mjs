import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceSync, collectSyncObjects } from "../sync-engine.mjs";

async function device(t, name, mode = "client") {
  const directory = await mkdtemp(join(tmpdir(), "reader-sync-relations-")); let workspace, sync;
  const start = async () => { workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false }); sync = await createWorkspaceSync(workspace, { replicaId: name, mode }); };
  await start();
  t.after(async () => { await workspace.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith("reader-sync-relations-")); await rm(directory, { recursive: true, force: true }); });
  return { get workspace() { return workspace; }, get sync() { return sync; }, restart: async () => { await workspace.close(); await start(); } };
}
async function transfer(source, target, data) {
  const pending = collectSyncObjects(data), seen = new Set();
  for (const ref of pending) {
    if (seen.has(ref.key)) continue; seen.add(ref.key);
    if (ref.kind === "object") {
      if (!await target.workspace.resources.hasObject(ref)) await target.workspace.resources.importObject(ref, source.workspace.resources.openObject(ref));
      pending.push(...collectSyncObjects(await source.workspace.resources.readObject(ref)));
    } else if (!await target.workspace.resources.has(ref.sha256)) await target.workspace.resources.put(source.workspace.resources.open(ref.sha256), { filename: ref.sha256 });
  }
}
async function pull(client, server, limit = 50) {
  const page = server.sync.pull({ after: client.sync.cursor, limit }); await transfer(server, client, page); await client.sync.applyPull(page); return page;
}
async function drainPull(client, server) { for (let i = 0; i < 100; i++) if (!(await pull(client, server)).hasMore) return; assert.fail("unbounded pull"); }
async function pushAll(client, server) {
  for (let i = 0; i < 100; i++) {
    client.sync.capture(); const batch = client.sync.pending().batches[0]; if (!batch) return;
    await transfer(client, server, batch);
    const receipt = await server.sync.push(localActor, batch); assert.equal(receipt.accepted, true, JSON.stringify(receipt.conflicts)); client.sync.acknowledge(receipt);
  }
  assert.fail("unbounded push");
}
async function enroll(client, server) { client.sync.acceptEnrollment(server.sync.enroll(localActor, { replicaId: client.sync.replicaId, requestId: randomUUID() })); await drainPull(client, server); await pushAll(client, server); }
async function publish(device, input) {
  const w = device.workspace, file = await w.upload(localActor, Buffer.from(JSON.stringify(input)), { filename: "input.json" });
  // Seed ordinary relationship data through the internal business path. These
  // fixtures do not claim a completed Agent conversion or independent review.
  const result = await w.publishAuthoring(localActor, { authoringSourceId: file.sourceId, requestId: randomUUID() });
  return result.document.id;
}
const source = (key) => ({ format: "reader-authoring-1", key, meta: { title: key, language: "en" }, blocks: [
  { key: "body", type: "para", text: "See [1](#reference)." }, { key: "refs", type: "heading", level: 1, text: "References" },
  { key: "reference", type: "para", text: "[1] Alice Smith. A reliable target paper. Journal of Testing, 2020. https://doi.org/10.5555/target.2020." },
] });
const target = () => ({ format: "reader-authoring-1", key: "target", meta: { title: "A reliable target paper", language: "en", authors: "Alice Smith", date: "2020" },
  extensions: { "continous-reader.bibliography": { work: { identifiers: { doi: "10.5555/target.2020" } } } }, blocks: [{ key: "body", type: "para", text: "The target result." }] });
const rows = (device) => device.workspace.db.prepare("SELECT * FROM document_relations ORDER BY id").all().map((row) => ({ ...row }));

for (const order of ["source-first", "target-first"]) test(`hub journals cross-device matches exactly once (${order}), including follower restart between catalog and match`, async (t) => {
  const hub = await device(t, "hub", "server"), a = await device(t, "source-device"), b = await device(t, "target-device"), observer = await device(t, "observer");
  // Seed one shared unresolved scholarly work so this test concerns inference,
  // not the separate explicit natural-key conflict workflow for independent IDs.
  const seed = await publish(hub, source("shared-seed"));
  for (const client of [a, b, observer]) await enroll(client, hub);
  const citing = await publish(a, source("offline-source")), targetId = await publish(b, target());
  assert.equal(a.workspace.relations.rows(citing)[0].status, "unresolved");
  assert.equal(b.workspace.relations.rows(seed)[0].status, "linked", "local user publication matches immediately offline");
  const first = order === "source-first" ? a : b, second = first === a ? b : a;
  await pushAll(first, hub); await drainPull(observer, hub);
  await pushAll(second, hub);
  const final = hub.workspace.relations.rows(citing)[0]; assert.equal(final.status, "linked"); assert.equal(final.targetDocuments[0].id, targetId);
  let sawCatalogBeforeMatch = false;
  for (let i = 0; i < 50 && observer.sync.cursor < hub.sync.head; i++) {
    const page = await pull(observer, hub, 1);
    const current = observer.workspace.relations.rows(citing)[0];
    if (current?.status === "unresolved" && observer.workspace.db.prepare("SELECT id FROM documents WHERE id=?").get(targetId)) {
      sawCatalogBeforeMatch = true; const savedRows = rows(observer), cursor = observer.sync.cursor;
      await observer.restart(); assert.deepEqual(rows(observer), savedRows, "restart cannot create its own match timestamps");
      assert.equal(observer.sync.cursor, cursor); observer.sync.capture(); assert.equal(observer.sync.status().pending, 0);
      break;
    }
    if (!page.hasMore) break;
  }
  assert.equal(sawCatalogBeforeMatch, true, "authority correction is a separately journaled transaction");
  for (const client of [a, b, observer]) await drainPull(client, hub);
  const canonical = rows(hub);
  for (const client of [a, b, observer]) { assert.deepEqual(rows(client), canonical); assert.equal(client.sync.status().conflicts, 0); }
  const head = hub.sync.head;
  for (let cycle = 0; cycle < 3; cycle++) for (const client of [a, b, observer]) { await pushAll(client, hub); await drainPull(client, hub); }
  assert.equal(hub.sync.head, head, "quiet cycles do not ping-pong inferred versions");
  for (const client of [a, b, observer]) assert.equal(client.sync.status().pending, 0);
});

test("a failed authoritative rematch rolls back accepted rows, journal and receipt together; exact retry succeeds", async (t) => {
  const hub = await device(t, "rollback-hub", "server"), client = await device(t, "rollback-device"); await enroll(client, hub);
  const id = await publish(client, source("rollback-source"));
  for (let i = 0; i < 50; i++) {
    client.sync.capture(); const batch = client.sync.pending().batches[0]; assert.ok(batch);
    await transfer(client, hub, batch);
    if (!batch.mutations.some((mutation) => mutation.entity === "documents" && mutation.value?.id === id)) {
      client.sync.acknowledge(await hub.sync.push(localActor, batch)); continue;
    }
    const head = hub.sync.head, sync = hub.workspace.relations.sync;
    hub.workspace.relations.sync = () => { throw new Error("injected rematch failure"); };
    await assert.rejects(hub.sync.push(localActor, batch), /injected rematch failure/);
    hub.workspace.relations.sync = sync;
    assert.equal(hub.sync.head, head); assert.equal(hub.workspace.db.prepare("SELECT id FROM documents WHERE id=?").get(id), undefined);
    assert.equal(hub.workspace.db.prepare("SELECT payload FROM sync_receipts WHERE request_id=?").get(batch.requestId), undefined);
    const receipt = await hub.sync.push(localActor, batch); assert.equal(receipt.accepted, true); client.sync.acknowledge(receipt);
    assert.deepEqual(await hub.sync.push(localActor, batch), receipt); return;
  }
  assert.fail("document transaction not found");
});
