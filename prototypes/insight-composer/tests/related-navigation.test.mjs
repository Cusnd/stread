import test from "node:test";
import assert from "node:assert/strict";
import { readerReturnRoute, relatedTrail, readingStateForEntry, relatedDestinationState, pushRelatedTrail } from "../src/related-navigation.js";

test("Reader returns to its workspace origin across article and note journeys and reloads", () => {
  for (const section of ["overview", "insights", "plan", "history"]) {
    const origin = { page: "flow", section };
    const entry = { readerReturn: readerReturnRoute({}, origin) };
    for (const page of ["reader", "notes"]) {
      assert.deepEqual(readerReturnRoute(JSON.parse(JSON.stringify(entry)), { page, documentId: "paper" }), origin);
    }
    assert.deepEqual(readerReturnRoute(entry, { page: "collection" }), { page: "collection" });
  }
});

test("direct Reader links and malformed return routes fall back to Collection", () => {
  for (const readerReturn of [undefined, null, {}, { page: "reader", documentId: "loop" }, { page: "https://elsewhere.invalid" }]) {
    assert.deepEqual(readerReturnRoute({ readerReturn }), { page: "collection" });
  }
  assert.deepEqual(readerReturnRoute({ readerReturn: { page: "flow", section: "missing", documentId: "discarded" } }), { page: "flow", section: "overview" });
  assert.deepEqual(readerReturnRoute({ readerReturn: { page: "collection" } }, { page: "flow", section: "insights" }), { page: "flow", section: "insights" });
});

test("article journeys retain independent source positions and language modes through nested jumps", () => {
  const a = { documentId: "a", blockId: "citation", offsetRatio: .43, viewportOffset: -18, mode: "bilingual", targetLanguage: "zh-CN", translationFirst: true };
  const b = { documentId: "b", blockId: "section-3", offsetRatio: .2, mode: "source" };
  const first = { readerTrail: pushRelatedTrail({}, { page: "reader", documentId: "a", revision: 2 }, "First paper", a) };
  const next = { readerTrail: pushRelatedTrail(first, { page: "reader", documentId: "b" }, "Second paper", b) };
  assert.deepEqual(next.readerTrail.map((item) => item.route.documentId), ["a", "b"]);
  assert.deepEqual(next.readerTrail[0].readingState, a);
  assert.equal(next.readerTrail[0].route.revision, 2);
  assert.deepEqual(relatedTrail(JSON.parse(JSON.stringify(next))), next.readerTrail);
  assert.deepEqual(readingStateForEntry({ readerPosition: a }, "a"), a);
  assert.deepEqual(readingStateForEntry({ readerPosition: a }, "b", b), b);
});

test("backlink destinations retain precise list/HTML addresses and select the visible language", () => {
  const source = { blockId: "references", itemId: "ref-1", field: "text", variant: "zh-CN" };
  const destination = relatedDestinationState("a", source, { documentId: "a", mode: "source", viewportOffset: 100, translationFirst: true });
  assert.deepEqual(destination.source, source);
  assert.equal(destination.mode, "translation");
  assert.equal(destination.targetLanguage, "zh-CN");
  assert.equal(destination.viewportOffset, undefined);
  assert.equal(relatedDestinationState("a", { blockId: "body", variant: "source" }, { documentId: "a", mode: "bilingual" }).mode, "bilingual");
  assert.equal(relatedDestinationState("a", null, { documentId: "b" }), null);
});

test("malformed history and long reading journeys stay bounded", () => {
  assert.deepEqual(relatedTrail({ readerTrail: {} }), []);
  assert.deepEqual(relatedTrail({ readerTrail: [null, { route: { page: "home" } }] }), []);
  let entry = {};
  for (let index = 0; index < 30; index++) entry = { readerTrail: pushRelatedTrail(entry, { page: "reader", documentId: String(index) }, "Paper", null) };
  assert.equal(entry.readerTrail.length, 20);
  assert.equal(entry.readerTrail[0].route.documentId, "10");
});
