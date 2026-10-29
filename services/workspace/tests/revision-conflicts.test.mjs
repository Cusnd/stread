import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceSync, collectSyncObjects } from "../sync-engine.mjs";
import { rowHash } from "../sync-schema.mjs";

async function device(t, name, mode = "client") {
  const directory = await mkdtemp(join(tmpdir(), "reader-revision-conflict-"));
  const workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  const sync = await createWorkspaceSync(workspace, { replicaId: name, mode });
  t.after(async () => { await workspace.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir())) && directory.includes("reader-revision-conflict-")); await rm(directory, { recursive: true, force: true }); });
  return { workspace, sync };
}
async function transfer(source, target, data) {
  for (const ref of collectSyncObjects(data)) {
    if (ref.key.startsWith("objects/")) {
      if (!await target.workspace.resources.hasObject(ref)) await target.workspace.resources.importObject(ref, await source.workspace.resources.openObject(ref));
    } else if (!await target.workspace.resources.has(ref.sha256)) await target.workspace.resources.put(await source.workspace.resources.open(ref.sha256), { filename: ref.sha256, mediaType: "application/octet-stream" });
  }
}
async function pull(target, server) {
  const value = server.sync.pull({ after: target.sync.cursor }); await transfer(server, target, value); await target.sync.applyPull(value);
}
async function push(source, server) {
  source.sync.capture(); const batch = source.sync.pending().batches[0]; assert.ok(batch);
  await transfer(source, server, batch);
  const receipt = await server.sync.push(localActor, batch); await transfer(server, source, receipt.states); source.sync.acknowledge(receipt);
  return receipt;
}
async function publish(h) {
  const w = h.workspace, input = { format: "reader-authoring-1", key: "sync-document", meta: { title: "Shared article", language: "en" },
    blocks: [{ key: "heading", type: "heading", text: "Introduction", level: 1 }, { key: "paragraph", type: "para", text: "Alpha shared content." }] };
  const source = await w.upload(localActor, Buffer.from(JSON.stringify(input)), { filename: "source.json", mediaType: "application/json" });
  const published = await w.publishAuthoring(localActor, { authoringSourceId: source.sourceId, requestId: randomUUID() });
  const saved = await w.revision(published.document.id);
  return { documentId: saved.document.id, blockId: saved.document.blocks[1].id };
}
async function revise(h, ids, expectedRevision, value) {
  return h.workspace.execute({ kind: "document.revise", ...ids, expectedRevision, requestId: randomUUID(), authorized: true,
    operations: [{ kind: "replace", blockId: ids.blockId, field: "text", value }] });
}
async function shared(t) {
  const server = await device(t, "server", "server"), local = await device(t, "laptop");
  const ids = await publish(server);
  local.sync.acceptEnrollment(server.sync.enroll(localActor, { replicaId: local.sync.replicaId, requestId: randomUUID() }));
  await pull(local, server); return { server, local, ids };
}

test("keeping an offline document branch creates a new revision and remaps only its local source addresses", async (t) => {
  const { server, local, ids } = await shared(t);
  const localReceipt = await revise(local, ids, 1, "Local branch content.");
  const note = await local.workspace.execute({ kind: "insight.save", documentId: ids.documentId, requestId: randomUUID(),
    insight: { type: "note", body: "A local note", color: "amber", revision: 2, blockId: ids.blockId, field: "text", quote: "Local branch content." } });
  await local.workspace.execute({ kind: "reading.checkpoint", documentId: ids.documentId, requestId: randomUUID(), readingState: { revision: 2, blockId: ids.blockId, offsetRatio: .5 } });
  const request = await local.workspace.execute({ kind: "change_request.save", documentId: ids.documentId, requestId: randomUUID(),
    changeRequest: { category: "correction", revision: 2, body: "Consider revising this local wording.", source: { blockId: ids.blockId, field: "text", quote: "Local branch content." } } });
  await revise(server, ids, 1, "Remote published content.");
  const remoteRevision = server.workspace.revisionRow(ids.documentId, 2);
  const receipt = await push(local, server); assert.equal(receipt.accepted, false);
  const conflict = local.sync.conflicts().conflicts[0], prepared = await local.workspace.prepareSyncConflictResolution(conflict);
  assert.deepEqual(prepared.mappings.map(({ fromRevision, toRevision }) => ({ fromRevision, toRevision })), [{ fromRevision: 2, toRevision: 3 }]);
  const restored = prepared.mutations.find((item) => item.entity === "revisions" && item.value?.revision === 2);
  assert.deepEqual(restored.value, { ...remoteRevision });
  for (const guard of prepared.guards) assert.equal(rowHash(local.sync.row(guard.entity, guard.key)), guard.hash);
  const result = await local.sync.resolveConflict({ id: conflict.id, choice: "local", expectedVersion: conflict.version });
  assert.equal(result.conflict.resolution, "local");
  assert.equal(local.workspace.row(ids.documentId).current_revision, 3);
  assert.equal((await local.workspace.revision(ids.documentId, 2)).document.blocks[1].text, "Remote published content.");
  assert.equal((await local.workspace.revision(ids.documentId, 3)).document.blocks[1].text, "Local branch content.");
  assert.equal(local.workspace.insights(ids.documentId).find((item) => item.id === note.insight.id).revision, 3);
  assert.equal(local.workspace.changeRequests(ids.documentId).find((item) => item.id === request.changeRequest.id).revision, 3);
  assert.equal(local.workspace.snapshot().documents[0].readingState.revision, 3);
  const retry = await local.workspace.storage.unpack(JSON.parse(local.workspace.db.prepare("SELECT payload FROM receipts WHERE request_id=?").get(localReceipt.requestId).payload));
  assert.deepEqual(retry, localReceipt, "old request receipts retain their exact offline result");
  assert.equal((await push(local, server)).accepted, true);
  assert.deepEqual(server.workspace.revisionRow(ids.documentId, 2), remoteRevision, "the cloud's published r2 never changes");
  assert.equal((await server.workspace.revision(ids.documentId, 3)).document.blocks[1].text, "Local branch content.");
});

