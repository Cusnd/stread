import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { canonical, hash } from "../errors.mjs";
import { createAuthoringEditPackage } from "../authoring-edit-package.mjs";
import { verifyPreviewSnapshot } from "../authoring-preview.mjs";
import { collectSyncObjects, createWorkspaceSync } from "../sync-engine.mjs";
import { createProtocolReviewEvidence } from "./authoring-protocol-evidence-fixture.mjs";

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), "reader-authoring-revision-"));
  let w = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  t.after(async () => { await w.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(directory.includes("reader-authoring-revision-")); await rm(directory, { recursive: true, force: true }); });
  const upload = (value) => w.upload(localActor, Buffer.from(JSON.stringify(value)), { filename: "authoring.json", mediaType: "application/json" });
  const create = async (input, extra = {}) => w.createAuthoringPreview(localActor, { authoringSourceId: (await upload(input)).sourceId, requestId: randomUUID(), ...extra });
  const reviews = new Map();
  const publish = async (preview, extra = {}) => {
    // Keep the same attached file IDs across retries and workspace restarts so
    // the existing exact business receipt assertions still exercise replay.
    if (!reviews.has(preview.id)) reviews.set(preview.id, createProtocolReviewEvidence({ preview,
      readReport: async current => (await w.getPreviewArtifact(localActor, current.id, "report")).value,
      upload: (bytes, filename, mediaType) => w.upload(localActor, bytes, { filename, mediaType }) }));
    return w.publishAuthoringPreview(localActor, { previewId: preview.id, expectedHash: preview.hash, requestId: randomUUID(),
      review: (await reviews.get(preview.id)).review, ...extra });
  };
  return { get w() { return w; }, upload, create, publish,
    command: (command) => w.execute(localActor, { requestId: randomUUID(), ...command }),
    restart: async () => { await w.close(); w = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false }); } };
}
const example = () => ({ format: "reader-authoring-1", key: "existing-article", meta: { title: "Current article", language: "en", translations: { "zh-CN": { title: "当前文章" } } }, blocks: [
  { key: "heading", type: "heading", text: "Overview", level: 1 },
  { key: "paragraph", type: "para", text: "Original paragraph 😀.", translations: { "zh-CN": { text: "原段落😀。" } } },
  { key: "list", type: "list", ordered: false, items: [{ key: "first", text: "First", translations: { "zh-CN": { text: "第一项" } } }, { key: "second", text: "Second" }] },
  { key: "table", type: "table", head: [["A", "B"]], rows: [["1", "2"]], caption: "Results", translations: { "zh-CN": { head: [["甲", "乙"]], rows: [["1", "2"]], caption: "结果" } } },
  { key: "html", type: "html", html: '<div class="layout-pair"><p data-key="claim">A claim.</p><p data-key="detail">Its detail.</p></div>', translations: { "zh-CN": { html: '<div class="layout-pair"><p data-key="claim">一个陈述。</p><p data-key="detail">其细节。</p></div>' } } },
  { key: "math", type: "math", tex: "x^2" },
  { key: "merged-table", type: "html", role: "table", html: '<table><caption data-key="caption">Merged result</caption><tbody><tr><th data-key="row" rowspan="2" scope="row">Method</th><td data-key="first">7</td></tr><tr><td data-key="second">9</td></tr></tbody></table>',
    translations: { "zh-CN": { html: '<table><caption data-key="caption">合并结果</caption><tbody><tr><th data-key="row" rowspan="2" scope="row">方法</th><td data-key="first">7</td></tr><tr><td data-key="second">9</td></tr></tbody></table>' } } },
] });
const targetFor = (pkg) => ({ documentId: pkg.base.documentId, baseRevision: pkg.base.revision, baseHash: pkg.base.documentHash });
async function initial(h, input = example()) { const preview = (await h.create(input)).preview; const result = await h.publish(preview); return { result, saved: await h.w.revision(result.document.id) }; }

