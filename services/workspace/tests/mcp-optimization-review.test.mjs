import test from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createWorkspaceMcp } from "../mcp.mjs";
import { createFileCapabilities, createMcpFileAccess } from "../file-capabilities.mjs";
import { validateDocument, applyOperations } from "../documents.mjs";
import { readDocumentProjection, readingResponseBytes, MAX_READING_RESPONSE_BYTES } from "../mcp-reading.mjs";
import { revisionOperation } from "../mcp-revision-schemas.mjs";

const document = (blocks) => ({ format: "continous-reader", schema: 2, id: "optimization-review", revision: 1, meta: { title: "Independent boundary fixture", language: "en" }, blocks });
const workspace = (saved) => ({ authorize() {}, revision: async () => saved, row: () => ({ current_revision: saved.document.revision }) });

test("read_context stays below its advertised wire budget after real file URL decoration", async (t) => {
  const baseUrl = "http://127.0.0.1:4177";
  // Legacy validation retains unknown fields. A paragraph's extension value
  // must not be treated as the validated boolean 'ordered' of a list.
  const saved = await validateDocument(document([{ id: "p", type: "para", text: "文".repeat(6000),
    ordered: Array.from({ length: 130 }, (_, i) => ({ url: baseUrl + "/api/sources/file-" + i + "/original" })),
  }]));
  const fileAccess = createMcpFileAccess({ capabilities: await createFileCapabilities(), baseUrl });
  const raw = await readDocumentProjection(workspace(saved), { view: "content", document_id: saved.document.id, max_chars: 6000 });
  assert.ok(readingResponseBytes(raw) <= MAX_READING_RESPONSE_BYTES);
  assert.equal(raw.spans[0].ordered, undefined, "unvalidated paragraph extension metadata is not projected as list semantics");
  assert.equal(raw.text, "文".repeat(6000));
  assert.equal(raw.metadataIncluded, false); assert.equal(raw.contentScope, "blocks");
  assert.equal(raw.coverage.metadataIncluded, false); assert.equal(raw.coverage.contentScope, "blocks");
  const server = createWorkspaceMcp(workspace(saved), undefined, { baseUrl, fileAccess });
  const client = new Client({ name: "independent-boundary-review", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  t.after(async () => { await client.close(); await server.close(); });
  const response = await client.callTool({ name: "read_context", arguments: { view: "content", document_id: saved.document.id, max_chars: 6000 } });
  assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") <= MAX_READING_RESPONSE_BYTES, "the final successful MCP envelope must respect its advertised wire ceiling");
  assert.equal(response.isError, undefined);
});

test("registrar rejects delivery-time enlargement and body coverage explicitly excludes metadata", async (t) => {
  const saved = await validateDocument(document([{ id: "p", type: "para", text: "body" }]));
  const out = await readDocumentProjection(workspace(saved), { view: "outline", document_id: saved.document.id });
  assert.equal(out.metadataIncluded, false); assert.equal(out.coverage.metadataIncluded, false);
  assert.equal(out.contentScope, "blocks"); assert.equal(out.coverage.contentScope, "blocks");
  const server = createWorkspaceMcp(workspace(saved), undefined, { fileAccess: { decorate: async (value) => ({ ...value, deliveryMetadata: "x".repeat(MAX_READING_RESPONSE_BYTES) }) } });
  const client = new Client({ name: "delivery-boundary-review", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
  t.after(async () => { await client.close(); await server.close(); });
  for (const view of ["outline", "content"]) {
    const response = await client.callTool({ name: "read_context", arguments: { view, document_id: saved.document.id } });
    assert.equal(response.isError, true); assert.equal(response.structuredContent.code, "READING_LIMIT");
    assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") <= MAX_READING_RESPONSE_BYTES);
  }
});

test("explicit revision schemas retain valid metadata, text, empty-cell and complete-matrix replacements", async () => {
  const original = document([{ id: "p", type: "para", text: "😀 alpha" }, { id: "t", type: "table", head: [["A", "B"]], rows: [["1", "2"]] }]);
  await validateDocument(original);
  const wire = [
    { kind: "replace", block_id: "$meta", field: "title", value: "Changed title" },
    { kind: "replace_range", block_id: "p", field: "text", start: 0, end: 2, expected_text: "😀", value: "" },
    { kind: "replace", block_id: "t", field: "rows", row: 0, column: 1, value: "" },
    { kind: "replace", block_id: "t", field: "head", value: [["X", "Y"]] },
  ];
  const camel = { block_id: "blockId", expected_text: "expectedText" };
  const operations = wire.map((input) => Object.fromEntries(Object.entries(revisionOperation.parse(input)).map(([key, value]) => [camel[key] || key, value])));
  const changed = await applyOperations(original, operations);
  await validateDocument(changed.document);
  assert.equal(changed.document.meta.title, "Changed title");
  assert.equal(changed.document.blocks[0].text, " alpha");
  assert.deepEqual(changed.document.blocks[1].rows, [["1", ""]]);
  assert.deepEqual(changed.document.blocks[1].head, [["X", "Y"]]);
  assert.equal(original.blocks[0].text, "😀 alpha", "the batch never mutates its baseline");
  await assert.rejects(applyOperations(original, [{ kind: "replace_range", blockId: "p", field: "text", start: 1, end: 2, expectedText: "\ude00", value: "x" }]), (error) => error.code === "VALIDATION_FAILED" && error.details.operation_index === 0 && error.details.target.block_id === "p");
});
