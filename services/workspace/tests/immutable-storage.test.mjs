import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { objectReference } from "../immutable-objects.mjs";
import { R2Resources } from "../../cloudflare/r2-resources.mjs";
import { ResourceFiles } from "../resources.mjs";
import { createProtocolReviewEvidence } from "./authoring-protocol-evidence-fixture.mjs";

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "reader-objects-"));
  let workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  t.after(async () => { await workspace.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir())) && directory.includes("reader-objects-")); await rm(directory, { recursive: true, force: true }); });
  return { directory, get workspace() { return workspace; }, restart: async () => { await workspace.close(); workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false }); } };
}
async function publish(w, { text = "Alpha beta.", repeat = 1, previewStorage = false } = {}) {
  const input = { format: "reader-authoring-1", key: "object-fixture", meta: { title: "Immutable storage", language: "en" }, blocks: [
    { key: "heading", type: "heading", level: 1, text: "Introduction", translations: { zh: { text: "简介" } } },
    ...Array.from({ length: repeat }, (_, index) => ({ key: "paragraph" + index, type: "para", text })),
  ] };
  const uploaded = await w.upload(localActor, Buffer.from(JSON.stringify(input)), { filename: "authoring.json", mediaType: "application/json" });
  // Ordinary revision tests seed synthetic business data without claiming
  // conversion review. Preview-storage tests exercise the real publication
  // boundary with the explicitly fabricated protocol evidence helper.
  if (!previewStorage) {
    const receipt = await w.publishAuthoring(localActor, { authoringSourceId: uploaded.sourceId, requestId: randomUUID() });
    return { documentId: receipt.document.id, receipt, uploaded };
  }
  const preview = await w.createAuthoringPreview(localActor, { authoringSourceId: uploaded.sourceId, requestId: randomUUID() });
  const protocol = await createProtocolReviewEvidence({ preview: preview.preview,
    readReport: async current => (await w.getPreviewArtifact(localActor, current.id, "report")).value,
    upload: (bytes, filename, mediaType) => w.upload(localActor, bytes, { filename, mediaType }),
  });
  const receipt = await w.publishAuthoringPreview(localActor, { previewId: preview.preview.id, expectedHash: preview.preview.hash, requestId: randomUUID(),
    review: protocol.review });
  return { documentId: receipt.document.id, preview, receipt, uploaded };
}

test("large content and preview use verified immutable objects, while lists and text search read only bounded database indexes", async (t) => {
  const h = await setup(t), w = h.workspace, text = "中文 😀 alpha needle ".repeat(9000);
  const result = await publish(w, { text, repeat: 12, previewStorage: true }), saved = await w.revision(result.documentId);
  assert.equal(saved.report.previewSubmission.previewId, result.preview.preview.id);
  assert.ok(Buffer.byteLength(JSON.stringify(saved.document)) > 2 * 1024 * 1024);
  const row = w.revisionRow(result.documentId);
  for (const column of ["content", "text_index", "fingerprints", "resources", "report", "authoring", "identity"]) {
    const ref = objectReference(JSON.parse(row[column])); assert.ok(ref, column); assert.ok(Buffer.byteLength(row[column]) < 300);
    assert.equal((await readFile(w.resources.objectPath(ref))).length, ref.size);
  }
  const indexes = w.db.prepare("SELECT payload FROM revision_indexes").all();
  assert.ok(indexes.length > 20); assert.ok(indexes.every((entry) => Buffer.byteLength(entry.payload) <= 65536));
  assert.ok(objectReference(JSON.parse(w.previewRow(result.preview.preview.id).payload)));
  assert.equal(w.revisionIndex(result.documentId).find((entry) => entry.blockId === saved.document.blocks[1].id).text, text);
  const read = w.resources.readObject;
  w.resources.readObject = async () => { throw new Error("Objects deliberately unavailable for index-only queries"); };
  assert.equal(w.snapshot().documents[0].title, "Immutable storage");
  assert.equal((await w.query({ kind: "search", query: "needle" })).documents[0].id, result.documentId);
  assert.equal(w.revisionNavigation(result.documentId).blocks[0].translations.zh.text, "简介");
  await assert.rejects(w.revision(result.documentId), /deliberately unavailable/);
  w.resources.readObject = read;
  const originalRead = ResourceFiles.prototype.readObject; let coldReads = 0;
  ResourceFiles.prototype.readObject = async function (...args) { coldReads++; return originalRead.apply(this, args); };
  try { await h.restart(); assert.equal(coldReads, 0, "a migrated cold start never loads document objects"); }
  finally { ResourceFiles.prototype.readObject = originalRead; }
  assert.deepEqual((await h.workspace.revision(result.documentId)).document, saved.document);
  assert.equal((await h.workspace.getAuthoringPreview(localActor, result.preview.preview.id)).document.blocks[1].text, text);
});