test("complete editing export round-trips current precise edits, stable identities and stale translation hashes", async (t) => {
  const h = await harness(t), { saved: original } = await initial(h), id = original.document.id;
  const htmlNode = original.index.find((entry) => entry.field === "html_text" && entry.variant === "source").nodeId;
  await h.command({ kind: "document.revise", documentId: id, expectedRevision: 1, authorized: true, operations: [
    { kind: "replace", blockId: original.document.blocks[1].id, field: "text", value: "Precisely changed current paragraph 😀." },
    { kind: "replace", blockId: original.document.blocks[3].id, field: "rows", row: 0, column: 1, value: "37" },
    { kind: "replace", blockId: original.document.blocks[4].id, field: "html_text", nodeId: htmlNode, value: "Current HTML claim." },
    { kind: "insert", afterBlockId: original.document.blocks[2].id, block: { type: "para", text: "User supplement." } },
  ] });
  const current = await h.w.revision(id), stored = await h.w.getAuthoringArtifacts(localActor, id);
  assert.equal(stored.matchesDocumentRevision, false);
  const pkg = (await h.w.getAuthoringEditPackageArtifact(localActor, id)).value;
  assert.equal(pkg.base.revision, 2); assert.equal(pkg.complete, true); assert.equal(pkg.historicalAuthoring.revision, 1);
  assert.match(JSON.stringify(pkg.authoring), /Precisely changed current paragraph/); assert.match(JSON.stringify(pkg.authoring), /Current HTML claim/);
  assert.equal(pkg.authoring.blocks.find((block) => block.key === "table").rows[0][1], "37");
  assert.ok(pkg.authoring.blocks.some((block) => block.origin === "user"));
  const descriptor = await h.w.getAuthoringEditPackage(localActor, id, 2);
  assert.equal(descriptor.sha256, hash(JSON.stringify(pkg))); assert.equal(descriptor.size, Buffer.byteLength(JSON.stringify(pkg)));
  const validation = await h.w.validateAuthoring(localActor, { authoringSourceId: (await h.upload(pkg.authoring)).sourceId, target: targetFor(pkg) });
  assert.equal(validation.valid, true);
  const candidate = (await h.create(pkg.authoring, { target: targetFor(pkg) })).preview, frozen = await h.w.previewSnapshot(candidate.id);
  assert.equal(frozen.validated.document.id, id); assert.equal(frozen.validated.document.revision, 3);
  assert.deepEqual(frozen.validated.document.blocks, current.document.blocks);
  assert.deepEqual(frozen.validated.fingerprints, current.fingerprints);
  const result = await h.publish(candidate); assert.equal(result.document.id, id); assert.equal(result.document.revision, 3);
  assert.deepEqual((await h.w.revision(id, 1)).authoring, example(), "original authoring remains an immutable historical source");
  assert.deepEqual((await h.w.revision(id, 2)).document, current.document);
  assert.equal(h.w.snapshot().documents.length, 1);
});

