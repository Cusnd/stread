import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createWorkspaceServer } from "../server.mjs";
import { publicMcpTools, removedMcpTools, schemaBranches } from "./mcp-input-fixture.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-mcp-catalog-"));
  const server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false, sync: false });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const client = new Client({ name: "catalog-contract-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + server.address().port + "/mcp")));
  t.after(async () => {
    await client.close(); await server.shutdown();
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep + "reader-mcp-catalog-"));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { client, workspace: server.workspace, call: (name, args = {}) => client.callTool({ name, arguments: args }) };
}

test("the real MCP catalog has exactly 32 public tools and removed names are protocol errors", async (t) => {
  const h = await fixture(t), tools = (await h.client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), publicMcpTools);
  for (const name of removedMcpTools) {
    assert.ok(!tools.some((tool) => tool.name === name), name);
    await assert.rejects(h.call(name), (error) => error.code === -32602 && /not found|unknown|not registered/i.test(error.message), name);
  }
  assert.equal(h.workspace.snapshot({}).documents.length, 0);
});

test("published branch schemas keep authorization separate and make operation-specific requirements inspectable", async (t) => {
  const h = await fixture(t), byName = Object.fromEntries((await h.client.listTools()).tools.map((tool) => [tool.name, tool]));
  const writes = {
    update_document: { metadata: ["document_id", "expected_version", "patch"], archive: ["document_id", "expected_version"], restore: ["document_id", "expected_version"] },
    update_collection: { create: ["label"], update: ["collection_id", "expected_version", "patch"], remove: ["collection_id", "expected_version"] },
    update_insight: { create: ["document_id", "insight"], update: ["document_id", "expected_version", "insight"], archive: ["document_id", "insight_id", "expected_version"], restore: ["document_id", "insight_id", "expected_version"] },
    update_reading_plan: { add: ["document_id", "expected_plan_version"], remove: ["document_id", "expected_plan_version"], move: ["document_id", "expected_plan_version", "direction"] },
    update_change_request: { create: ["document_id", "body"], update: ["document_id", "change_request_id", "expected_version", "patch"], cancel: ["document_id", "change_request_id", "expected_version"], reopen: ["document_id", "change_request_id", "expected_version"] },
    update_glossary: { create: ["term", "definition"], update: ["id", "expected_revision", "patch"], remove: ["id", "expected_revision"], restore: ["id", "expected_revision"] },
  };
  for (const [name, actions] of Object.entries(writes)) {
    const schema = byName[name].inputSchema;
    assert.equal(schema.additionalProperties, false, name);
    assert.deepEqual([...schema.required].sort(), ["authorized", "operation", "request_id"]);
    assert.equal(schema.properties.authorized.const, true, name);
    const branches = schemaBranches(schema.properties.operation);
    assert.deepEqual(branches.map((branch) => branch.properties.action.const).sort(), Object.keys(actions).sort(), name);
    for (const branch of branches) {
      const action = branch.properties.action.const;
      assert.equal(branch.additionalProperties, false, name + "." + action);
      for (const field of ["action", ...actions[action]]) assert.ok(branch.required.includes(field), name + "." + action + "." + field);
      assert.equal(branch.properties.authorized, undefined); assert.equal(branch.properties.request_id, undefined);
    }
    const invalid = await h.call(name, { authorized: true, request_id: randomUUID(), operation: { action: "not-an-action" } });
    assert.equal(invalid.isError, true, name);
  }
  for (const [name, discriminator, actions] of [
    ["query_documents", "action", ["list", "search", "metadata"]], ["read_resources", "kind", ["asset", "pdf_pages", "authoring_artifacts"]],
    ["query_reading_activity", "view", ["summary", "history"]], ["query_glossary", "action", ["list", "search", "get"]],
    ["query_uploaded_sources", "action", ["list", "get"]], ["inspect_authoring_preview", "target", ["preview", "draft"]],
  ]) {
    const branches = schemaBranches(byName[name].inputSchema);
    assert.deepEqual(branches.map((branch) => branch.properties[discriminator].const).sort(), actions.sort(), name);
    for (const branch of branches) { assert.equal(branch.additionalProperties, false, name); assert.ok(branch.required.includes(discriminator), name); }
    assert.equal((await h.call(name, { [discriminator]: "unknown" })).isError, true, name);
  }
  assert.deepEqual(byName.query_insights.inputSchema.properties.state.enum, ["active", "archived", "all"]);
});

test("retained tool names reject their old flat write payload and mixed read/write branches", async (t) => {
  const h = await fixture(t);
  for (const [name, args] of [
    ["update_collection", { authorized: true, request_id: randomUUID(), collection_id: "collection-a", expected_version: 1, patch: { label: "Flat" } }],
    ["update_change_request", { authorized: true, request_id: randomUUID(), document_id: "document-a", change_request_id: "request-a", expected_version: 1, patch: { body: "Flat" } }],
    ["update_collection", { authorized: true, request_id: randomUUID(), operation: { action: "create", label: "Mixed", collection_id: "collection-a" } }],
    ["update_insight", { authorized: true, request_id: randomUUID(), operation: { action: "update", document_id: "document-a", insight: { id: "insight-a", body: "Missing expected version" } } }],
    ["update_insight", { authorized: true, request_id: randomUUID(), operation: { action: "create", document_id: "document-a", insight: { id: "existing-id", type: "note", body: "No identity injection", color: "green" } } }],
    ["query_documents", { action: "metadata", query: "mixed", document_id: "document-a" }],
    ["read_resources", { kind: "asset", document_id: "document-a", path: "source.pdf", offset: 2 }],
    ["inspect_authoring_preview", { target: "draft", draft_id: "draft-a", preview_id: "preview-a" }],
    ["query_insights", { state: "archived", include_archived: true }],
  ]) assert.equal((await h.call(name, args)).isError, true, name + " rejects its invalid branch");
  assert.deepEqual((await h.call("list_collections")).structuredContent.collections, []);
});
