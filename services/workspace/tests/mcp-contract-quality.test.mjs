import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { createWorkspaceServer } from "../server.mjs";
import { createWorkspaceMcp } from "../mcp.mjs";
import { createToolRegistrar } from "../mcp-tool-contract.mjs";
import { mcpFailureValue } from "../mcp-recovery.mjs";
import { readDocumentProjection } from "../mcp-reading.mjs";
import { validateDocument } from "../documents.mjs";
import { WorkspaceError } from "../errors.mjs";
import { publishAuthoringFixture } from "./authoring-fixture.mjs";

async function harness(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-mcp-quality-"));
  const server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false, sync: false });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = "http://127.0.0.1:" + server.address().port;
  const client = new Client({ name: "contract-quality-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  t.after(async () => {
    await client.close(); await server.shutdown();
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep + "reader-mcp-quality-"));
    await rm(dataDir, { recursive: true, force: true });
  });
  const raw = (name, input = {}) => client.callTool({ name, arguments: input });
  const call = async (name, input = {}) => { const result = await raw(name, input); assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent; };
  const write = (name, action, input) => call(name, { authorized: true, request_id: randomUUID(), operation: { action, ...input } });
  const publish = (title) => publishAuthoringFixture({ base, authoring: { format: "reader-authoring-1", key: "quality-" + randomUUID(), meta: { title, language: "en" }, blocks: [{ key: "p", type: "para", text: "A stable paragraph." }] } });
  return { call, raw, write, publish, workspace: server.workspace, client };
}

test("list continuations bind scope and offset, reject changes, and preserve independent range reads", async (t) => {
  const h = await harness(t);
  for (const label of ["A", "B", "C"]) await h.write("update_collection", "create", { label });
  const first = await h.call("list_collections", { limit: 1 });
  assert.equal(first.consistency.mode, "fresh_range");
  assert.ok(first.next.continuation);
  const second = await h.call(first.nextTool, first.next);
  assert.equal(second.consistency.mode, "continued");
  assert.equal(second.consistency.snapshot, first.consistency.snapshot);
  assert.equal(second.collections[0].label, "B");
  const wrongScope = await h.raw("list_collections", { ...first.next, parent_id: null });
  assert.equal(wrongScope.structuredContent.code, "CONTINUATION_SCOPE_MISMATCH");
  assert.equal((await h.raw("list_collections", { ...first.next, offset: 2 })).structuredContent.code, "CONTINUATION_SCOPE_MISMATCH");
  assert.equal((await h.raw("list_collections", { ...first.next, continuation: "invalid" })).structuredContent.code, "INVALID_CONTINUATION");
  await h.write("update_collection", "create", { label: "AA" });
  const stale = (await h.raw("list_collections", first.next)).structuredContent;
  assert.equal(stale.code, "LIST_CHANGED");
  assert.equal(stale.recovery.mode, "reread");
  assert.equal(stale.recovery.next.continuation, undefined);
  const restarted = await h.call(stale.recovery.nextTool, stale.recovery.next);
  assert.equal(restarted.collections[0].label, "A");
  const randomRange = await h.call("list_collections", { offset: 2, limit: 1 });
  assert.equal(randomRange.consistency.mode, "fresh_range");
  assert.equal(randomRange.collections[0].label, "B");
});

test("plan and insight continuations detect membership, order and filter-changing writes", async (t) => {
  const h = await harness(t), a = await h.publish("A"), b = await h.publish("B");
  let plan = await h.call("get_reading_plan");
  plan = await h.write("update_reading_plan", "add", { document_id: a.document.id, expected_plan_version: plan.planVersion });
  await h.write("update_reading_plan", "add", { document_id: b.document.id, expected_plan_version: plan.planVersion });
  const first = await h.call("get_reading_plan", { limit: 1 });
  await h.write("update_collection", "create", { label: "Unrelated" });
  assert.equal((await h.call("get_reading_plan", first.next)).documents[0].id, b.document.id, "unrelated collection changes do not invalidate a plan page");
  await h.write("update_reading_plan", "move", { document_id: b.document.id, expected_plan_version: first.planVersion, direction: "up" });
  assert.equal((await h.raw("get_reading_plan", first.next)).structuredContent.code, "LIST_CHANGED");
  const saved = [];
  for (const body of ["one", "two"]) saved.push((await h.write("update_insight", "create", { document_id: a.document.id, insight: { type: "note", body, color: "green" } })).insight);
  const insights = await h.call("query_insights", { document_id: a.document.id, limit: 1 });
  await h.write("update_insight", "archive", { document_id: a.document.id, insight_id: saved[0].id, expected_version: saved[0].version });
  assert.equal((await h.raw("query_insights", insights.next)).structuredContent.code, "LIST_CHANGED");
});