test("revision preview preserves independent metadata, plan, notes, reading and source resources", async (t) => {
  const h = await harness(t), input = example();
  const source = await h.w.upload(localActor, Buffer.from("Synthetic source text."), { filename: "original.txt", mediaType: "text/plain" });
  const image = await h.w.upload(localActor, await readFile(new URL("../authoring-examples/images/paired.png", import.meta.url)), { filename: "figure.png", mediaType: "image/png" });
  input.source = { path: "source.txt", sha256: source.sha256, media_type: "text/plain" }; input.blocks[1].source = [{ page: 1, box: [.1, .1, .9, .2] }];
  input.blocks.push({ key: "figure", type: "figure", src: "figure.png", alt: "A paired synthetic example", caption: "Preserved image", translations: { "zh-CN": { alt: "并列示例", caption: "保留图片" } } });
  const first = (await h.create(input, { resources: { "source.txt": source.sourceId, "figure.png": image.sourceId } })).preview, published = await h.publish(first), id = published.document.id;
  const saved = await h.w.revision(id), pkg = await createAuthoringEditPackage(saved), edited = structuredClone(pkg.authoring);
  edited.blocks.reverse(); edited.blocks.find((block) => block.key === "paragraph").text = "Revised claim.";
  const preview = (await h.create(edited, { target: targetFor(pkg) })).preview;
  await h.command({ kind: "document.update", documentId: id, expectedVersion: h.w.row(id).version, patch: { tags: ["keep"], summary: "Independent user summary" } });
  await h.command({ kind: "plan.add", documentId: id, expectedPlanVersion: h.w.meta("planVersion") });
  await h.command({ kind: "reading.checkpoint", documentId: id, readingState: { revision: 1, blockId: saved.document.blocks[1].id, offsetRatio: .4 } });
  const note = await h.command({ kind: "insight.save", documentId: id, insight: { type: "note", body: "Unrelated source note", color: "amber", revision: 1, blockId: saved.document.blocks[0].id, field: "text", quote: "Overview" } });
  const before = h.w.snapshot(), notes = h.w.insights(id), resources = saved.resourceMap;
  const receipt = await h.publish(preview);
  assert.equal(receipt.document.id, id); assert.equal(receipt.document.revision, 2);
  const next = await h.w.revision(id), after = h.w.snapshot();
  assert.deepEqual(next.resourceMap, resources); assert.deepEqual(next.document.source, saved.document.source);
  assert.deepEqual(next.document.blocks.find((block) => block.id === saved.document.blocks[1].id).source, saved.document.blocks[1].source);
  assert.deepEqual(after.planIds, before.planIds); assert.deepEqual(after.documents[0].readingState, before.documents[0].readingState);
  assert.deepEqual(after.documents[0].tags, ["keep"]); assert.equal(after.documents[0].summary, "Independent user summary");
  assert.deepEqual(h.w.insights(id), notes); assert.equal(note.insight.revision, 1);
});

test("removed and split blocks report unresolved candidate references while retaining exact old provenance", async (t) => {
  const h = await harness(t), { saved } = await initial(h), id = saved.document.id, block = saved.document.blocks[1];
  const note = await h.command({ kind: "insight.save", documentId: id, insight: { type: "note", body: "Quote remains historical", color: "amber", revision: 1, blockId: block.id, field: "text", quote: block.text } });
  const pkg = await createAuthoringEditPackage(saved), edited = structuredClone(pkg.authoring);
  edited.blocks.splice(1, 1, { key: "split-one", type: "para", text: "Original" }, { key: "split-two", type: "para", text: "paragraph 😀." });
  const preview = (await h.create(edited, { target: targetFor(pkg) })).preview, frozen = await h.w.previewSnapshot(preview.id);
  assert.ok(frozen.revisionTarget.impact.removed.includes(block.id)); assert.equal(preview.impact.unresolvedReferences, 1);
  assert.equal(frozen.revisionTarget.impact.references[0].references[0].historicalReferencePreserved, true);
  await h.publish(preview);
  assert.deepEqual(h.w.insights(id).find((item) => item.id === note.insight.id), note.insight);
  assert.equal((await h.w.revision(id, 1)).document.blocks[1].text, block.text);
});