test("all unpublished descendants are rebased beyond both heads and preparation cannot silently consume later local edits", async (t) => {
  const { server, local, ids } = await shared(t);
  await revise(local, ids, 1, "Local revision two."); await revise(local, ids, 2, "Local revision three.");
  await revise(server, ids, 1, "Remote revision two."); await revise(server, ids, 2, "Remote revision three.");
  const receipt = await push(local, server); assert.equal(receipt.accepted, false);
  const conflict = local.sync.conflicts().conflicts[0], prepared = await local.workspace.prepareSyncConflictResolution(conflict);
  assert.deepEqual(prepared.mappings.map(({ fromRevision, toRevision }) => [fromRevision, toRevision]), [[2, 4], [3, 5]]);
  assert.equal(prepared.mutations.find((item) => item.entity === "documents").value.current_revision, 5);
  await local.workspace.execute({ kind: "document.update", documentId: ids.documentId, expectedVersion: local.workspace.row(ids.documentId).version, requestId: randomUUID(), patch: { summary: "Changed during preparation" } });
  assert.ok(prepared.guards.some((guard) => rowHash(local.sync.row(guard.entity, guard.key)) !== guard.hash), "the engine can reject this stale prepared rebase atomically");
});

test("new insight or reading-session rows created during rebase preparation reject the stale resolution", async (t) => {
  for (const added of ["insight", "session"]) await t.test(added, async (t) => {
    const { server, local, ids } = await shared(t);
    await revise(local, ids, 1, "Local branch content.");
    await revise(server, ids, 1, "Remote branch content.");
    assert.equal((await push(local, server)).accepted, false);
    const conflict = local.sync.conflicts().conflicts[0], prepare = local.workspace.prepareSyncConflictResolution.bind(local.workspace);
    let created;
    local.workspace.prepareSyncConflictResolution = async (input) => {
      const result = await prepare(input);
      if (added === "insight") created = await local.workspace.execute({ kind: "insight.save", documentId: ids.documentId, requestId: randomUUID(),
        insight: { type: "note", body: "Created during rebase", color: "amber", revision: 2, blockId: ids.blockId, field: "text", quote: "Local branch content." } });
      else created = await local.workspace.execute({ kind: "reading.session.start", documentId: ids.documentId, documentRevision: 2,
        sessionId: "session-" + randomUUID(), requestId: randomUUID(), startedAt: new Date().toISOString(), position: { blockId: ids.blockId } });
      return result;
    };
    await assert.rejects(local.sync.resolveConflict({ id: conflict.id, choice: "local", expectedVersion: conflict.version }), (error) => error.code === "REVISION_CONFLICT");
    assert.equal(local.workspace.row(ids.documentId).current_revision, 2);
    assert.equal((await local.workspace.revision(ids.documentId, 2)).document.blocks[1].text, "Local branch content.");
    if (added === "insight") assert.equal(local.workspace.insights(ids.documentId).find((value) => value.id === created.insight.id).revision, 2);
    else assert.equal(local.workspace.db.prepare('SELECT document_revision FROM reading_sessions WHERE id=?').get(created.session.id).document_revision, 2);
    assert.equal(local.sync.conflicts().conflicts.find((value) => value.id === conflict.id).status, "pending");
  });
});
