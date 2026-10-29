import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { compileInput, validateDocument, applyOperations } from "../documents.mjs";
import { createAuthoringEditPackage } from "../authoring-edit-package.mjs";
import { verifyPreviewSnapshot } from "../authoring-preview.mjs";
import { createWorkspace, localActor } from "../service.mjs";
import { createProtocolReviewEvidence } from "./authoring-protocol-evidence-fixture.mjs";

const example = () => ({
  format: "reader-authoring-1", key: "auxiliary-navigation", meta: { title: "Source without section headings", language: "en" },
  blocks: [
    { key: "opening", type: "para", text: "The original opening.", translations: { "zh-CN": { text: "原始开篇。" } } },
    { key: "evidence", type: "para", text: "The evidence remains a paragraph." },
    { key: "steps", type: "list", ordered: false, items: [{ key: "nested-step", text: "A source item." }] },
    { key: "details", type: "html", html: '<p data-key="nested-detail">A source detail.</p>' },
    { key: "ending", type: "para", text: "The original ending." },
  ],
  navigation: { kind: "auxiliary", items: [
    { targetKey: "opening", text: "Problem and motivation", level: 1, translations: { "zh-CN": { text: "问题与动机" } } },
    { targetKey: "evidence", text: "Evidence", level: 2 },
    { targetKey: "ending", text: "Discussion", level: 1 },
  ] },
});
const indexedContent = (index) => index.map(({ revision, ...entry }) => entry);

async function savedInput(input = example()) {
  const compiled = await compileInput(input), validated = await validateDocument(compiled.document);
  return { ...compiled, ...validated, resourceMap: {} };
}

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), "reader-authoring-navigation-"));
  let w = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  t.after(async () => {
    await w.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes("reader-authoring-navigation-"));
    await rm(directory, { recursive: true, force: true });
  });
  const upload = (value) => w.upload(localActor, Buffer.from(JSON.stringify(value)), { filename: "authoring.json", mediaType: "application/json" });
  const create = async (input, extra = {}) => w.createAuthoringPreview(localActor, { authoringSourceId: (await upload(input)).sourceId, requestId: randomUUID(), ...extra });
  const reviews = new Map();
  const publish = async (preview, extra = {}) => {
    if (!reviews.has(preview.id)) reviews.set(preview.id, createProtocolReviewEvidence({ preview,
      readReport: async current => (await w.getPreviewArtifact(localActor, current.id, "report")).value,
      upload: (bytes, filename, mediaType) => w.upload(localActor, bytes, { filename, mediaType }) }));
    return w.publishAuthoringPreview(localActor, { previewId: preview.id, expectedHash: preview.hash, requestId: randomUUID(),
      review: (await reviews.get(preview.id)).review, ...extra });
  };
  // Seed ordinary navigation-operation data through the internal business API;
  // the immutable preview publication assertions below use protocol evidence.
  const seed = async input => w.publishAuthoring(localActor, { authoringSourceId: (await upload(input)).sourceId, requestId: randomUUID() });
  return { get w() { return w; }, create, publish, seed,
    command: (command) => w.execute(localActor, { requestId: randomUUID(), ...command }),
    restart: async () => { await w.close(); w = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false }); },
  };
}

test("auxiliary navigation compiles to existing stable targets without changing source content, indexes or fingerprints", async () => {
  const input = example(), without = structuredClone(input); delete without.navigation;
  const base = await savedInput(without), compiled = await compileInput(input, base), validated = await validateDocument(compiled.document);
  assert.deepEqual(compiled.document.blocks, base.document.blocks);
  assert.deepEqual(indexedContent(validated.index), indexedContent(base.index));
  assert.deepEqual(validated.fingerprints, base.fingerprints);
  assert.equal(compiled.document.blocks.some((block) => block.type === "heading"), false);
  assert.deepEqual(compiled.document.navigation.items.map((item) => item.targetId), [base.document.blocks[0].id, base.document.blocks[1].id, base.document.blocks[4].id]);
  assert.equal(compiled.document.navigation.items[0].translations["zh-CN"].text, "问题与动机");
  assert.equal(Object.hasOwn(compiled.document.navigation.items[0], "targetKey"), false);
  assert.equal(JSON.stringify(validated.index).includes("Problem and motivation"), false);
  assert.equal(Object.hasOwn(base.document, "navigation"), false);
});

