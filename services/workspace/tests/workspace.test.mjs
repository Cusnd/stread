import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceServer } from "../server.mjs";
import { runPdf } from "../resources.mjs";
import { hash } from "../errors.mjs";
import { MCP_INSTRUCTIONS } from "../mcp-views.mjs";
import { publishAuthoringFixture } from "./authoring-fixture.mjs";
import { createProtocolReviewEvidence } from "./authoring-protocol-evidence-fixture.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function harness(t, options = {}) {
  const dataDir = options.dataDir || await mkdtemp(join(tmpdir(), "reader-workspace-test-"));
  const server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false, ...options });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = "GET", body, headers = {}, status = 200 } = {}) => {
    const response = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers } });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const command = (body, status) => request("/api/commands", { method: "POST", body: { requestId: randomUUID(), ...body }, status });
  t.after(async () => { await server.shutdown(); if (!options.dataDir) await rm(dataDir, { recursive: true, force: true }); });
  return { server, workspace: server.workspace, base, request, command, dataDir, headers: options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {} };
}
function documentFixture(key = "doc-test-" + randomUUID()) {
  return { format: "reader-authoring-1", key, extensions: { "test.retained": { value: true } }, meta: { title: "Test material", language: "en" }, blocks: [
    { key: "heading", type: "heading", level: 1, text: "First heading" },
    { key: "paragraph", type: "para", text: "Alpha beta gamma.", extensions: { "test.values": [1, 2] } },
    { key: "list", type: "list", ordered: false, items: [{ key: "item-one", text: "A stable item" }] },
    { key: "table", type: "table", head: [["Name", "Value"]], rows: [["One", "1"], ["Blank", ""]] },
  ] };
}
async function uploadBytes(h, bytes, filename, mediaType = "application/json") {
  const uploaded = await fetch(h.base + "/api/sources?filename=" + encodeURIComponent(filename), { method: "POST", headers: { ...h.headers, "Content-Type": mediaType }, body: bytes });
  assert.equal(uploaded.status, 201); return uploaded.json();
}
async function publishAuthoring(h, input, resources = {}) {
  const { publication, blockIds: ids } = await publishAuthoringFixture({ base: h.base, headers: h.headers, authoring: input, resources });
  const envelope = await h.request("/api/documents/" + publication.document.id, { headers: h.headers });
  return { publication, envelope, ids };
}
const protocolEvidence = (h, preview) => createProtocolReviewEvidence({ preview,
  readReport: current => h.request(`/api/authoring/previews/${current.id}/artifacts/report.json`, { headers: h.headers }),
  upload: (bytes, filename, mediaType) => uploadBytes(h, bytes, filename, mediaType) });
async function publishPreviewFixture(h, input, resources = {}) {
  const authoringBytes = Buffer.from(JSON.stringify(input)), file = await uploadBytes(h, authoringBytes, "authoring.json");
  const submission = { authoringSourceId: file.sourceId, resources, requestId: randomUUID() };
  const { preview } = await h.request("/api/authoring/previews", { method: "POST", headers: h.headers, body: submission, status: 201 });
  const { review } = await protocolEvidence(h, preview);
  const publicationInput = { previewId: preview.id, expectedHash: preview.hash, requestId: randomUUID(), review };
  const publication = await h.request("/api/authoring/previews/publish", { method: "POST", headers: h.headers, body: publicationInput, status: 201 });
  const envelope = await h.request("/api/documents/" + publication.document.id, { headers: h.headers });
  const ids = Object.fromEntries(input.blocks.map((block, index) => [block.key, envelope.document.blocks[index].id]));
  return { authoringFile: file, authoringBytes, preview, publication, publicationInput, envelope, ids };
}
async function importBytes(h, bytes, filename, mediaType = "application/json", authoredInput, publish = publishAuthoring) {
  const file = await uploadBytes(h, bytes, filename, mediaType), sourcePath = "source" + (filename.match(/\.[^.]+$/)?.[0] || ".bin");
  const input = { ...(authoredInput || JSON.parse(bytes.toString("utf8"))), source: { path: sourcePath, media_type: mediaType, sha256: file.sha256 } };
  return { file, ...await publish(h, input, { [sourcePath]: file.sourceId }) };
}
async function importDocument(h, input = documentFixture(), publish = publishAuthoring) { return importBytes(h, Buffer.from(JSON.stringify(input)), "material.json", "application/json", undefined, publish); }
// Simulate an older stored document in this test's isolated database. New authoring
// remains strict; lossless reads and revisions must still retain historical extras.
async function addHistoricalFields(h, envelope) {
  const document = structuredClone(envelope.document);
  document.custom = { retained: true }; document.meta.customMeta = "keep"; document.blocks[1].customBlock = [1, 2];
  const db = new DatabaseSync(join(h.dataDir, "workspace.sqlite"));
  try { db.prepare("UPDATE revisions SET content=? WHERE document_id=? AND revision=?").run(JSON.stringify(document), document.id, document.revision); }
  finally { db.close(); }
  return h.request("/api/documents/" + document.id);
}

