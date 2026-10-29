import test from "node:test";
import assert from "node:assert/strict";
import { canonical, hash } from "../errors.mjs";
import { deriveAuthoringReviewScope } from "../authoring-review-scope.mjs";
import { prepareAuthoring } from "../authoring-core.mjs";
import { compileInput, validateDocument } from "../documents.mjs";
import { freezeAuthoringPreview, verifyPreviewSnapshot } from "../authoring-preview.mjs";

const document = () => ({ id: "doc-scope", schema: 2, revision: 1, meta: { title: "Scope", language: "en" }, blocks: [
  { id: "paragraph", type: "para", text: "Original paragraph." },
  { id: "figure", type: "figure", src: "figure.png" },
  { id: "html", type: "html", html: '<div class="layout-pair"><p>A</p><p>B</p></div>', css: ".layout-pair { gap: 8px; }" },
] });
const file = (digest = "a", extra = {}) => ({ id: "file-" + digest, sha256: digest.repeat(64), size: 8, mediaType: "image/png", ...extra });
const derive = (baseline, candidate, extra = {}) => deriveAuthoringReviewScope({ baseline, candidate, ...extra });
const digestValid = ({ scopeHash, ...scope }) => assert.equal(scopeHash, hash(canonical(scope)));

test("a new document has full service-derived coverage with a deterministic scope hash", () => {
  const candidate = document(), original = structuredClone(candidate);
  const scope = derive(null, candidate, { candidateResourceMap: { "figure.png": file() } });
  assert.equal(scope.kind, "full"); assert.deepEqual(scope.requiredBlockIds, ["figure", "html", "paragraph"]);
  assert.deepEqual(scope.removedBlockIds, []); assert.equal(scope.metaChanged, true); assert.equal(scope.orderChanged, true);
  assert.deepEqual(scope.changedResourcePaths, ["figure.png"]); digestValid(scope);
  assert.deepEqual(candidate, original); assert.deepEqual(derive(null, candidate, { candidateResourceMap: { "figure.png": file() } }), scope);
});

test("unchanged revision counters and compiler identity metadata do not require a full reread", () => {
  const baseline = document(), candidate = structuredClone(baseline); candidate.revision++;
  baseline.extensions = { "continous-reader.authoring": { key: "paper", format: "reader-authoring-1" } };
  candidate.extensions = { "continous-reader.authoring": { key: "paper", format: "reader-authoring-1", diagnostic: "derived" } };
  const scope = derive(baseline, candidate);
  assert.equal(scope.kind, "affected"); assert.deepEqual(scope.requiredBlockIds, []);
  assert.equal(scope.metaChanged, false); assert.equal(scope.navigationChanged, false); assert.equal(scope.orderChanged, false); digestValid(scope);
});

test("a metadata-only edit retains a dedicated check without reviewing unchanged body text", () => {
  const baseline = document(), candidate = structuredClone(baseline); candidate.meta.translations = { "zh-CN": { title: "范围" } };
  const scope = derive(baseline, candidate);
  assert.equal(scope.kind, "affected"); assert.equal(scope.metaChanged, true); assert.deepEqual(scope.requiredBlockIds, []);
  assert.equal(scope.orderChanged, false); assert.equal(scope.sourceChanged, false);
});

test("complete block comparison includes translations and nested list changes", () => {
  const baseline = document(); baseline.blocks.push({ id: "list", type: "list", ordered: false, items: [{ id: "item", text: "Item" }] });
  const candidate = structuredClone(baseline);
  candidate.blocks[0].translations = { "zh-CN": { text: "原段落。" } };
  candidate.blocks.at(-1).items[0].translations = { "zh-CN": { text: "条目" } };
  const scope = derive(baseline, candidate);
  assert.equal(scope.kind, "affected"); assert.deepEqual(scope.requiredBlockIds, ["list", "paragraph"]);
});

test("changing the inherited document language expands beyond metadata-only review", () => {
  const baseline = document(), candidate = structuredClone(baseline); candidate.meta.language = "zh-CN";
  const scope = derive(baseline, candidate);
  assert.equal(scope.metaChanged, true); assert.equal(scope.kind, "full"); assert.equal(scope.requiredBlockIds.length, candidate.blocks.length);
});