test("auxiliary label and translation edits retain block identities and source translation provenance", async () => {
  const base = await savedInput(), input = example();
  input.navigation.items[0].text = "New navigation wording";
  input.navigation.items[0].translations["zh-CN"].text = "新导航措辞";
  const next = await compileInput(input, base), validated = await validateDocument(next.document);
  assert.equal(next.document.id, base.document.id);
  assert.equal(next.document.revision, base.document.revision + 1);
  assert.deepEqual(next.document.blocks, base.document.blocks);
  assert.deepEqual(indexedContent(validated.index), indexedContent(base.index));
  assert.deepEqual(validated.fingerprints, base.fingerprints);
  assert.deepEqual(next.document.navigation.items.map((item) => item.targetId), base.document.navigation.items.map((item) => item.targetId));
});

test("new authoring rejects malformed, missing, duplicated, nested and out-of-order navigation", async (t) => {
  const cases = [
    ["empty items", (input) => { input.navigation.items = []; }, "E_AUTHOR_VALUE"],
    ["too many items", (input) => { input.navigation.items = Array.from({ length: 201 }, () => input.navigation.items[0]); }, "E_AUTHOR_VALUE"],
    ["unknown kind", (input) => { input.navigation.kind = "source"; }, "E_AUTHOR_VALUE"],
    ["unknown property", (input) => { input.navigation.items[0].generated = true; }, "E_AUTHOR_FIELD"],
    ["generated target id", (input) => { input.navigation.items[0].targetId = "b-runtime"; }, "E_AUTHOR_FIELD"],
    ["missing target", (input) => { input.navigation.items[0].targetKey = "missing"; }, "E_AUTHOR_NAVIGATION_TARGET"],
    ["list item target", (input) => { input.navigation.items[0].targetKey = "nested-step"; }, "E_AUTHOR_NAVIGATION_TARGET"],
    ["html node target", (input) => { input.navigation.items[0].targetKey = "nested-detail"; }, "E_AUTHOR_NAVIGATION_TARGET"],
    ["duplicate target", (input) => { input.navigation.items[1].targetKey = "opening"; }, "E_AUTHOR_NAVIGATION_TARGET"],
    ["wrong order", (input) => { input.navigation.items.reverse(); }, "E_AUTHOR_NAVIGATION_ORDER"],
    ["empty label", (input) => { input.navigation.items[0].text = ""; }, "E_AUTHOR_VALUE"],
    ["blank label", (input) => { input.navigation.items[0].text = "  "; }, "E_AUTHOR_NAVIGATION_LABEL"],
    ["long label", (input) => { input.navigation.items[0].text = "x".repeat(121); }, "E_AUTHOR_VALUE"],
    ["multiline label", (input) => { input.navigation.items[0].text = "First\nsecond"; }, "E_AUTHOR_NAVIGATION_LABEL"],
    ["unicode line separator", (input) => { input.navigation.items[0].text = "First\u2028second"; }, "E_AUTHOR_NAVIGATION_LABEL"],
    ["html label", (input) => { input.navigation.items[0].text = "<b>Text</b>"; }, "E_AUTHOR_NAVIGATION_LABEL"],
    ["markdown label", (input) => { input.navigation.items[0].text = "**Text**"; }, "E_AUTHOR_NAVIGATION_LABEL"],
    ["link label", (input) => { input.navigation.items[0].text = "[Text](https://example.com)"; }, "E_AUTHOR_NAVIGATION_LABEL"],
    ["formula label", (input) => { input.navigation.items[0].text = "$x^2$"; }, "E_AUTHOR_NAVIGATION_LABEL"],
    ["invalid translation", (input) => { input.navigation.items[0].translations["zh-CN"].text = "   "; }, "E_AUTHOR_NAVIGATION_LABEL"],
    ["invalid translation language", (input) => { input.navigation.items[0].translations.source = { text: "Source" }; }, "E_AUTHOR_VALUE"],
    ["translation provenance field", (input) => { input.navigation.items[0].translations["zh-CN"].source_hash = "generated"; }, "E_AUTHOR_DERIVED"],
    ["zero level", (input) => { input.navigation.items[0].level = 0; }, "E_AUTHOR_VALUE"],
    ["deep level", (input) => { input.navigation.items[0].level = 4; }, "E_AUTHOR_VALUE"],
    ["fractional level", (input) => { input.navigation.items[0].level = 1.5; }, "E_AUTHOR_VALUE"],
  ];
  for (const [name, mutate, code] of cases) await t.test(name, async () => {
    const input = example(); mutate(input);
    await assert.rejects(compileInput(input), (error) => error.code === "VALIDATION_FAILED" && error.details.diagnostics.some((diagnostic) => diagnostic.code === code && diagnostic.path.startsWith("$.navigation")));
  });
});

