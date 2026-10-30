import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createWorkspaceServer } from "../server.mjs";
import { createWorkspaceMcp } from "../mcp.mjs";
import { localActor } from "../actor.mjs";
import { publicMcpTools } from "./mcp-input-fixture.mjs";
import { publishAuthoringFixture } from "./authoring-fixture.mjs";

const protocolVersion = "2026-07-28";
async function harness(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "stread-queue-mcp-")), token = "queue-test-auth";
  const server = await createWorkspaceServer({ dataDir, authToken: token, bootstrap: false, glossaryPath: false, staticRoot: false, sync: false });
  const clients = [];
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = "http://127.0.0.1:" + server.address().port, headers = { Authorization: "Bearer " + token };
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await server.shutdown();
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep + "stread-queue-mcp-"));
    await rm(dataDir, { recursive: true, force: true });
  });
  const connect = async ({ modern = false, stdio = false } = {}) => {
    const client = new Client({ name: "queue-test", version: "1" }, modern ? { versionNegotiation: { mode: { pin: protocolVersion } } } : {});
    clients.push(client);
    await client.connect(stdio
      ? new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../stdio.mjs", import.meta.url))], env: { ...process.env, WORKSPACE_URL: base, CONTINUOUS_READER_AUTH_TOKEN: token }, stderr: "pipe" })
      : new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers } }));
    return client;
  };
  const source = async (name = "original.txt") => {
    const response = await fetch(base + "/api/sources?filename=" + name, { method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: "Original content for " + name });
    assert.equal(response.status, 201);
    return response.json();
  };
  const execute = (input) => server.workspace.execute(localActor, { requestId: randomUUID(), ...input });
  const create = async (body = "Convert the whole original and preserve all content.", name) => {
    const uploaded = await source(name);
    const value = await execute({ kind: "queue.create", task: { type: "conversion", sourceId: uploaded.sourceId, title: "Convert source", body } });
    return { task: value.task, source: uploaded };
  };
  return { base, headers, connect, create, execute, workspace: server.workspace, clients };
}
const read = async (client, uri) => {
  const result = await client.readResource({ uri });
  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0].mimeType, "application/json");
  return JSON.parse(result.contents[0].text);
};
const resourceError = (code) => (error) => error.data?.code === code;

test("Queue resources and exact T references work through HTTP and stdio in both protocol eras", { timeout: 20000 }, async (t) => {
  const h = await harness(t), { task, source } = await h.create();
  let catalog;
  for (const stdio of [false, true]) for (const modern of [false, true]) {
    const client = await h.connect({ modern, stdio });
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), publicMcpTools);
    const inputs = tools.map(({ name, inputSchema }) => ({ name, inputSchema }));
    if (catalog) assert.deepEqual(inputs, catalog); else catalog = inputs;
    assert.deepEqual(client.getServerCapabilities().resources, { listChanged: false, subscribe: false });
    assert.ok((await client.listResources()).resources.some((entry) => entry.uri === "stread://queue"));
    const templates = (await client.listResourceTemplates()).resourceTemplates;
    assert.deepEqual(templates.map((entry) => entry.name).sort(), ["queue-list", "queue-task"]);
    const list = await read(client, "stread://queue");
    assert.equal(list.tasks.length, 1);
    assert.equal(list.tasks[0].id, task.id);
    assert.equal(list.tasks[0].reference, task.reference);
    assert.equal(list.tasks[0].status, "pending");
    const detail = await read(client, list.tasks[0].uri);
    assert.equal(detail.documentId, undefined, "conversion precedes its published document");
    assert.equal(detail.content.text, task.body);
    assert.deepEqual(detail.workflow.authoringBinding, { extensions: { "stread.queue": { taskId: task.id, taskVersion: task.version } } });
    assert.deepEqual(detail.workflow.reads[0], { tool: "query_uploaded_sources", arguments: { action: "get", source_id: source.sourceId } });
    const resolved = await client.callTool({ name: "resolve_reference", arguments: { reference: task.reference } });
    assert.ok(!resolved.isError, JSON.stringify(resolved));
    assert.equal(resolved.structuredContent.task.id, task.id);
    assert.equal(resolved.structuredContent.documentId, undefined);
    assert.equal(resolved.structuredContent.content.text, task.body);
    const lower = await client.callTool({ name: "resolve_reference", arguments: { reference: task.reference.toLowerCase() } });
    assert.equal(lower.structuredContent.task.id, task.id);
    assert.equal((await h.workspace.query(localActor, { kind: "queue.task", taskId: task.id })).task.status, "pending", "reads do not claim or execute work");
    await client.close();
  }
});

