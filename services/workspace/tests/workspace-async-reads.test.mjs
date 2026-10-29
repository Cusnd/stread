import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createWorkspace, localActor } from "../service.mjs";
import { Workspace } from "../workspace-core.mjs";
import { FlowData } from "../flow.mjs";
import { DocumentRelations } from "../relations.mjs";
import { createProtocolReviewEvidence } from "./authoring-protocol-evidence-fixture.mjs";

test("the real Workspace read contract supports async SQL while SQLite stays synchronously readable", async t => {
  const directory = await mkdtemp(join(tmpdir(), "reader-async-workspace-"));
  const local = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  t.after(async () => { await local.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(directory.includes("reader-async-workspace-")); await rm(directory, { recursive: true, force: true }); });
  const authoring = { format: "reader-authoring-1", key: "async-core", meta: { title: "Async contract", language: "en" }, blocks: [{ key: "paragraph", type: "para", text: "A searchable needle." }] };
  const uploaded = await local.upload(localActor, Buffer.from(JSON.stringify(authoring)), { filename: "source.json", mediaType: "application/json" });
  const created = await local.createAuthoringPreview(localActor, { authoringSourceId: uploaded.sourceId, requestId: randomUUID() });
  // Keep a genuinely published preview for the async draft/preview read
  // branches below. This helper supplies explicitly synthetic protocol evidence,
  // not a real Agent run or a claim of source/Reader acceptance.
  const evidence = await createProtocolReviewEvidence({ preview: created.preview,
    readReport: async preview => (await local.getPreviewArtifact(localActor, preview.id, "report")).value,
    upload: (bytes, filename, mediaType) => local.upload(localActor, bytes, { filename, mediaType }) });
  const publication = await local.publishAuthoringPreview(localActor, { previewId: created.preview.id, expectedHash: created.preview.hash, requestId: randomUUID(), review: evidence.review });
  const id = publication.document.id, saved = await local.revision(id), block = saved.document.blocks[0];
  const insight = { id: "async-note", documentId: id, version: 1, reference: "#N00001", type: "note", body: "Preserved note", blockId: block.id, field: "text", quote: block.text, revision: 1 };
  local.db.prepare("INSERT INTO insights VALUES(?,?,1,?,NULL)").run(insight.id, id, JSON.stringify(insight));
  local.db.prepare("INSERT INTO references_map VALUES(?,?)").run(insight.reference, insight.id);
  local.db.prepare("INSERT INTO change_requests VALUES(?,?,1,?,?)").run("request", id, "#R00001", JSON.stringify({ id: "request", documentId: id, reference: "#R00001", status: "pending" }));
  local.db.prepare("INSERT INTO glossary VALUES('term',1,'contract',?,NULL)").run(JSON.stringify({ id: "term", term: "Contract", aliases: [], definition: "Exact behavior" }));
  const sql = { query: async (...args) => { await Promise.resolve(); return local.sql.query(...args); }, batch: async (...args) => { await Promise.resolve(); return local.sql.batch(...args); } };
  const remote = new Workspace({ database: null, sql, resources: local.resources });
  remote.flow = new FlowData(null, { navigation: (id, revision) => remote.revisionNavigation(id, revision), meta: key => remote.meta(key) }, { sql, initialize: false });
  const relationReads = { prepare: statement => ({ all: (...values) => sql.query(statement, values), get: async (...values) => (await sql.query(statement, values))[0] }) };
  remote.relations = new DocumentRelations(relationReads, { initialize: false });
  assert.equal(local.snapshot().documents[0].id, id, "SQLite synchronous consumers retain their return shape");
  assert.equal(local.revisionState(id).document.id, id);
  for (const [method, args] of [
    ["snapshot", []], ["documentSummaries", [{ documentId: id }]], ["revisionState", [id]], ["material", [local.row(id)]], ["insights", [id]], ["changeRequests", [id]],
    ["documentRelations", [id]], ["objectPreferences", [id]], ["envelope", [id]], ["reference", ["#N00001"]], ["reference", ["#R00001"]], ["glossaryList", []], ["glossaryGet", ["term"]],
    ["file", [uploaded.sourceId]], ["uploadedSources", [localActor]], ["uploadedSource", [localActor, uploaded.sourceId]], ["getAuthoringContract", [localActor, uploaded.sourceId]],
    ["getAuthoringPreview", [localActor, created.preview.id]], ["getAuthoringDraft", [localActor, created.preview.draftId]], ["previewMetadata", [created.preview.id]],
  ]) assert.deepEqual(await remote[method](...args), await local[method](...args), method);
  for (const kind of ["collections", "reading_plan", "object_preferences", "insights", "change_requests", "proposals", "changes", "search", "glossary.get"])
    assert.deepEqual(await remote.query({ kind, documentId: id, query: "needle", id: "term" }), await local.query({ kind, documentId: id, query: "needle", id: "term" }), kind);
  const before = local.db.prepare("SELECT * FROM preview_metadata WHERE preview_id=?").get(created.preview.id);
  await remote.cachePreviewMetadata({ id: created.preview.id, draftId: "stale", hash: "stale" }, "obsolete-payload");
  assert.deepEqual(local.db.prepare("SELECT * FROM preview_metadata WHERE preview_id=?").get(created.preview.id), before, "old fetched objects cannot overwrite metadata for a different payload");
  await assert.rejects(remote.documentSummaries({ documentId: "missing" }), error => error.code === "NOT_FOUND");
});
