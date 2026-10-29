import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createWorkspaceServer } from "../server.mjs";
import { publishAuthoringFixture } from "./authoring-fixture.mjs";
import { DocumentRelations } from "../relations.mjs";

const document = (id, title, blocks, meta = {}) => ({ format: "reader-authoring-1", key: id, meta: { title, language: "en", ...meta }, blocks: blocks.map(({ id: key, ...block }) => ({ key, ...block })) });
const citing = () => document("citing", "Reading with references", [
  { id: "body", type: "para", text: "See [1](#bib-one) for the result." },
  { id: "refs", type: "heading", level: 1, text: "References" },
  { id: "bib-one", type: "para", text: "[1] Alice Smith. A reliable target paper. Journal of Testing, 2020. https://doi.org/10.5555/target.2020." },
]);
const target = (id = "target") => document(id, "A reliable target paper", [{ id: "body", type: "para", text: "An independent result." }], { authors: "Alice Smith", year: 2020, doi: "10.5555/target.2020" });

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-relations-"));
  let server, base;
  const fixtures = new Map();
  const id = (key) => fixtures.get(key)?.document.id || key;
  const blockId = (key, blockKey) => fixtures.get(key)?.blockIds[blockKey] || blockKey;
  async function start() {
    server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  t.after(async () => { await server.shutdown(); assert.ok(dataDir.startsWith(join(tmpdir(), "reader-relations-"))); await rm(dataDir, { recursive: true, force: true }); });
  const get = async (path) => { const response = await fetch(base + path.replace(/(\/api\/documents\/)([^/?]+)/, (_, prefix, key) => prefix + id(key))); const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
  const execute = (input) => {
    const key = input.documentId;
    const source = (value) => value && ({ ...value, ...(value.blockId ? { blockId: blockId(key, value.blockId) } : {}) });
    return server.workspace.execute({ requestId: randomUUID(), ...input,
      ...(key ? { documentId: id(key) } : {}),
      ...(input.targetDocumentId ? { targetDocumentId: id(input.targetDocumentId) } : {}),
      ...(input.operations ? { operations: input.operations.map(source) } : {}),
      ...(input.changeRequest ? { changeRequest: { ...input.changeRequest, ...(input.changeRequest.source ? { source: source(input.changeRequest.source) } : {}) } } : {}),
    });
  };
  async function add(value) {
    const authoring = structuredClone(value), { year, doi, arxiv, ...meta } = authoring.meta;
    authoring.meta = { ...meta, ...(year ? { date: String(year) } : {}) };
    if (doi || arxiv) authoring.extensions = { "continous-reader.bibliography": { work: { identifiers: { ...(doi ? { doi } : {}), ...(arxiv ? { arxiv } : {}) } } } };
    const fixture = await publishAuthoringFixture({ base, authoring });
    fixtures.set(value.key, fixture);
    return fixture.document.id;
  }
  return { get, execute, add, id, blockId, get workspace() { return server.workspace; }, relations: (id = "citing") => get(`/api/documents/${id}/relations`),
    restart: async () => { await server.shutdown(); await start(); },
    mcp: async () => { const client = new Client({ name: "relations-test", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"))); t.after(() => client.close()); return client; } };
}

test("relation rematching runs once per content commit and skips unchanged restart or unrelated metadata", async (t) => {
  const h = await setup(t); await h.add(citing()); await h.add(target());
  const before = await h.relations(), original = DocumentRelations.prototype.resolve; let resolves = 0, catalogReads = 0;
  const mock = t.mock.method(DocumentRelations.prototype, "resolve", function (...args) { resolves++; return original.apply(this, args); });
  const trackCatalog = () => { const query = h.workspace.sql.query; h.workspace.sql.query = function (sql, ...args) {
    if (sql === 'SELECT * FROM bibliographic_documents ORDER BY rowid') catalogReads++;
    return query.call(this, sql, ...args);
  }; };
  trackCatalog();
  await h.execute({ kind: "document.revise", documentId: "citing", expectedRevision: 1, authorized: true,
    operations: [{ kind: "replace", blockId: "body", field: "text", value: `Still see [1](#${h.blockId("citing", "bib-one")}).` }] });
  assert.equal(catalogReads, 1, "extraction prepares against one shared catalog for its commit");
  const saved = await h.relations(); assert.equal(saved.outgoing[0].id, before.outgoing[0].id); assert.equal(saved.outgoing[0].status, "linked");
  resolves = 0; await h.restart(); assert.equal(resolves, 0, "an unchanged restart does not compare every citation to every document");
  catalogReads = 0; trackCatalog();
  const record = (await h.get("/api/documents/target")).record;
  await h.execute({ kind: "document.update", documentId: "target", expectedVersion: record.version, patch: { tags: ["local-tag"] } });
  assert.equal(catalogReads, 0, "tags are not citation identity and do not read the citation catalog");
  await h.execute({ kind: "document.archive", documentId: "target", expectedVersion: record.version + 1 });
  assert.equal(catalogReads, 1); assert.equal((await h.relations()).outgoing[0].status, "unresolved");
  mock.mock.restore();
});

test("relation invalidation rolls back with state and manual batch resolution reads one shared catalog", async (t) => {
  const h = await setup(t); await h.add(target());
  for (let i = 0; i < 3; i++) {
    const source = citing(); source.key = "citing-" + i; await h.add(source);
    const relation = (await h.relations(source.key)).outgoing[0];
    await h.execute({ kind: "relation.link", documentId: source.key, relationId: relation.id, expectedVersion: relation.version, targetDocumentId: "target", authorized: true });
  }
  const w = h.workspace, catalog = w.relations.documents.bind(w.relations); let reads = 0;
  w.relations.documents = () => { reads++; return catalog(); };
  w.db.transaction(() => w.relations.sync([])); assert.equal(reads, 1);
  assert.equal(w.db.prepare("SELECT value FROM relation_match_state WHERE key='dirty'").get().value, "0");
  assert.throws(() => w.db.transaction(() => {
    w.db.prepare("UPDATE documents SET archived_at='synthetic' WHERE id=?").run(h.id("target"));
    assert.equal(w.db.prepare("SELECT value FROM relation_match_state WHERE key='dirty'").get().value, "1");
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(w.db.prepare("SELECT value FROM relation_match_state WHERE key='dirty'").get().value, "0");
  assert.equal(w.row(h.id("target")).archived_at, null);
  // Replicated/direct SQL changes use the same durable invalidation trigger.
  w.db.prepare("UPDATE bibliographic_documents SET payload=payload WHERE document_id=?").run(h.id("target"));
  assert.equal(w.db.prepare("SELECT value FROM relation_match_state WHERE key='dirty'").get().value, "1");
  reads = 0; w.db.transaction(() => w.relations.sync([])); assert.equal(reads, 1);
  assert.ok(w.relations.rows().every((relation) => relation.decision === "manual" && relation.status === "linked"));
});

test("document and relation proposal paths retain dirty catalog rematching, including already applied proposals", async (t) => {
  const h = await setup(t); await h.add(citing()); await h.add(target());
  const w = h.workspace, query = w.sql.query; let catalogReads = 0;
  w.sql.query = function (sql, ...args) {
    if (sql === 'SELECT * FROM bibliographic_documents ORDER BY rowid') catalogReads++;
    return query.call(this, sql, ...args);
  };
  const withDirtyCatalog = async operation => {
    w.db.prepare('UPDATE bibliographic_documents SET payload=payload WHERE document_id=?').run(h.id('target'));
    assert.equal(w.db.prepare("SELECT value FROM relation_match_state WHERE key='dirty'").get().value, '1');
    catalogReads = 0;
    const result = await operation();
    assert.equal(catalogReads, 1, 'this existing proposal branch prepares the dirty catalog once');
    assert.equal(w.db.prepare("SELECT value FROM relation_match_state WHERE key='dirty'").get().value, '0');
    return result;
  };
  const proposed = await withDirtyCatalog(() => h.execute({ kind: 'document.revise', documentId: 'citing', expectedRevision: 1,
    operations: [{ kind: 'replace', blockId: 'body', field: 'text', value: `Updated discussion of [1](#${h.blockId('citing', 'bib-one')}).` }] }));
  assert.equal(w.row(h.id('citing')).current_revision, 1, 'a proposal does not publish its candidate');
  const accepted = await withDirtyCatalog(() => h.execute({ kind: 'proposal.accept', proposalId: proposed.proposal.id }));
  assert.equal(accepted.document.revision, 2);
  const repeated = await withDirtyCatalog(() => h.execute({ kind: 'proposal.accept', proposalId: proposed.proposal.id }));
  assert.equal(repeated.document.revision, 2, 'a new request accepting an applied proposal retains the old revision');
  const relation = (await h.relations()).outgoing[0];
  const relationProposal = await h.execute({ kind: 'relation.dismiss', documentId: 'citing', relationId: relation.id, expectedVersion: relation.version });
  const dismissed = await withDirtyCatalog(() => h.execute({ kind: 'proposal.accept', proposalId: relationProposal.proposal.id }));
  assert.equal(dismissed.relation.status, 'dismissed');
  const repeatedRelation = await withDirtyCatalog(() => h.execute({ kind: 'proposal.accept', proposalId: relationProposal.proposal.id }));
  assert.equal(repeatedRelation.relation.status, 'dismissed');
  assert.equal(w.row(h.id('citing')).current_revision, 2, 'relation decisions do not publish another document revision');
});

test("local bibliography identities backfill on import, reverse citations and archived targets stay consistent", async (t) => {
  const h = await setup(t); await h.add(citing());
  let relations = await h.relations(); assert.equal(relations.outgoing.length, 1);
  const unresolved = relations.outgoing[0]; assert.equal(unresolved.status, "unresolved"); assert.ok(unresolved.targetWorkId); assert.equal(unresolved.source.blockId, h.blockId("citing", "bib-one"));
  await h.add(target());
  relations = await h.relations(); const linked = relations.outgoing[0];
  assert.equal(linked.id, unresolved.id); assert.equal(linked.status, "linked"); assert.deepEqual(linked.targetDocuments.map((item) => item.id), [h.id("target")]);
  assert.equal(linked.targetWorkId, unresolved.targetWorkId); assert.ok(linked.occurrences.some((item) => item.blockId === h.blockId("citing", "body")));
  const incoming = (await h.relations("target")).incoming; assert.equal(incoming.length, 1); assert.equal(incoming[0].documentId, h.id("citing"));
  const record = (await h.get("/api/documents/target")).record;
  await h.execute({ kind: "document.archive", documentId: "target", expectedVersion: record.version });
  assert.equal((await h.relations()).outgoing[0].status, "unresolved");
  await h.execute({ kind: "document.restore", documentId: "target", expectedVersion: record.version + 1 });
  assert.equal((await h.relations()).outgoing[0].status, "linked");
  await h.add(target("target-copy"));
  assert.equal((await h.relations()).outgoing[0].targetDocuments.length, 2);
  await h.restart(); assert.equal((await h.relations()).outgoing[0].id, linked.id);
  assert.equal((await h.get("/api/documents/citing")).document.revision, 1);
});

test("manual decisions are idempotent, persistent and versioned separately; changed or removed references become stale", async (t) => {
  const h = await setup(t); await h.add(citing()); await h.add(target());
  const initial = (await h.relations()).outgoing[0];
  const command = { kind: "relation.dismiss", documentId: "citing", relationId: initial.id, expectedVersion: initial.version, authorized: true, requestId: randomUUID() };
  const dismissed = await h.execute(command); assert.equal(dismissed.relation.status, "dismissed"); assert.deepEqual(await h.execute(command), dismissed);
  await assert.rejects(h.execute({ ...command, requestId: randomUUID() }), (error) => error.code === "REVISION_CONFLICT");
  await h.add(target("another-copy")); await h.restart();
  let relation = (await h.relations()).outgoing[0]; assert.equal(relation.status, "dismissed");
  const reset = await h.execute({ kind: "relation.reset", documentId: "citing", relationId: relation.id, expectedVersion: relation.version, authorized: true }); assert.equal(reset.relation.status, "linked");
  const manual = await h.execute({ kind: "relation.link", documentId: "citing", relationId: relation.id, expectedVersion: reset.relation.version, targetDocumentId: "target", authorized: true });
  assert.equal(manual.relation.decision, "manual"); assert.equal((await h.get("/api/documents/citing")).document.revision, 1);
  await h.execute({ kind: "document.revise", documentId: "citing", expectedRevision: 1, authorized: true, operations: [{ kind: "replace", blockId: "bib-one", field: "text", value: "[1] Bob Jones. Another target. Journal, 2023." }] });
  relation = (await h.relations()).outgoing[0]; assert.equal(relation.id, initial.id); assert.equal(relation.status, "stale"); assert.deepEqual(relation.targetDocuments, []);
  assert.equal((await h.get("/api/documents/citing/relations?revision=1")).readOnly, true);
  await h.execute({ kind: "document.revise", documentId: "citing", expectedRevision: 2, authorized: true, operations: [{ kind: "replace", blockId: "body", field: "text", value: "No citation." }, { kind: "remove", blockId: "bib-one" }] });
  relation = (await h.relations()).outgoing[0]; assert.equal(relation.status, "stale"); assert.equal(relation.sourceMissing, true);
  await assert.rejects(h.execute({ kind: "relation.link", documentId: "citing", relationId: relation.id, expectedVersion: relation.version, targetDocumentId: "target", authorized: true }), (error) => error.code === "ANCHOR_UNRESOLVED");
});

test("relation proposals and MCP completion of R requests are atomic and never increment document revision", async (t) => {
  const h = await setup(t); await h.add(citing()); await h.add(target());
  const client = await h.mcp();
  const call = async (name, args) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent; };
  let listed = await call("list_document_relations", { document_id: h.id("citing") }); const relation = listed.relations[0]; assert.equal(listed.page.total, 1);
  const request = (await h.execute({ kind: "change_request.save", documentId: "citing", changeRequest: { category: "instruction", body: "Do not link this reference automatically.", revision: 1, source: { blockId: "bib-one", field: "text", variant: "source" } } })).changeRequest;
  const proposal = await call("set_document_relation", { document_id: h.id("citing"), relation_id: relation.id, expected_version: relation.version, action: "dismiss", request_id: randomUUID(), change_request_id: request.id, expected_change_request_version: request.version });
  assert.equal(proposal.proposal.kind, "relation"); assert.equal(proposal.proposal.status, "pending");
  assert.equal((await h.get("/api/references/" + encodeURIComponent(request.reference))).changeRequest.status, "pending");
  assert.equal((await h.relations()).outgoing[0].status, "linked");
  const accepted = await call("decide_revision_proposal", { proposal_id: proposal.proposal.id, request_id: randomUUID(), decision: "accept" });
  assert.equal(accepted.relation.status, "dismissed"); assert.equal(accepted.changeRequest.status, "completed"); assert.equal(accepted.changeRequest.appliedRelationId, relation.id); assert.equal(accepted.changeRequest.appliedRevision, undefined);
  assert.equal((await h.get("/api/documents/citing")).document.revision, 1);
  const nextRequest = (await h.execute({ kind: "change_request.save", documentId: "citing", changeRequest: { category: "instruction", body: "Link the reference.", revision: 1 } })).changeRequest;
  const current = (await h.relations()).outgoing[0];
  const pending = await call("set_document_relation", { document_id: h.id("citing"), relation_id: relation.id, expected_version: current.version, action: "link", target_document_id: h.id("target"), request_id: randomUUID(), change_request_id: nextRequest.id, expected_change_request_version: nextRequest.version });
  await h.execute({ kind: "change_request.cancel", documentId: "citing", changeRequestId: nextRequest.id, expectedVersion: nextRequest.version });
  await assert.rejects(h.execute({ kind: "proposal.accept", proposalId: pending.proposal.id }), (error) => error.code === "REVISION_CONFLICT");
  assert.equal((await h.relations()).outgoing[0].status, "dismissed");
});

test("same title and year do not merge works by author initials; a manual link remains limited to the selected identity", async (t) => {
  const h = await setup(t), source = citing();
  source.blocks[2].text = "[1] Alice Smith. A reliable target paper. Journal of Testing, 2020.";
  await h.add(source);
  const first = target("alice"), second = target("andrew");
  delete first.meta.doi; delete second.meta.doi; second.meta.authors = "Andrew Jones";
  await h.add(first); await h.add(second);
  const relation = (await h.relations()).outgoing[0];
  const result = await h.execute({ kind: "relation.link", documentId: "citing", relationId: relation.id, expectedVersion: relation.version, targetDocumentId: "alice", authorized: true });
  assert.deepEqual(result.relation.targetDocuments.map((entry) => entry.id), [h.id("alice")]);
  assert.equal((await h.relations("andrew")).incoming.length, 0);
  await assert.rejects(h.execute({ kind: "relation.link", documentId: "citing", relationId: relation.id, expectedVersion: result.relation.version, targetDocumentId: "bad/path", authorized: true }), (error) => error.code === "VALIDATION_FAILED");
});

test("manual selection excludes an identifier-conflicting copy instead of expanding through a shared DOI", async (t) => {
  const h = await setup(t); await h.add(citing());
  const selected = target("selected"), conflicting = target("conflicting");
  selected.meta.arxiv = "1706.03762"; conflicting.meta.arxiv = "1512.03385";
  await h.add(selected); await h.add(conflicting);
  const reference = (await h.relations()).outgoing[0]; assert.equal(reference.status, "candidate");
  const saved = await h.execute({ kind: "relation.link", documentId: "citing", relationId: reference.id, expectedVersion: reference.version, targetDocumentId: "selected", authorized: true });
  assert.deepEqual(saved.relation.targetDocuments.map((entry) => entry.id), [h.id("selected")]);
  await h.restart(); assert.deepEqual((await h.relations()).outgoing[0].targetDocuments.map((entry) => entry.id), [h.id("selected")]);
});