test("question tasks retain Q identity and complete only after the version-guarded answer is saved", async (t) => {
  const h = await harness(t), client = await h.connect();
  const { document } = await publishAuthoringFixture({ base: h.base, headers: h.headers,
    authoring: { format: "reader-authoring-1", key: "queue-question-fixture", meta: { title: "Question article", language: "en" }, blocks: [{ key: "p", type: "para", text: "A question source." }] } });
  const { insight } = await h.execute({ kind: "insight.save", documentId: document.id,
    insight: { type: "question", color: "blue", body: "Why does this happen?", revision: document.revision } });
  const { task } = await h.execute({ kind: "queue.create", task: { type: "question", documentId: document.id, insightId: insight.id, expectedInsightVersion: insight.version } });
  const original = await read(client, `stread://queue/tasks/${task.id}`);
  assert.equal(original.task.relatedReference, insight.reference);
  assert.equal(original.task.insightVersion, task.insightVersion);
  assert.deepEqual(original.workflow.reads, [{ tool: "resolve_reference", arguments: { reference: insight.reference, document_id: document.id } }]);
  const answer = { document_id: document.id, insight_id: insight.id, expected_version: task.insightVersion,
    authorized: true, answer: { blocks: [{ type: "paragraph", text: "An approved explanation." }] } };
  const cancelled = await h.execute({ kind: "queue.cancel", taskId: task.id, expectedVersion: task.version });
  const stale = await client.callTool({ name: "answer_question", arguments: { ...answer, request_id: randomUUID() } });
  assert.equal(stale.structuredContent.code, "REVISION_CONFLICT");
  const reopened = await h.execute({ kind: "queue.reopen", taskId: task.id, expectedVersion: cancelled.task.version });
  const saved = await client.callTool({ name: "answer_question", arguments: { ...answer, expected_version: reopened.task.insightVersion, request_id: randomUUID() } });
  assert.ok(!saved.isError, JSON.stringify(saved));
  const completed = await read(client, `stread://queue/tasks/${task.id}?part=answer`);
  assert.equal(completed.task.status, "completed"); assert.equal(completed.task.result.insightId, insight.id);
  assert.equal(completed.content.text, "", "the answer is not duplicated under the T identity");
  const linked = await client.callTool({ name: "resolve_reference", arguments: { reference: insight.reference, part: "answer" } });
  assert.equal(linked.structuredContent.content.text, "An approved explanation.");
});

test("resource and T text continuations are bounded, Unicode-safe, and reject stale versions", async (t) => {
  const h = await harness(t), body = "A😀汉字 ".repeat(1600), { task } = await h.create(body);
  const client = await h.connect();
  let uri = `stread://queue/tasks/${encodeURIComponent(task.reference)}?max_chars=101`, text = "", reads = 0;
  do {
    const detail = await read(client, uri);
    assert.ok(detail.content.text.length <= 101);
    assert.ok(detail.content.text.isWellFormed());
    text += detail.content.text; uri = detail.next;
    assert.ok(++reads < 120);
  } while (uri);
  assert.equal(text, task.body);
  const first = await read(client, `stread://queue/tasks/${task.id}?max_chars=100`);
  const firstTool = await client.callTool({ name: "resolve_reference", arguments: { reference: task.reference, max_chars: 100 } });
  assert.ok(firstTool.structuredContent.next);
  await assert.rejects(read(client, `stread://queue/tasks/${task.id}?offset=100`), resourceError("VERSION_REQUIRED"));
  await assert.rejects(read(client, `stread://queue/tasks/${task.id}?max_chars=6001`), resourceError("VALIDATION_FAILED"));
  const edited = await h.execute({ kind: "queue.update", taskId: task.id, expectedVersion: task.version, patch: { body: "Updated instruction" } });
  assert.equal(edited.task.reference, task.reference);
  await assert.rejects(read(client, first.next), resourceError("REVISION_CONFLICT"));
  const stale = await client.callTool({ name: "resolve_reference", arguments: firstTool.structuredContent.next });
  assert.equal(stale.structuredContent.code, "REVISION_CONFLICT");
  assert.equal(stale.structuredContent.recovery.next.reference, task.reference);
});