test("a failed object upload or losing CAS never exposes a new revision; retries and history survive restart", async (t) => {
  const h = await setup(t), w = h.workspace, result = await publish(w), saved = await w.revision(result.documentId), blockId = saved.document.blocks[1].id;
  const command = (value) => ({ kind: "document.revise", documentId: result.documentId, expectedRevision: 1, requestId: randomUUID(), authorized: true,
    operations: [{ kind: "replace_range", blockId, field: "text", start: 0, end: 5, expectedText: "Alpha", value }] });
  const originalPut = w.resources.putObject.bind(w.resources), failed = command("Failed");
  w.resources.putObject = async () => { throw new Error("injected object write failure"); };
  await assert.rejects(w.execute(failed), /injected object write failure/);
  assert.equal(w.row(result.documentId).current_revision, 1);
  assert.equal(w.db.prepare("SELECT request_id FROM receipts WHERE request_id=?").get(failed.requestId), undefined);
  w.resources.putObject = originalPut;
  const commands = [command("Winner one"), command("Winner two")];
  const outcomes = await Promise.allSettled(commands.map((value) => w.execute(value)));
  assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((value) => value.status === "rejected").reason.code, "REVISION_CONFLICT");
  const won = outcomes.findIndex((value) => value.status === "fulfilled"), receipt = outcomes[won].value;
  assert.equal(w.row(result.documentId).current_revision, 2);
  const storedReceipt = JSON.parse(w.db.prepare("SELECT payload FROM receipts WHERE request_id=?").get(commands[won].requestId).payload);
  assert.ok(objectReference(storedReceipt.document));
  await h.restart();
  assert.deepEqual(await h.workspace.execute(commands[won]), receipt);
  assert.equal((await h.workspace.revision(result.documentId, 1)).document.blocks[1].text, "Alpha beta.");
  assert.equal((await h.workspace.revision(result.documentId)).document.blocks[1].text, receipt.document.blocks[1].text);
});

test("inline historical revisions and previews migrate losslessly with stable business state", async (t) => {
  const h = await setup(t), w = h.workspace, result = await publish(w, { previewStorage: true }), saved = await w.revision(result.documentId);
  const previewRow = w.previewRow(result.preview.preview.id), preview = await w.storage.unpack(JSON.parse(previewRow.payload));
  const before = w.snapshot(), changes = await w.query({ kind: "changes" });
  w.db.transaction(() => {
    w.db.prepare("UPDATE revisions SET content=?,text_index=?,fingerprints=?,resources=?,report=?,authoring=?,identity=? WHERE document_id=?")
      .run(...[saved.document, saved.index, saved.fingerprints, saved.resourceMap, saved.report, saved.authoring, saved.identity].map(JSON.stringify), result.documentId);
    w.db.prepare("DELETE FROM revision_indexes WHERE document_id=?").run(result.documentId);
    w.db.prepare("UPDATE authoring_previews SET payload=? WHERE id=?").run(JSON.stringify(preview), preview.id);
    w.db.prepare("DELETE FROM metadata WHERE key='immutableStorageVersion'").run();
  });
  assert.deepEqual((await w.revision(result.documentId)).document, saved.document, "inline records remain readable before migration");
  await h.restart();
  const after = h.workspace;
  assert.deepEqual(await after.revision(result.documentId), saved);
  assert.deepEqual(after.snapshot(), before); assert.deepEqual(await after.query({ kind: "changes" }), changes);
  assert.ok(objectReference(JSON.parse(after.revisionRow(result.documentId).content)));
  assert.ok(objectReference(JSON.parse(after.previewRow(preview.id).payload)));
  assert.deepEqual(await after.storage.unpack(JSON.parse(after.previewRow(preview.id).payload)), preview);
});

