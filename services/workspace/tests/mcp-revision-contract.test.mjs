import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createWorkspaceServer } from "../server.mjs";
import { publishAuthoringFixture } from "./authoring-fixture.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-edit-contract-"));
  const server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false, sync: false });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { document, blockIds } = await publishAuthoringFixture({ base, authoring: {
    format: "reader-authoring-1", key: "edit-contract", meta: { title: "Edit contract", language: "en" },
    blocks: [{ key: "p", type: "para", text: "😀 alpha beta alpha" }, { key: "q", type: "para", text: "untouched" },
      { key: "table", type: "table", head: [["Column"]], rows: [["original"]] }],
  } });
  const client = new Client({ name: "revision-contract", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  t.after(async () => {
    await client.close(); await server.shutdown();
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep + "reader-edit-contract-"));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { client, workspace: server.workspace, document, blockIds,
    call: (args) => client.callTool({ name: "revise_document", arguments: { document_id: document.id,
      authorized: true, expected_revision: 1, request_id: randomUUID(), ...args } }) };
}

test("public operation schemas advertise range fields, typed replacements and exclusive anchors", async (t) => {
  const h = await fixture(t), tool = (await h.client.listTools()).tools.find((item) => item.name === "revise_document");
  const operations = tool.inputSchema.properties.operations.items.anyOf;
  const ranges = operations.filter((item) => item.properties.kind.const === "replace_range");
  assert.ok(ranges.length >= 1);
  for (const range of ranges) {
    for (const name of ["start", "end", "expected_text", "value"]) assert.ok(range.required.includes(name), name);
    assert.equal(range.properties.value.type, "string");
  }
  for (const operation of [
    { kind: "replace_range", block_id: h.blockIds.p, field: "text", start: 3, end: 8, value: "A" },
    { kind: "replace", block_id: h.blockIds.p, field: "text", value: { text: "A" } },
    { kind: "replace", block_id: h.blockIds.table, field: "rows", row: 0, value: "A" },
    { kind: "move", block_id: h.blockIds.p, before_block_id: h.blockIds.q, after_block_id: h.blockIds.q },
    { kind: "insert", block: { type: "para", text: "floating" } },
  ]) assert.equal((await h.call({ operations: [operation] })).isError, true);
  assert.equal(h.workspace.row(h.document.id).current_revision, 1);
});

test("failed batch reports the exact operation and rolls back; retry preserves original receipt", async (t) => {
  const h = await fixture(t), requestId = randomUUID();
  const failed = await h.call({ request_id: requestId, operations: [
    { kind: "replace_range", block_id: h.blockIds.p, field: "text", start: 3, end: 8, expected_text: "alpha", value: "A" },
    { kind: "replace_range", block_id: h.blockIds.q, field: "text", start: 0, end: 3, expected_text: "bad", value: "B" },
  ] });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.code, "TEXT_CONFLICT");
  assert.equal(failed.structuredContent.details.operation_index, 1);
  assert.equal(failed.structuredContent.details.operation_kind, "replace_range");
  assert.deepEqual(failed.structuredContent.details.target, { block_id: h.blockIds.q, field: "text" });
  assert.equal(h.workspace.row(h.document.id).current_revision, 1);
  assert.equal((await h.workspace.revision(h.document.id)).document.blocks[0].text, "😀 alpha beta alpha");

  const nextRequest = randomUUID(), args = { request_id: nextRequest, operations: [
    { kind: "replace_range", block_id: h.blockIds.p, field: "text", start: 3, end: 8, expected_text: "alpha", value: "A" },
    // Sequential offsets refer to the result after the preceding edit.
    { kind: "replace_range", block_id: h.blockIds.p, field: "text", start: 5, end: 9, expected_text: "beta", value: "B" },
  ] };
  const applied = await h.call(args), replay = await h.call(args);
  assert.ok(!applied.isError, JSON.stringify(applied));
  assert.deepEqual(replay.structuredContent, applied.structuredContent);
  assert.equal(h.workspace.row(h.document.id).current_revision, 2);
  const saved = await h.workspace.revision(h.document.id);
  assert.equal(saved.document.blocks[0].text, "😀 A B alpha");
  assert.equal(saved.document.blocks[1].text, "untouched");
  const misuse = await h.call({ ...args, operations: [{ kind: "replace", block_id: h.blockIds.q, field: "text", value: "different" }] });
  assert.equal(misuse.structuredContent.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(h.workspace.row(h.document.id).current_revision, 2);
});
