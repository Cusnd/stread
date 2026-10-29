import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { GlossaryStore } from "../store.mjs";
import { createHttpServer } from "../server.mjs";

const sample = { term: "配分函数", aliases: ["partition function", "Z(x)"], definition: "对固定提示下的所有候选回答求和，使策略概率归一化。", documentId: "dpo", documentTitle: "直接偏好优化" };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "reader-glossary-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "glossary.json");
  return { path, store: new GlossaryStore(path) };
}

test("saved entries survive a new store and search aliases with source metadata", async (t) => {
  const { store, path } = await fixture(t);
  const { entry } = await store.create(sample);
  const reopened = new GlossaryStore(path);
  assert.deepEqual(await reopened.get(entry.id), entry);
  assert.equal((await reopened.list({ query: "PARTITION" })).entries[0].id, entry.id);
  assert.equal((await reopened.list({ documentId: "other" })).total, 0);
  assert.equal(entry.origin, "user");
  assert.equal(entry.revision, 1);
});

test("queued writes retain every entry and reject stale edits without data loss", async (t) => {
  const { store } = await fixture(t);
  const entries = await Promise.all(Array.from({ length: 16 }, (_, index) => store.create({ ...sample, term: "并发术语" + index })));
  assert.equal((await store.list()).total, 16);
  assert.equal((await store.list()).revision, 16);
  const original = entries[0].entry;
  const updated = await store.update(original.id, { ...sample, term: original.term, definition: "已更新", expectedRevision: original.revision });
  await assert.rejects(store.update(original.id, { ...sample, expectedRevision: original.revision }), { status: 409 });
  assert.equal((await store.get(original.id)).definition, "已更新");
  const removed = await store.remove(original.id, updated.entry.revision);
  await assert.rejects(store.get(original.id), { status: 404 });
  const restored = await store.restore(original.id, removed.entry.revision);
  assert.equal(restored.entry.id, original.id);
  assert.equal(restored.entry.definition, "已更新");
  assert.equal((await store.list()).total, 16);
});

test("duplicates, invalid fields and corrupted storage never silently replace data", async (t) => {
  const { store, path } = await fixture(t);
  await store.create({ ...sample, term: "DPO" });
  await assert.rejects(store.create({ ...sample, term: "ｄｐｏ" }), { status: 409 });
  assert.throws(() => store.create({ ...sample, definition: "" }), { status: 400 });
  assert.throws(() => store.create({ ...sample, aliases: Array(9).fill("a") }), { status: 400 });
  await writeFile(path, "broken storage", "utf8");
  await assert.rejects(store.create(sample));
  assert.equal(await readFile(path, "utf8"), "broken storage");
});

test("browser API writes can be read through real HTTP and stdio MCP clients", async (t) => {
  const { store, path } = await fixture(t);
  const http = createHttpServer(store);
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { http.closeAllConnections(); http.close(resolve); }));
  const url = `http://127.0.0.1:${http.address().port}`;
  const response = await fetch(url + "/api/glossary", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:4173" }, body: JSON.stringify(sample) });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:4173");
  const { entry } = await response.json();
  const client = new Client({ name: "glossary-http-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
  t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 3);
  assert.ok(tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  const listed = await client.callTool({ name: "list_glossary", arguments: {} });
  assert.equal(listed.structuredContent.entries[0].id, entry.id);
  const searched = await client.callTool({ name: "search_glossary", arguments: { query: "Z(x)" } });
  assert.equal(searched.structuredContent.entries[0].definition, sample.definition);
  const detail = await client.callTool({ name: "get_glossary_term", arguments: { id: entry.id } });
  assert.deepEqual(detail.structuredContent.entry, entry);
  assert.equal((await client.callTool({ name: "get_glossary_term", arguments: { id: "bad-id" } })).isError, true);
  const stdio = new Client({ name: "glossary-stdio-test", version: "1.0.0" });
  await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../stdio.mjs", import.meta.url))], env: { ...process.env, CONTINUOUS_READER_GLOSSARY_DATA: path } }));
  t.after(() => stdio.close());
  assert.deepEqual((await stdio.callTool({ name: "get_glossary_term", arguments: { id: entry.id } })).structuredContent.entry, entry);
  assert.equal((await fetch(url + "/api/glossary", { headers: { Origin: "https://untrusted.example" } })).status, 403);
  assert.equal((await fetch(url + "/api/glossary", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await fetch(url + "/api/glossary", { method: "POST", headers: { "Content-Type": "application/json" }, body: "broken" })).status, 400);
});