test("formal publication retains exact source bytes and reads older unknown fields losslessly", async (t) => {
  const h = await harness(t), input = documentFixture(), bytes = Buffer.from(JSON.stringify(input, null, 2));
  const imported = await importBytes(h, bytes, "material.json"), documentId = imported.envelope.document.id;
  assert.equal(imported.file.sha256, hash(bytes)); assert.equal(imported.envelope.document.source.sha256, hash(bytes));
  assert.deepEqual(imported.envelope.document.extensions["test.retained"], input.extensions["test.retained"]);
  assert.equal(imported.envelope.document.blocks[1].text, input.blocks[1].text);
  const expected = (await addHistoricalFields(h, imported.envelope)).document;
  assert.deepEqual(expected.custom, { retained: true }); assert.equal(expected.meta.customMeta, "keep"); assert.deepEqual(expected.blocks[1].customBlock, [1, 2]);
  const raw = await fetch(h.base + imported.envelope.assetBase + "source.json");
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), bytes); assert.match(raw.headers.get("content-disposition"), /^attachment;/); assert.equal(raw.headers.get("x-content-type-options"), "nosniff"); assert.match(raw.headers.get("content-security-policy"), /sandbox/);
  const cached = await fetch(h.base + imported.envelope.assetBase + "source.json", { headers: { "If-None-Match": raw.headers.get("etag") } }); assert.equal(cached.status, 304);
  assert.deepEqual(await h.request(`/api/documents/${documentId}/export`), expected);
  await h.request("/api/documents/missing", { status: 404 });
  await h.request(`/api/documents/${documentId}/assets/%2e%2e%2fsecret`, { status: 403 });
  await h.request(`/api/documents/${documentId}?revision=-1`, { status: 400 });
  await h.command({ unexpected: "missing command type" }, 400);
  await h.request("/api/workspace", { headers: { Origin: "https://untrusted.invalid" }, status: 403 });
});

test("concurrent insights allocate unique references, retries precede version checks, answers are atomic", async (t) => {
  const h = await harness(t), { envelope, ids } = await importDocument(h), documentId = envelope.document.id;
  const created = await Promise.all(Array.from({ length: 12 }, (_, n) => h.command({ kind: "insight.save", documentId, insight: { type: "question", body: "Question " + n, color: "sky", customNote: { n } } })));
  assert.equal(new Set(created.map((r) => r.insight.reference)).size, 12);
  let insight = created[0].insight; assert.equal(insight.version, 1); assert.equal(insight.revision, 1);
  const requestId = randomUUID(), update = { requestId, kind: "insight.save", documentId, expectedVersion: 1, insight: { id: insight.id, body: "Edited question", archivedAt: "forged", createdAt: "forged", updatedAt: "forged", resolvedAt: "forged", answerAuthorization: { subjectId: "forged" } } };
  const first = await h.command(update), replay = await h.command(update); assert.deepEqual(first, replay); assert.deepEqual(first.insight.customNote, { n: 0 });
  assert.equal(first.insight.createdAt, insight.createdAt); assert.notEqual(first.insight.updatedAt, "forged"); assert.equal(first.insight.archivedAt, undefined); assert.equal(first.insight.resolvedAt, undefined); assert.equal(first.insight.answerAuthorization, undefined);
  await h.command({ ...update, insight: { id: insight.id, body: "Different input" } }, 409);
  await h.command({ ...update, requestId: randomUUID() }, 409);
  await h.command({ kind: "insight.answer", documentId, insightId: insight.id, expectedVersion: 2, answer: { blocks: [{ type: "paragraph", text: "Approved" }] }, authorized: false }, 403);
  await h.command({ kind: "insight.answer", documentId, insightId: insight.id, expectedVersion: 2, answer: { blocks: [{}] }, authorized: true }, 400);
  const unchanged = await h.request("/api/references/" + encodeURIComponent(insight.reference)); assert.equal(unchanged.insight.answer, undefined);
  const answered = await h.command({ kind: "insight.answer", documentId, insightId: insight.id, expectedVersion: 2, answer: { blocks: [{ type: "paragraph", text: "Approved" }] }, authorized: true });
  assert.ok(answered.insight.resolvedAt); assert.equal(answered.insight.version, 3); assert.ok(answered.insight.answerAuthorization.requestId);
  const forged = await h.command({ kind: "insight.save", documentId, expectedVersion: 3, insight: { id: insight.id, body: "Keep real approval", resolvedAt: "forged", answerAuthorization: { subjectId: "forged" }, customAfterAnswer: true } }); assert.deepEqual(forged.insight.answerAuthorization, answered.insight.answerAuthorization); assert.equal(forged.insight.resolvedAt, answered.insight.resolvedAt); assert.equal(forged.insight.customAfterAnswer, true);
  const highlighted = await h.command({ kind: "insight.save", documentId, insight: { type: "annotation", body: "", color: "amber", blockId: ids.paragraph, variant: "source", field: "text", start: 0, end: 5, quote: "Alpha" } });
  assert.equal(highlighted.insight.referenceStatus, "exact");
  await h.command({ kind: "insight.save", documentId, insight: { type: "annotation", body: "", color: "amber", blockId: ids.paragraph, start: 0, end: 5, quote: "Wrong" } }, 409);
  await h.command({ kind: "insight.save", documentId, insight: { type: "annotation", body: "", color: "amber", sources: [{}] } }, 400);
  await h.command({ kind: "insight.archive", documentId, insightId: highlighted.insight.id, expectedVersion: 1 });
  await h.request("/api/references/" + encodeURIComponent(highlighted.insight.reference), { status: 404 });
  const restored = await h.command({ kind: "insight.restore", documentId, insightId: highlighted.insight.id, expectedVersion: 2 }); assert.equal(restored.insight.version, 3);
});

