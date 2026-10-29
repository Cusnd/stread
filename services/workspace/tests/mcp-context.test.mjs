import { mergedWrite } from "./mcp-input-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createWorkspaceServer } from "../server.mjs";
import { applyOperations, validateDocument } from "../documents.mjs";
import { publishAuthoringFixture } from "./authoring-fixture.mjs";

async function setup(t, blocks) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-bounded-mcp-"));
  const server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`, w = server.workspace;
  const authoring = { format: "reader-authoring-1", key: "bounded-test", meta: { title: "Bounded context fixture", language: "en" }, blocks: blocks.map(({ id, ...block }) => ({ key: id, ...block })) };
  const uploaded = await fetch(base + "/api/sources?filename=bounded-source.json", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(authoring) }).then((r) => r.json());
  authoring.source = { path: "source.json", sha256: uploaded.sha256, media_type: "application/json" };
  const { document, blockIds } = await publishAuthoringFixture({ base, authoring, resources: { "source.json": uploaded.sourceId } });
  const client = new Client({ name: "bounded-context-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  t.after(async () => { await client.close(); await server.shutdown(); assert.ok(dataDir.startsWith(join(tmpdir(), "reader-bounded-mcp-"))); await rm(dataDir, { recursive: true, force: true }); });
  const raw = (name, args = {}) => client.callTool({ name, arguments: args });
  const call = async (name, args = {}) => { const r = await raw(name, args); assert.ok(!r.isError, JSON.stringify(r)); assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent); return r.structuredContent; };
  return { w, client, call, raw, blockIds, documentId: document.id, execute: (c) => w.execute({ requestId: randomUUID(), documentId: document.id, ...c }) };
}

test("exact reads enforce targets and hard budgets, and page giant cells without leaks", async (t) => {
  const long = "cell α 😀 ".repeat(4000), table = { id: "table", type: "table", head: [["Name", "Value"]], rows: [["needle", long]], translations: { zh: { head: [["名字", "值"]], rows: [["关键词", "译文不应返回"]] } } };
  const h = await setup(t, [table, { id: "tail", type: "para", text: "Unrelated tail." }]);
  const tools = await h.client.listTools(); assert.ok(!tools.tools.some((x) => ["get_document", "read_document"].includes(x.name)));
  assert.equal((await h.raw("read_context", { document_id: h.documentId })).structuredContent.code, "TARGET_REQUIRED");
  assert.equal((await h.raw("read_context", { document_id: h.documentId, block_id: h.blockIds.table, max_chars: 6001 })).isError, true);
  let args = { document_id: h.documentId, block_id: h.blockIds.table, field: "rows", row: 0, column: 1, before_chars: 0, max_chars: 6000 }, text = "", calls = 0;
  do {
    const result = await h.call("read_context", args);
    assert.ok(result.returnedChars <= 6000); assert.equal(result.segments.reduce((sum, s) => sum + s.text.length, 0), result.returnedChars);
    assert.equal(result.segments.length, 1); assert.equal(result.segments[0].address.variant, "source");
    assert.ok(!JSON.stringify(result).includes("译文不应返回")); assert.ok(!result.blocks && !result.document);
    assert.ok(!/[\uD800-\uDBFF]$/.test(result.segments[0].text));
    text += result.segments[0].text; args = result.next; calls++;
    assert.ok(calls < 30);
  } while (args);
  assert.equal(text, long);
  const small = await h.call("read_context", { document_id: h.documentId, block_id: h.blockIds.table, field: "rows", row: 0, column: 0, before_chars: 0 });
  assert.equal(small.segments[0].text, "needle"); assert.ok(JSON.stringify(small).length < 1200);
});

test("multi-entry blocks paginate without dropping cells and exclude other languages", async (t) => {
  const rows = Array.from({ length: 40 }, (_, i) => [`entry-${i}`, ""]);
  const h = await setup(t, [{ id: "table", type: "table", head: [["A", "B"]], rows }]);
  let args = { document_id: h.documentId, block_id: h.blockIds.table, before_chars: 0, max_chars: 100 }, collected = [];
  for (let i = 0; args && i < 30; i++) { const r = await h.call("read_context", args); collected.push(...r.segments); args = r.next; }
  assert.equal(args, null);
  assert.equal(collected.map((s) => s.text).join(""), "AB" + rows.flat().join(""));
  assert.ok(collected.every((s) => s.address.variant === "source"));
});

test("column-only exact reads keep their selection and Unicode text across every continuation", async (t) => {
  const rows = Array.from({ length: 37 }, (_, i) => [`excluded-${i}`, `选中-${i}😀 `.repeat(9), `also-excluded-${i}`]);
  const h = await setup(t, [{ id: "table", type: "table", head: [["Left", "Selected", "Right"]], rows }]);
  let next = { view: "exact", document_id: h.documentId, block_id: h.blockIds.table, field: "rows", column: 1, before_chars: 0, max_chars: 100 };
  const cells = new Map(); let calls = 0;
  while (next) {
    const result = await h.call("read_context", next); assert.ok(result.returnedChars <= 100);
    for (const segment of result.segments) {
      assert.equal(segment.role, "target"); assert.equal(segment.address.column, 1);
      assert.ok(segment.text.isWellFormed());
      cells.set(segment.address.row, (cells.get(segment.address.row) || "") + segment.text);
    }
    next = result.next;
    if (next) { assert.equal(next.column, 1); assert.equal(next.row, undefined); assert.equal(next.field, "rows"); }
    assert.ok(++calls < 100, "every bounded continuation makes progress");
  }
  assert.deepEqual([...cells.values()], rows.map((row) => row[1]));
});

test("reference-centered reads, exact range writes and pinned historical continuation preserve unread text", async (t) => {
  const text = "prefix ".repeat(15000) + "target beta" + " suffix".repeat(1000), at = text.indexOf("target beta");
  const h = await setup(t, [{ id: "p", type: "para", text }]);
  const saved = (await h.execute({ kind: "change_request.save", changeRequest: { category: "correction", revision: 1, body: "Replace beta with gamma.", source: { blockId: h.blockIds.p, field: "text", variant: "source", start: at, end: at + 11, quote: "target beta" } } })).changeRequest;
  const context = await h.call("read_context", { reference: saved.reference, max_chars: 200 });
  assert.equal(context.segments.find((s) => s.role === "target").start, at); assert.ok(context.returnedChars <= 200);
  const wrong = await h.raw("revise_document", { document_id: h.documentId, expected_revision: 1, request_id: randomUUID(), authorized: true, operations: [{ kind: "replace_range", block_id: h.blockIds.p, field: "text", start: at + 7, end: at + 11, expected_text: "oops", value: "gamma" }] });
  assert.equal(wrong.structuredContent.code, "TEXT_CONFLICT"); assert.equal(h.w.row(h.documentId).current_revision, 1);
  const command = { document_id: h.documentId, expected_revision: 1, request_id: randomUUID(), authorized: true, change_request_id: saved.id, expected_change_request_version: saved.version, operations: [{ kind: "replace_range", block_id: h.blockIds.p, field: "text", start: at + 7, end: at + 11, expected_text: "beta", value: "gamma" }] };
  const receipt = await h.call("revise_document", command); assert.equal(receipt.document.revision, 2); assert.ok(!receipt.document.blocks); assert.ok(JSON.stringify(receipt).length < 2500);
  assert.deepEqual(await h.call("revise_document", command), receipt);
  assert.equal((await h.w.revision(h.documentId)).document.blocks[0].text, text.replace("target beta", "target gamma"));
  assert.equal(receipt.changeRequest.status, "completed");
  const oldPage = await h.call("read_context", context.next); assert.equal(oldPage.revision, 1); assert.equal(oldPage.currentRevision, 2);
  const unresolved = (await h.raw("read_context", { reference: saved.reference })).structuredContent;
  assert.equal(unresolved.code, "ANCHOR_UNRESOLVED");
  assert.equal(unresolved.recovery.next.revision, saved.revision, "recovery reads the saved anchor's known original revision instead of repeating the failing current read");
  const recovered = await h.call(unresolved.recovery.nextTool, unresolved.recovery.next);
  assert.equal(recovered.revision, 1); assert.equal(recovered.currentRevision, 2);
  assert.ok(recovered.segments.some((segment) => segment.role === "target" && segment.text.startsWith("target beta")));
  assert.equal((await h.raw("revise_document", { ...command, request_id: randomUUID() })).structuredContent.code, "REVISION_CONFLICT");
});

test("insight detail and saved answers stay bounded and enforce continuation version", async (t) => {
  const h = await setup(t, [{ id: "p", type: "para", text: "A short paragraph." }]);
  const body = "Long question. ".repeat(900);
  const saved = await h.call("update_insight", mergedWrite("create", { authorized: true, ...{ document_id: h.documentId, request_id: randomUUID(), insight: { type: "question", body, color: "sky" } } }));
  assert.equal(saved.insight.body.length, 240); assert.equal(saved.insight.bodyTruncated, true);
  const answer = { blocks: [{ type: "paragraph", text: "Answer detail. ".repeat(6000) }] };
  const answered = await h.call("answer_question", { document_id: h.documentId, insight_id: saved.insight.id, expected_version: saved.insight.version, request_id: randomUUID(), authorized: true, answer });
  assert.ok(answered.insight.hasAnswer); assert.ok(!answered.insight.answer);
  const list = await h.call("query_insights", { state: "active", document_id: h.documentId }); assert.equal(list.insights.length, 1); assert.ok(JSON.stringify(list).length < 1500);
  const first = await h.call("resolve_reference", { reference: saved.insight.reference, part: "answer", max_chars: 300 });
  assert.equal(first.content.text.length, 300); assert.equal(first.next.expected_version, 2);
  await h.execute({ kind: "insight.save", expectedVersion: 2, insight: { ...h.w.insights(h.documentId)[0], body: "Updated question." } });
  assert.equal((await h.raw("resolve_reference", first.next)).structuredContent.code, "REVISION_CONFLICT");
  assert.equal((await h.raw("read_context", { reference: saved.insight.reference })).structuredContent.code, "TARGET_REQUIRED");
});

test("search and proposal output never carry full bodies; proposal approval still applies exact content", async (t) => {
  const text = "Large paragraph with needle. ".repeat(5000);
  const h = await setup(t, [{ id: "p", type: "para", text }, { id: "q", type: "para", text: "second needle" }]);
  const found = await h.call("query_documents", { action: "search", query: "needle", document_id: h.documentId, limit: 1 });
  assert.equal(found.matches.length, 1); assert.equal(found.page.nextOffset, 1); assert.equal(found.matches[0].matchStart, text.indexOf("needle")); assert.ok(found.matches[0].excerpt.text.length <= 240);
  assert.equal(found.nextTool, "query_documents"); assert.equal(found.next.action, "search");
  const following = await h.call(found.nextTool, found.next); assert.equal(following.matches.length, 1); assert.notEqual(following.matches[0].address.blockId, found.matches[0].address.blockId);
  const list = await h.call("query_documents", { action: "list", document_id: h.documentId }); assert.ok(list.documents[0].source.path); assert.ok(JSON.stringify(list).length < 1500);
  const proposal = await h.call("revise_document", { document_id: h.documentId, expected_revision: 1, request_id: randomUUID(), operations: [{ kind: "replace_range", block_id: h.blockIds.p, field: "text", start: 0, end: 5, expected_text: "Large", value: "Small" }] });
  assert.equal(proposal.proposal.status, "pending"); assert.ok(!proposal.proposal.before && !proposal.proposal.after); assert.ok(JSON.stringify(proposal).length < 2000);
  const listed = await h.call("list_revision_proposals"); assert.ok(JSON.stringify(listed).length < 2000);
  const applied = await h.call("decide_revision_proposal", { proposal_id: proposal.proposal.id, request_id: randomUUID(), decision: "accept" }); assert.equal(applied.document.revision, 2);
  assert.equal((await h.w.revision(h.documentId)).document.blocks[0].text, "Small" + text.slice(5));
});

test("range replacement validates Unicode, table shape and translation source hashes", async () => {
  const document = { format: "continous-reader", schema: 2, id: "range", revision: 1, meta: { title: "Range", language: "en" }, blocks: [
    { id: "p", type: "para", text: "😀 beta", translations: { zh: { text: "😀 贝塔" } } },
    { id: "t", type: "table", head: [["H"]], rows: [["beta"]] },
    { id: "h", type: "html", html_profile: "reader-html-1", html: '<p data-node-id="n">Alpha <em>beta</em> <span data-tex="x^2"></span></p>' },
  ] };
  const validated = await validateDocument(document);
  await assert.rejects(applyOperations(document, [{ kind: "replace_range", blockId: "p", field: "text", start: 1, end: 2, expectedText: "\ude00", value: "X" }]), { code: "VALIDATION_FAILED" });
  await assert.rejects(applyOperations(document, [{ kind: "replace_range", blockId: "p", field: "text", variant: "zh", start: 3, end: 5, expectedText: "贝塔", value: "伽马" }]), { code: "SOURCE_HASH_MISMATCH" });
  const result = await applyOperations(document, [
    { kind: "replace_range", blockId: "p", field: "text", variant: "zh", sourceHash: validated.fingerprints.p, start: 3, end: 5, expectedText: "贝塔", value: "伽马" },
    { kind: "replace_range", blockId: "t", field: "rows", row: 0, column: 0, start: 0, end: 4, expectedText: "beta", value: "gamma" },
    { kind: "replace_range", blockId: "h", field: "html_text", nodeId: "n", start: 6, end: 10, expectedText: "beta", value: "gamma" },
  ]);
  assert.equal(result.document.blocks[0].translations.zh.text, "😀 伽马"); assert.deepEqual(result.document.blocks[1].rows, [["gamma"]]); assert.match(result.document.blocks[2].html, /Alpha <em>gamma<\/em>/); assert.match(result.document.blocks[2].html, /data-tex="x\^2"/);
  assert.equal(result.changes[2].before, "beta"); assert.equal(result.changes[2].after, "gamma");
  await assert.rejects(applyOperations(document, [{ kind: "replace_range", blockId: "h", field: "html_text", nodeId: "n", start: 11, end: 16, expectedText: "$x^2$", value: "x" }]), { code: "VALIDATION_FAILED" });
});