test("changed staged content is rejected and tampered local or R2 objects fail their hash checks", async (t) => {
  const h = await setup(t), w = h.workspace, result = await publish(w), saved = await w.revision(result.documentId);
  const next = structuredClone(saved.document); next.revision++;
  const validated = await w.validateCandidate(next, saved);
  await w.prepareRevision(validated, saved.resourceMap, saved);
  validated.document.meta.title = "Changed after upload";
  assert.throws(() => w.db.transaction(() => w.saveRevision(validated, saved.resourceMap, saved)), (error) => error.code === "OBJECT_PREPARATION_CHANGED");
  assert.equal(w.db.prepare("SELECT revision FROM revisions WHERE document_id=? AND revision=2").get(result.documentId), undefined);
  const ref = objectReference(JSON.parse(w.revisionRow(result.documentId).content)), path = w.resources.objectPath(ref), bytes = await readFile(path);
  const changed = Buffer.from(bytes); changed[changed.length - 2] ^= 1; await writeFile(path, changed);
  await assert.rejects(w.resources.readObject(ref), (error) => error.code === "OBJECT_INTEGRITY_FAILED");
  await assert.rejects(w.resources.hasObject(ref), (error) => error.code === "OBJECT_INTEGRITY_FAILED");
  await assert.rejects(w.resources.importObject(ref, bytes), (error) => error.code === "OBJECT_INTEGRITY_FAILED");
  await writeFile(path, bytes);
  const objects = new Map(), bucket = {
    head: async (key) => objects.has(key) ? { size: objects.get(key).length } : null,
    get: async (key) => objects.has(key) ? { body: new Response(objects.get(key)).body } : null,
    put: async (key, bytes) => { objects.set(key, Buffer.from(bytes)); return { size: bytes.length }; },
  };
  const cloud = new R2Resources(bucket), cloudRef = await cloud.putObject({ unchanged: "same" });
  assert.deepEqual(await cloud.readObject(cloudRef), { unchanged: "same" });
  objects.set(cloudRef.key, Buffer.from('{"unchanged":"oops"}'));
  await assert.rejects(cloud.readObject(cloudRef), (error) => error.code === "OBJECT_INTEGRITY_FAILED");
  await assert.rejects(cloud.hasObject(cloudRef), (error) => error.code === "OBJECT_INTEGRITY_FAILED");
  await assert.rejects(cloud.importObject(cloudRef, Buffer.from('{"unchanged":"same"}')), (error) => error.code === "OBJECT_INTEGRITY_FAILED");
  await assert.rejects(cloud.putObject({ unchanged: "same" }), (error) => error.code === "OBJECT_INTEGRITY_FAILED");
  assert.ok((await readdir(join(h.directory, "objects", "sha256"))).every((name) => /^[a-f0-9]{64}$/.test(name)), "temporary object files are cleaned");
});

test("original-file presence verifies content and R2 checksum metadata avoids downloading valid objects", async (t) => {
  const h = await setup(t), bytes = Buffer.from("verified source bytes"), changed = Buffer.from("corrupt! source bytes");
  assert.equal(changed.length, bytes.length);
  const file = await h.workspace.resources.put(bytes, { filename: "source.txt" });
  assert.equal(await h.workspace.resources.has(file.sha256), true);
  await writeFile(h.workspace.resources.path(file.sha256), changed);
  await assert.rejects(h.workspace.resources.has(file.sha256), (error) => error.code === "OBJECT_INTEGRITY_FAILED");
  await assert.rejects(h.workspace.resources.put(bytes, { filename: "source.txt" }), (error) => error.code === "OBJECT_INTEGRITY_FAILED");

  const objects = new Map(), blob = "blobs/" + file.sha256; let gets = 0, provideChecksum = true;
  const bucket = {
    head: async (key) => objects.has(key) ? { size: objects.get(key).length,
      ...(provideChecksum ? { checksums: { sha256: createHash("sha256").update(objects.get(key)).digest() } } : {}) } : null,
    get: async (key) => { gets++; return objects.has(key) ? { body: new Response(objects.get(key)).body } : null; },
    put: async (key, input) => { const value = Buffer.from(await new Response(input).arrayBuffer()); objects.set(key, value); return { size: value.length }; },
    delete: async (key) => objects.delete(key),
  };
  const cloud = new R2Resources(bucket); objects.set(blob, bytes);
  assert.equal(await cloud.has(file.sha256), true); assert.equal(gets, 0);
  const ref = await cloud.putObject({ verified: true });
  assert.equal(await cloud.hasObject(ref), true); assert.equal(gets, 0);
  objects.set(blob, changed);
  await assert.rejects(cloud.has(file.sha256), (error) => error.code === "OBJECT_INTEGRITY_FAILED");
  await assert.rejects(cloud.put(bytes, { filename: "source.txt" }), (error) => error.code === "OBJECT_INTEGRITY_FAILED");
  assert.ok([...objects.keys()].every((key) => !key.startsWith("staging/")), "failed source writes clean staging objects");
  provideChecksum = false;
  await assert.rejects(cloud.has(file.sha256), (error) => error.code === "OBJECT_INTEGRITY_FAILED");
  objects.set(blob, bytes); assert.equal(await cloud.has(file.sha256), true);
  assert.ok(gets >= 2, "legacy objects without checksum metadata are streamed for verification");
});
