import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { createAuthoringEditPackage } from "../authoring-edit-package.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "reader-authoring-review-"));
  const workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  t.after(async () => { await workspace.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(directory.includes("reader-authoring-review-")); await rm(directory, { recursive: true, force: true }); });
  const input = { format: "reader-authoring-1", key: "review-existing", meta: { title: "Existing", language: "en" }, blocks: [
    { key: "kept", type: "para", text: "Keep this." },
    { key: "restored", type: "para", text: "Restore original identity.", translations: { zh: { text: "恢复原身份。" } } },
    { key: "list", type: "list", ordered: false, items: [{ key: "first", text: "First", translations: { zh: { text: "第一" } } }, { key: "second", text: "Second" }] },
    { key: "html", type: "html", html: '<p data-key="first">First HTML.</p><p data-key="second">Second HTML.</p>' },
  ] };
  const upload = authoring => workspace.upload(localActor, Buffer.from(JSON.stringify(authoring)), { filename: "authoring.json", mediaType: "application/json" });
  const create = async (authoring, extra = {}) => workspace.createAuthoringPreview(localActor, {
    authoringSourceId: (await upload(authoring)).sourceId, requestId: randomUUID(), ...extra });
  // Existing-document setup is not a conversion-completion assertion. These
  // tests inspect candidate identity restoration without publishing candidates.
  const receipt = await workspace.publishAuthoring(localActor, { authoringSourceId: (await upload(input)).sourceId, requestId: randomUUID() });
  const saved = await workspace.revision(receipt.document.id);
  const pkg = await createAuthoringEditPackage(saved), target = { documentId: pkg.base.documentId, baseRevision: pkg.base.revision, baseHash: pkg.base.documentHash };
  return { workspace, input, saved, pkg, target, create };
}

test("reverting a candidate deletion restores original block, list-item and HTML-node identities", async (t) => {
  const h = await fixture(t), removed = structuredClone(h.pkg.authoring);
  removed.blocks = removed.blocks.filter((block) => block.key !== "restored");
  removed.blocks.find((block) => block.key === "list").items.shift();
  removed.blocks.find((block) => block.key === "html").html = '<p data-key="second">Second HTML.</p>';
  const first = (await h.create(removed, { target: h.target })).preview;
  const reverted = (await h.create(h.pkg.authoring, { previousPreviewId: first.id })).preview;
  const snapshot = await h.workspace.previewSnapshot(reverted.id);
  const before = h.saved.document.blocks, after = snapshot.validated.document.blocks;
  assert.deepEqual(after.map((block) => block.id), before.map((block) => block.id), "restoring the original author key must recover its original block ID");
  assert.deepEqual(after.find((block) => block.type === "list").items.map((item) => item.id), before.find((block) => block.type === "list").items.map((item) => item.id));
  assert.deepEqual(snapshot.validated.index.filter((entry) => entry.field === "html_text").map((entry) => entry.nodeId), h.saved.index.filter((entry) => entry.field === "html_text").map((entry) => entry.nodeId));
});

test("restoring an original list item from a candidate deletion retains its stale translation provenance", async (t) => {
  const h = await fixture(t), list = h.saved.document.blocks.find((block) => block.type === "list"), item = list.items[0];
  await h.workspace.execute(localActor, { kind: "document.revise", documentId: h.saved.document.id, expectedRevision: 1, requestId: randomUUID(), authorized: true,
    operations: [{ kind: "replace", blockId: list.id, itemId: item.id, field: "text", value: "First, changed after translation." }] });
  const base = await h.workspace.revision(h.saved.document.id), savedItem = base.document.blocks.find((block) => block.id === list.id).items[0];
  assert.notEqual(savedItem.translations.zh.source_hash, base.fingerprints[item.id]);
  const pkg = await createAuthoringEditPackage(base), removed = structuredClone(pkg.authoring);
  removed.blocks.find((block) => block.key === "list").items.shift();
  const target = { documentId: pkg.base.documentId, baseRevision: pkg.base.revision, baseHash: pkg.base.documentHash };
  const first = (await h.create(removed, { target })).preview, restored = (await h.create(pkg.authoring, { previousPreviewId: first.id })).preview;
  const snapshot = await h.workspace.previewSnapshot(restored.id), restoredItem = snapshot.validated.document.blocks.find((block) => block.id === list.id).items[0];
  assert.equal(restoredItem.translations.zh.source_hash, savedItem.translations.zh.source_hash, "restoring a stale translation is not a new review of its source");
  assert.equal(restoredItem.id, item.id);
});

test("restored base identities do not replace newer candidate content or regenerate candidate additions", async (t) => {
  const h = await fixture(t), edited = structuredClone(h.pkg.authoring);
  const removed = edited.blocks.splice(1, 1)[0];
  edited.blocks[0].text = "Newest candidate content.";
  edited.blocks.push({ key: "candidate-added", type: "para", origin: "user", text: "New candidate addition." });
  edited.blocks.find((block) => block.key === "list").items.push({ key: "candidate-item", text: "New list item." });
  edited.blocks.find((block) => block.key === "html").html += '<p data-key="candidate-node">New HTML node.</p>';
  const first = (await h.create(edited, { target: h.target })).preview, before = await h.workspace.previewSnapshot(first.id);
  edited.blocks.splice(1, 0, removed);
  const restored = (await h.create(edited, { previousPreviewId: first.id })).preview, after = await h.workspace.previewSnapshot(restored.id);
  assert.equal(after.validated.document.blocks[0].text, "Newest candidate content.");
  assert.equal(after.compiled.identity.blocks.restored.id, h.saved.identity.blocks.restored.id);
  assert.equal(after.compiled.identity.blocks["candidate-added"].id, before.compiled.identity.blocks["candidate-added"].id);
  assert.equal(after.compiled.identity.blocks.list.items["candidate-item"], before.compiled.identity.blocks.list.items["candidate-item"]);
  assert.equal(after.compiled.identity.blocks.html.nodes.find((node) => node.key === "candidate-node").id, before.compiled.identity.blocks.html.nodes.find((node) => node.key === "candidate-node").id);
});