test("new affected references and concurrent body writes block publication without consuming the candidate", async (t) => {
  const h = await harness(t), { saved } = await initial(h), id = saved.document.id, pkg = await createAuthoringEditPackage(saved), edited = structuredClone(pkg.authoring);
  edited.blocks[1].text = "A revised statement.";
  const preview = (await h.create(edited, { target: targetFor(pkg) })).preview;
  await h.command({ kind: "insight.save", documentId: id, insight: { type: "note", body: "New relevant note", color: "amber", revision: 1, blockId: saved.document.blocks[1].id, field: "text", quote: saved.document.blocks[1].text } });
  await assert.rejects(h.publish(preview), { code: "REVISION_REFERENCES_CHANGED" });
  assert.equal(h.w.row(id).current_revision, 1); assert.equal(h.w.previewRow(preview.id).published_document_id, null);
  const refreshed = (await h.create(edited, { previousPreviewId: preview.id })).preview;
  assert.equal(refreshed.impact.affectedReferences, 1);
  await h.command({ kind: "document.revise", documentId: id, expectedRevision: 1, authorized: true, operations: [{ kind: "replace", blockId: saved.document.blocks[0].id, field: "text", value: "Changed concurrently" }] });
  await assert.rejects(h.publish(refreshed), { code: "REVISION_CONFLICT" });
  assert.equal(h.w.row(id).current_revision, 2); assert.equal(h.w.previewRow(refreshed.id).published_document_id, null);
});

