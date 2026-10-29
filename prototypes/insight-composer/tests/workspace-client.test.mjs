import test from "node:test";
import assert from "node:assert/strict";
import { bundledDocumentInfo, documentPresentation } from "../src/bundled-document-info.js";
import { accessibleLegacySessions, executeCommand, parseRoute, readViewState, referenceDestination, routeUrl, WorkspaceError } from "../src/workspace-api.js";

test("bundled source warnings and downloads require the retained document identity and original file", () => {
  const original = { id: "doc_attention_is_all_you_need_v7", source: { sha256: "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697" } };
  assert.match(documentPresentation(original).translation_note, /41\.8.*41\.0/);
  assert.equal(bundledDocumentInfo(original).downloads.length, 2);
  assert.deepEqual(bundledDocumentInfo({ ...original, id: "new-import" }), {});
  assert.deepEqual(documentPresentation({ id: "no-source" }), {});
  assert.deepEqual(bundledDocumentInfo({ ...original, source: { sha256: "different-file" } }), {});
  assert.deepEqual(documentPresentation({ ...original, extensions: { "continous-reader.presentation": { source_note: "Verified replacement" } } }), { source_note: "Verified replacement" });
});

test("routes preserve legacy samples and reserve the hash for article anchors", () => {
  assert.deepEqual(parseRoute("?example=attention-html"), { page: "legacy" });
  assert.deepEqual(parseRoute("?paper=resnet"), { page: "legacy" });
  assert.deepEqual(parseRoute(""), { page: "collection" });
  assert.deepEqual(parseRoute("?view=home"), { page: "collection" });
  assert.deepEqual(parseRoute("?view=collection"), { page: "collection" });
  assert.deepEqual(parseRoute("?view=unknown"), { page: "collection" });
  const route = { page: "reader", documentId: "doc/with spaces", insightId: "note#2" };
  assert.deepEqual(parseRoute(routeUrl(route)), route);
  assert.equal(routeUrl({ page: "collection" }), "?view=collection");
  assert.equal(routeUrl({ page: "home" }), "?view=collection");
  assert.deepEqual(parseRoute("?view=flow"), { page: "flow", section: "overview" });
  for (const section of ["overview", "insights", "plan", "history"]) {
    const flow = { page: "flow", section };
    assert.deepEqual(parseRoute(routeUrl(flow)), flow);
  }
  assert.deepEqual(parseRoute("?view=flow&section=unknown"), { page: "flow", section: "overview" });
});

test("reference lookup recognizes workspace references and exact reader links", () => {
  assert.deepEqual(referenceDestination("q00001"), { reference: "#Q00001" });
  assert.deepEqual(referenceDestination("https://reader.example/?document=doc1&insight=n2#S1"), { documentId: "doc1", insightId: "n2", hash: "#S1" });
  assert.deepEqual(referenceDestination('{"documentId":"doc1","blockId":"S1"}'), { documentId: "doc1", insightId: null, hash: "#S1" });
  assert.deepEqual(referenceDestination('{"document_id":"doc1","block_id":"S1","revision":2}'), { documentId: "doc1", insightId: null, hash: "#S1", revision: 2 });
  assert.equal(referenceDestination("Attention paper"), null);
});

test("migration reads only matching legacy sessions and retains drafts separately", () => {
  const source = new Map([
    ["reader-session:doc1", JSON.stringify({ notes: [{ id: "n1", body: "saved" }], draft: { body: "unfinished" } })],
    ["reader-session:doc1:html-table3", "malformed"],
    ["reader-session:unrelated", JSON.stringify({ notes: [{ id: "n2" }] })],
  ]);
  const sessions = accessibleLegacySessions({ documents: [{ id: "doc1" }] }, { getItem: (key) => source.get(key) });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].notes.length, 1);
  assert.equal(sessions[0].draft.body, "unfinished");
  assert.equal(source.size, 3);
  assert.deepEqual(readViewState({ getItem: () => "malformed" }), { collection: {}, flow: {} });
  const collection = { query: "attention", selectedId: "doc1", listScrollTop: 120 };
  assert.deepEqual(readViewState({ getItem: () => JSON.stringify({ home: { scrollY: 90 }, collection }) }), { collection, flow: {} });
  const flow = { section: "insights", query: "attention", selectedInsightId: "n1", detailWidth: 420 };
  assert.deepEqual(readViewState({ getItem: () => JSON.stringify({ collection, flow }) }), { collection, flow });
});

test("a retry after an unknown network outcome reuses its idempotency key", async () => {
  const original = globalThis.fetch;
  const requests = [];
  let failure = true;
  globalThis.fetch = async (_path, options) => {
    requests.push(JSON.parse(options.body));
    if (failure) { failure = false; throw new TypeError("connection lost"); }
    return new Response(JSON.stringify({ requestId: requests.at(-1).requestId, revision: 2 }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const command = { kind: "plan.add", documentId: "test-retry" };
    await assert.rejects(executeCommand(command), /connection lost/);
    await executeCommand(command);
    assert.equal(requests[0].requestId, requests[1].requestId);
    await executeCommand(command);
    assert.notEqual(requests[1].requestId, requests[2].requestId);
  } finally { globalThis.fetch = original; }
});

test("a rejected write returns a typed failure without inventing saved state", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Version changed", code: "conflict", details: { version: 3 } }), { status: 409, headers: { "Content-Type": "application/json" } });
  try { await assert.rejects(executeCommand({ kind: "insight.save", documentId: "test-conflict", insight: {} }), (error) => error instanceof WorkspaceError && error.status === 409 && error.details.version === 3); }
  finally { globalThis.fetch = original; }
});