test("document revisions preserve history, source hashes, exact proposals and unknown data", async (t) => {
  const h = await harness(t), { envelope, ids } = await importDocument(h), documentId = envelope.document.id;
  await addHistoricalFields(h, envelope);
  const revise = (operations, fields = {}) => h.command({ kind: "document.revise", documentId, expectedRevision: 1, operations, ...fields });
  const proposal = await revise([{ kind: "replace", blockId: ids.paragraph, field: "text", value: "Alpha changed." }]);
  assert.equal(proposal.proposal.status, "pending"); assert.equal((await h.request("/api/documents/" + documentId)).document.revision, 1);
  const accept = { kind: "proposal.accept", proposalId: proposal.proposal.id, requestId: randomUUID() };
  const accepted = await h.command(accept); assert.equal(accepted.document.revision, 2); assert.deepEqual(await h.command(accept), accepted);
  assert.deepEqual(accepted.document.custom, { retained: true }); assert.deepEqual(accepted.document.blocks[1].customBlock, [1, 2]);
  assert.equal((await h.request(`/api/documents/${documentId}?revision=1`)).document.blocks[1].text, "Alpha beta gamma.");
  const current = await h.request("/api/documents/" + documentId), sourceHash = current.fingerprints[ids.paragraph];
  await h.command({ kind: "document.revise", documentId, expectedRevision: 2, authorized: true, operations: [{ kind: "replace", blockId: ids.paragraph, field: "text", variant: "zh", value: "修改的原文", sourceHash: "sha256:" + "0".repeat(64) }] }, 409);
  const translated = await h.command({ kind: "document.revise", documentId, expectedRevision: 2, authorized: true, operations: [{ kind: "replace", blockId: ids.paragraph, field: "text", variant: "zh", value: "修改的原文", sourceHash }] });
  assert.equal(translated.document.blocks[1].translations.zh.source_hash, sourceHash);
  const staleProposal = await h.command({ kind: "document.revise", documentId, expectedRevision: 3, operations: [{ kind: "replace", blockId: ids.paragraph, field: "text", value: "Proposal text" }] });
  const changed = await h.command({ kind: "document.revise", documentId, expectedRevision: 3, authorized: true, operations: [{ kind: "replace", blockId: ids.paragraph, field: "text", value: "New source" }, { kind: "replace", blockId: "$meta", field: "title", value: "New title" }, { kind: "insert", afterBlockId: ids.table, block: { type: "para", text: "User addition", language: "zh" } }] });
  assert.equal(changed.record.title, "New title"); assert.equal(changed.document.blocks.at(-1).origin, "user"); assert.equal(changed.document.blocks.at(-1).source, undefined);
  assert.equal(changed.document.blocks[1].translations.zh.source_hash, sourceHash);
  const textResult = await h.workspace.query({ kind: "read_document", documentId, blockId: ids.paragraph }); assert.equal(textResult.text.find((v) => v.variant === "zh").translationState, "stale");
  await h.command({ kind: "proposal.accept", proposalId: staleProposal.proposal.id }, 409);
  const simultaneous = await Promise.allSettled(["One", "Two"].map((value) => h.workspace.execute({ kind: "document.revise", requestId: randomUUID(), documentId, expectedRevision: 4, authorized: true, operations: [{ kind: "replace", blockId: ids.paragraph, field: "text", value }] })));
  assert.equal(simultaneous.filter((v) => v.status === "fulfilled").length, 1); assert.equal(simultaneous.filter((v) => v.status === "rejected")[0].reason.code, "REVISION_CONFLICT");
});

test("collections, independent plan, checkpoints and reversible material archive share one authority", async (t) => {
  const h = await harness(t), firstImport = await importDocument(h), first = firstImport.envelope.record, ids = firstImport.ids, second = (await importDocument(h)).envelope.record;
  const a = (await h.command({ kind: "collection.create", label: "Parent", parentId: null })).collection;
  const b = (await h.command({ kind: "collection.create", label: "Child", parentId: a.id })).collection;
  await h.command({ kind: "collection.update", collectionId: a.id, expectedVersion: 1, patch: { parentId: b.id } }, 409);
  await h.command({ kind: "document.update", documentId: first.id, expectedVersion: first.version, patch: { collectionIds: [b.id], tags: ["research"] } });
  await h.command({ kind: "collection.remove", collectionId: b.id, expectedVersion: 1 }, 409);
  await h.command({ kind: "plan.add", documentId: first.id }); await h.command({ kind: "plan.add", documentId: first.id }); await h.command({ kind: "plan.add", documentId: second.id });
  let snapshot = await h.request("/api/workspace"); assert.deepEqual(snapshot.planIds, [first.id, second.id]); assert.ok(snapshot.documents.every((d) => d.status === "unread"));
  await h.command({ kind: "plan.move", documentId: second.id, direction: -1, expectedPlanVersion: snapshot.planVersion });
  await h.command({ kind: "reading.open", documentId: first.id });
  const state = { documentId: first.id, revision: 1, blockId: ids.paragraph, offsetRatio: 0.4, mode: "bilingual", targetLanguage: "zh", translationFirst: true };
  await h.command({ kind: "reading.checkpoint", documentId: first.id, readingState: state });
  snapshot = await h.request("/api/workspace"); assert.equal(snapshot.currentId, first.id); assert.deepEqual(snapshot.planIds, [second.id, first.id]); assert.deepEqual(snapshot.documents.find((d) => d.id === first.id).readingState, state);
  const version = snapshot.documents.find((d) => d.id === first.id).version;
  const archived = await h.command({ kind: "document.archive", documentId: first.id, expectedVersion: version });
  assert.equal((await h.request("/api/workspace")).documents.length, 1); assert.equal((await h.request("/api/workspace?includeArchived=1")).documents.length, 2);
  await h.command({ kind: "document.restore", documentId: first.id, expectedVersion: archived.record.version });
  await h.command({ kind: "reading.open", documentId: first.id, restart: true });
  assert.equal((await h.request("/api/documents/" + first.id)).readingState, null);
});