test("every pageable catalog branch advertises continuations while singular reads stay unchanged", async (t) => {
  const h = await harness(t), byName = Object.fromEntries((await h.client.listTools()).tools.map((tool) => [tool.name, tool]));
  for (const name of ["list_collections", "get_reading_plan", "query_insights", "list_change_requests", "list_revision_proposals", "list_document_relations"]) assert.ok(byName[name].inputSchema.properties.continuation, name);
  for (const name of ["query_documents", "query_glossary", "query_uploaded_sources"]) {
    const schema = byName[name].inputSchema;
    const branches = schema.oneOf || schema.anyOf;
    assert.ok(branches.find((branch) => branch.properties.action.const === "list").properties.continuation, name);
    assert.equal(branches.find((branch) => ["get", "metadata"].includes(branch.properties.action.const)).properties.continuation, undefined, name);
  }
  for (const name of ["read_context", "revise_document", "query_documents", "resolve_reference", "create_authoring_preview", "publish_authoring_preview"]) assert.ok(byName[name].outputSchema, name);
});

test("source, change-request and proposal lists preserve continuation guards through their existing handlers", async (t) => {
  const h = await harness(t), { document, blockIds } = await h.publish("List guards");
  for (const label of ["one", "two"]) h.workspace.recordFile({ filename: label + ".txt", mediaType: "text/plain", sha256: "0".repeat(64), size: 0 });
  const sources = await h.call("query_uploaded_sources", { action: "list", limit: 1 });
  assert.ok(sources.next.continuation);
  assert.equal((await h.call("query_uploaded_sources", sources.next)).consistency.mode, "continued");
  h.workspace.recordFile({ filename: "three.txt", mediaType: "text/plain", sha256: "1".repeat(64), size: 0 });
  assert.equal((await h.raw("query_uploaded_sources", sources.next)).structuredContent.code, "LIST_CHANGED");
  for (const body of ["one", "two"]) await h.write("update_change_request", "create", { document_id: document.id, category: "correction", body, revision: document.revision });
  const requests = await h.call("list_change_requests", { document_id: document.id, limit: 1 });
  assert.equal((await h.call("list_change_requests", requests.next)).consistency.mode, "continued");
  for (const value of ["One", "Two"]) await h.call("revise_document", { document_id: document.id, expected_revision: document.revision, request_id: randomUUID(), operations: [{ kind: "replace_range", block_id: blockIds.p, field: "text", start: 0, end: 1, expected_text: "A", value }] });
  assert.equal((await h.raw("list_change_requests", requests.next)).structuredContent.code, "LIST_CHANGED", "conservative workspace fence rejects a changed list epoch");
  const proposals = await h.call("list_revision_proposals", { document_id: document.id, limit: 1 });
  assert.equal((await h.call("list_revision_proposals", proposals.next)).consistency.mode, "continued");
});

