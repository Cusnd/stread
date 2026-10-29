import test from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createWorkspaceMcp } from "../mcp.mjs";
import { createToolRegistrar } from "../mcp-tool-contract.mjs";
import { beginListRead } from "../mcp-continuations.mjs";
import { representationTag } from "../http-representation.mjs";
import { handleWorkspaceApi } from "../api-router.mjs";
import { validateDocument } from "../documents.mjs";
import { canonical, hash } from "../errors.mjs";

const actor = { workspaceId: "local", subjectId: "reader", scopes: ["read", "write"] };
const later = async value => { await Promise.resolve(); return value; };

test("list guards await both business reads and preserve the existing continuation bytes", async () => {
  const state = [{ id: "a", label: "A", parent_id: null, version: 1 }];
  const workspace = { readListVersionState: async (name) => { assert.equal(name, "list_collections"); return later(state); } };
  const input = { offset: 0, limit: 1 };
  const guard = await beginListRead("list_collections", workspace, actor, input);
  const result = await guard.finish({ collections: [{ id: "a" }], page: { offset: 0, count: 1, total: 2, nextOffset: 1 } });
  const scope = hash(canonical({ tool: "list_collections", actor, filters: { limit: 1 } }));
  const version = hash(canonical(state));
  assert.equal(result.next.continuation, Buffer.from(JSON.stringify({ v: 1, scope, version, offset: 1 })).toString("base64url"));
  assert.deepEqual(result.consistency, { mode: "fresh_range", snapshot: version });
  const continued = await beginListRead("list_collections", workspace, actor, result.next);
  state[0].version++;
  await assert.rejects(continued.finish({}), error => error.code === "LIST_CHANGED");
});

test("the registrar awaits a changed-list guard before decorating or returning results", async () => {
  let callback, version = 1, decorated = false;
  const calls = [];
  const workspace = {
    authorize() { calls.push("authorize"); },
    async readListVersionState() { calls.push("version:" + version); return later({ version }); },
    get db() { throw new Error("MCP must not access a database driver"); },
  };
  const register = createToolRegistrar({ registerTool(_name, _options, handler) { callback = handler; } }, workspace, actor, {
    fileAccess: { decorate: async value => { decorated = true; return value; } },
  });
  register("list_collections", "test", z.object({ offset: z.number(), limit: z.number() }), async () => {
    calls.push("handler"); version++;
    return { collections: [{ id: "a" }], page: { offset: 0, count: 1, total: 1, nextOffset: null } };
  });
  const result = await callback({ offset: 0, limit: 1 });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "LIST_CHANGED");
  assert.deepEqual(calls, ["authorize", "version:1", "handler", "version:2"]);
  assert.equal(decorated, false);
});

test("real MCP transport resolves async documents, source descriptors, plans and reading heads", async t => {
  const document = { format: "continous-reader", schema: 2, id: "article", revision: 3,
    meta: { title: "Async article", language: "en" }, blocks: [{ id: "p", type: "para", text: "Measured source text." }] };
  const saved = await validateDocument(document);
  const documentReads = [];
  const records = ["first", "article", "last"].map(id => ({ id, title: id, version: 2, revision: 3, tags: [], collectionIds: [], readingState: null }));
  const source = { sourceId: "source", filename: "source.pdf", sha256: "a".repeat(64), size: 12, mediaType: "application/pdf", url: "/api/sources/source/original" };
  const workspace = {
    authorize() {},
    get db() { throw new Error("MCP must not access a database driver"); },
    readListVersionState: async () => later({ workspace: 7 }),
    row: async () => later({ current_revision: 3 }),
    revision: async () => later(saved),
    revisionIndex: async () => later(saved.index),
    documentSummaries: async ({ documentId } = {}) => {
      documentReads.push(documentId); return later(documentId ? records.filter(record => record.id === documentId) : records);
    },
    query: async (_actor, input) => {
      assert.equal(input.kind, "reading_plan");
      return later({ planIds: records.map(record => record.id), planVersion: 4, currentId: "article", workspaceRevision: 7 });
    },
    uploadedSource: async () => later(source),
    uploadedSources: async () => later({ sources: [source], page: { offset: 0, count: 1, total: 1, nextOffset: null } }),
    getAuthoringContract: async () => later({ source, documentation: [], routes: { validate: "/api/authoring/validate" } }),
    resource: async (_actor, input) => { assert.equal(input.revision, 3); return later(source); },
  };
  const server = createWorkspaceMcp(workspace, actor, { baseUrl: "https://reader.example" });
  const client = new Client({ name: "async-read-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    return result.structuredContent;
  };
  const plan = await call("get_reading_plan", { offset: 1, limit: 1 });
  assert.deepEqual(documentReads, ["article"], "the plan only loads its requested page");
  assert.deepEqual(plan.documents.map(row => [row.id, row.planIndex]), [["article", 1]]);
  assert.deepEqual(plan.page, { offset: 1, count: 1, total: 3, nextOffset: 2 });
  assert.equal((await call("query_documents", { action: "metadata", document_id: "article", part: "title" })).content.text, "article");
  assert.equal((await call("query_uploaded_sources", { action: "get", source_id: "source" })).url, "https://reader.example/api/sources/source/original");
  assert.equal((await call("query_uploaded_sources", { action: "list" })).sources[0].sourceId, "source");
  assert.equal((await call("get_authoring_contract", { source_id: "source" })).source.sourceId, "source");
  assert.equal((await call("read_resources", { kind: "asset", document_id: "article", path: "source.pdf" })).revision, 3);
  const exact = await call("read_context", { document_id: "article", block_id: "p", before_chars: 0 });
  assert.equal(exact.currentRevision, 3); assert.equal(exact.segments[0].text, "Measured source text.");
  const continuous = await call("read_context", { view: "content", document_id: "article" });
  assert.equal(continuous.currentRevision, 3); assert.ok(continuous.text.includes("Measured source text."));
  const search = await call("query_documents", { action: "search", document_id: "article", query: "Measured" });
  assert.equal(search.matches[0].address.blockId, "p");
});

test("HTTP validators and file descriptors await their business reads", async () => {
  let version = 2;
  const workspace = {
    authorize() {}, meta: async () => later(version),
    draft: async () => later({ id: "draft", currentPreviewId: "preview", version }),
    previewRow: async () => later({ payload: "fixed-candidate", published_document_id: null }),
    flow: { now: () => new Date("2026-01-02T12:00:00Z"), getRevision: async () => later(4) },
    uploadedSource: async () => later({ sourceId: "source", filename: "original.pdf" }),
    uploadedSourceResource: async () => later({ sha256: "a".repeat(64), size: 12 }),
  };
  const url = new URL("https://reader.example/api/authoring/drafts/draft");
  const first = await representationTag(workspace, actor, url); version++;
  assert.notEqual(await representationTag(workspace, actor, url), first);
  const response = await handleWorkspaceApi(new Request("https://reader.example/api/sources/source"), { workspace, actor });
  assert.deepEqual(await response.json(), { sourceId: "source", filename: "original.pdf" });
  const original = await handleWorkspaceApi(new Request("https://reader.example/api/sources/source/original"), { workspace, actor,
    fileResponse: (_request, resource) => { assert.equal(resource.size, 12); return new Response("bytes"); } });
  assert.equal(await original.text(), "bytes");
});