test("new textless figures and removed blocks cannot disappear from the review scope", () => {
  const baseline = document(), candidate = structuredClone(baseline);
  candidate.blocks = candidate.blocks.filter((block) => block.id !== "paragraph");
  candidate.blocks.push({ id: "new-figure", type: "figure", src: "figure.png" });
  const scope = derive(baseline, candidate);
  assert.deepEqual(scope.requiredBlockIds, ["new-figure"]); assert.deepEqual(scope.removedBlockIds, ["paragraph"]);
  assert.equal(scope.orderChanged, true); assert.equal(scope.kind, "affected");
});

test("order-only and navigation-only edits require their own checks without inventing body changes", () => {
  const baseline = document(), ordered = structuredClone(baseline), navigable = structuredClone(baseline);
  ordered.blocks.reverse(); navigable.navigation = { kind: "auxiliary", items: [{ target: "paragraph", text: "Context", level: 1 }] };
  const order = derive(baseline, ordered), navigation = derive(baseline, navigable);
  assert.equal(order.orderChanged, true); assert.equal(order.navigationChanged, false); assert.deepEqual(order.requiredBlockIds, []);
  assert.equal(navigation.navigationChanged, true); assert.equal(navigation.orderChanged, false); assert.deepEqual(navigation.requiredBlockIds, []);
  assert.notEqual(order.scopeHash, navigation.scopeHash);
});

test("same-path resource replacement includes source, translated, fallback and extension consumers", () => {
  const baseline = document(); baseline.blocks.push(
    { id: "html-asset", type: "html", html: '<p>Image</p>', translations: { "zh-CN": { html: '<img src="figure.png" alt="图">' } } },
    { id: "fallback", type: "html", html: "<p>Fallback</p>", fallback: { image: "figure.png" } },
    { id: "table", type: "table", head: [], rows: [["1"]], extensions: { "continous-reader.source-table": { image: "figure.png" } } },
  );
  const candidate = structuredClone(baseline), scope = derive(baseline, candidate, {
    baselineResourceMap: { "figure.png": file("a") }, candidateResourceMap: { "figure.png": file("b") },
  });
  assert.equal(scope.kind, "affected"); assert.deepEqual(scope.changedResourcePaths, ["figure.png"]);
  assert.deepEqual(scope.requiredBlockIds, ["fallback", "figure", "html-asset", "table"]);
});

test("HTML dependency parsing decodes escaped paths rather than using text matching", () => {
  const baseline = document(); baseline.blocks[2].html = '<img src="figures/a&amp;b.png" alt="Figure">';
  const scope = derive(baseline, structuredClone(baseline), { baselineResourceMap: { "figures/a&b.png": file("a") }, candidateResourceMap: { "figures/a&b.png": file("b") } });
  assert.equal(scope.kind, "affected"); assert.deepEqual(scope.requiredBlockIds, ["html"]);
});

test("binding metadata alone does not make unchanged bytes require another resource review", () => {
  const baseline = document(), scope = derive(baseline, structuredClone(baseline), {
    baselineResourceMap: { "figure.png": file("a", { filename: "old.png" }) },
    candidateResourceMap: { "figure.png": file("a", { id: "new-file-id", filename: "new.png", createdAt: "later" }) },
  });
  assert.deepEqual(scope.changedResourcePaths, []); assert.deepEqual(scope.requiredBlockIds, []);
});

test("local layout changes cover their entire HTML group while global layout changes widen safely", () => {
  const baseline = document(), local = structuredClone(baseline), global = structuredClone(baseline);
  local.blocks[2].css = ".layout-pair { gap: 16px; }";
  global.extensions = { "future.layout": { columns: 2 } };
  assert.deepEqual(derive(baseline, local).requiredBlockIds, ["html"]);
  const scope = derive(baseline, global); assert.equal(scope.kind, "full"); assert.deepEqual(scope.requiredBlockIds, ["figure", "html", "paragraph"]);
});

