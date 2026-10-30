import test from "node:test";
import assert from "node:assert/strict";
import { parseRoute, readViewState, referenceDestination, routeUrl, writeViewState } from "../src/workspace-api.js";
import { readerReturnRoute } from "../src/related-navigation.js";

test("Queue task links round-trip without changing Collection defaults or Reader routes", () => {
  for (const taskId of ["2a541efd-dd78-44e8-9fce-c7c042c15551", "#T00024"]) {
    const route = { page: "queue", taskId };
    assert.deepEqual(parseRoute(routeUrl(route)), route);
    assert.deepEqual(referenceDestination(routeUrl(route)), { taskId });
  }
  assert.deepEqual(parseRoute("?view=queue"), { page: "queue" });
  assert.deepEqual(parseRoute("?view=home"), { page: "collection" });
  assert.deepEqual(parseRoute("?view=queue&document=paper"), { page: "reader", documentId: "paper", insightId: null });
  assert.deepEqual(referenceDestination("t00024"), { reference: "#T00024" });
  assert.equal(referenceDestination("#T24"), null);
});

test("Reader and related-article returns retain the Queue task after a refresh", () => {
  const origin = { page: "queue", taskId: "#T00024" };
  const entry = JSON.parse(JSON.stringify({ readerReturn: readerReturnRoute({}, origin) }));
  assert.deepEqual(readerReturnRoute(entry, { page: "reader", documentId: "paper" }), origin);
  assert.deepEqual(readerReturnRoute(entry, { page: "notes", documentId: "paper" }), origin);
  assert.deepEqual(readerReturnRoute(entry, { page: "collection" }), { page: "collection" });
  assert.deepEqual(readerReturnRoute({ readerReturn: { page: "queue", taskId: {} } }), { page: "queue" });
});

test("Queue filters, expansion, scroll and unsaved requirements survive the session view mirror", () => {
  let saved;
  const storage = { setItem(_key, value) { saved = value; }, getItem() { return saved; } };
  const queue = { type: "conversion", status: "needs_attention", query: "00024", selectedId: "task-a", scrollTop: 247,
    draft: { type: "conversion", body: "Keep every table", sourceId: "source-a" }, navigationExpanded: false };
  assert.equal(writeViewState(storage, { collection: { query: "papers" }, flow: { section: "history" }, queue, navigationExpanded: false }), true);
  const value = readViewState(storage, "queue");
  const { navigationExpanded, ...content } = queue;
  assert.deepEqual(value.queue, content);
  assert.equal(value.navigationExpanded, navigationExpanded);
  assert.deepEqual(value.collection, { query: "papers" });
  assert.deepEqual(value.flow, { section: "history" });
});