test("revision hashes, draft heads and identical request receipts remain exact across restart", async (t) => {
  const h = await harness(t), { saved } = await initial(h), pkg = await createAuthoringEditPackage(saved), edited = structuredClone(pkg.authoring); edited.blocks[1].text = "Published revision.";
  const preview = (await h.create(edited, { target: targetFor(pkg) })).preview, snapshot = await h.w.previewSnapshot(preview.id), tampered = structuredClone(snapshot);
  tampered.revisionTarget.baseRevision += 1; assert.throws(() => verifyPreviewSnapshot(tampered), { code: "PREVIEW_HASH_MISMATCH" });
  await assert.rejects(h.create(edited, { previousPreviewId: preview.id, target: { ...targetFor(pkg), baseHash: "0".repeat(64) } }), { code: "REVISION_TARGET_MISMATCH" });
  await assert.rejects(h.publish(preview, { expectedHash: "0".repeat(64) }), { code: "PREVIEW_HASH_MISMATCH" });
  await h.restart(); assert.deepEqual(await h.w.previewSnapshot(preview.id), snapshot);
  const requestId = randomUUID(), receipt = await h.publish(preview, { requestId }); await h.restart();
  assert.deepEqual(await h.publish(preview, { requestId }), receipt);
  assert.equal(h.w.db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE document_id=?").get(saved.document.id).n, 2);
  assert.equal(h.w.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE request_id=?").get(requestId).n, 1);
});

test("unsupported legacy content is rejected rather than exported from stale authoring", async (t) => {
  const h = await harness(t), { saved } = await initial(h), unsupported = structuredClone(saved);
  unsupported.document.meta.unknownLegacyFact = "Must not disappear";
  await assert.rejects(createAuthoringEditPackage(unsupported), { code: "EDITING_EXPORT_UNSUPPORTED" });
  assert.equal(h.w.row(saved.document.id).current_revision, 1);
});

test("revision publication checks dependent references again after asynchronous object staging", async (t) => {
  const h = await harness(t), { saved } = await initial(h), pkg = await createAuthoringEditPackage(saved), edited = structuredClone(pkg.authoring);
  edited.blocks[1].text = "Pending publication.";
  const preview = (await h.create(edited, { target: targetFor(pkg) })).preview, prepare = h.w.prepareRevision.bind(h.w);
  let entered, release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; }), releasedPromise = new Promise((resolve) => { release = resolve; });
  h.w.prepareRevision = async (...args) => { const result = await prepare(...args); entered(); await releasedPromise; return result; };
  const publication = h.publish(preview);
  await enteredPromise;
  await h.command({ kind: "insight.save", documentId: saved.document.id, insight: { type: "note", body: "Concurrent reference", color: "amber", revision: 1, blockId: saved.document.blocks[1].id, quote: saved.document.blocks[1].text } });
  release(); await assert.rejects(publication, { code: "REVISION_REFERENCES_CHANGED" });
  assert.equal(h.w.row(saved.document.id).current_revision, 1);
  assert.equal(h.w.db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE document_id=?").get(saved.document.id).n, 1);
});

test("existing article revision publication travels as an atomic business group and retains offline conflicts and receipts", async (t) => {
  const hub = await harness(t), client = await harness(t);
  const hubSync = await createWorkspaceSync(hub.w, { replicaId: "hub", mode: "server" });
  const clientSync = await createWorkspaceSync(client.w, { replicaId: "client", mode: "client" });
  const transfer = async (source, target, value) => {
    for (const ref of collectSyncObjects(value)) {
      if (ref.key.startsWith("objects/")) { if (!await target.resources.hasObject(ref)) await target.resources.importObject(ref, await source.resources.openObject(ref)); }
      else if (!await target.resources.has(ref.sha256)) await target.resources.put(await source.resources.open(ref.sha256), { filename: ref.sha256, mediaType: "application/octet-stream" });
    }
  };
  const { saved } = await initial(hub), id = saved.document.id;
  clientSync.acceptEnrollment(hubSync.enroll(localActor, { replicaId: clientSync.replicaId, requestId: randomUUID() }));
  const inbound = hubSync.pull({ after: clientSync.cursor }); await transfer(hub.w, client.w, inbound); await clientSync.applyPull(inbound);
  const pkg = (await client.w.getAuthoringEditPackageArtifact(localActor, id)).value, edited = structuredClone(pkg.authoring); edited.blocks[1].text = "Offline authoring revision.";
  const preview = (await client.create(edited, { target: targetFor(pkg) })).preview, requestId = randomUUID(), receipt = await client.publish(preview, { requestId });
  clientSync.capture(); const batch = clientSync.pending().batches[0];
  assert.deepEqual(clientSync.pending().batches[0], batch, "outbox retry keeps the exact immutable batch");
  const indices = ["documents", "revisions", "receipts"].map((entity) => batch.mutations.findIndex((mutation) => mutation.entity === entity && (entity !== "receipts" || mutation.value.request_id === requestId)));
  assert.ok(indices.every((index) => index >= 0));
  assert.ok(batch.atomicGroups.some((group) => indices.every((index) => group.includes(index))), "publication head, revision and receipt form one business group");
  await transfer(client.w, hub.w, batch);
  const synced = await hubSync.push(localActor, batch); assert.equal(synced.accepted, true);
  assert.deepEqual(await hubSync.push(localActor, batch), synced, "response-loss replay keeps exact sync receipt");
  await transfer(hub.w, client.w, synced.states); clientSync.acknowledge(synced);
  assert.deepEqual((await hub.w.revision(id, 2)).document, (await client.w.revision(id, 2)).document);
  assert.deepEqual(await client.publish(preview, { requestId }), receipt);
  const nextPkg = (await client.w.getAuthoringEditPackageArtifact(localActor, id)).value, next = structuredClone(nextPkg.authoring); next.blocks[1].text = "Divergent offline revision.";
  const nextPreview = (await client.create(next, { target: targetFor(nextPkg) })).preview; await client.publish(nextPreview);
  await hub.command({ kind: "document.revise", documentId: id, expectedRevision: 2, authorized: true, operations: [{ kind: "replace", blockId: saved.document.blocks[1].id, field: "text", value: "Concurrent remote revision." }] });
  clientSync.capture(); const conflictingBatch = clientSync.pending().batches[0]; await transfer(client.w, hub.w, conflictingBatch);
  const conflict = await hubSync.push(localActor, conflictingBatch); assert.equal(conflict.accepted, false);
  await transfer(hub.w, client.w, conflict.states); clientSync.acknowledge(conflict);
  assert.ok(clientSync.conflicts().conflicts.length > 0);
  assert.equal((await client.w.revision(id, 3)).document.blocks[1].text, "Divergent offline revision.");
  assert.equal((await hub.w.revision(id, 3)).document.blocks[1].text, "Concurrent remote revision.");
  assert.deepEqual(await client.publish(preview, { requestId }), receipt, "older business receipt survives a later offline conflict");
});
