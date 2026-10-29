import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createWorkspaceServer } from "../server.mjs";
import { canonical, hash } from "../errors.mjs";
import { localActor } from "../actor.mjs";
import { collectQualityEvidence, previewQualityReport, QUALITY_LIMITS, QUALITY_REVIEW_FORMAT, requirePublishableQuality, storedAuthoringQuality, validateQualityReview } from "../authoring-quality.mjs";
import { createFileCapabilities } from "../file-capabilities.mjs";

async function fixture(t, { authToken = "" } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-quality-test-"));
  const fileCapabilities = await createFileCapabilities();
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  let server, base;
  const start = async () => {
    server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false, authToken, fileCapabilities });
    await new Promise(done => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  await start();
  const request = async (path, body, expected = 200, requestHeaders = headers) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { ...requestHeaders, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  const upload = async (value, filename = "review.json", mediaType = "application/json") => {
    const bytes = mediaType === "application/json" && typeof value !== "string" ? JSON.stringify(value) : value;
    const response = await fetch(base + "/api/sources?filename=" + encodeURIComponent(filename), { method: "POST", headers: { ...headers, "Content-Type": mediaType }, body: bytes });
    const file = await response.json(); assert.equal(response.status, 201, JSON.stringify(file)); return file;
  };
  const create = async (input = documentInput(), previousPreviewId) => {
    const source = await upload(input, "authoring.json");
    return (await request("/api/authoring/previews", { authoringSourceId: source.sourceId, requestId: randomUUID(), ...(previousPreviewId ? { previousPreviewId } : {}) }, 201)).preview;
  };
  t.after(async () => {
    await server.shutdown();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir())); assert.ok(basename(dataDir).startsWith("reader-quality-test-"));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { request, upload, create, headers, fileCapabilities, get base() { return base; }, get w() { return server.workspace; }, restart: async () => { await server.shutdown(); await start(); } };
}

function documentInput() {
  return { format: "reader-authoring-1", key: "quality-fixture", meta: { title: "Quality fixture", language: "en" }, blocks: [
    { key: "paragraph", type: "para", text: "A complete synthetic source paragraph." },
    { key: "list", type: "list", ordered: false, items: [{ key: "one", text: "First item." }] },
    { key: "table", type: "table", head: [["Method", "Value"]], rows: [["A", "10541–10551"]] },
    { key: "html", type: "html", html: '<p data-key="inner">Addressable text.</p>' },
  ] };
}
const reportPath = (preview, ids) => `/api/authoring/previews/${preview.id}/artifacts/report.json${ids ? "?evidenceSourceIds=" + ids.join(",") : ""}`;
const submission = (preview, ids = []) => ({ previewId: preview.id, expectedHash: preview.hash, requestId: randomUUID(), review: {
  sourceReview: "Synthetic fixture; no original PDF or source-fidelity acceptance is claimed.",
  layoutReview: "Synthetic evidence tests only; no actual browser appearance acceptance is claimed.",
  interactionReview: "This fixture verifies the HTTP quality-evidence workflow; no browser interaction is claimed.", evidenceSourceIds: ids,
} });
function review(preview, evidenceId, role = "independent") {
  return { format: QUALITY_REVIEW_FORMAT, preview: { id: preview.id, hash: preview.hash },
    reviewer: { id: "synthetic-reviewer", role, method: "Synthetic review assertions for automated protocol tests; no human review is claimed." },
    baseline: { sourceSha256: null, artifactSourceIds: [] },
    layers: { source_fidelity: { status: "not_applicable", summary: "Synthetic example with no external original.", evidenceSourceIds: [] },
      reader_visual: { status: "verified", summary: "Synthetic visual-evidence claim tests binding, not actual appearance.", evidenceSourceIds: [evidenceId] },
      usability: { status: "verified", summary: "Synthetic usability-evidence claim tests binding, not actual interactions.", evidenceSourceIds: [evidenceId] } }, issues: [] };
}
const issue = (extra = {}) => ({ key: "figure-right-edge", layer: "reader_visual", severity: "blocking", status: "failed", authorKey: "paragraph",
  expected: "The complete source object is reachable.", actual: "A reviewer found a clipped right edge.", evidenceSourceIds: [], recheck: { suggestion: "Compare against an enlarged original page including the surrounding axis and caption." }, ...extra });

test("initial preview quality separates structural PASS from three unverified layers and preserves the frozen hash", async t => {
  const h = await fixture(t), preview = await h.create(), snapshot = await h.w.previewSnapshot(preview.id);
  const before = canonical(snapshot), manifest = await h.request(`/api/authoring/previews/${preview.id}/artifacts/manifest.json`);
  const report = await h.request(reportPath(preview)), q = report.quality;
  assert.equal(q.status, "unverified"); assert.equal(q.layers.structural_resources.status, "verified");
  for (const layer of ["source_fidelity", "reader_visual", "usability"]) assert.equal(q.layers[layer].status, "unverified");
  assert.deepEqual(q.preview, { id: preview.id, hash: preview.hash });
  assert.equal(q.observations.headingCount, 0); assert.equal(q.observations.navigationEntryCount, 0);
  assert.ok(q.issues.some(issue => issue.key === "navigation-no-entries" && issue.severity === "warning"));
  assert.equal(q.publication.allowed, false); assert.ok(q.publication.pendingCheckKeys.includes("independent_review"));
  assert.equal(hash(canonical(manifest)), preview.hash);
  assert.equal(canonical(await h.w.previewSnapshot(preview.id)), before);
  const input = documentInput(); input.navigation = { kind: "auxiliary", items: [{ targetKey: "paragraph", text: "Setup", level: 1 }] };
  const navigable = await h.create(input, preview.id), navigationReport = await h.request(reportPath(navigable));
  assert.equal(navigationReport.quality.observations.navigationKind, "auxiliary");
  assert.equal(navigationReport.quality.observations.navigationEntryCount, 1);
  assert.ok(!navigationReport.quality.issues.some(issue => issue.key === "navigation-no-entries"));
});

test("legacy text remains unverified and cannot publish a new candidate, including after restart", async t => {
  const h = await fixture(t), preview = await h.create(), input = submission(preview);
  const before = await h.request("/api/workspace");
  const rejected = await h.request("/api/authoring/previews/publish", input, 409);
  assert.equal(rejected.code, "AUTHORING_QUALITY_FAILED");
  const snapshot = await h.w.previewSnapshot(preview.id);
  const report = { quality: previewQualityReport(snapshot, { legacyReview: input.review }) };
  assert.equal(report.quality.status, "unverified"); assert.equal(report.quality.legacyReview.status, "unverified");
  assert.equal(report.quality.layers.reader_visual.status, "unverified");
  assert.equal(report.quality.preview.hash, preview.hash);
  assert.equal(h.w.db.prepare("SELECT * FROM receipts WHERE request_id = ?").get(input.requestId), undefined);
  await h.restart();
  assert.deepEqual(await h.request("/api/authoring/previews/publish", input, 409), rejected);
  assert.deepEqual(await h.request("/api/workspace"), before);
  assert.equal(h.w.db.prepare("SELECT * FROM receipts WHERE request_id = ?").get(input.requestId), undefined);
});

test("structured failed evidence is visible before publication and blocks it without mutating the frozen preview", async t => {
  const h = await fixture(t), preview = await h.create(), evidence = await h.upload("Synthetic observation of clipped content", "crop.txt", "text/plain");
  const value = review(preview, evidence.sourceId); value.issues = [issue({ evidenceSourceIds: [evidence.sourceId] })];
  const reportFile = await h.upload(value), ids = [reportFile.sourceId, evidence.sourceId];
  const before = canonical(await h.w.previewSnapshot(preview.id));
  const projected = (await h.request(reportPath(preview, ids))).quality;
  assert.equal(projected.status, "failed"); assert.equal(projected.publication.allowed, false);
  assert.equal(projected.layers.reader_visual.status, "failed");
  assert.ok(projected.issues.some(issue => issue.key === "figure-right-edge" && issue.authorKey === "paragraph"));
  const rejected = await h.request("/api/authoring/previews/publish", submission(preview, ids), 409);
  assert.equal(rejected.code, "AUTHORING_QUALITY_FAILED");
  assert.deepEqual(rejected.details.blockingIssueKeys, ["figure-right-edge"]);
  assert.equal((await h.request("/api/workspace")).documents.length, 0);
  assert.equal(canonical(await h.w.previewSnapshot(preview.id)), before);
  assert.equal((await h.request(reportPath(preview))).quality.status, "unverified", "review projection does not overwrite the immutable candidate");
  const input = documentInput(); input.blocks[0].text += " The source object is now complete.";
  const updated = await h.create(input, preview.id);
  const old = await h.request("/api/authoring/previews/publish", submission(updated, ids), 409);
  assert.equal(old.code, "QUALITY_PREVIEW_MISMATCH");
  const fixed = review(updated, evidence.sourceId);
  fixed.issues = [issue({ status: "resolved", actual: "Compared the corrected candidate and found the full object.", evidenceSourceIds: [evidence.sourceId], recheck: { suggestion: "Compare corrected content with the original context.", previousIssueKey: "figure-right-edge", previousPreviewId: preview.id } })];
  const corrected = await h.upload(fixed), correctedIds = [corrected.sourceId, evidence.sourceId];
  const saved = await h.request(reportPath(updated, correctedIds));
  assert.equal(saved.quality.status, "unverified"); assert.equal(saved.quality.layers.source_fidelity.status, "not_applicable");
  assert.equal(saved.quality.reviews[0].independence, "declared-not-authenticated");
  assert.equal(saved.quality.issues.find(item => item.key === "figure-right-edge").recheck.previousPreviewId, preview.id);
  assert.equal(saved.quality.publication.allowed, false, "resolving a v1 finding does not complete the v2 workflow");
  assert.equal((await h.request("/api/authoring/previews/publish", submission(updated, correctedIds), 409)).code, "AUTHORING_QUALITY_FAILED");
  assert.equal((await h.request("/api/workspace")).documents.length, 0);
});

test("unverified blocking issues and failed layers block even when other claims say verified; warnings remain visible", async t => {
  const h = await fixture(t), preview = await h.create(), evidence = await h.upload("Synthetic observation", "checks.txt", "text/plain");
  for (const mode of ["unverified-blocker", "failed-layer"]) {
    const value = review(preview, evidence.sourceId);
    if (mode === "unverified-blocker") value.issues = [issue({ status: "unverified" })];
    else value.layers.usability.status = "failed";
    const file = await h.upload(value);
    const rejected = await h.request("/api/authoring/previews/publish", submission(preview, [file.sourceId, evidence.sourceId]), 409);
    assert.equal(rejected.code, "AUTHORING_QUALITY_FAILED");
  }
  const value = review(preview, evidence.sourceId); value.issues = [issue({ severity: "warning", status: "unverified" })];
  const file = await h.upload(value), projection = (await h.request(reportPath(preview, [file.sourceId, evidence.sourceId]))).quality;
  assert.equal(projection.publication.allowed, false);
  assert.ok(projection.publication.pendingCheckKeys.includes("independent_review"));
  assert.ok(projection.issues.some(issue => issue.key === "figure-right-edge" && issue.status === "unverified"));
});

test("generator declarations are never promoted to independently verified quality", async t => {
  const h = await fixture(t), preview = await h.create(), evidence = await h.upload("Self review notes", "self.txt", "text/plain");
  const file = await h.upload(review(preview, evidence.sourceId, "generator"));
  const q = (await h.request(reportPath(preview, [file.sourceId, evidence.sourceId]))).quality;
  assert.equal(q.status, "unverified"); assert.equal(q.layers.reader_visual.status, "unverified");
  assert.equal(q.layers.reader_visual.assessments[0].reportedStatus, "verified");
  assert.equal(q.layers.reader_visual.assessments[0].effectiveStatus, "unverified");
  assert.equal(q.reviews[0].reviewer.role, "generator");
});

test("review claims require attached non-self evidence, exact source baseline and valid stable locations", async t => {
  const h = await fixture(t), preview = await h.create(), snapshot = await h.w.previewSnapshot(preview.id);
  const evidence = await h.upload("Fixture evidence", "checks.txt", "text/plain"), reportId = "file-report";
  const base = review(preview, evidence.sourceId);
  const checked = value => validateQualityReview(value, snapshot, [reportId, evidence.sourceId], reportId);
  for (const mutate of [
    value => value.layers.reader_visual.evidenceSourceIds = [],
    value => value.layers.usability.status = "not_applicable",
    value => delete value.layers.usability,
    value => value.reviewer.role = "model-verified",
    value => value.extra = true,
    value => value.issues = [issue({ status: "resolved" })],
  ]) { const value = structuredClone(base); mutate(value); assert.throws(() => checked(value), { code: "QUALITY_REVIEW_INVALID" }); }
  for (const id of ["file-not-attached", reportId]) {
    const value = structuredClone(base); value.layers.reader_visual.evidenceSourceIds = [id];
    assert.throws(() => checked(value), { code: "QUALITY_EVIDENCE_MISSING" });
  }
  const mismatch = structuredClone(base); mismatch.baseline.sourceSha256 = "a".repeat(64);
  assert.throws(() => checked(mismatch), { code: "QUALITY_SOURCE_MISMATCH" });
  const indexed = snapshot.validated.index.find(entry => entry.itemId), table = snapshot.validated.index.find(entry => entry.field === "rows"), html = snapshot.validated.index.find(entry => entry.nodeId);
  for (const target of [
    { blockId: indexed.blockId, itemId: indexed.itemId, field: "text" },
    { blockId: table.blockId, field: "rows", row: table.row, column: table.column },
    { blockId: html.blockId, nodeId: html.nodeId, field: html.field },
  ]) {
    const value = structuredClone(base), located = issue({ target }); delete located.authorKey; value.issues = [located];
    assert.equal(checked(value).issues[0].target.blockId, target.blockId);
    value.issues[0].target.blockId = "blk-foreign";
    assert.throws(() => checked(value), { code: "QUALITY_TARGET_INVALID" });
  }
  const sourceSnapshot = structuredClone(snapshot); sourceSnapshot.validated.document.source = { sha256: "b".repeat(64) }; sourceSnapshot.validation.summary.pageCount = 2;
  const sourceReview = structuredClone(base); sourceReview.baseline = { sourceSha256: "b".repeat(64), artifactSourceIds: [evidence.sourceId] };
  sourceReview.layers.source_fidelity = { status: "verified", summary: "Synthetic original-first baseline and comparison.", evidenceSourceIds: [evidence.sourceId] };
  sourceReview.issues = [issue({ source: { page: 2, box: [0.1, 0.2, 0.7, 0.8] } })];
  assert.equal(validateQualityReview(sourceReview, sourceSnapshot, [reportId, evidence.sourceId], reportId).issues[0].source.page, 2);
  sourceReview.issues[0].source.page = 3;
  assert.throws(() => validateQualityReview(sourceReview, sourceSnapshot, [reportId, evidence.sourceId], reportId), { code: "QUALITY_REVIEW_INVALID" });
});

test("evidence read is bounded and cannot use malformed JSON or reports as mutual evidence", async t => {
  const h = await fixture(t), preview = await h.create(), snapshot = await h.w.previewSnapshot(preview.id);
  const bad = await h.upload("{ not json }");
  const malformed = await h.request(reportPath(preview, [bad.sourceId]), undefined, 400);
  assert.equal(malformed.code, "QUALITY_REVIEW_INVALID");
  const fakeWorkspace = { file: async id => ({ id, mediaType: "text/plain", size: QUALITY_LIMITS.evidenceBytes + 1 }) };
  await assert.rejects(collectQualityEvidence(fakeWorkspace, snapshot, ["file-large"], () => assert.fail("must not open oversized evidence")), { code: "QUALITY_EVIDENCE_LIMIT" });
  await assert.rejects(collectQualityEvidence(fakeWorkspace, snapshot, Array.from({ length: 41 }, (_, i) => "file-" + i), () => {}), { code: "QUALITY_REVIEW_INVALID" });
  const jsonWorkspace = { file: async id => ({ id, mediaType: "application/json", size: QUALITY_LIMITS.jsonBytes + 1 }) };
  await assert.rejects(collectQualityEvidence(jsonWorkspace, snapshot, ["file-json"], () => {}), { code: "QUALITY_EVIDENCE_LIMIT" });
  const reports = { "file-one": review(preview, "file-two"), "file-two": review(preview, "file-one") };
  const bytes = Object.fromEntries(Object.entries(reports).map(([id, value]) => [id, Buffer.from(JSON.stringify(value))]));
  const byHash = new Map(Object.values(bytes).map(value => [hash(value), value]));
  const mutualWorkspace = { file: async id => ({ id, mediaType: "application/json", size: bytes[id].length, sha256: hash(bytes[id]) }), resources: { read: async digest => byHash.get(digest) } };
  await assert.rejects(collectQualityEvidence(mutualWorkspace, snapshot, ["file-one", "file-two"], async () => {}), { code: "QUALITY_EVIDENCE_MISSING" });
});

test("quality projection requires full workspace authorization; a scoped preview grant cannot read extra evidence", async t => {
  const h = await fixture(t, { authToken: "quality-test-token" }), preview = await h.create(), evidence = await h.upload("Private evidence", "checks.txt", "text/plain");
  const file = await h.upload(review(preview, evidence.sourceId)), ids = [file.sourceId, evidence.sourceId];
  await h.request(reportPath(preview, ids), undefined, 401, {});
  const signed = await h.fileCapabilities.issue(h.base + reportPath(preview), { scope: { kind: "preview", id: preview.id } });
  const signedPath = new URL(signed.url).pathname + new URL(signed.url).search;
  const base = await h.request(signedPath, undefined, 200, {});
  assert.equal(base.quality.status, "unverified");
  const rejected = await h.request(signedPath + "&evidenceSourceIds=" + ids.join(","), undefined, 403, {});
  assert.equal(rejected.code, "INVALID_FILE_CAPABILITY");
  const projected = (await h.request(reportPath(preview, ids))).quality;
  assert.equal(projected.status, "unverified"); assert.equal(projected.layers.reader_visual.status, "verified");
  assert.equal(projected.publication.allowed, false);
  await h.request(`/api/authoring/previews/${preview.id}/artifacts/document.json?evidenceSourceIds=${file.sourceId}`, undefined, 400);
  await h.request(reportPath(preview, ids) + "&evidenceSourceIds=" + file.sourceId, undefined, 400);
});

test("a saved document revision cannot inherit verified quality from an earlier exact preview", async t => {
  const h = await fixture(t), preview = await h.create(), evidence = await h.upload("Synthetic accepted review", "checks.txt", "text/plain");
  const report = await h.upload(review(preview, evidence.sourceId));
  const snapshot = await h.w.previewSnapshot(preview.id);
  // An explicit historical record exercises read compatibility without using
  // old declarations to bypass the new publication gate.
  const historicalQuality = (await h.request(reportPath(preview, [report.sourceId, evidence.sourceId]))).quality;
  historicalQuality.status = "verified"; historicalQuality.publication.allowed = true;
  const saved = { ...snapshot.validated, authoring: snapshot.compiled.authoring, identity: snapshot.compiled.identity,
    report: { ...snapshot.validated.report, previewSubmission: { previewId: preview.id, previewHash: preview.hash,
      documentHash: snapshot.manifest.documentHash, quality: historicalQuality } } };
  assert.equal(storedAuthoringQuality(saved).status, "verified");
  const changed = structuredClone(saved); changed.document.revision++; changed.document.blocks[0].text += " Later edit.";
  const q = storedAuthoringQuality(changed);
  assert.equal(q.status, "unverified"); assert.equal(q.preview, null); assert.equal(q.previousAssessment.recheckRequired, true);
  assert.equal(q.previousAssessment.preview.hash, preview.hash);
  assert.equal(q.document.sha256, hash(canonical(changed.document)));
  assert.equal(q.layers.reader_visual.status, "unverified");
});

test("structured quality reports do not add or rename any MCP tool", async t => {
  const h = await fixture(t), contract = await h.request("/api/authoring/contract");
  assert.ok(contract.documentation.some(doc => doc.filename === "conversion-workflow.md"));
  assert.ok(contract.documentation.some(doc => doc.filename === "guide.md"));
  assert.ok(contract.steps.some(step => /review scope|review template/i.test(step)));
  const { createWorkspaceMcp } = await import("../mcp.mjs");
  const mcp = createWorkspaceMcp(h.w, localActor, { baseUrl: h.base });
  const registered = Object.keys(mcp._registeredTools || {});
  // Catalog ownership remains in the existing MCP module; this inspection must
  // not silently accept a missing registration mechanism.
  assert.equal(registered.length, 32);
  assert.ok(registered.includes("publish_authoring_preview"));
  assert.ok(!registered.some(name => name.includes("quality")));
  await mcp.close();
});