test("plain comparison labels and all documented top-level targets are valid", async () => {
  const input = example();
  input.navigation.items = input.blocks.map((block, index) => ({ targetKey: block.key, text: index ? block.key : "Error < 1 and cost > 0", level: index % 3 + 1 }));
  const compiled = await compileInput(input);
  assert.deepEqual(compiled.document.navigation.items.map((item) => item.targetId), compiled.document.blocks.map((block) => block.id));
});

test("complete editing export maps navigation back to stable author keys and preserves its exact semantics", async () => {
  const base = await savedInput(), pkg = await createAuthoringEditPackage(base);
  assert.deepEqual(pkg.authoring.navigation, example().navigation);
  const next = await compileInput(pkg.authoring, { identity: pkg.identity, document: pkg.document });
  assert.deepEqual(next.document.navigation, base.document.navigation);
  assert.deepEqual(next.document.blocks, base.document.blocks);
  assert.equal(pkg.verification.sourceFingerprintsPreserved, true);
});

test("old unknown or malformed navigation remains readable and is never silently lost through editing export", async (t) => {
  for (const navigation of [null, { kind: "legacy", payload: ["keep"] }, { kind: "auxiliary", items: [{ targetId: "missing", text: "Unresolved", level: 1 }] }]) {
    await t.test(JSON.stringify(navigation), async () => {
      const base = await savedInput(); base.document.navigation = navigation;
      const validated = await validateDocument(base.document);
      assert.deepEqual(validated.document.navigation, navigation);
      const revised = await applyOperations(base.document, [{ kind: "move", blockId: base.document.blocks[0].id, afterBlockId: base.document.blocks[4].id }]);
      assert.deepEqual(revised.document.navigation, navigation);
      await assert.rejects(createAuthoringEditPackage({ ...base, ...validated }), { code: "EDITING_EXPORT_UNSUPPORTED" });
    });
  }
  const base = await savedInput();
  base.document.navigation.items[0].unknownLegacyFact = "Keep this future item unchanged";
  const moved = await applyOperations(base.document, [{ kind: "move", blockId: base.document.blocks[0].id, afterBlockId: base.document.blocks[4].id }]);
  assert.deepEqual(moved.document.navigation, base.document.navigation);
  await assert.rejects(createAuthoringEditPackage(base), { code: "EDITING_EXPORT_UNSUPPORTED" });
});