test("unknown resource consumers and opaque retained block types widen rather than narrow review", () => {
  const baseline = document();
  const unknownPath = derive(baseline, structuredClone(baseline), { baselineResourceMap: { "legacy.bin": file("a") }, candidateResourceMap: { "legacy.bin": file("b") } });
  assert.equal(unknownPath.kind, "full"); assert.equal(unknownPath.requiredBlockIds.length, baseline.blocks.length);
  baseline.blocks.push({ id: "legacy", type: "unknown-retained", value: "opaque" });
  const opaque = derive(baseline, structuredClone(baseline), { baselineResourceMap: { "figure.png": file("a") }, candidateResourceMap: { "figure.png": file("b") } });
  assert.equal(opaque.kind, "full"); assert.ok(opaque.requiredBlockIds.includes("legacy"));
});

test("retained unsupported CSS asset forms do not lose their dependency when another consumer is known", () => {
  const baseline = document(); baseline.blocks[2].css = '.legacy { background: URL("figure.png"); }';
  const scope = derive(baseline, structuredClone(baseline), { baselineResourceMap: { "figure.png": file("a") }, candidateResourceMap: { "figure.png": file("b") } });
  assert.equal(scope.kind, "full"); assert.deepEqual(scope.requiredBlockIds, ["figure", "html", "paragraph"]);
});

test("original source changes require full review even when all paragraph strings are equal", () => {
  const baseline = document(); baseline.source = { path: "source.pdf", sha256: "a".repeat(64) };
  const candidate = structuredClone(baseline); candidate.source.sha256 = "b".repeat(64);
  const scope = derive(baseline, candidate);
  assert.equal(scope.sourceChanged, true); assert.equal(scope.kind, "full"); assert.equal(scope.requiredBlockIds.length, candidate.blocks.length);
});

test("caller-provided scope lists cannot override service-derived changes", () => {
  const baseline = document(), candidate = structuredClone(baseline); candidate.blocks[0].text = "Changed.";
  const scope = derive(baseline, candidate, { requiredBlockIds: [], kind: "affected", reviewScope: { requiredBlockIds: [] } });
  assert.deepEqual(scope.requiredBlockIds, ["paragraph"]);
});

test("prepareAuthoring freezes derived review scope through the existing revisionTargetHash chain", async () => {
  const input = { format: "reader-authoring-1", key: "scope-integration", meta: { title: "Scope integration", language: "en" }, blocks: [
    { key: "one", type: "para", text: "First paragraph." }, { key: "two", type: "para", text: "Second paragraph." },
  ] };
  const compiled = await compileInput(input), validated = await validateDocument(compiled.document, { resourceMap: {} });
  const baseline = { ...validated, authoring: compiled.authoring, identity: compiled.identity, resourceMap: {} };
  const next = structuredClone(input); next.blocks[1].translations = { "zh-CN": { text: "第二段。" } };
  const bytes = Buffer.from(JSON.stringify(next)), source = { id: "file-candidate", sha256: hash(bytes), size: bytes.length, mediaType: "application/json" };
  const row = { document_id: baseline.document.id, revision: baseline.document.revision, payload: "synthetic baseline" };
  const workspace = {
    file: async () => source, files: async () => [],
    row: async () => ({ id: baseline.document.id, current_revision: baseline.document.revision }), revisionRow: async () => row,
    storage: { load: async () => baseline }, sql: { query: async () => [] },
    resources: { read: async () => bytes, open: async () => (async function* () { yield bytes; })() },
  };
  const prepared = await prepareAuthoring(workspace, { authoringSourceId: source.id, resources: {}, target: {
    documentId: baseline.document.id, baseRevision: baseline.document.revision, baseHash: hash(canonical(baseline.document)),
  } });
  const scope = prepared.revisionTarget.reviewScope;
  assert.equal(scope.kind, "affected"); assert.deepEqual(scope.requiredBlockIds, [baseline.document.blocks[1].id]); digestValid(scope);
  const frozen = freezeAuthoringPreview(prepared);
  assert.equal(frozen.manifest.version, "reader-preview-3");
  assert.equal(frozen.manifest.revisionTargetHash, hash(canonical(JSON.parse(JSON.stringify(frozen.revisionTarget)))));
  verifyPreviewSnapshot(frozen);
  const tampered = structuredClone(frozen); tampered.revisionTarget.reviewScope.requiredBlockIds = [];
  assert.throws(() => verifyPreviewSnapshot(tampered), (error) => error.code === "PREVIEW_HASH_MISMATCH");
  assert.deepEqual(baseline.document, validated.document, "The saved baseline is not modified.");
});
