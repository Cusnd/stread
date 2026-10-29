import { mergedWrite, schemaBranches } from "./mcp-input-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createWorkspaceServer } from "../server.mjs";
import { publishAuthoringFixture } from "./authoring-fixture.mjs";

async function harness(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-insight-titles-"));
  let server, base;
  const clients = [];
  const start = async () => {
    server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  await start();
  t.after(async () => {
    for (const client of clients) await client.close();
    await server.shutdown();
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep));
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = async (path, body, status = 200) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const { document, blockIds } = await publishAuthoringFixture({ base, authoring: {
    format: "reader-authoring-1", key: "independent-insight-titles", meta: { title: "Insight title fixture", language: "en" },
    blocks: [{ key: "paragraph", type: "para", text: "A stable source paragraph." }],
  } });
  const command = (input, status = 200) => request("/api/commands", { requestId: randomUUID(), documentId: document.id, ...input }, status);
  return {
    document, blockIds, command, request,
    get workspace() { return server.workspace; },
    reference: (reference) => request("/api/references/" + encodeURIComponent(reference)),
    restart: async () => { await server.shutdown(); await start(); },
    connectMcp: async () => {
      const client = new Client({ name: "insight-title-contract-test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
      clients.push(client);
      const raw = (name, args) => client.callTool({ name, arguments: args });
      const call = async (name, args) => { const value = await raw(name, args); assert.ok(!value.isError, JSON.stringify(value)); return value.structuredContent; };
      return { client, raw, call };
    },
  };
}

test("independent titles persist through editing, answer/review operations and restart without changing content identity", async (t) => {
  const h = await harness(t);
  const original = (await h.command({ kind: "insight.save", insight: { type: "question", title: "  Attention scaling  ", body: "Why is the score divided by the square root of the key dimension?", color: "sky", blockId: h.blockIds.paragraph, field: "text", start: 2, end: 8, quote: "stable" } })).insight;
  assert.equal(original.title, "Attention scaling");
  await h.command({ kind: "insight.review.add", insightId: original.id });
  const answered = (await h.command({ kind: "insight.answer", insightId: original.id, expectedVersion: original.version, authorized: true, answer: { blocks: [{ type: "paragraph", text: "It controls the variance of dot products." }] } })).insight;
  const renamed = (await h.command({ kind: "insight.save", expectedVersion: answered.version, insight: { id: original.id, title: "Variance control" } })).insight;
  for (const key of ["id", "reference", "references", "body", "answer", "answerAuthorization", "resolvedAt", "revision", "blockId", "field", "start", "end", "quote", "createdAt"]) assert.deepEqual(renamed[key], answered[key], key);
  assert.equal(renamed.version, answered.version + 1);
  const flow = await h.request("/api/flow/insights?review=pending&question=resolved");
  assert.equal(flow.items[0].title, "Variance control");
  assert.equal(flow.items[0].review.pending, true);
  const edited = (await h.command({ kind: "insight.save", expectedVersion: renamed.version, insight: { id: original.id, body: "Updated detailed question." } })).insight;
  assert.equal(edited.title, "Variance control", "omitted title is preserved");
  const cleared = (await h.command({ kind: "insight.save", expectedVersion: edited.version, insight: { id: original.id, title: "   " } })).insight;
  assert.equal(cleared.title, "");
  assert.equal(cleared.body, edited.body);
  const final = (await h.command({ kind: "insight.save", expectedVersion: cleared.version, insight: { id: original.id, title: "A durable title" } })).insight;
  await h.restart();
  assert.deepEqual((await h.reference(original.reference)).insight, final);
  assert.equal((await h.workspace.query({ kind: "insights", documentId: h.document.id })).insights[0].title, "A durable title");
  const envelope = await h.request(`/api/documents/${h.document.id}`);
  assert.equal(envelope.insights[0].title, "A durable title");
  assert.equal(envelope.insights[0].review.pending, true);
  assert.deepEqual(envelope.document, h.document);
});

test("untitled insights remain lossless and invalid titles cannot partially update existing insights", async (t) => {
  const h = await harness(t);
  const original = (await h.command({ kind: "insight.save", insight: { type: "note", body: "This full body must never become an automatic title.", color: "green" } })).insight;
  assert.equal(Object.hasOwn(original, "title"), false);
  const edited = (await h.command({ kind: "insight.save", expectedVersion: original.version, insight: { id: original.id, body: "Still untitled after a body edit." } })).insight;
  assert.equal(Object.hasOwn(edited, "title"), false);
  assert.equal(Object.hasOwn((await h.reference(original.reference)).insight, "title"), false);
  const beforeRevision = (await h.request("/api/workspace")).revision;
  for (const [title, message] of [[null, /文本/], [12, /文本/], ["a\nb", /单行/], ["a\rb", /单行/], ["a\u0085b", /单行/], ["a\u2028b", /单行/], ["a\u2029b", /单行/], ["a".repeat(201), /200/], ["\ud800", /Unicode/]]) {
    const result = await h.command({ kind: "insight.save", expectedVersion: edited.version, insight: { id: original.id, title, body: "Must not replace body on validation failure." } }, 400);
    assert.equal(result.code, "VALIDATION_FAILED");
    assert.match(result.error, message);
  }
  assert.deepEqual((await h.reference(original.reference)).insight, edited);
  assert.equal((await h.request("/api/workspace")).revision, beforeRevision);
  const boundary = "标".repeat(198) + "😀";
  const maximum = (await h.command({ kind: "insight.save", expectedVersion: edited.version, insight: { id: original.id, title: ` \t${boundary}\t ` } })).insight;
  assert.equal(maximum.title, boundary);
  assert.equal(maximum.title.length, 200);
  const explicitClear = (await h.command({ kind: "insight.save", expectedVersion: maximum.version, insight: { id: original.id, title: "" } })).insight;
  assert.equal(explicitClear.title, "");
  const titleOnly = await h.command({ kind: "insight.save", insight: { type: "note", title: "A title does not substitute for detailed content", body: "", color: "green" } }, 400);
  assert.match(titleOnly.error, /洞见内容/);
});

test("Flow searches independent titles and carries them into reading-history insight summaries", async (t) => {
  const h = await harness(t), startedAt = new Date(Date.now() - 3000).toISOString(), sessionId = randomUUID();
  await h.command({ kind: "reading.session.start", sessionId, documentRevision: 1, startedAt });
  const note = (await h.command({ kind: "insight.save", insight: { type: "note", title: "Gradient Signal", body: "The detailed explanation contains the token orthogonal.", color: "green" } })).insight;
  const endedAt = new Date().toISOString();
  await h.command({ kind: "reading.session.activity", sessionId, sequence: 1, startedAt, endedAt, activeMs: Date.parse(endedAt) - Date.parse(startedAt) });
  const titleMatches = await h.request("/api/flow/insights?query=gradient%20signal&type=note");
  assert.equal(titleMatches.total, 1);
  assert.equal(titleMatches.items[0].id, note.id);
  assert.equal(titleMatches.items[0].title, "Gradient Signal");
  assert.equal((await h.request("/api/flow/insights?query=orthogonal")).items[0].id, note.id);
  const history = await h.request("/api/flow/history?timezone=UTC");
  assert.equal(history.items[0].insights[0].title, "Gradient Signal");
  const renamed = (await h.command({ kind: "insight.save", expectedVersion: note.version, insight: { id: note.id, title: "100% Literal _ proof" } })).insight;
  assert.equal((await h.request("/api/flow/insights?query=gradient")).total, 0);
  assert.equal((await h.request("/api/flow/insights?query=%25")).items[0].title, renamed.title);
  assert.equal((await h.request("/api/flow/insights?query=%25%27")).total, 0);
  assert.equal((await h.request("/api/flow/summary?timezone=UTC")).totals.insightCount, 1);
});

test("MCP exposes the independent title contract and returns titles separately from bounded bodies", async (t) => {
  const h = await harness(t), mcp = await h.connectMcp();
  const tools = (await mcp.client.listTools()).tools;
  const branches = schemaBranches(tools.find((tool) => tool.name === "update_insight").inputSchema.properties.operation);
  const schema = branches.find((branch) => branch.properties.action.const === "create").properties.insight;
  assert.equal(schema.properties.title.type, "string");
  assert.match(schema.properties.title.description, /max 200 UTF-16/);
  assert.equal(schema.required?.includes("title") || false, false);
  assert.ok(tools.find((tool) => tool.name === "resolve_reference").inputSchema.properties.part.enum.includes("title"));
  const title = "Independent title ".repeat(10).trim(), body = "Full detailed body. ".repeat(40);
  const requestId = randomUUID(), input = { type: "note", title: ` ${title} `, body, color: "green", retainedExtension: true };
  const saved = await mcp.call("update_insight", mergedWrite("create", { authorized: true, ...{ document_id: h.document.id, request_id: requestId, insight: input } }));
  assert.equal(saved.insight.title, title);
  assert.equal(saved.insight.body.length, 240);
  assert.equal(saved.insight.bodyTruncated, true);
  const repeated = await h.command({ kind: "insight.save", requestId, insight: input });
  assert.equal(repeated.insight.id, saved.insight.id);
  assert.equal(repeated.insight.version, 1, "MCP title validation must not change the raw command's idempotency hash");
  assert.equal((await h.reference(saved.insight.reference)).insight.retainedExtension, true, "the optional title schema retains existing extensible insight input");
  assert.equal((await mcp.call("query_insights", { state: "active", document_id: h.document.id })).insights[0].title, title);
  const first = await mcp.call("resolve_reference", { reference: saved.insight.reference, part: "title", max_chars: 100 });
  const last = await mcp.call("resolve_reference", first.next);
  assert.equal(first.content.text + last.content.text, title);
  assert.equal(last.next, null);
  assert.equal((await mcp.call("resolve_reference", { reference: saved.insight.reference })).content.text, body);
  const invalid = await mcp.raw("update_insight", mergedWrite("update", { authorized: true, ...{ document_id: h.document.id, request_id: randomUUID(), expected_version: saved.insight.version, insight: { id: saved.insight.id, title: "First\nSecond" } } }));
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid), /单行/);
  const cleared = await mcp.call("update_insight", mergedWrite("update", { authorized: true, ...{ document_id: h.document.id, request_id: randomUUID(), expected_version: saved.insight.version, insight: { id: saved.insight.id, title: "" } } }));
  assert.equal(cleared.insight.title, "");
  assert.equal((await h.reference(saved.insight.reference)).insight.body, body);
  const old = (await h.command({ kind: "insight.save", insight: { type: "note", body: "Original untitled body.", color: "green" } })).insight;
  const oldRead = await mcp.call("resolve_reference", { reference: old.reference, part: "title" });
  assert.equal(oldRead.content.text, "");
  assert.equal(Object.hasOwn(oldRead.insight, "title"), false);
});