test("navigation-only revision uses the reviewed immutable snapshot hash while preserving all source anchors", async (t) => {
  const h = await harness(t), input = example(); delete input.navigation;
  const initial = (await h.create(input)).preview, first = await h.publish(initial), base = await h.w.revision(first.document.id);
  const pkg = await createAuthoringEditPackage(base);
  pkg.authoring.navigation = example().navigation;
  const preview = (await h.create(pkg.authoring, { target: { documentId: base.document.id, baseRevision: 1, baseHash: pkg.base.documentHash } })).preview;
  assert.notEqual(preview.hash, initial.hash);
  const snapshot = await h.w.previewSnapshot(preview.id), tampered = structuredClone(snapshot);
  tampered.validated.document.navigation.items[0].text = "Changed after review";
  assert.throws(() => verifyPreviewSnapshot(tampered), { code: "PREVIEW_HASH_MISMATCH" });
  await assert.rejects(h.publish(preview, { expectedHash: initial.hash }), { code: "PREVIEW_HASH_MISMATCH" });
  assert.equal(h.w.row(base.document.id).current_revision, 1);
  await h.publish(preview);
  const revised = await h.w.revision(base.document.id);
  assert.equal(revised.document.revision, 2);
  assert.deepEqual(revised.document.blocks, base.document.blocks);
  assert.deepEqual(revised.fingerprints, base.fingerprints);
  assert.deepEqual(indexedContent(revised.index), indexedContent(base.index));
  assert.deepEqual(revised.document.navigation.items.map((item) => item.targetId), [base.document.blocks[0].id, base.document.blocks[1].id, base.document.blocks[4].id]);
  assert.equal(Object.hasOwn((await h.w.revision(base.document.id, 1)).document, "navigation"), false);
  assert.deepEqual((await createAuthoringEditPackage(revised)).authoring.navigation, example().navigation);
});

test("precise move/remove operations keep exact targets, ordered navigation and immutable earlier revisions", async (t) => {
  const h = await harness(t), published = await h.seed(example());
  const id = published.document.id, original = await h.w.revision(id), originalCopy = structuredClone(original.document);
  const [opening, evidence, , , ending] = original.document.blocks;
  await h.command({ kind: "document.revise", documentId: id, expectedRevision: 1, authorized: true, operations: [
    { kind: "move", blockId: ending.id, beforeBlockId: opening.id },
    { kind: "remove", blockId: evidence.id },
  ] });
  const current = await h.w.revision(id);
  assert.deepEqual(current.document.navigation.items.map((item) => item.targetId), [ending.id, opening.id]);
  assert.deepEqual(current.document.navigation.items.map((item) => item.text), ["Discussion", "Problem and motivation"]);
  assert.deepEqual((await h.w.revision(id, 1)).document, originalCopy);
  assert.deepEqual(original.document, originalCopy, "operations never mutate the supplied earlier revision");
  const pkg = await createAuthoringEditPackage(current);
  assert.deepEqual(pkg.authoring.navigation.items.map((item) => item.targetKey), ["ending", "opening"]);
  assert.deepEqual(pkg.document.navigation, current.document.navigation);
  const revisionPreview = (await h.create(pkg.authoring, { target: { documentId: id, baseRevision: 2, baseHash: pkg.base.documentHash } })).preview;
  const frozen = await h.w.previewSnapshot(revisionPreview.id);
  assert.deepEqual(frozen.validated.document.navigation, current.document.navigation);
  await h.publish(revisionPreview);
  await h.restart();
  assert.deepEqual((await h.w.revision(id)).document.navigation, current.document.navigation);
  assert.deepEqual((await h.w.revision(id, 1)).document, originalCopy);
  assert.deepEqual((await h.w.revision(id, 2)).document, current.document);
  assert.equal(h.w.snapshot().documents.length, 1);
  await h.command({ kind: "document.revise", documentId: id, expectedRevision: 3, authorized: true, operations: [
    { kind: "remove", blockId: ending.id }, { kind: "remove", blockId: opening.id },
  ] });
  const withoutNavigation = await h.w.revision(id);
  assert.equal(Object.hasOwn(withoutNavigation.document, "navigation"), false);
  assert.equal(Object.hasOwn((await createAuthoringEditPackage(withoutNavigation)).authoring, "navigation"), false);
  assert.deepEqual((await h.w.revision(id, 3)).document.navigation, current.document.navigation);
});
