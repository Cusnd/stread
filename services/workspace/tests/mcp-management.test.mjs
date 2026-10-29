import { mergedWrite, schemaBranches } from "./mcp-input-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { createWorkspaceServer } from "../server.mjs";
import { createWorkspaceMcp } from "../mcp.mjs";
import { publishAuthoringFixture } from "./authoring-fixture.mjs";

async function harness(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-mcp-management-"));
  const connections = [];
  let server, base;
  const start = async () => {
    server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  await start();
  t.after(async () => {
    for (const client of connections) await client.close();
    await server?.shutdown();
    const resolved = resolve(dataDir);
    assert.ok(resolved.startsWith(resolve(tmpdir()) + sep) && resolved !== resolve(tmpdir()));
    await rm(resolved, { recursive: true, force: true });
  });
  const request = async (path, body, status = 200) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const connect = async (actor) => {
    const client = new Client({ name: "management-test", version: "1" });
    if (actor) {
      const mcp = createWorkspaceMcp(server.workspace, actor, { baseUrl: base });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await mcp.connect(right); await client.connect(left);
      t.after(() => mcp.close());
    } else await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    connections.push(client);
    const raw = (name, args = {}) => client.callTool({ name, arguments: args });
    const call = async (name, args = {}) => {
      const response = await raw(name, args);
      assert.ok(!response.isError, `${name}: ${JSON.stringify(response)}`);
      const value = response.structuredContent;
      assert.ok(value, `${name} returns structured content`);
      assert.deepEqual(JSON.parse(response.content[0].text), value, "structured/text projections agree");
      assert.ok(JSON.stringify(value).length < 24000, `${name} has a bounded response`);
      return value;
    };
    const write = (name, args) => call(name, { request_id: randomUUID(), authorized: true, ...args });
    return { client, raw, call, write };
  };
  const publish = (title = "Management document") => publishAuthoringFixture({ base, authoring: {
    format: "reader-authoring-1", key: "management-" + randomUUID(), meta: { title, language: "en" },
    blocks: [{ key: "para", type: "para", text: "A stable paragraph for explicit changes." }, { key: "table", type: "table", head: [["A", "B"]], rows: [["1", "2"]] }],
  } });
  return { request, connect, publish, get workspace() { return server.workspace; }, command: (input, status) => request("/api/commands", { requestId: randomUUID(), ...input }, status), restart: async () => { await server.shutdown(); await start(); } };
}

test("management tools expose precise schemas, current-user declarations and correct permission hints", async (t) => {
  const h = await harness(t), m = await h.connect();
  const tools = (await m.client.listTools()).tools, byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  for (const name of ["query_reading_activity", "query_insights", "get_reading_plan", "list_collections", "query_documents", "get_object_preferences"]) assert.equal(byName[name].annotations.readOnlyHint, true, name);
  for (const name of ["update_glossary", "update_collection", "update_document", "update_insight", "update_reading_plan", "update_change_request", "set_insight_review", "update_object_preferences"]) {
    const tool = byName[name]; assert.equal(tool.annotations.readOnlyHint, false, name);
    assert.ok(tool.inputSchema.required.includes("authorized"), name); assert.ok(tool.inputSchema.required.includes("request_id"), name);
    assert.equal(tool.inputSchema.properties.authorized.const, true, name);
    assert.equal(tool.inputSchema.additionalProperties, false, name);
  }
  assert.equal(byName.update_collection.annotations.destructiveHint, true);
  assert.equal(byName.update_insight.annotations.destructiveHint, true, "one destructive branch makes the combined tool conservative");
  assert.ok(schemaBranches(byName.update_insight.inputSchema.properties.operation).some((schema) => schema.properties.action.const === "restore"));
  assert.equal(byName.answer_question.inputSchema.properties.answer.properties.blocks.type, "array");
  const createInsight = schemaBranches(byName.update_insight.inputSchema.properties.operation).find((schema) => schema.properties.action.const === "create");
  assert.ok(createInsight.properties.insight.properties.type.enum.includes("question"));
  assert.ok(!tools.some((tool) => /reading_session|record_reading/.test(tool.name) || /reading_activity/.test(tool.name) && !tool.annotations.readOnlyHint), "Agent tools cannot fabricate human reading time");
  for (const authorized of [undefined, false]) assert.equal((await m.raw("update_collection", mergedWrite("create", { request_id: randomUUID(), label: "Forbidden", ...(authorized === undefined ? {} : { authorized }) }))).isError, true);
  assert.deepEqual((await m.call("list_collections")).collections, []);
  const readOnly = await h.connect({ workspaceId: "local", subjectId: "observer", scopes: ["read"] });
  const attempted = await readOnly.raw("update_collection", mergedWrite("create", { request_id: randomUUID(), authorized: true, label: "Denied" }));
  assert.equal(attempted.isError, true); assert.equal(attempted.structuredContent.code, "FORBIDDEN");
  assert.deepEqual((await readOnly.call("list_collections")).collections, []);
});

test("Collection management preserves metadata, rejects stale writes and manages hierarchy without recursive deletion", async (t) => {
  const h = await harness(t), m = await h.connect(), { document } = await h.publish();
  const root = (await m.write("update_collection", mergedWrite("create", { label: "Research" }))).collection;
  const child = (await m.write("update_collection", mergedWrite("create", { label: "Attention", parent_id: root.id }))).collection;
  assert.equal((await m.call("list_collections", { parent_id: root.id })).collections[0].id, child.id);
  assert.equal((await m.raw("update_collection", mergedWrite("remove", { request_id: randomUUID(), authorized: true, collection_id: root.id, expected_version: root.version }))).structuredContent.code, "COLLECTION_NOT_EMPTY");
  const cycle = await m.raw("update_collection", mergedWrite("update", { request_id: randomUUID(), authorized: true, collection_id: root.id, expected_version: root.version, patch: { parent_id: child.id } }));
  assert.equal(cycle.structuredContent.code, "COLLECTION_CYCLE");
  const before = (await m.call("query_documents", { action: "metadata", document_id: document.id })).document;
  const args = { request_id: randomUUID(), authorized: true, document_id: document.id, expected_version: before.version, patch: { summary: "Long summary. ".repeat(600), tags: ["research", "attention"], collection_ids: [child.id], status: "reading" } };
  const first = await m.call("update_document", mergedWrite("metadata", args));
  assert.deepEqual(await m.call("update_document", mergedWrite("metadata", args)), first);
  assert.equal(first.document.version, before.version + 1); assert.equal(first.document.summaryTruncated, true);
  assert.equal((await m.call("query_documents", { action: "list", collection_id: child.id, tag: "attention", status: "reading" })).documents[0].id, document.id);
  assert.equal((await m.raw("update_document", mergedWrite("metadata", { ...args, request_id: randomUUID() }))).structuredContent.code, "REVISION_CONFLICT");
  const page = await m.call("query_documents", { action: "metadata", document_id: document.id, max_chars: 100 });
  assert.equal(page.content.text.length, 100); assert.ok(page.next);
  assert.equal(page.nextTool, "query_documents"); assert.equal(page.next.action, "metadata");
  assert.equal((await m.raw("query_documents", { action: "metadata", document_id: document.id, offset: 100 })).structuredContent.code, "REVISION_REQUIRED");
  const changed = await m.write("update_document", mergedWrite("metadata", { document_id: document.id, expected_version: first.document.version, patch: { tags: ["revised"] } }));
  assert.equal((await m.raw("query_documents", { action: "metadata", ...page.next })).structuredContent.code, "REVISION_CONFLICT");
  assert.deepEqual(await m.call("update_document", mergedWrite("metadata", args)), first, "old exact retry returns its immutable receipt after unrelated changes");
  const archived = await m.write("update_document", mergedWrite("archive", { document_id: document.id, expected_version: changed.document.version }));
  assert.ok(archived.document.archivedAt); assert.equal((await m.call("query_documents", { action: "list" })).documents.length, 0);
  assert.equal((await m.call("query_documents", { action: "list", include_archived: true })).documents[0].id, document.id);
  const restored = await m.write("update_document", mergedWrite("restore", { document_id: document.id, expected_version: archived.document.version }));
  assert.equal(restored.document.archivedAt, null);
  await m.write("update_document", mergedWrite("metadata", { document_id: document.id, expected_version: restored.document.version, patch: { collection_ids: [] } }));
  const renamed = await m.write("update_collection", mergedWrite("update", { collection_id: child.id, expected_version: child.version, patch: { label: "Renamed", parent_id: null } }));
  assert.equal(renamed.collection.parentId, null);
  await m.write("update_collection", mergedWrite("remove", { collection_id: child.id, expected_version: renamed.collection.version }));
  await m.write("update_collection", mergedWrite("remove", { collection_id: root.id, expected_version: root.version }));
  assert.deepEqual((await m.call("list_collections")).collections, []);
});

test("reading plan order uses atomic CAS and never records activity", async (t) => {
  const h = await harness(t), m = await h.connect(), a = await h.publish("First"), b = await h.publish("Second");
  const initial = await m.call("get_reading_plan");
  const races = await Promise.all([a, b].map((item) => m.raw("update_reading_plan", mergedWrite("add", { request_id: randomUUID(), authorized: true, document_id: item.document.id, expected_plan_version: initial.planVersion }))));
  assert.equal(races.filter((result) => !result.isError).length, 1);
  assert.equal(races.find((result) => result.isError).structuredContent.code, "REVISION_CONFLICT");
  let plan = await m.call("get_reading_plan");
  const missing = [a.document.id, b.document.id].find((id) => !plan.documents.some((item) => item.id === id));
  await m.write("update_reading_plan", mergedWrite("add", { document_id: missing, expected_plan_version: plan.planVersion }));
  plan = await m.call("get_reading_plan"); const originalOrder = plan.documents.map((item) => item.id);
  const move = { request_id: randomUUID(), authorized: true, document_id: originalOrder[1], direction: "up", expected_plan_version: plan.planVersion };
  const receipt = await m.call("update_reading_plan", mergedWrite("move", move));
  assert.deepEqual(await m.call("update_reading_plan", mergedWrite("move", move)), receipt);
  plan = await m.call("get_reading_plan", { limit: 1 });
  assert.equal(plan.documents[0].id, originalOrder[1]); assert.equal(plan.documents[0].planIndex, 0); assert.equal(plan.page.nextOffset, 1);
  const last = await m.call("get_reading_plan", { offset: 1, limit: 1 });
  assert.equal(last.documents[0].planIndex, 1);
  await m.write("update_reading_plan", mergedWrite("remove", { document_id: originalOrder[0], expected_plan_version: plan.planVersion }));
  assert.equal((await m.call("get_reading_plan")).documents.length, 1);
  assert.equal((await m.call("query_reading_activity", { view: "summary" })).totals.activeMs, 0);
  assert.deepEqual((await m.call("query_reading_activity", { view: "history" })).sessions, []);
});

test("reading statistics combine dates, documents, current tags/collections and actor scope without reassigning overlaps", async (t) => {
  const h = await harness(t), m = await h.connect(), a = await h.publish("Statistics A"), b = await h.publish("Statistics B");
  const collection = (await m.write("update_collection", mergedWrite("create", { label: "Statistics group" }))).collection;
  for (const [document, tags, collectionIds] of [[a.document, ["science", "favorite"], [collection.id]], [b.document, ["science"], []]]) {
    const current = (await m.call("query_documents", { action: "metadata", document_id: document.id })).document;
    await m.write("update_document", mergedWrite("metadata", { document_id: document.id, expected_version: current.version, patch: { tags, collection_ids: collectionIds } }));
  }
  const base = Date.now() - 30000, sidA = randomUUID(), sidB = randomUUID(), iso = ms => new Date(ms).toISOString();
  await h.command({ kind: "reading.session.start", sessionId: sidA, documentId: a.document.id, documentRevision: 1, startedAt: iso(base) });
  await h.command({ kind: "reading.session.start", sessionId: sidB, documentId: b.document.id, documentRevision: 1, startedAt: iso(base) });
  await h.command({ kind: "reading.session.activity", sessionId: sidA, sequence: 1, startedAt: iso(base), endedAt: iso(base + 15000), activeMs: 15000 });
  await h.command({ kind: "reading.session.activity", sessionId: sidB, sequence: 1, startedAt: iso(base + 10000), endedAt: iso(base + 25000), activeMs: 15000 });
  const dates = { from: iso(base).slice(0, 10), to: iso(base + 25000).slice(0, 10), timezone: "UTC" };
  const original = await m.call("query_reading_activity", { view: "summary", ...dates });
  assert.equal(original.totals.activeMs, 25000); assert.ok(Array.isArray(original.days)); assert.equal(original.groups, undefined);
  const groups = await m.call("query_reading_activity", { view: "summary", ...dates, group_by: ["document"], limit: 1 });
  assert.equal(groups.totals.activeMs, 25000); assert.equal(groups.page.total, 2); assert.equal(groups.groups.length, 1);
  const second = await m.call("query_reading_activity", { view: "summary", ...dates, group_by: ["document"], offset: 1, limit: 1 });
  assert.deepEqual(groups.totals, second.totals, "pagination does not change range totals");
  const byDocument = new Map([...groups.groups, ...second.groups].map(row => [row.documentId, row]));
  assert.equal(byDocument.get(a.document.id).activeMs, 15000); assert.equal(byDocument.get(b.document.id).activeMs, 10000);
  const selected = await m.call("query_reading_activity", { view: "summary", ...dates, document_ids: [a.document.id, b.document.id],
    actor_ids: ["local"], tags: ["science", "favorite"], tag_mode: "all", collection_ids: [collection.id], group_by: ["day", "document", "actor"] });
  assert.equal(selected.totals.activeMs, 15000); assert.equal(selected.groups[0].documentId, a.document.id); assert.equal(selected.groups[0].actorId, "local");
  const filterOnly = await m.call("query_reading_activity", { view: "summary", ...dates, document_ids: [b.document.id] });
  assert.equal(filterOnly.totals.activeMs, 10000); assert.ok(Array.isArray(filterOnly.days));
  const forbidden = await m.raw("query_reading_activity", { view: "summary", ...dates, actor_ids: ["another-user"] });
  assert.equal(forbidden.structuredContent.code, "FORBIDDEN");
  assert.equal((await m.raw("query_reading_activity", { view: "summary", group_by: ["day", "day"] })).isError, true);
  assert.equal((await m.raw("query_reading_activity", { view: "history", group_by: ["day"] })).isError, true);
});

test("cross-library insights, review CAS and archive/restore preserve references, answers and review membership", async (t) => {
  const h = await harness(t), m = await h.connect(), a = await h.publish("One"), b = await h.publish("Two");
  const question = (await m.call("update_insight", mergedWrite("create", { authorized: true, ...{ document_id: a.document.id, request_id: randomUUID(), insight: { type: "question", title: "Explicit independent title", body: "Question detail. ".repeat(1000), color: "sky" } } }))).insight;
  await m.call("update_insight", mergedWrite("create", { authorized: true, ...{ document_id: b.document.id, request_id: randomUUID(), insight: { type: "note", body: "A note in another document.", color: "green" } } }));
  const all = await m.call("query_insights", { state: "active", limit: 1 }); assert.equal(all.page.total, 2); assert.equal(all.page.nextOffset, 1);
  const found = await m.call("query_insights", { state: "active", query: "independent", question: "unresolved" });
  assert.equal(found.insights[0].id, question.id); assert.equal(found.insights[0].body.length, 240);
  const added = await m.write("set_insight_review", { document_id: a.document.id, insight_id: question.id, action: "add", expected_activity_revision: found.activityRevision });
  assert.equal(added.insight.review.pending, true); assert.equal(added.insight.version, question.version);
  const stale = await m.raw("set_insight_review", { request_id: randomUUID(), authorized: true, document_id: a.document.id, insight_id: question.id, action: "remove", expected_activity_revision: found.activityRevision });
  assert.equal(stale.structuredContent.code, "REVISION_CONFLICT");
  const answered = await m.call("answer_question", { document_id: a.document.id, insight_id: question.id, expected_version: question.version, request_id: randomUUID(), authorized: true, answer: { blocks: [{ type: "paragraph", text: "Explicitly requested answer." }] } });
  assert.equal((await m.call("query_insights", { state: "active", review: "pending", question: "resolved" })).insights[0].id, question.id);
  const archived = await m.write("update_insight", mergedWrite("archive", { document_id: a.document.id, insight_id: question.id, expected_version: answered.insight.version }));
  assert.ok(archived.insight.archivedAt); assert.equal((await m.call("query_insights", { state: "active", review: "pending" })).page.total, 0);
  assert.equal((await m.call("query_insights", { state: "archived", document_id: a.document.id })).insights[0].reference, question.reference);
  const restored = await m.write("update_insight", mergedWrite("restore", { document_id: a.document.id, insight_id: question.id, expected_version: archived.insight.version }));
  assert.equal(restored.insight.reference, question.reference); assert.equal(restored.insight.hasAnswer, true);
  const pending = await m.call("query_insights", { state: "active", review: "pending" }); assert.equal(pending.insights[0].id, question.id);
  const completed = await m.write("set_insight_review", { document_id: a.document.id, insight_id: question.id, action: "complete", expected_activity_revision: pending.activityRevision });
  assert.equal(completed.insight.review.pending, false); assert.ok(completed.insight.review.lastReviewedAt); assert.equal(completed.insight.version, restored.insight.version);
  const summary = await m.call("query_reading_activity", { view: "summary", days: 30, timezone: "America/Los_Angeles", offset: 20 });
  assert.equal(summary.page.total, 30); assert.equal(summary.days.length, 10); assert.equal(summary.totals.insightCount, 2);
});

test("insight state and archived-document scope remain independent while review and question filters stay effective", async (t) => {
  const h = await harness(t), m = await h.connect(), a = await h.publish("Archived parent"), b = await h.publish("Active parent");
  const create = async (documentId, insight) => (await m.write("update_insight", { operation: { action: "create", document_id: documentId, insight } })).insight;
  const pending = await create(a.document.id, { type: "question", body: "Review this archived parent's question.", color: "sky" });
  const archived = await create(a.document.id, { type: "note", body: "An archived insight with preserved identity.", color: "green" });
  const active = await create(b.document.id, { type: "note", body: "The active document remains visible.", color: "green" });
  const initial = await m.call("query_insights", { state: "active" });
  await m.write("set_insight_review", { document_id: a.document.id, insight_id: pending.id, action: "add", expected_activity_revision: initial.activityRevision });
  await m.write("update_insight", { operation: { action: "archive", document_id: a.document.id, insight_id: archived.id, expected_version: archived.version } });
  const ids = async (input) => (await m.call("query_insights", input)).insights.map((item) => item.id).sort();
  assert.deepEqual(await ids({ state: "active" }), [pending.id, active.id].sort());
  assert.deepEqual(await ids({ state: "archived" }), [archived.id]);
  assert.deepEqual(await ids({ state: "all" }), [pending.id, archived.id, active.id].sort());
  const metadata = (await m.call("query_documents", { action: "metadata", document_id: a.document.id })).document;
  await m.write("update_document", { operation: { action: "archive", document_id: a.document.id, expected_version: metadata.version } });
  assert.deepEqual(await ids({}), [active.id], "default discovery excludes an archived parent");
  assert.deepEqual(await ids({ state: "active" }), [active.id]);
  assert.deepEqual(await ids({ state: "archived" }), [archived.id]);
  assert.deepEqual(await ids({ state: "all" }), [pending.id, archived.id, active.id].sort());
  assert.deepEqual(await ids({ document_id: a.document.id, state: "active" }), [pending.id]);
  assert.deepEqual(await ids({ document_id: a.document.id, state: "archived" }), [archived.id]);
  assert.deepEqual(await ids({ document_id: a.document.id, state: "all" }), [pending.id, archived.id].sort());
  assert.deepEqual(await ids({ document_id: a.document.id, state: "active", query: "parent", question: "unresolved", review: "pending" }), [pending.id]);
  assert.deepEqual(await ids({ document_id: a.document.id, state: "active", question: "resolved", review: "pending" }), []);
  assert.deepEqual(await ids({ state: "all", type: "note" }), [archived.id, active.id].sort());
  const recovered = await m.write("update_insight", { operation: { action: "restore", document_id: a.document.id, insight_id: archived.id, expected_version: archived.version + 1 } });
  assert.equal(recovered.insight.reference, archived.reference);
  assert.deepEqual(await ids({ document_id: a.document.id, state: "archived" }), []);
});

test("change-request lifecycle supports exact patch retries and rejects overwriting cancelled/completed work", async (t) => {
  const h = await harness(t), m = await h.connect(), { document, blockIds } = await h.publish();
  const created = await m.write("update_change_request", mergedWrite("create", { document_id: document.id, category: "correction", body: "Please change stable to clear.", revision: document.revision, source: { block_id: blockIds.para, field: "text", start: 2, end: 8, quote: "stable" } }));
  const original = created.changeRequest; assert.equal(original.status, "pending");
  const args = { request_id: randomUUID(), authorized: true, document_id: document.id, change_request_id: original.id, expected_version: original.version, patch: { body: "Change the word only." } };
  const edited = await m.call("update_change_request", mergedWrite("update", args));
  assert.equal(edited.changeRequest.category, "correction"); assert.equal(edited.changeRequest.source.blockId, blockIds.para);
  const later = await m.write("update_change_request", mergedWrite("update", { document_id: document.id, change_request_id: original.id, expected_version: edited.changeRequest.version, patch: { category: "instruction" } }));
  assert.deepEqual(await m.call("update_change_request", mergedWrite("update", args)), edited, "a later category edit must not alter the exact-retry command hash");
  const cancelled = await m.write("update_change_request", mergedWrite("cancel", { document_id: document.id, change_request_id: original.id, expected_version: later.changeRequest.version }));
  assert.equal(cancelled.changeRequest.status, "cancelled");
  const invalid = await m.raw("update_change_request", mergedWrite("update", { ...args, request_id: randomUUID(), expected_version: cancelled.changeRequest.version })); assert.equal(invalid.structuredContent.code, "REVISION_CONFLICT");
  const reopened = await m.write("update_change_request", mergedWrite("reopen", { document_id: document.id, change_request_id: original.id, expected_version: cancelled.changeRequest.version }));
  assert.equal(reopened.changeRequest.reference, original.reference);
  await m.call("revise_document", { document_id: document.id, expected_revision: document.revision, request_id: randomUUID(), authorized: true, change_request_id: original.id, expected_change_request_version: reopened.changeRequest.version, operations: [{ kind: "replace_range", block_id: blockIds.para, field: "text", start: 2, end: 8, expected_text: "stable", value: "clear" }] });
  const completed = (await m.call("list_change_requests", { document_id: document.id, status: "completed" })).changeRequests[0];
  assert.equal(completed.id, original.id);
  const denied = await m.raw("update_change_request", mergedWrite("reopen", { request_id: randomUUID(), authorized: true, document_id: document.id, change_request_id: original.id, expected_version: completed.version })); assert.equal(denied.structuredContent.code, "REVISION_CONFLICT");
});

test("object preference tools enforce atomic workspace CAS, field patches, explicit resets and bounded reads", async (t) => {
  const h = await harness(t), m = await h.connect(), { document, blockIds } = await h.publish();
  const initial = await m.call("get_object_preferences", { document_id: document.id });
  const args = { request_id: randomUUID(), authorized: true, document_id: document.id, document_revision: initial.documentRevision, expected_workspace_revision: initial.workspaceRevision, objects: [{ block_id: blockIds.table, width_percent: 140 }] };
  const saved = await m.call("update_object_preferences", args); assert.equal(saved.objectCount, 1);
  assert.deepEqual(await m.call("update_object_preferences", args), saved);
  const read = await m.call("get_object_preferences", { document_id: document.id }); assert.equal(read.objects[0].widthPercent, 140);
  assert.equal((await m.raw("update_object_preferences", { ...args, request_id: randomUUID() })).structuredContent.code, "REVISION_CONFLICT");
  await m.write("update_object_preferences", { document_id: document.id, document_revision: document.revision, expected_workspace_revision: read.workspaceRevision, objects: [{ block_id: blockIds.table, font_size: 22 }] });
  const both = await m.call("get_object_preferences", { document_id: document.id }); assert.equal(both.objects[0].widthPercent, 140); assert.equal(both.objects[0].fontSize, 22);
  await m.write("update_object_preferences", { document_id: document.id, document_revision: document.revision, expected_workspace_revision: both.workspaceRevision, objects: [{ block_id: blockIds.table, width_percent: null }] });
  const reset = await m.call("get_object_preferences", { document_id: document.id }); assert.equal(reset.objects[0].widthPercent, null); assert.equal(reset.objects[0].fontSize, 22);
  assert.equal(reset.documentRevision, document.revision, "preferences never revise article content");
  const invalid = await m.raw("update_object_preferences", { ...args, request_id: randomUUID(), expected_workspace_revision: reset.workspaceRevision, objects: [{ block_id: blockIds.table, width_percent: 180 }, { block_id: blockIds.para, font_size: 20 }] });
  assert.equal(invalid.structuredContent.code, "ANCHOR_UNRESOLVED");
  assert.equal((await m.call("get_object_preferences", { document_id: document.id })).objects[0].widthPercent, null, "mixed invalid batches roll back");
});

test("explicitly authorized glossary CRUD preserves omitted fields, supports deletion discovery and survives retry/restart", async (t) => {
  const h = await harness(t), m = await h.connect();
  const args = { request_id: randomUUID(), authorized: true, term: "Attention", definition: "A detailed definition. ".repeat(200), aliases: ["Attn"], document_title: "Source" };
  const created = await m.call("update_glossary", mergedWrite("create", args)); assert.equal(created.entry.definitionTruncated, true);
  assert.deepEqual(await m.call("update_glossary", mergedWrite("create", args)), created);
  const id = created.entry.id;
  const update = { request_id: randomUUID(), authorized: true, id, expected_revision: created.entry.revision, patch: { term: "Selective attention" } };
  const renamed = await m.call("update_glossary", mergedWrite("update", update));
  assert.equal(renamed.entry.definitionChars, args.definition.trim().length); assert.deepEqual(renamed.entry.aliases, ["Attn"]);
  const second = await m.write("update_glossary", mergedWrite("update", { id, expected_revision: renamed.entry.revision, patch: { aliases: ["Attention mechanism"] } }));
  assert.deepEqual(await m.call("update_glossary", mergedWrite("update", update)), renamed, "retry after another field change preserves the first receipt");
  assert.equal((await m.raw("update_glossary", mergedWrite("update", { ...update, request_id: randomUUID() }))).structuredContent.code, "REVISION_CONFLICT");
  assert.equal((await m.raw("update_glossary", mergedWrite("update", { ...update, patch: { term: "Different payload" } }))).structuredContent.code, "IDEMPOTENCY_CONFLICT");
  const removed = await m.write("update_glossary", mergedWrite("remove", { id, expected_revision: second.entry.revision })); assert.ok(removed.entry.deletedAt);
  assert.equal((await m.call("query_glossary", { action: "list" })).entries.length, 0);
  const deleted = await m.call("query_glossary", { action: "list", include_deleted: true }); assert.equal(deleted.entries[0].id, id); assert.ok(deleted.entries[0].deletedAt);
  const exact = await m.call("query_glossary", { action: "get", id, max_chars: 100 }); assert.ok(exact.entry.deletedAt); assert.equal(exact.definition.text.length, 100);
  assert.equal(exact.nextTool, "query_glossary"); assert.equal(exact.next.action, "get");
  const following = await m.call(exact.nextTool, exact.next); assert.equal(following.definition.start, exact.definition.end); assert.equal(following.entry.id, id);
  const restored = await m.write("update_glossary", mergedWrite("restore", { id, expected_revision: removed.entry.revision })); assert.equal(restored.entry.deletedAt, undefined);
  assert.equal((await m.call("query_glossary", { action: "search", query: "mechanism" })).entries[0].id, id);
  await h.restart(); const after = await h.connect();
  assert.deepEqual(await after.call("update_glossary", mergedWrite("create", args)), created, "idempotency receipts survive restart");
  const persisted = await after.call("query_glossary", { action: "get", id, max_chars: 6000 }); assert.equal(persisted.definition.text, args.definition.trim()); assert.deepEqual(persisted.entry.aliases, ["Attention mechanism"]);
});