test("recovery distinguishes changed writes, exact retries and unknown commit outcomes", async () => {
  const input = { document_id: "d", request_id: "original", expected_revision: 1, operations: [{ block_id: "b", field: "text", expected_text: "x" }] };
  const conflict = mcpFailureValue(new WorkspaceError("SOURCE_HASH_MISMATCH", "changed", 409, { operation_index: 0, target: { block_id: "b", field: "text", variant: "fr" } }), { name: "revise_document", input, write: true });
  assert.equal(conflict.details.operation_index, 0);
  assert.equal(conflict.recovery.requestIdPolicy, "new_after_review");
  assert.deepEqual(conflict.recovery.next, { document_id: "d", block_id: "b", field: "text", variant: "fr", max_chars: 2000 });
  const unknown = mcpFailureValue(new Error("private runtime detail"), { name: "revise_document", input, write: true });
  assert.equal(unknown.recovery.mode, "unknown"); assert.equal(unknown.recovery.requestIdPolicy, "preserve_unknown");
  assert.ok(!JSON.stringify(unknown).includes("private runtime detail"));
  const retry = mcpFailureValue(new WorkspaceError("RATE_LIMITED", "later", 429, { retryable: true }), { write: true });
  assert.equal(retry.recovery.mode, "exact_retry"); assert.equal(retry.recovery.requestIdPolicy, "reuse_exact");
  for (const code of ["READING_HISTORY_PENDING", "READING_STATISTICS_PENDING"]) {
    const pending = mcpFailureValue(new WorkspaceError(code, "building derived history", 503, { retryable: true, retryAfterMs: 250 }), { name: "query_reading_activity" });
    assert.equal(pending.recovery.mode, "exact_retry"); assert.equal(pending.recovery.retryable, true);
    assert.equal(pending.recovery.requestIdPolicy, "not_applicable"); assert.equal(pending.details.retryAfterMs, 250);
  }
  const reused = mcpFailureValue(new WorkspaceError("IDEMPOTENCY_CONFLICT", "different", 409), { write: true });
  assert.equal(reused.recovery.retryable, false);
  const saved = await validateDocument({ format: "continous-reader", schema: 2, id: "reading", revision: 1, meta: { title: "Recovery", language: "en" }, blocks: [{ id: "b", type: "para", text: "A stable paragraph. ".repeat(20) }] });
  const workspace = { authorize() {}, row: () => ({ current_revision: 1 }), revision: async () => saved };
  const first = await readDocumentProjection(workspace, { view: "content", document_id: "reading", max_chars: 100 });
  assert.ok(first.next.cursor);
  for (const [patch, code] of [[{ block_id: "b" }, "CURSOR_MISMATCH"], [{ cursor: "broken" }, "INVALID_CURSOR"]]) {
    const input = { ...first.next, ...patch };
    const failure = await readDocumentProjection(workspace, input).then(() => assert.fail("invalid cursor must fail"), (error) => mcpFailureValue(error, { name: "read_context", input }));
    assert.equal(failure.code, code); assert.equal(failure.recovery.mode, "reread");
    assert.equal(failure.recovery.nextTool, "read_context");
    const { cursor, ...expected } = input;
    assert.deepEqual(failure.recovery.next, expected, "restart drops only the cursor and preserves the selected revision, language and scope");
    const restarted = await readDocumentProjection(workspace, failure.recovery.next);
    assert.equal(restarted.text, first.text);
    assert.equal(restarted.spans[0].sourceStart, 0);
  }
  for (const [code, details] of [
    ["REVISION_CONFLICT", { documentId: "d", expectedRevision: 1, currentRevision: 2 }],
    ["REVISION_BASE_MISMATCH", { documentId: "d", baseRevision: 1 }],
    ["REVISION_REFERENCES_CHANGED", { documentId: "d", baseRevision: 1 }],
  ]) {
    const failure = mcpFailureValue(new WorkspaceError(code, "changed", 409, details), { name: "publish_authoring_preview", input: { preview_id: "old-preview", request_id: "original" }, write: true });
    assert.equal(failure.recovery.nextTool, "read_resources");
    assert.deepEqual(failure.recovery.next, { kind: "authoring_artifacts", mode: "editing", document_id: "d" });
    assert.equal(failure.recovery.requestIdPolicy, "new_after_review");
  }
  const unknownDocument = mcpFailureValue(new WorkspaceError("REVISION_CONFLICT", "changed", 409), { name: "publish_authoring_preview", input: { preview_id: "old-preview" }, write: true });
  assert.equal(unknownDocument.recovery.nextTool, "inspect_authoring_preview");
  assert.deepEqual(unknownDocument.recovery.next, { target: "preview", preview_id: "old-preview" });
  const long = mcpFailureValue(new WorkspaceError("REVISION_CONFLICT", "x".repeat(20000), 409, { operation_index: 1, target: { block_id: "x".repeat(10000) }, secret: "x".repeat(20000) }), { name: "revise_document", input, write: true });
  assert.ok(JSON.stringify(long).length < 5000);
});

test("output contracts actually reject malformed success without claiming a write was rolled back", async (t) => {
  const server = new McpServer({ name: "output-test", version: "1" }), client = new Client({ name: "test", version: "1" });
  const register = createToolRegistrar(server, { authorize() {} }, { workspaceId: "test", subjectId: "test", scopes: ["read", "write"] });
  let writes = 0;
  register("test_write", "Fixture", {}, async () => { writes++; return { unexpected: true }; }, { write: true, outputSchema: z.object({ requestId: z.string() }) });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "test_write", arguments: {} });
  assert.equal(writes, 1); assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "OUTPUT_CONTRACT_VIOLATION");
  assert.equal(result.structuredContent.recovery.requestIdPolicy, "preserve_unknown");
});

