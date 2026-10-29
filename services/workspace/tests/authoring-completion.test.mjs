import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createWorkspaceServer } from "../server.mjs";
import { canonical, hash } from "../errors.mjs";
import { publicMcpTools, schemaBranches } from "./mcp-input-fixture.mjs";
import { withoutFileAccess } from "./mcp-result-fixture.mjs";

// These are isolated protocol fixtures. Their deliberately fabricated session
// IDs and check declarations exercise validation/publication data flow only.
// They are not actual Agent runs, source reviews or Reader acceptance evidence.
const PROTOCOL_ONLY = "Synthetic protocol fixture only; no actual subagent, source review or Reader acceptance is claimed.";
// Captured read-only from the still-running pre-change 4186 service, 2026-10-26.
// Full source snapshot: .audit/translation-completion/mcp-input-schema-baseline.json.
const PRIOR_32_INPUT_SCHEMAS_HASH = "be5928da6b48a8428ec92f8642fd758c8dedd0a36a24f4f2d26be755830cb830";

async function harness(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-completion-test-"));
  const server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false, sync: false });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: "completion-protocol-fixture", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  t.after(async () => {
    await client.close(); await server.shutdown();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    assert.ok(basename(dataDir).startsWith("reader-completion-test-"));
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = async (path, body, status = 200) => {
    const response = await fetch(new URL(path, base), { method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`);
    return value;
  };
  const upload = async (value, filename = "fixture.json", mediaType = "application/json") => {
    const response = await fetch(base + "/api/sources?filename=" + encodeURIComponent(filename), { method: "POST",
      headers: { "Content-Type": mediaType }, body: typeof value === "string" ? value : JSON.stringify(value) });
    const file = await response.json(); assert.equal(response.status, 201, JSON.stringify(file)); return file;
  };
  const raw = (name, input = {}) => client.callTool({ name, arguments: input });
  const call = async (name, input = {}) => { const result = await raw(name, input); assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent; };
  const create = async ({ translated = true, source = false, input = authoring(translated), previousPreviewId, target } = {}) => {
    const resources = {};
    if (source) {
      const file = await upload("Original protocol fixture text, not a research paper.", "source.txt", "text/plain");
      input.source = { path: "source.txt", sha256: file.sha256, media_type: "text/plain" };
      resources["source.txt"] = file.sourceId;
    }
    const file = await upload(input, "authoring.json");
    return (await call("create_authoring_preview", { authoring_source_id: file.sourceId, resources, request_id: randomUUID(),
      ...(previousPreviewId ? { previous_preview_id: previousPreviewId } : {}), ...(target ? { target } : {}) })).preview;
  };
  return { request, upload, raw, call, create, client, w: server.workspace };
}

function authoring(translated = true) {
  const input = { format: "reader-authoring-1", key: "completion-fixture", meta: { title: "Protocol checks", language: "en" },
    navigation: { kind: "auxiliary", items: [{ targetKey: "p", text: "Checks", level: 1, translations: { "zh-CN": { text: "检查" } } }] },
    blocks: [
      { key: "p", type: "para", text: "The first complete source paragraph." },
      { key: "q", type: "para", text: "The second complete source paragraph." },
      { key: "table", type: "table", head: [["Method", "Value"]], rows: [["Baseline", "17"]] },
    ] };
  if (translated) {
    input.meta.translations = { "zh-CN": { title: "协议检查" } };
    input.blocks[0].translations = { "zh-CN": { text: "第一段完整的原文。" } };
    input.blocks[1].translations = { "zh-CN": { text: "第二段完整的原文。" } };
    input.blocks[2].translations = { "zh-CN": { head: [["方法", "数值"]], rows: [["基线", "17"]] } };
  }
  return input;
}

const reportPath = (preview, ids = []) => `/api/authoring/previews/${preview.id}/artifacts/report.json${ids.length ? "?evidenceSourceIds=" + ids.join(",") : ""}`;
const submission = (preview, ids = [], requestId = randomUUID()) => ({ previewId: preview.id, expectedHash: preview.hash, requestId,
  review: { sourceReview: PROTOCOL_ONLY, layoutReview: PROTOCOL_ONLY, interactionReview: PROTOCOL_ONLY, evidenceSourceIds: ids } });
const mcpSubmission = value => ({ preview_id: value.previewId, expected_hash: value.expectedHash, request_id: value.requestId,
  review: { source_review: value.review.sourceReview, layout_review: value.review.layoutReview,
    interaction_review: value.review.interactionReview, evidence_source_ids: value.review.evidenceSourceIds } });
const formalState = h => canonical(Object.fromEntries([
  "documents", "revisions", "reading", "insights", "object_preferences", "changes", "receipts", "metadata",
].map(table => [table, h.w.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));

async function rejectWithoutCommit(h, preview, ids, { status = 409, code = "AUTHORING_QUALITY_FAILED", requestId = randomUUID(), mcp = false } = {}) {
  const before = formalState(h), frozen = canonical(await h.w.previewSnapshot(preview.id));
  const input = submission(preview, ids, requestId);
  const result = mcp ? await h.raw("publish_authoring_preview", mcpSubmission(input)) : await h.request("/api/authoring/previews/publish", input, status);
  if (mcp) assert.equal(result.isError, true);
  const failure = mcp ? result.structuredContent : result;
  assert.equal(failure.code, code, JSON.stringify(failure));
  assert.equal(formalState(h), before, "a rejection must not mutate formal state or write a receipt");
  assert.equal(canonical(await h.w.previewSnapshot(preview.id)), frozen, "a rejection must not replace the immutable preview");
  assert.equal(h.w.db.prepare("SELECT * FROM receipts WHERE request_id = ?").get(requestId), undefined);
  return failure;
}

async function protocolPacket(h, preview, { patchReview, patchRun, inventory = "valid", attachRun = true, additionalEvidenceIds = [] } = {}) {
  const quality = (await h.request(reportPath(preview))).quality;
  const plan = quality.workflow.plan;
  // Retained v2 compatibility fixture. New callers receive only the v3 template.
  const report = { format: "reader-quality-review-2", preview: { id: preview.id, hash: preview.hash },
    reviewer: { id: "fixture-reviewer", role: "independent", method: PROTOCOL_ONLY },
    baseline: { sourceSha256: plan.sourceSha256, artifactSourceIds: [] },
    layers: Object.fromEntries(["source_fidelity", "reader_visual", "usability"].map(key => [key, { status: "unverified", summary: PROTOCOL_ONLY, evidenceSourceIds: [] }])),
    issues: [], workflow: { planHash: plan.hash, scopeHash: plan.scope.scopeHash, delivery: { targetLanguage: plan.defaultTargetLanguage },
      runSourceId: "fixture-run", coverage: {}, checks: [], translationExceptions: [] } };
  const snapshotTime = Date.parse(preview.createdAt);
  assert.ok(Number.isFinite(snapshotTime), "protocol evidence uses the actual frozen snapshot creation time");
  const candidateTime = new Date(Math.max(snapshotTime, Date.now())).toISOString();
  const trace = await h.upload(PROTOCOL_ONLY, "protocol-only-trace.txt", "text/plain");
  const run = { format: "reader-review-run-1", kind: "subagent", preview: { id: preview.id, hash: preview.hash }, planHash: plan.hash, generatorSessionId: "fixture-generator",
    reviewerSessionId: "fixture-reviewer", reviewerId: "fixture-reviewer", contextIsolation: "fresh", readOnly: true,
    traceSourceIds: [trace.sourceId], sourceFirstAt: new Date(snapshotTime - 1000).toISOString(), candidateFirstAccessAt: candidateTime,
    completedAt: candidateTime, fixtureBoundary: PROTOCOL_ONLY };
  patchRun?.(run);
  const runFile = await h.upload(run, "protocol-only-run.json");
  const ids = [...additionalEvidenceIds, trace.sourceId, ...(attachRun ? [runFile.sourceId] : [])];
  let inventoryId;
  if (plan.sourceSha256) {
    const value = inventory === "absent" ? { fixtureBoundary: PROTOCOL_ONLY }
      : { format: "reader-source-inventory-1", sourceSha256: inventory === "wrong-hash" ? "0".repeat(64) : plan.sourceSha256,
        sourceFirst: inventory !== "candidate-first", articleBoundary: "The complete synthetic source.txt file.",
        entries: inventory === "empty" ? [] : [{ kind: "text", source: "source.txt", description: PROTOCOL_ONLY }], fixtureBoundary: PROTOCOL_ONLY };
    inventoryId = (await h.upload(value, "protocol-only-source-inventory.json")).sourceId; ids.push(inventoryId);
  }
  report.reviewer = { id: "fixture-reviewer", role: "independent", method: PROTOCOL_ONLY };
  report.baseline.artifactSourceIds = inventoryId ? [inventoryId] : [];
  for (const [key, layer] of Object.entries(report.layers)) Object.assign(layer, { status: key === "source_fidelity" && !plan.sourceSha256 ? "not_applicable" : "verified",
    summary: PROTOCOL_ONLY, evidenceSourceIds: key === "source_fidelity" && !plan.sourceSha256 ? [] : [trace.sourceId] });
  report.workflow.runSourceId = runFile.sourceId;
  report.workflow.coverage = structuredClone(plan.requiredCoverage);
  report.workflow.checks = plan.checks.map(item => ({ key: item.key, status: item.applicable ? "verified" : "not_applicable",
    summary: PROTOCOL_ONLY, evidenceSourceIds: item.applicable ? [trace.sourceId] : [] }));
  patchReview?.(report, { quality, plan, trace, runFile, inventoryId });
  const reportFile = await h.upload(report, "protocol-only-review.json"); ids.push(reportFile.sourceId);
  return { ids, report, plan, reportFile, runFile, run, trace, inventoryId };
}

async function compactPacket(h, preview, patchReview) {
  const { quality } = await h.request(reportPath(preview));
  const report = structuredClone(quality.workflow.reviewTemplate);
  const trace = await h.upload(PROTOCOL_ONLY + "\nFabricated spawn trace for protocol validation.", "compact-protocol-trace.txt", "text/plain");
  const supporting = await h.upload(PROTOCOL_ONLY + "\nFabricated source-first and Reader review observations.", "compact-protocol-review.md", "text/markdown");
  report.reviewer = { sessionId: "/protocol-fixture/reviewer", generatorSessionId: "/protocol-fixture/generator", traceSourceIds: [trace.sourceId] };
  report.result = { status: "verified", summary: PROTOCOL_ONLY, sourceFirst: true, readerInspected: true };
  report.evidenceSourceIds = [supporting.sourceId];
  patchReview?.(report, { trace, supporting, quality });
  const reportFile = await h.upload(report, "compact-protocol-review.json");
  return { ids: [trace.sourceId, supporting.sourceId, reportFile.sourceId], report, reportFile, trace, supporting, plan: quality.workflow.plan };
}

test("compact v3 publishes a whole-scope attestation with ordinary evidence, exact replay and immutable candidate binding", async t => {
  const h = await harness(t), preview = await h.create({ source: true }), packet = await compactPacket(h, preview);
  assert.equal(packet.report.format, "reader-quality-review-3");
  for (const removed of ["workflow", "baseline", "layers", "createdAt"]) assert.equal(packet.report[removed], undefined);
  const quality = (await h.request(reportPath(preview, packet.ids))).quality;
  assert.equal(quality.workflow.completion.ready, true); assert.equal(quality.publication.allowed, true);
  assert.equal(quality.reviews[0].reviewer.sessionId, "/protocol-fixture/reviewer");
  assert.equal(quality.reviews[0].independence, "declared-not-authenticated");
  assert.equal(quality.layers.reader_visual.basis, "reviewer-attestation");
  const input = mcpSubmission(submission(preview, packet.ids));
  const published = await h.call("publish_authoring_preview", input);
  assert.deepEqual((await h.request(`/api/documents/${published.document.id}`)).document, (await h.request(preview.documentUrl)).document);
  const replay = await h.call("publish_authoring_preview", input);
  assert.deepEqual(withoutFileAccess(replay), withoutFileAccess(published));
  const changed = authoring(); changed.blocks[0].translations["zh-CN"].text = "修复后的新候选。";
  const next = await h.create({ input: changed });
  await rejectWithoutCommit(h, next, packet.ids, { code: "QUALITY_PREVIEW_MISMATCH", mcp: true });
});

test("compact v3 requires a distinct reviewer, spawn trace, source-first review and actual Reader inspection", async t => {
  const h = await harness(t), preview = await h.create({ source: true });
  for (const [name, patch, pending] of [
    ["self-review", report => { report.reviewer.sessionId = report.reviewer.generatorSessionId; }, "reviewer_run"],
    ["missing-trace", report => { report.reviewer.traceSourceIds = []; }, "reviewer_run"],
    ["candidate-first", report => { report.result.sourceFirst = false; }, "source_first"],
    ["no-reader-inspection", report => { report.result.readerInspected = false; }, "reader_inspection"],
    ["unverified", report => { report.result.status = "unverified"; }, "review_result"],
  ]) await t.test(name, async () => {
    const packet = await compactPacket(h, preview, patch), failure = await rejectWithoutCommit(h, preview, packet.ids, { mcp: name === "self-review" });
    assert.ok(failure.details.pendingCheckKeys.includes(pending), JSON.stringify(failure));
  });
});

test("compact v3 requires attached supporting bytes and rejects reports used as evidence", async t => {
  const h = await harness(t), preview = await h.create({ source: true });
  const missing = await compactPacket(h, preview, report => { report.evidenceSourceIds = []; });
  await rejectWithoutCommit(h, preview, missing.ids, { status: 400, code: "QUALITY_REVIEW_INVALID" });
  const packet = await compactPacket(h, preview);
  for (const id of [packet.trace.sourceId, packet.supporting.sourceId]) {
    await rejectWithoutCommit(h, preview, packet.ids.filter(value => value !== id), { status: 400, code: "QUALITY_EVIDENCE_MISSING" });
  }
  for (const target of ["trace", "supporting"]) {
    const circular = await compactPacket(h, preview, report => {
      if (target === "trace") report.reviewer.traceSourceIds = [packet.reportFile.sourceId];
      else report.evidenceSourceIds = [packet.reportFile.sourceId];
    });
    await rejectWithoutCommit(h, preview, [...new Set([...packet.ids, ...circular.ids])], { status: 400, code: "QUALITY_EVIDENCE_MISSING" });
  }
});

test("compact v3 keeps translation presence mandatory and identical text visible without per-field paperwork", async t => {
  const h = await harness(t), incomplete = await h.create({ translated: false }), packet = await compactPacket(h, incomplete);
  const failure = await rejectWithoutCommit(h, incomplete, packet.ids);
  assert.ok(failure.details.pendingCheckKeys.includes("translation_incomplete"));
  const input = authoring(); input.blocks[2].rows[0][0] = "BERT"; input.blocks[2].translations["zh-CN"].rows[0][0] = "BERT";
  const named = await h.create({ input }), reviewed = await compactPacket(h, named, report => {
    report.result.summary = PROTOCOL_ONLY + " The fixture deliberately retains the model name BERT; no real semantic review is claimed.";
  });
  const quality = (await h.request(reportPath(named, reviewed.ids))).quality;
  assert.equal(quality.observations.translation.identicalFieldCount, 1);
  assert.equal(quality.publication.allowed, true);
  assert.ok(quality.issues.some(issue => issue.key === "translation-identical-source-zh-CN"));
});

test("compact v3 cannot approve missing translation hidden by literal math-looking text", async t => {
  const h = await harness(t);
  const cases = [
    { type: "para", text: "\\(English prose\\)" },
    { type: "para", text: "\\[English prose\\]" },
    { type: "para", text: "`$English prose$`" },
    { type: "html", html: '<p data-key="literal">$English prose$</p>' },
  ];
  for (const block of cases) {
    const input = authoring();
    input.blocks[0] = { key: "p", ...block };
    const preview = await h.create({ input }), packet = await compactPacket(h, preview);
    const quality = (await h.request(reportPath(preview, packet.ids))).quality;
    assert.equal(quality.observations.translation.missingFieldCount, 1, JSON.stringify(block));
    assert.equal(quality.publication.allowed, false, JSON.stringify(block));
    assert.ok(quality.publication.pendingCheckKeys.includes("translation_incomplete"));
    await rejectWithoutCommit(h, preview, packet.ids);
  }
});

test("compact v3 language overrides still require the explicit user request", async t => {
  const h = await harness(t), preview = await h.create({ translated: false });
  const silent = await compactPacket(h, preview, report => { report.delivery = { targetLanguage: "source" }; });
  await rejectWithoutCommit(h, preview, silent.ids, { status: 400, code: "QUALITY_REVIEW_INVALID" });
  const explicit = await compactPacket(h, preview, report => { report.delivery = { targetLanguage: "source", userRequest: "Synthetic protocol instruction: retain the source-language fixture." }; });
  const quality = (await h.request(reportPath(preview, explicit.ids))).quality;
  assert.equal(quality.publication.allowed, true); assert.equal(quality.workflow.completion.targetLanguage, "source");
  assert.ok(quality.observations.translation.missingFieldCount > 0);
});

test("compact v3 and retained v2 failures cannot be masked by a passing report", async t => {
  const h = await harness(t), preview = await h.create({ source: true }), good = await compactPacket(h, preview);
  const failures = [
    await compactPacket(h, preview, report => { report.result.status = "failed"; }),
    await compactPacket(h, preview, report => { report.issues.push({ key: "clipped-table", layer: "reader_visual", severity: "blocking", status: "failed",
      expected: "All table cells remain reachable.", actual: "Synthetic clipping finding.", evidenceSourceIds: report.evidenceSourceIds,
      recheck: { suggestion: "Inspect the full table in the new candidate." } }); }),
    await protocolPacket(h, preview, { patchReview: report => { report.workflow.checks.find(item => item.key === "content").status = "failed"; } }),
  ];
  for (const failed of failures) {
    for (const ids of [[...good.ids, ...failed.ids], [...failed.ids, ...good.ids]]) {
      const quality = (await h.request(reportPath(preview, [...new Set(ids)]))).quality;
      assert.equal(quality.status, "failed"); assert.equal(quality.publication.allowed, false);
      await rejectWithoutCommit(h, preview, [...new Set(ids)]);
    }
  }
});

test("MCP discovers the compact v3 template and exact review scope without changing the 32 tool inputs", async t => {
  const h = await harness(t), tools = (await h.client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), publicMcpTools);
  const inputs = tools.map(({ name, inputSchema }) => ({ name, inputSchema })).sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(hash(canonical(inputs)), PRIOR_32_INPUT_SCHEMAS_HASH, "all 32 public input schemas retain their pre-gate shape");
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool.inputSchema]));
  assert.deepEqual(Object.keys(byName.publish_authoring_preview.properties).sort(), ["expected_hash", "preview_id", "request_id", "review"]);
  assert.deepEqual(Object.keys(byName.publish_authoring_preview.properties.review.properties).sort(), ["evidence_source_ids", "interaction_review", "layout_review", "source_review"]);
  assert.equal(byName.publish_authoring_preview.properties.review.additionalProperties, false);
  assert.equal(byName.publish_authoring_preview.properties.review.properties.evidence_source_ids.maxItems, 40);
  const branches = schemaBranches(byName.inspect_authoring_preview);
  assert.deepEqual(branches.map(branch => Object.keys(branch.properties).sort()).sort(), [["draft_id", "target"], ["preview_id", "target"]]);
  const contract = await h.call("get_authoring_contract");
  const guide = contract.documentation.find(item => item.filename === "conversion-workflow.md");
  assert.ok(guide, "a cold MCP client can find the complete workflow document");
  assert.match(JSON.stringify(contract), /compact review template/);
  const preview = await h.create(), inspected = await h.call("inspect_authoring_preview", { target: "preview", preview_id: preview.id });
  assert.equal(inspected.preview.review.status, "pending");
  assert.ok(inspected.preview.review.pending.some(item => item.key === "independent_review"));
  const report = await h.request(inspected.preview.review.reportUrl), { plan, reviewTemplate, completion } = report.quality.workflow;
  assert.equal(plan.scope.kind, "full"); assert.equal(completion.ready, false);
  assert.equal(plan.runEvidenceVersion, 2);
  assert.equal(reviewTemplate.format, "reader-quality-review-3");
  assert.deepEqual(Object.keys(reviewTemplate).sort(), ["evidenceSourceIds", "format", "issues", "preview", "result", "reviewer"]);
  assert.deepEqual(reviewTemplate.preview, { id: preview.id, hash: preview.hash });
  assert.equal(reviewTemplate.result.status, "unverified");
  assert.equal(reviewTemplate.result.sourceFirst, false); assert.equal(reviewTemplate.result.readerInspected, false);
  assert.deepEqual(reviewTemplate.reviewer.traceSourceIds, []); assert.deepEqual(reviewTemplate.evidenceSourceIds, []);
  assert.deepEqual(plan.requiredCoverage.blockIds, (await h.request(preview.documentUrl)).document.blocks.map(block => block.id));
  assert.deepEqual(plan.checks.map(item => item.key), ["source_inventory", "content", "objects", "relationships", "translation", "reader_render", "reader_interaction"]);
  assert.equal(report.quality.publication.allowed, false);
});

test("HTTP and MCP reject absent, legacy and generator-only evidence without consuming the request ID", async t => {
  const h = await harness(t), preview = await h.create();
  const variants = [
    { name: "absent", ids: [] },
    { name: "legacy-v1", ...(await protocolPacket(h, preview, { patchReview: report => { report.format = "reader-quality-review-1"; delete report.workflow; } })) },
    { name: "generator-v2", ...(await protocolPacket(h, preview, { patchReview: report => { report.reviewer.role = "generator"; } })) },
  ];
  for (const variant of variants) await t.test(variant.name, async () => {
    const failure = await rejectWithoutCommit(h, preview, variant.ids);
    assert.ok(failure.details.pendingCheckKeys.includes("independent_review"));
    const mcp = await rejectWithoutCommit(h, preview, variant.ids, { mcp: true });
    assert.equal(mcp.recovery.nextTool, "inspect_authoring_preview");
    assert.deepEqual(mcp.recovery.next, { target: "preview", preview_id: preview.id });
    assert.equal(mcp.recovery.requestIdPolicy, "new_after_review");
    assert.ok(mcp.details.pendingCheckKeys.includes("independent_review"));
    assert.ok(mcp.details.pending.length <= 4);
  });
});

test("complete check declarations cannot publish missing default Chinese text or natural-language table fields", async t => {
  const h = await harness(t);
  for (const mode of ["missing", "missing-table-head"]) await t.test(mode, async () => {
    const input = authoring(mode !== "missing");
    if (mode === "missing-table-head") delete input.blocks[2].translations["zh-CN"].head;
    const preview = await h.create({ input }), packet = await protocolPacket(h, preview);
    const q = (await h.request(reportPath(preview, packet.ids))).quality;
    assert.equal(q.workflow.completion.ready, false);
    assert.ok(q.workflow.completion.pending.some(item => item.key === "translation_incomplete"));
    const failure = await rejectWithoutCommit(h, preview, packet.ids);
    assert.ok(failure.details.pendingCheckKeys.includes("translation_incomplete"));
  });
});

test("copied natural-language fields need an exact independently evidenced retention exception", async t => {
  const h = await harness(t), input = authoring();
  input.blocks[2].translations["zh-CN"].head[0][1] = "Value";
  const copied = await h.create({ input }), packet = await protocolPacket(h, copied);
  const failure = await rejectWithoutCommit(h, copied, packet.ids, { mcp: true });
  assert.ok(failure.details.pendingCheckKeys.includes("translation_identical"));
  const q = (await h.request(reportPath(copied, packet.ids))).quality;
  assert.equal(q.observations.translation.identicalFieldCount, 1);
  assert.equal(q.observations.translation.identical[0].field, "head");
  assert.equal(q.observations.translation.identical[0].column, 1);

  const named = authoring(); named.blocks[2].rows[0][0] = "BERT";
  named.blocks[2].translations["zh-CN"].rows[0][0] = "BERT";
  const model = await h.create({ input: named });
  const explained = await protocolPacket(h, model, { patchReview: (report, { quality, trace }) => {
    report.workflow.translationExceptions = quality.observations.translation.identical.map(target => ({ target,
      reason: "BERT is the model's proper name and is intentionally retained in Chinese; this synthetic protocol fixture tests the explicit exception shape only.",
      evidenceSourceIds: [trace.sourceId] }));
  } });
  const ready = (await h.request(reportPath(model, explained.ids))).quality;
  assert.equal(ready.observations.translation.identicalFieldCount, 1, "the exception must not erase the observable unchanged field");
  assert.equal(ready.workflow.completion.ready, true); assert.equal(ready.publication.allowed, true);
});

test("bounded observations cannot truncate the internal set of required translation exceptions", async t => {
  const h = await harness(t), input = authoring();
  input.blocks[2].rows = Array.from({ length: 25 }, (_, index) => [`MODEL-${index}`, "17"]);
  input.blocks[2].translations["zh-CN"].rows = structuredClone(input.blocks[2].rows);
  const preview = await h.create({ input });
  const exceptionFor = (target, evidenceId) => ({ target,
    reason: "Synthetic fixture model identifiers deliberately stay unchanged; this is a protocol-only retention check.", evidenceSourceIds: [evidenceId] });
  const partial = await protocolPacket(h, preview, { patchReview: (report, { quality, trace }) => {
    assert.equal(quality.observations.translation.identicalFieldCount, 25);
    assert.equal(quality.observations.translation.identicalTruncated, true);
    assert.equal(quality.workflow.translation.identical.length, 25, "the downloadable workflow exposes every scoped exception target");
    assert.equal(quality.workflow.translation.identicalTruncated, false);
    report.workflow.translationExceptions = quality.observations.translation.identical.map(target => exceptionFor(target, trace.sourceId));
  } });
  const failure = await rejectWithoutCommit(h, preview, partial.ids);
  assert.ok(failure.details.pendingCheckKeys.includes("translation_identical"));
  const pending = (await h.request(reportPath(preview, partial.ids))).quality.workflow.completion.pending.find(item => item.key === "translation_identical");
  assert.equal(pending.details.missingCount, 5);
  const table = (await h.request(preview.documentUrl)).document.blocks.find(block => block.type === "table");
  const complete = await protocolPacket(h, preview, { patchReview: (report, { trace }) => {
    report.workflow.translationExceptions = input.blocks[2].rows.map((_, row) => exceptionFor({ blockId: table.id, row, column: 0, field: "rows" }, trace.sourceId));
  } });
  const ready = (await h.request(reportPath(preview, complete.ids))).quality;
  assert.equal(ready.observations.translation.identical.length, 20, "the public observation remains bounded");
  assert.equal(ready.workflow.completion.ready, true);
});

test("v2 coverage cannot omit service-selected blocks, resources, metadata, navigation, order or checks", async t => {
  const h = await harness(t), preview = await h.create({ source: true });
  for (const [name, patch, pending] of [
    ["blocks", report => report.workflow.coverage.blockIds.pop(), "coverage_blockIds"],
    ["resources", report => { report.workflow.coverage.resourcePaths = []; }, "coverage_resourcePaths"],
    ["meta", report => { report.workflow.coverage.meta = false; }, "coverage_meta"],
    ["navigation", report => { report.workflow.coverage.navigation = false; }, "coverage_navigation"],
    ["order", report => { report.workflow.coverage.order = false; }, "coverage_order"],
    ["check", report => { report.workflow.checks = report.workflow.checks.filter(item => item.key !== "reader_interaction"); }, "reader_interaction"],
    ["unchecked", report => { report.workflow.checks.find(item => item.key === "objects").status = "unverified"; }, "objects"],
  ]) await t.test(name, async () => {
    const packet = await protocolPacket(h, preview, { patchReview: patch });
    const failure = await rejectWithoutCommit(h, preview, packet.ids, { mcp: name === "blocks" });
    assert.ok(failure.details.pendingCheckKeys.includes(pending), JSON.stringify(failure));
  });
});

test("actual run provenance fields and source-first inventory are required, not arbitrary attached text", async t => {
  const h = await harness(t), preview = await h.create({ source: true });
  for (const [name, options, pending] of [
    ["missing-run-record", { patchRun: run => { run.format = "fixture-not-a-run"; } }, "reviewer_run"],
    ["same-session", { patchRun: run => { run.reviewerSessionId = run.generatorSessionId; } }, "reviewer_run"],
    ["inherited-context", { patchRun: run => { run.contextIsolation = "inherited"; } }, "reviewer_run"],
    ["writable-reviewer", { patchRun: run => { run.readOnly = false; } }, "reviewer_run"],
    ["wrong-reviewer", { patchRun: run => { run.reviewerId = "other-reviewer"; } }, "reviewer_run"],
    ["missing-trace", { patchRun: run => { run.traceSourceIds = []; } }, "reviewer_run"],
    ["candidate-before-source", { patchRun: run => { run.sourceFirstAt = new Date(Date.parse(run.completedAt) + 1000).toISOString(); } }, "reviewer_run"],
    ["missing-inventory", { inventory: "absent" }, "source_inventory"],
    ["wrong-inventory-source", { inventory: "wrong-hash" }, "source_inventory"],
    ["empty-inventory", { inventory: "empty" }, "source_inventory"],
    ["candidate-first-inventory", { inventory: "candidate-first" }, "source_inventory"],
  ]) await t.test(name, async () => {
    const packet = await protocolPacket(h, preview, options), failure = await rejectWithoutCommit(h, preview, packet.ids);
    assert.ok(failure.details.pendingCheckKeys.includes(pending), JSON.stringify(failure));
  });
  const unattached = await protocolPacket(h, preview, { attachRun: false });
  await rejectWithoutCommit(h, preview, unattached.ids, { status: 400, code: "QUALITY_REVIEW_INVALID" });
});

test("reviewer runs bind the exact candidate and plan and cannot claim candidate access before snapshot creation", async t => {
  const h = await harness(t), preview = await h.create(), created = Date.parse(preview.createdAt);
  for (const [name, patchRun] of [
    ["missing-preview", run => { delete run.preview; }],
    ["other-preview", run => { run.preview.id = "preview-another-candidate"; }],
    ["other-preview-hash", run => { run.preview.hash = "a".repeat(64); }],
    ["missing-plan", run => { delete run.planHash; }],
    ["other-plan", run => { run.planHash = "b".repeat(64); }],
    ["candidate-access-too-early", run => {
      run.sourceFirstAt = new Date(created - 2000).toISOString();
      run.candidateFirstAccessAt = new Date(created - 1000).toISOString();
    }],
    ["completion-too-early", run => {
      run.sourceFirstAt = new Date(created - 3000).toISOString();
      run.candidateFirstAccessAt = new Date(created - 2000).toISOString();
      run.completedAt = new Date(created - 1000).toISOString();
    }],
  ]) await t.test(name, async () => {
    const packet = await protocolPacket(h, preview, { patchRun });
    const failure = await rejectWithoutCommit(h, preview, packet.ids, { mcp: name === "candidate-access-too-early" });
    assert.ok(failure.details.pendingCheckKeys.includes("reviewer_run"), JSON.stringify(failure));
  });
  const sourceFirst = await protocolPacket(h, preview, { patchRun: run => {
    run.sourceFirstAt = new Date(created - 86400000).toISOString();
  } });
  assert.equal((await h.request(reportPath(preview, sourceFirst.ids))).quality.workflow.completion.ready, true,
    "the original may be inspected before the candidate exists");
});

test("a new exact-bound report cannot reuse an earlier candidate's reviewer run file", async t => {
  const h = await harness(t), first = await h.create(), previous = await protocolPacket(h, first);
  const input = authoring(); input.blocks[0].translations["zh-CN"].text = "候选版本变化后的完整中文。";
  const next = await h.create({ input, previousPreviewId: first.id });
  const reused = await protocolPacket(h, next, {
    additionalEvidenceIds: [previous.runFile.sourceId, previous.trace.sourceId],
    patchReview: report => { report.workflow.runSourceId = previous.runFile.sourceId; },
  });
  assert.deepEqual(reused.report.preview, { id: next.id, hash: next.hash }, "only the independently attached run is stale");
  assert.equal(reused.report.workflow.planHash, reused.plan.hash);
  const failure = await rejectWithoutCommit(h, next, reused.ids, { mcp: true });
  assert.ok(failure.details.pendingCheckKeys.includes("reviewer_run"));
  const fresh = await protocolPacket(h, next);
  assert.equal((await h.request(reportPath(next, fresh.ids))).quality.workflow.completion.ready, true);
});

test("a complete good report cannot hide any attached v2 failed checklist or its failed layer", async t => {
  const h = await harness(t), preview = await h.create({ source: true }), good = await protocolPacket(h, preview);
  for (const [key, layer, role = "independent"] of [
    ["source_inventory", "source_fidelity"], ["content", "source_fidelity"], ["objects", "source_fidelity"],
    ["relationships", "source_fidelity"], ["translation", "usability"], ["reader_render", "reader_visual"],
    ["reader_interaction", "usability"], ["reader_render", "reader_visual", "generator"],
  ]) await t.test(`${role}:${key}`, async () => {
    const failed = await protocolPacket(h, preview, { patchReview: report => {
      report.reviewer.role = role;
      report.workflow.checks.find(item => item.key === key).status = "failed";
    } });
    assert.ok(Object.values(failed.report.layers).every(item => item.status === "verified"), "only the checklist records the failure");
    assert.deepEqual(failed.report.issues, []);
    const ids = [...new Set([...good.ids, ...failed.ids])];
    const projected = (await h.request(reportPath(preview, ids))).quality;
    assert.equal(projected.status, "failed"); assert.equal(projected.publication.allowed, false);
    assert.equal(projected.layers[layer].status, "failed");
    assert.ok(projected.publication.blockingIssueKeys.length > 0);
    assert.ok(projected.issues.some(issue => issue.severity === "blocking" && issue.status === "failed" && issue.layer === layer));
    const rejection = await rejectWithoutCommit(h, preview, ids, { mcp: role === "generator" });
    assert.ok(rejection.details.failedLayers.includes(layer));
    const reversed = (await h.request(reportPath(preview, [...new Set([...failed.ids, ...good.ids])]))).quality;
    assert.equal(reversed.status, "failed", "report order cannot change which failed checks block publication");
    assert.equal(reversed.publication.allowed, false);
  });
});

test("v2 reports bind preview hash, plan hash and scope hash before any publication state changes", async t => {
  const h = await harness(t), preview = await h.create();
  for (const [name, patch, code] of [
    ["preview-hash", report => { report.preview.hash = "a".repeat(64); }, "QUALITY_PREVIEW_MISMATCH"],
    ["preview-id", report => { report.preview.id = "preview-other"; }, "QUALITY_PREVIEW_MISMATCH"],
    ["plan-hash", report => { report.workflow.planHash = "b".repeat(64); }, "QUALITY_PLAN_MISMATCH"],
    ["scope-hash", report => { report.workflow.scopeHash = "c".repeat(64); }, "QUALITY_PLAN_MISMATCH"],
  ]) await t.test(name, async () => {
    const packet = await protocolPacket(h, preview, { patchReview: patch });
    await rejectWithoutCommit(h, preview, packet.ids, { code, mcp: name === "plan-hash" });
  });
  const foreign = await protocolPacket(h, preview, { patchReview: report => { report.workflow.coverage.blockIds = ["foreign-block"]; } });
  await rejectWithoutCommit(h, preview, foreign.ids, { status: 400, code: "QUALITY_REVIEW_INVALID" });
});

test("source-only is an explicit delivery exception and cannot silently bypass the default language", async t => {
  const h = await harness(t), preview = await h.create({ translated: false });
  const silent = await protocolPacket(h, preview, { patchReview: report => { report.workflow.delivery.targetLanguage = "source"; } });
  await rejectWithoutCommit(h, preview, silent.ids, { status: 400, code: "QUALITY_REVIEW_INVALID" });
  const explicit = await protocolPacket(h, preview, { patchReview: report => {
    report.workflow.delivery = { targetLanguage: "source", userRequest: "Fixture instruction: retain only the source language for this protocol test." };
    report.workflow.checks.find(item => item.key === "translation").status = "not_applicable";
  } });
  const q = (await h.request(reportPath(preview, explicit.ids))).quality;
  assert.equal(q.workflow.completion.ready, true); assert.equal(q.workflow.completion.targetLanguage, "source");
  assert.ok(q.observations.translation.missingFieldCount > 0, "the explicit exception never hides missing Chinese observations");
  assert.equal(q.publication.allowed, true);
});

test("protocol-only complete evidence publishes the exact snapshot, supports exact replay and refreshes MCP readiness", async t => {
  const h = await harness(t), preview = await h.create({ source: true }), requestId = randomUUID();
  await rejectWithoutCommit(h, preview, [], { requestId, mcp: true });
  const packet = await protocolPacket(h, preview), q = (await h.request(reportPath(preview, packet.ids))).quality;
  assert.equal(q.status, "verified"); assert.equal(q.workflow.completion.ready, true);
  assert.equal(q.publication.allowed, true); assert.equal(q.workflow.completion.reviewSourceId, packet.reportFile.sourceId);
  assert.match(q.workflow.completion.boundary, /does not authenticate/i);
  const input = mcpSubmission(submission(preview, packet.ids, requestId));
  const published = await h.call("publish_authoring_preview", input);
  assert.equal(published.preview.hash, preview.hash); assert.equal(published.preview.published, true);
  assert.equal(published.preview.review.status, "ready");
  const document = (await h.request(`/api/documents/${published.document.id}`)).document;
  assert.deepEqual(document, (await h.request(preview.documentUrl)).document);
  assert.ok(h.w.db.prepare("SELECT * FROM receipts WHERE request_id = ?").get(requestId));
  const replay = await h.call("publish_authoring_preview", input);
  assert.deepEqual(withoutFileAccess(replay), withoutFileAccess(published), "renewable access grants do not change the saved business receipt");
  assert.equal(replay.document.id, published.document.id); assert.equal(replay.document.revision, published.document.revision);
  assert.equal(h.w.db.prepare("SELECT COUNT(*) AS count FROM documents").get().count, 1);
  assert.equal(h.w.db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE request_id = ?").get(requestId).count, 1);
  const inspected = await h.call("inspect_authoring_preview", { target: "preview", preview_id: preview.id });
  assert.equal(inspected.preview.review.status, "ready");
  const savedQuality = (await h.request(published.artifacts.artifacts.find(artifact => artifact.kind === "report").url)).quality;
  assert.equal(savedQuality.workflow.completion.planHash, packet.plan.hash);
  assert.equal(savedQuality.reviews[0].independence, "declared-not-authenticated");
  const downloaded = await h.request(inspected.preview.review.reportUrl);
  assert.equal(downloaded.qualityBasis, "retained-exact-publication");
  assert.equal(downloaded.quality.workflow.completion.ready, true);
  assert.deepEqual(downloaded.quality.preview, { id: preview.id, hash: preview.hash });
  assert.equal(downloaded.quality.document.sha256, hash(canonical(document)));
  assert.equal(downloaded.quality.workflow.completion.planHash, packet.plan.hash);
  assert.equal(downloaded.quality.workflow.completion.scopeHash, packet.plan.scope.scopeHash);
  assert.deepEqual(downloaded.quality.workflow.plan.scope, packet.plan.scope);
  assert.deepEqual(downloaded.quality, savedQuality, "the published preview URL returns the same exact retained assessment as its saved revision");

  const generator = await protocolPacket(h, preview, { patchReview: report => { report.reviewer.role = "generator"; } });
  const projected = await h.request(reportPath(preview, generator.ids));
  assert.equal(projected.qualityBasis, undefined, "an explicit evidence query requests a fresh projection");
  assert.equal(projected.quality.workflow.completion.ready, false);
  assert.ok(projected.quality.publication.pendingCheckKeys.includes("independent_review"));
  assert.equal(projected.quality.reviews[0].reviewer.role, "generator");
  assert.deepEqual((await h.request(inspected.preview.review.reportUrl)).quality, savedQuality, "a pending projection never replaces the retained successful assessment");
});

test("a corrected candidate cannot reuse the prior snapshot's complete evidence", async t => {
  const h = await harness(t), first = await h.create(), packet = await protocolPacket(h, first);
  const input = authoring(); input.blocks[0].translations["zh-CN"].text = "修正后的第一段完整原文。";
  const next = await h.create({ input, previousPreviewId: first.id });
  assert.notEqual(next.hash, first.hash);
  await rejectWithoutCommit(h, next, packet.ids, { code: "QUALITY_PREVIEW_MISMATCH", mcp: true });
  assert.equal((await h.request(reportPath(next))).quality.workflow.completion.ready, false);
});

test("an existing revision reviews only frozen affected targets while retaining inherited missing-translation observations", async t => {
  const h = await harness(t), original = await h.create({ translated: false });
  const oldPacket = await protocolPacket(h, original, { patchReview: report => {
    report.workflow.delivery = { targetLanguage: "source", userRequest: "Protocol fixture: the initial revision intentionally contains only source text." };
    report.workflow.checks.find(item => item.key === "translation").status = "not_applicable";
  } });
  const published = await h.request("/api/authoring/previews/publish", submission(original, oldPacket.ids), 201);
  const pkg = await h.request(`/api/documents/${published.document.id}/authoring/editing.json`);
  const originalDocument = (await h.request(original.documentUrl)).document;
  const removedId = originalDocument.blocks.find(block => block.type === "table").id;
  const changedId = originalDocument.blocks[0].id;
  pkg.authoring.blocks = pkg.authoring.blocks.filter(block => block.type !== "table");
  pkg.authoring.blocks[0].translations = { "zh-CN": { text: "此次修订只补充第一段的完整中文翻译。" } };
  const next = await h.create({ input: pkg.authoring, target: { document_id: pkg.base.documentId,
    base_revision: pkg.base.revision, base_hash: pkg.base.documentHash } });
  const incomplete = await protocolPacket(h, next, { patchReview: report => { report.workflow.coverage.removedBlockIds = []; } });
  assert.equal(incomplete.plan.scope.kind, "affected");
  assert.deepEqual(incomplete.plan.requiredCoverage.blockIds, [changedId]);
  assert.deepEqual(incomplete.plan.requiredCoverage.removedBlockIds, [removedId]);
  const failure = await rejectWithoutCommit(h, next, incomplete.ids);
  assert.ok(failure.details.pendingCheckKeys.includes("coverage_removedBlockIds"));
  const complete = await protocolPacket(h, next), q = (await h.request(reportPath(next, complete.ids))).quality;
  assert.ok(q.observations.translation.missingFieldCount > 0, "unchanged old gaps stay visible");
  assert.equal(q.workflow.completion.ready, true, "unrelated legacy gaps do not expand the server-selected revision scope");
  assert.match(q.workflow.plan.boundary, /Unchanged content is outside this review/);
  const updated = await h.request("/api/authoring/previews/publish", submission(next, complete.ids), 201);
  assert.equal(updated.document.id, published.document.id); assert.equal(updated.document.revision, 2);
  assert.deepEqual((await h.request(`/api/documents/${updated.document.id}`)).document, (await h.request(next.documentUrl)).document);
});