test("legacy collisions preserve provenance and drafts; glossary imports preserve tombstones and versions", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-legacy-test-")), glossaryPath = join(dataDir, "old-glossary.json"), termId = randomUUID(), deletedId = randomUUID();
  const original = JSON.stringify({ schema: 1, revision: 12, entries: [{ id: termId, term: "Tensor", definition: "User definition", aliases: [], revision: 4, createdAt: "before", updatedAt: "before", custom: true }, { id: deletedId, term: "Removed", definition: "Keep tombstone", aliases: [], revision: 2, deletedAt: "before" }] });
  await writeFile(glossaryPath, original);
  const h = await harness(t, { dataDir, glossaryPath }); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const one = (await importDocument(h)).envelope.document.id, two = (await importDocument(h)).envelope.document.id;
  const raw = { id: "legacy-note", type: "question", body: "Retained legacy question", color: "sky", reference: "#Q00001", customLegacy: { keep: 1 } };
  const first = await h.command({ kind: "legacy.import", documentId: one, sessionKey: "one", notes: [raw], draft: { body: "Do not save" }, rawSession: "raw session one" });
  const second = await h.command({ kind: "legacy.import", documentId: two, sessionKey: "two", notes: [raw] });
  assert.equal(first.migration.retainedDraft, true); assert.notEqual(first.migration.mappings[0].id, second.migration.mappings[0].id); assert.notEqual(first.migration.mappings[0].reference, second.migration.mappings[0].reference);
  await h.request("/api/references/%23Q00001", { status: 409 });
  assert.equal((await h.request("/api/references/%23Q00001?documentId=" + two)).documentId, two);
  const repeat = await h.command({ kind: "legacy.import", documentId: one, sessionKey: "one", notes: [raw], draft: { body: "Do not save" }, rawSession: "raw session one" }); assert.deepEqual(repeat.migration, first.migration);
  assert.equal((await h.request("/api/documents/" + one)).insights.length, 1);
  const glossary = await h.request("/api/glossary"); assert.equal(glossary.revision, 12); assert.equal(glossary.entries[0].revision, 4); assert.equal(glossary.entries[0].custom, true);
  const restored = await h.request(`/api/glossary/${deletedId}/restore`, { method: "POST", body: { expectedRevision: 2 } }); assert.equal(restored.entry.revision, 3);
  await h.request(`/api/glossary/${termId}`, { method: "PATCH", body: { term: "Tensor", definition: "New user definition", aliases: [], expectedRevision: 3 }, status: 409 });
  const edited = await h.request(`/api/glossary/${termId}`, { method: "PATCH", body: { term: "Tensor", definition: "New user definition", aliases: [], expectedRevision: 4 } }); assert.equal(edited.entry.custom, true);
  assert.equal(await readFile(glossaryPath, "utf8"), original);
});

test("restart preserves publication receipts and historical conversion records without resuming them", async (t) => {
  const h = await harness(t), imported = await importDocument(h, documentFixture(), publishPreviewFixture), documentId = imported.envelope.document.id;
  const command = { kind: "insight.save", requestId: randomUUID(), documentId, insight: { type: "note", body: "Persisted note", color: "sky" } }, saved = await h.command(command);
  await h.server.shutdown();
  const legacyJobs = ["queued", "running", "ready", "cancelled"].map((status) => ({ id: "conversion-" + randomUUID(), sourceId: imported.file.sourceId, status, requestId: randomUUID(), attempt: 1, diagnostics: [{ code: "HISTORICAL", message: "Retain unchanged." }] }));
  const db = new DatabaseSync(join(h.dataDir, "workspace.sqlite"));
  try { for (const job of legacyJobs) db.prepare("INSERT INTO conversions VALUES(?,?,?,?)").run(job.id, job.sourceId, job.status, JSON.stringify(job)); } finally { db.close(); }
  const next = await createWorkspace({ dataDir: h.dataDir, bootstrap: false, glossaryPath: false });
  try {
    assert.deepEqual(await next.execute(command), saved); assert.equal((await next.query({ kind: "reference", reference: saved.insight.reference })).insight.body, "Persisted note");
    assert.deepEqual(await next.publishAuthoringPreview(localActor, imported.publicationInput), imported.publication);
    const changes = await next.query({ kind: "changes", after: 0 }); assert.ok(changes.changes.some((c) => c.documentId === documentId));
    await new Promise((done) => setImmediate(done));
    assert.equal((await next.query({ kind: "workspace" })).documents.length, 1);
    assert.deepEqual((await next.query({ kind: "document", documentId })).document, imported.envelope.document);
    assert.equal(hash(await readFile(next.resources.path(imported.file.sha256))), imported.file.sha256);
    const checkDb = new DatabaseSync(join(h.dataDir, "workspace.sqlite"));
    try { const records = checkDb.prepare("SELECT payload FROM conversions ORDER BY id").all().map((row) => JSON.parse(row.payload)); assert.deepEqual(records, legacyJobs.toSorted((a, b) => a.id.localeCompare(b.id))); } finally { checkDb.close(); }
  } finally { await next.close(); }
});


test("HTTP MCP and stdio clients read and write the same workspace", async (t) => {
  const h = await harness(t), { envelope, ids } = await importDocument(h), documentId = envelope.document.id;
  const client = new Client({ name: "workspace-test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(h.base + "/mcp"))); t.after(() => client.close());
  const tools = await client.listTools(); assert.ok(tools.tools.some((tool) => tool.name === "read_context")); assert.ok(!tools.tools.some((tool) => ["get_document", "read_document", "convert_document", "get_conversion", "cancel_conversion"].includes(tool.name))); assert.equal(client.getInstructions(), MCP_INSTRUCTIONS);
  const revisionTool = tools.tools.find((tool) => tool.name === "revise_document"); assert.ok(JSON.stringify(revisionTool.inputSchema).includes('"kind"')); assert.ok(JSON.stringify(revisionTool.inputSchema).includes('"replace"'));
  const cell = await client.callTool({ name: "read_context", arguments: { document_id: documentId, block_id: ids.table, field: "rows", row: 0, column: 1, before_chars: 0 } }); assert.equal(cell.structuredContent.segments.length, 1); assert.equal(cell.structuredContent.segments[0].text, "1");
  const saved = await client.callTool({ name: "update_insight", arguments: { authorized: true, request_id: randomUUID(), operation: { action: "create", document_id: documentId, insight: { type: "question", body: "MCP saved question", color: "sky" } } } });
  assert.equal(saved.isError, undefined); const insight = saved.structuredContent.insight;
  assert.equal((await h.request("/api/references/" + encodeURIComponent(insight.reference))).insight.body, "MCP saved question");
  const invalid = await client.callTool({ name: "revise_document", arguments: { document_id: documentId, expected_revision: 99, request_id: randomUUID(), operations: [{ kind: "replace", block_id: ids.paragraph, field: "text", value: "invalid" }] } }); assert.equal(invalid.isError, true);
  const stdio = new Client({ name: "workspace-stdio-test", version: "1" });
  await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(repoRoot, "services/workspace/stdio.mjs")], env: { ...process.env, WORKSPACE_URL: h.base }, stderr: "pipe" })); t.after(() => stdio.close());
  assert.equal(stdio.getInstructions(), client.getInstructions());
  const resolved = await stdio.callTool({ name: "resolve_reference", arguments: { reference: insight.reference } }); assert.equal(resolved.structuredContent.insight.id, insight.id);
});