test("resource list pagination retains filters and fails on changed queues", async (t) => {
  const h = await harness(t);
  const one = await h.create("First conversion", "one.txt"), two = await h.create("Second conversion", "two.txt"), three = await h.create("Third conversion", "three.txt");
  const client = await h.connect();
  const first = await read(client, "stread://queue/list?type=conversion&status=pending&limit=1");
  assert.equal(first.page.total, 3); assert.equal(first.tasks.length, 1);
  const next = new URL(first.next);
  assert.equal(next.searchParams.get("type"), "conversion");
  assert.equal(next.searchParams.get("revision"), String(first.revision));
  const second = await read(client, first.next);
  assert.notEqual(second.tasks[0].id, first.tasks[0].id);
  assert.equal(second.revision, first.revision);
  await assert.rejects(read(client, "stread://queue/list?offset=1"), resourceError("VERSION_REQUIRED"));
  await assert.rejects(read(client, "stread://queue/list?limit=21"), resourceError("VALIDATION_FAILED"));
  await assert.rejects(read(client, "stread://queue/list?type=not-a-type"), resourceError("VALIDATION_FAILED"));
  await h.execute({ kind: "queue.cancel", taskId: one.task.id, expectedVersion: one.task.version });
  await assert.rejects(read(client, first.next), resourceError("LIST_CHANGED"));
  const filtered = await read(client, "stread://queue/list?status=cancelled&query=" + encodeURIComponent(one.task.reference));
  assert.deepEqual(filtered.tasks.map((task) => task.id), [one.task.id]);
  assert.equal((await read(client, "stread://queue")).page.total, 2);
  assert.ok(two.task.id && three.task.id);
});

test("task reads keep authentication and issue only scoped original-file capabilities", async (t) => {
  const h = await harness(t), { task } = await h.create();
  const denied = await fetch(h.base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "stread://queue" } }) });
  assert.equal(denied.status, 401);
  const client = await h.connect(), detail = await read(client, `stread://queue/tasks/${task.id}`);
  const sourceUrl = new URL(detail.uploadedSource.url);
  assert.ok(sourceUrl.search, "file access is decorated through the existing capability issuer");
  assert.equal((await fetch(sourceUrl)).status, 200);
  sourceUrl.search = "";
  assert.equal((await fetch(sourceUrl)).status, 401);
  const badDocument = await client.callTool({ name: "resolve_reference", arguments: { reference: task.reference, document_id: "different-document" } });
  assert.equal(badDocument.structuredContent.code, "NOT_FOUND");
  const scoped = createWorkspaceMcp(h.workspace, { ...localActor, scopes: [] }, { baseUrl: h.base });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const restricted = new Client({ name: "restricted-queue-test", version: "1" });
  h.clients.push(restricted); t.after(() => scoped.close());
  await Promise.all([scoped.connect(serverTransport), restricted.connect(clientTransport)]);
  await assert.rejects(read(restricted, "stread://queue"), resourceError("FORBIDDEN"));
  await assert.rejects(read(restricted, `stread://queue/tasks/${task.id}`), resourceError("FORBIDDEN"));
});

test("linked R work keeps its identity and completes through the existing revision tool", async (t) => {
  const h = await harness(t), client = await h.connect();
  const { document, blockIds } = await publishAuthoringFixture({ base: h.base, headers: h.headers,
    authoring: { format: "reader-authoring-1", key: "queue-mcp-fixture", meta: { title: "Queue article", language: "en" }, blocks: [{ key: "p", type: "para", text: "Old wording." }] } });
  const created = await h.execute({ kind: "queue.create", task: { type: "correction", documentId: document.id, body: "Use the corrected wording." } });
  const detail = await read(client, `stread://queue/tasks/${created.task.id}`);
  assert.match(detail.task.relatedReference, /^#R\d{5,}$/);
  const linked = await client.callTool({ name: "resolve_reference", arguments: { reference: detail.task.relatedReference } });
  assert.equal(linked.structuredContent.changeRequest.id, detail.task.changeRequestId);
  const applied = await client.callTool({ name: "revise_document", arguments: { document_id: document.id, expected_revision: document.revision,
    request_id: randomUUID(), authorized: true, change_request_id: detail.task.changeRequestId, expected_change_request_version: linked.structuredContent.changeRequest.version,
    operations: [{ kind: "replace", block_id: blockIds.p, field: "text", value: "Corrected wording." }] } });
  assert.ok(!applied.isError, JSON.stringify(applied));
  const completed = await read(client, `stread://queue/tasks/${created.task.id}`);
  assert.equal(completed.task.reference, created.task.reference);
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.task.result.kind, "revision");
  assert.equal(completed.task.result.revision, applied.structuredContent.document.revision);
  assert.equal((await read(client, "stread://queue")).page.total, 0);
});