test("committed writes recover their exact receipt after delivery failure even after a later edit", async (t) => {
  const h = await harness(t);
  for (const failureMode of ["exception", "invalid_output"]) {
    const requestId = randomUUID(); let failDelivery = true;
    const mcp = createWorkspaceMcp(h.workspace, undefined, { fileAccess: { decorate: async (value) => {
      if (failDelivery && value.requestId === requestId) {
        failDelivery = false;
        if (failureMode === "exception") throw new Error("private delivery diagnostic");
        return { ...value, collection: { ...value.collection, version: "invalid" } };
      }
      return value;
    } } });
    const client = new Client({ name: "delivery-failure-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair(); await mcp.connect(right); await client.connect(left);
    t.after(async () => { await client.close(); await mcp.close(); });
    const args = { authorized: true, request_id: requestId, operation: { action: "create", label: "Original " + failureMode } };
    const first = await client.callTool({ name: "update_collection", arguments: args });
    assert.equal(first.isError, true); assert.equal(first.structuredContent.code, failureMode === "exception" ? "INTERNAL_ERROR" : "OUTPUT_CONTRACT_VIOLATION");
    assert.equal(first.structuredContent.recovery.mode, "unknown");
    assert.equal(first.structuredContent.recovery.requestIdPolicy, "preserve_unknown");
    assert.ok(!JSON.stringify(first).includes("private delivery diagnostic"));
    const original = (await h.call("list_collections")).collections.find((item) => item.label === args.operation.label);
    assert.ok(original, "delivery failure does not imply rollback");
    await h.write("update_collection", "update", { collection_id: original.id, expected_version: original.version, patch: { label: "Later " + failureMode } });
    const replay = await client.callTool({ name: "update_collection", arguments: args });
    assert.equal(replay.isError, undefined); assert.equal(replay.structuredContent.requestId, requestId);
    assert.deepEqual(replay.structuredContent.collection, original, "exact replay returns the original receipt, not newer state");
    const changed = await client.callTool({ name: "update_collection", arguments: { ...args, operation: { action: "create", label: "Changed payload" } } });
    assert.equal(changed.structuredContent.code, "IDEMPOTENCY_CONFLICT");
    const saved = (await h.call("list_collections")).collections;
    assert.equal(saved.filter((item) => item.id === original.id).length, 1); assert.equal(saved.find((item) => item.id === original.id).label, "Later " + failureMode);
  }
});

test("malformed and unapproved writes cannot alter state and read-only actors cannot replay a saved write", async (t) => {
  const h = await harness(t), requestId = randomUUID();
  const valid = { authorized: true, request_id: requestId, operation: { action: "create", label: "Explicit synthetic collection" } };
  const before = await h.call("list_collections");
  for (const argumentsValue of [
    { ...valid, authorized: false }, { request_id: requestId, operation: valid.operation },
    { ...valid, request_id: 7 }, { ...valid, operation: { ...valid.operation, authorized: true } },
    { ...valid, operation: { action: "create", label: { instruction: "create me" } } },
    { ...valid, operation: { action: "update", collection_id: "missing", patch: { label: "No version" } } },
  ]) {
    const result = await h.raw("update_collection", argumentsValue); assert.equal(result.isError, true);
    assert.deepEqual(await h.call("list_collections"), before, "input rejection cannot create state or a receipt");
  }
  const created = await h.call("update_collection", valid);
  assert.equal(created.collection.label, valid.operation.label, "the request ID was not consumed by invalid attempts");
  for (const actor of [
    { workspaceId: "local", subjectId: "readonly", scopes: ["read"] },
    { workspaceId: "other-workspace", subjectId: "local", scopes: ["read", "write"] },
  ]) {
    const mcp = createWorkspaceMcp(h.workspace, actor), client = new Client({ name: "scope-replay-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair(); await mcp.connect(right); await client.connect(left);
    t.after(async () => { await client.close(); await mcp.close(); });
    const denied = await client.callTool({ name: "update_collection", arguments: valid });
    assert.equal(denied.isError, true); assert.equal(denied.structuredContent.code, "FORBIDDEN");
    assert.equal(denied.structuredContent.recovery.mode, "request_authorization");
    const read = await client.callTool({ name: "list_collections", arguments: {} });
    assert.equal(Boolean(read.isError), actor.workspaceId !== "local");
  }
  assert.deepEqual(await h.call("update_collection", valid), created);
});