test("retired extraction routes and MCP tools reject calls without creating documents", async (t) => {
  const h = await harness(t), source = await uploadBytes(h, Buffer.from("Retain this original."), "source.txt", "text/plain");
  for (const request of [{ path: "/api/conversions", method: "POST", body: { sourceId: source.sourceId, requestId: randomUUID() } }, { path: "/api/conversions/old-task", method: "GET" }, { path: "/api/conversions/old-task/cancel", method: "POST", body: {} }]) {
    await h.request(request.path, { ...request, status: 404 });
  }
  const client = new Client({ name: "retired-conversion-test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(h.base + "/mcp"))); t.after(() => client.close());
  for (const name of ["convert_document", "get_conversion", "cancel_conversion"]) {
    await assert.rejects(client.callTool({ name, arguments: { source_id: source.sourceId, request_id: randomUUID(), id: "old-task" } }),
      (error) => error.code === -32602 && /not found|unknown|not registered/i.test(error.message));
  }
  assert.equal((await h.request("/api/workspace")).documents.length, 0);
  assert.equal(hash(await readFile(h.workspace.resources.path(source.sha256))), source.sha256);
});

test("authentication protects workspace, MCP, source pages, exports and retained HTML", async (t) => {
  const h = await harness(t, { authToken: "test-token-never-production" }), workspace = h.workspace;
  const original = Buffer.from('<!doctype html><title>Retained HTML</title><h1>Title</h1><p>Readable</p><script>window.evil=true</script>');
  const authored = { format: "reader-authoring-1", key: "retained-html", meta: { title: "Retained HTML", language: "en" }, blocks: [{ key: "title", type: "heading", level: 1, text: "Title" }, { key: "body", type: "para", text: "Readable" }] };
  const { envelope } = await importBytes(h, original, "unsafe.html", "text/html", authored), documentId = envelope.document.id;
  for (const path of ["/api/workspace", `/api/documents/${documentId}/export`, `/api/documents/${documentId}/assets/source.html`, `/api/documents/${documentId}/pdf`, `/api/documents/${documentId}/pages/1.png`]) await h.request(path, { status: 401 });
  await h.request("/mcp", { method: "POST", body: {}, status: 401 });
  await h.request("/api/session", { method: "POST", body: { token: "wrong" }, status: 401 });
  const session = await fetch(h.base + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "test-token-never-production" }) }); assert.equal(session.status, 200); const cookie = session.headers.get("set-cookie"); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  await h.request("/api/workspace", { headers: { Cookie: cookie.split(";")[0] } });
  const response = await fetch(h.base + `/api/documents/${documentId}/assets/source.html`, { headers: h.headers });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition"), /^attachment/); assert.match(response.headers.get("content-security-policy"), /sandbox/); assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
  const client = new Client({ name: "authenticated-workspace-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.base + "/mcp"), { requestInit: { headers: h.headers } })); t.after(() => client.close());
  const listed = await client.callTool({ name: "query_documents", arguments: { action: "list" } }); assert.equal(listed.structuredContent.documents[0].id, documentId);
  assert.ok(!JSON.stringify((await workspace.query({ kind: "document", documentId })).document.blocks).includes("window.evil"));
});


test("PDF crop and rotation transforms agree with original page images and stored source hashes", async (t) => {
  const h = await harness(t), fixture = join(h.dataDir, "crop-rotation.pdf"), measurements = await runPdf({ action: "coordinate_probe", outputPath: fixture });
  assert.deepEqual(measurements.map((m) => m.rotation), [0, 90, 180, 270]);
  for (const m of measurements) { assert.equal(m.width, m.pixelWidth); assert.equal(m.height, m.pixelHeight); assert.ok(m.box.every((n) => n >= 0 && n <= 1)); assert.ok(m.box[0] < m.box[2] && m.box[1] < m.box[3]); }
  const authored = { format: "reader-authoring-1", key: "crop-rotation", meta: { title: "Mapped text", language: "en" }, blocks: [{ key: "mapped", type: "para", text: "Mapped text", source: [{ page: 1, box: measurements[1].box }] }] };
  const original = await readFile(fixture), { envelope } = await importBytes(h, original, "crop-rotation.pdf", "application/pdf", authored), documentId = envelope.document.id;
  const manifest = await h.request(`/api/documents/${documentId}/pdf`); assert.equal(manifest.sourceHash, hash(original)); assert.equal(manifest.pages[0].rotation, 90);
  assert.deepEqual(envelope.document.blocks[0].source[0].box, measurements[1].box);
  const image = await fetch(h.base + manifest.pages[0].imageUrl); assert.equal(image.headers.get("content-type"), "image/png"); const bytes = Buffer.from(await image.arrayBuffer()); assert.equal(bytes.subarray(1, 4).toString(), "PNG"); assert.equal(bytes.readUInt32BE(16), 1200); assert.equal(bytes.readUInt32BE(20), 900);
  const retained = await fetch(h.base + manifest.sourceUrl); assert.equal(hash(Buffer.from(await retained.arrayBuffer())), hash(original));
});


test("bundled bootstrap preserves sample revisions and fixture historical broken links, rejects new broken links", async (t) => {
  const sampleRoot = await mkdtemp(join(tmpdir(), "reader-bootstrap-samples-"));
  t.after(() => rm(sampleRoot, { recursive: true, force: true }));
  await filesystem.cp(join(repoRoot, "prototypes/insight-composer/public/articles"), sampleRoot, { recursive: true });
  const samplePath = join(sampleRoot, "resnet/document.json");
  const historical = JSON.parse(await readFile(samplePath, "utf8"));
  historical.blocks.find((block) => block.type === "para").text += " [Historical fixture link](#missing-historical-fixture)";
  await writeFile(samplePath, JSON.stringify(historical));
  const h = await harness(t, { bootstrap: true, sampleRoot }), snapshot = await h.request("/api/workspace"); assert.equal(snapshot.documents.length, 4); assert.deepEqual(snapshot.planIds, []); assert.equal(snapshot.currentId, null);
  const attention = snapshot.documents.find((d) => d.id === "doc_attention_is_all_you_need_v7"); assert.equal(attention.revision, 2); assert.equal((await h.request(`/api/documents/${attention.id}?revision=1`)).document.revision, 1);
  const resnet = snapshot.documents.find((d) => /Deep Residual/.test(d.title)), saved = await h.request("/api/documents/" + resnet.id); assert.ok(saved.report.danglingLinks.length > 0);
  const paragraph = saved.document.blocks.find((b) => b.type === "para");
  await h.command({ kind: "document.revise", documentId: resnet.id, expectedRevision: resnet.revision, authorized: true, operations: [{ kind: "replace", blockId: paragraph.id, field: "text", value: paragraph.text + " Retained valid update." }] });
  await h.command({ kind: "document.revise", documentId: resnet.id, expectedRevision: resnet.revision + 1, authorized: true, operations: [{ kind: "replace", blockId: paragraph.id, field: "text", value: "[New broken](#missing-new)" }] }, 400);
});

test("real Attention PDF binds to an MCP-authored preview and accepts a persisted local correction", async (t) => {
  const h = await harness(t), original = await readFile(resolve(repoRoot, "prototypes/insight-composer/public/articles/attention-is-all-you-need/source.pdf"));
  const file = await uploadBytes(h, original, "attention.pdf", "application/pdf");
  // This small authored excerpt tests transport, resource identity and revision behavior;
  // it is deliberately not a claim of whole-paper conversion or visual acceptance.
  const authored = { format: "reader-authoring-1", key: "attention-excerpt", meta: { title: "Attention uploaded source excerpt", language: "en" }, source: { path: "source.pdf", media_type: "application/pdf", sha256: file.sha256 }, blocks: [{ key: "excerpt", type: "para", text: "Attention Is All You Need", source: [{ page: 1 }] }] };
  const authoringFile = await uploadBytes(h, Buffer.from(JSON.stringify(authored)), "authoring.json");
  const client = new Client({ name: "real-pdf-test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(h.base + "/mcp"))); t.after(() => client.close());
  const created = await client.callTool({ name: "create_authoring_preview", arguments: { authoring_source_id: authoringFile.sourceId, resources: { "source.pdf": file.sourceId }, request_id: randomUUID() } }); assert.equal(created.isError, undefined);
  const preview = created.structuredContent.preview;
  const { mcpReview } = await protocolEvidence(h, preview);
  const published = await client.callTool({ name: "publish_authoring_preview", arguments: { preview_id: preview.id, expected_hash: preview.hash, request_id: randomUUID(), review: mcpReview } }); assert.equal(published.isError, undefined);
  const documentId = published.structuredContent.document.id, envelope = await h.request("/api/documents/" + documentId), manifest = await h.request(`/api/documents/${documentId}/pdf`); assert.equal(manifest.pages.length, 15); assert.equal(manifest.sourceHash, hash(original));
  const block = envelope.document.blocks[0]; assert.deepEqual(block.source, [{ page: 1 }]);
  const read = await client.callTool({ name: "read_context", arguments: { document_id: documentId, block_id: block.id } }); assert.ok(read.structuredContent.segments.some((item) => item.address.blockId === block.id && item.text === block.text));
  const correction = await client.callTool({ name: "revise_document", arguments: { document_id: documentId, expected_revision: 1, request_id: randomUUID(), authorized: true, operations: [{ kind: "replace", block_id: block.id, field: "text", value: block.text + "\nReview correction for integration verification." }] } }); assert.equal(correction.isError, undefined); assert.equal(correction.structuredContent.document.revision, 2);
  const current = await h.request("/api/documents/" + documentId); assert.match(current.document.blocks[0].text, /integration verification/); assert.deepEqual(current.document.blocks[0].source, block.source);
});


test("authoring HTML node edits rebuild indexes, translation provenance and detached references", async (t) => {
  const h = await harness(t);
  const input = { format: "reader-authoring-1", key: "html-fixture", meta: { title: "HTML material", language: "en", translations: { zh: { title: "HTML 资料" } } }, blocks: [
    { key: "html", type: "html", html: '<p data-key="first">Alpha <em>beta</em>.</p><p data-key="second">Second text.</p>', translations: { zh: { html: '<p data-key="first">阿尔法。</p><p data-key="second">第二段。</p>' } } },
    { key: "list", type: "list", ordered: false, items: [{ key: "first", text: "Original item", translations: { zh: { text: "列表项" } } }] },
  ] };
  const { envelope } = await importBytes(h, Buffer.from(JSON.stringify(input)), "authoring.json"), documentId = envelope.document.id, blockId = envelope.document.blocks[0].id;
  const originalArtifact = (await h.workspace.revision(documentId)); assert.ok(originalArtifact.authoring); assert.ok(originalArtifact.identity);
  assert.match(envelope.document.meta.translations.zh.source_hash, /^sha256:/); assert.match(envelope.document.blocks[1].items[0].translations.zh.source_hash, /^sha256:/);
  const read = await h.workspace.query({ kind: "read_document", documentId, blockId }), first = read.text.find((entry) => entry.variant === "source" && entry.text.startsWith("Alpha")); assert.ok(first.nodeId);
  const saved = await h.command({ kind: "insight.save", documentId, insight: { type: "annotation", body: "Original quotation", color: "amber", blockId, field: "html_text", nodeId: first.nodeId, quote: first.text, start: 0, end: first.text.length } });
  const changed = await h.command({ kind: "document.revise", documentId, expectedRevision: 1, authorized: true, operations: [{ kind: "replace", blockId, field: "html_text", nodeId: first.nodeId, value: "Corrected HTML text." }] }); assert.equal(changed.document.revision, 2);
  const after = await h.workspace.query({ kind: "read_document", documentId, blockId }); assert.equal(after.text.find((entry) => entry.variant === "source" && entry.nodeId === first.nodeId).text, "Corrected HTML text."); assert.equal(after.text.find((entry) => entry.variant === "zh").translationState, "stale");
  const current = await h.request("/api/documents/" + documentId); assert.equal(current.insights.find((note) => note.id === saved.insight.id).referenceStatus, "unresolved"); assert.equal(current.insights.find((note) => note.id === saved.insight.id).quote, first.text);
  const translated = await h.command({ kind: "document.revise", documentId, expectedRevision: 2, authorized: true, operations: [{ kind: "replace", blockId, field: "html_text", nodeId: first.nodeId, variant: "zh", sourceHash: current.fingerprints[blockId], value: "纠正后的 HTML 文字。" }] }); assert.equal(translated.document.revision, 3);
  const check = await h.workspace.query({ kind: "read_document", documentId, blockId }); assert.equal(check.text.find((entry) => entry.variant === "zh").translationState, "current");
  assert.equal((await h.request(`/api/documents/${documentId}?revision=1`)).document.blocks[0].html, envelope.document.blocks[0].html);
  const latest = await h.request("/api/documents/" + documentId);
  const titled = await h.command({ kind: "document.update", documentId, expectedVersion: latest.record.version, patch: { title: "Title retains conversion provenance" } }); assert.equal(titled.document.revision, 4);
  assert.deepEqual((await h.workspace.revision(documentId)).authoring, originalArtifact.authoring); assert.deepEqual((await h.workspace.revision(documentId)).identity, originalArtifact.identity);
  await h.command({ kind: "document.revise", documentId, expectedRevision: 4, authorized: true, operations: [{ kind: "replace", blockId, field: "html_text", nodeId: first.nodeId, value: "Subsequent edit keeps provenance." }] });
  assert.deepEqual((await h.workspace.revision(documentId)).authoring, originalArtifact.authoring); assert.deepEqual((await h.workspace.revision(documentId)).identity, originalArtifact.identity);
});

test("partial blob writes and failed blob/page publication remove their owned temporary files", async (t) => {
  const h = await harness(t), blobs = join(h.dataDir, "blobs"), pages = join(h.dataDir, "pages"), originalOpen = filesystem.open;
  const failure = () => Object.assign(new Error("Injected storage failure"), { code: "EIO" });
  const openMock = t.mock.method(filesystem, "open", async (path, ...arguments_) => {
    const handle = await originalOpen(path, ...arguments_);
    if (String(path).startsWith(blobs) && String(path).endsWith(".tmp")) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (bytes) => { await write(bytes.subarray(0, 3)); throw failure(); };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(h.workspace.resources.put(Buffer.from("Partial upload"), { filename: "partial.txt" }), { code: "EIO" }); assert.deepEqual(await readdir(blobs), []); }
  finally { openMock.mock.restore(); syncBuiltinESMExports(); }
  const fixture = join(h.dataDir, "publish.pdf"); await runPdf({ action: "coordinate_probe", outputPath: fixture });
  const file = await h.workspace.resources.putPath(fixture), originalRename = filesystem.rename, originalLink = filesystem.link;
  const linkMock = t.mock.method(filesystem, "link", async (source, destination) => {
    if (String(source).startsWith(blobs)) throw failure();
    return originalLink(source, destination);
  });
  const renameMock = t.mock.method(filesystem, "rename", async (source, destination) => {
    if (String(source).startsWith(blobs) || String(source).startsWith(pages)) throw failure();
    return originalRename(source, destination);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(h.workspace.resources.put(Buffer.from("Failed publication"), { filename: "rename.txt" }), { code: "EIO" });
    await assert.rejects(h.workspace.resources.page(file, 1), { code: "EIO" });
    assert.deepEqual(await readdir(blobs), [file.sha256]); assert.deepEqual(await readdir(pages), []); assert.equal(h.workspace.resources.rendering.size, 0);
  } finally { linkMock.mock.restore(); renameMock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(hash(await readFile(h.workspace.resources.path(file.sha256))), file.sha256);
});

test("change requests preserve source identity, retry atomically, survive restart and remain separate from insights", async (t) => {
  const h = await harness(t), { envelope, ids } = await importDocument(h), documentId = envelope.document.id;
  const changeRequest = { category: "correction", body: "Correct beta against the original.", revision: 1, source: { blockId: ids.paragraph, field: "text", variant: "source", start: 6, end: 10, quote: "beta" }, status: "completed", reference: "#R99999" };
  const input = { kind: "change_request.save", documentId, changeRequest, requestId: randomUUID() };
  const receipt = await h.command(input), saved = receipt.changeRequest;
  assert.equal(saved.reference, "#R00001"); assert.equal(saved.status, "pending");
  assert.equal(saved.source.quote, "beta"); assert.equal(saved.revision, 1);
  assert.deepEqual(await h.command(input), receipt);
  assert.equal((await h.request("/api/documents/" + documentId)).insights.length, 0);
  const invalid = await h.command({ ...input, requestId: randomUUID(), changeRequest: { ...changeRequest, source: { ...changeRequest.source, quote: "fake" } } }, 409);
  assert.equal(invalid.code, "ANCHOR_UNRESOLVED");
  await h.command({ ...input, requestId: randomUUID(), changeRequest: { ...changeRequest, body: "  " } }, 400);
  const docWide = (await h.command({ kind: "change_request.save", documentId, changeRequest: { category: "instruction", body: "Explain the main idea after the introduction.", revision: 1 } })).changeRequest;
  assert.equal(docWide.source, undefined); assert.equal(docWide.reference, "#R00002");
  const edit = { kind: "change_request.save", documentId, expectedVersion: 1, changeRequest: { ...saved, body: "Correct only beta." } };
  const updated = (await h.command(edit)).changeRequest; assert.equal(updated.version, 2); assert.equal(updated.reference, saved.reference);
  await h.command(edit, 409);
  const cancelled = (await h.command({ kind: "change_request.cancel", documentId, changeRequestId: updated.id, expectedVersion: 2 })).changeRequest;
  assert.equal(cancelled.status, "cancelled");
  await h.command({ ...edit, expectedVersion: 3 }, 409);
  const reopened = (await h.command({ kind: "change_request.reopen", documentId, changeRequestId: updated.id, expectedVersion: 3 })).changeRequest;
  assert.equal(reopened.status, "pending"); assert.equal(reopened.reference, saved.reference);
  const second = await createWorkspace({ dataDir: h.dataDir, bootstrap: false, glossaryPath: false });
  try { const requests = (await second.query({ kind: "change_requests", documentId })).changeRequests; assert.equal(requests.length, 2); assert.equal(requests.find((item) => item.id === saved.id).body, "Correct only beta."); } finally { await second.close(); }
});

test("MCP reads a saved change request and resolves its R reference against the same workspace", async (t) => {
  const h = await harness(t), { envelope, ids } = await importDocument(h), documentId = envelope.document.id;
  const saved = (await h.command({ kind: "change_request.save", documentId, changeRequest: { category: "instruction", body: "Add a short explanation.", revision: 1 } })).changeRequest;
  const client = new Client({ name: "change-request-test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(h.base + "/mcp"))); t.after(() => client.close());
  const listed = await client.callTool({ name: "list_change_requests", arguments: { document_id: documentId, status: "pending" } });
  assert.equal(listed.isError, undefined); assert.equal(listed.structuredContent.changeRequests[0].body, saved.body);
  const resolved = await client.callTool({ name: "resolve_reference", arguments: { reference: saved.reference } }); assert.equal(resolved.structuredContent.changeRequest.id, saved.id);
  assert.equal((await h.request("/api/references/" + encodeURIComponent(saved.reference))).changeRequest.id, saved.id);
  const revision = await client.callTool({ name: "revise_document", arguments: { document_id: documentId, expected_revision: 1, request_id: randomUUID(), authorized: true, change_request_id: saved.id, expected_change_request_version: saved.version, operations: [{ kind: "insert", after_block_id: ids.paragraph, block: { type: "para", text: "Requested explanation.", language: "en" } }] } });
  assert.equal(revision.isError, undefined); assert.equal(revision.structuredContent.document.revision, 2);
  const after = await h.request("/api/documents/" + documentId); assert.equal(after.changeRequests[0].revision, 1); assert.equal(after.document.revision, 2); assert.equal(after.changeRequests[0].status, "completed"); assert.equal(after.changeRequests[0].appliedRevision, 2);
});

test("linked revision proposals cannot complete an edited or withdrawn change request", async (t) => {
  const h = await harness(t), { envelope, ids } = await importDocument(h), documentId = envelope.document.id;
  const saved = (await h.command({ kind: "change_request.save", documentId, changeRequest: { category: "correction", body: "Fix beta.", revision: 1 } })).changeRequest;
  const proposalInput = { kind: "document.revise", documentId, expectedRevision: 1, changeRequestId: saved.id, expectedChangeRequestVersion: saved.version, operations: [{ kind: "replace", blockId: ids.paragraph, field: "text", value: "Corrected text." }] };
  const proposed = await h.command(proposalInput);
  assert.equal((await h.request("/api/documents/" + documentId)).changeRequests[0].status, "pending");
  await h.command({ kind: "change_request.cancel", documentId, changeRequestId: saved.id, expectedVersion: 1 });
  await h.command({ kind: "proposal.accept", proposalId: proposed.proposal.id }, 409);
  assert.equal((await h.request("/api/documents/" + documentId)).document.revision, 1);
  const reopened = (await h.command({ kind: "change_request.reopen", documentId, changeRequestId: saved.id, expectedVersion: 2 })).changeRequest;
  const currentProposal = await h.command({ ...proposalInput, expectedChangeRequestVersion: reopened.version });
  const command = { kind: "proposal.accept", proposalId: currentProposal.proposal.id, requestId: randomUUID() };
  const accepted = await h.command(command);
  assert.equal(accepted.changeRequest.status, "completed"); assert.equal(accepted.changeRequest.appliedRevision, 2);
  assert.deepEqual(await h.command(command), accepted);
  assert.equal((await h.request("/api/documents/" + documentId)).changeRequests[0].status, "completed");
});
