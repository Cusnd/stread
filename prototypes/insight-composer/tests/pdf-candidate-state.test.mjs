import assert from "node:assert/strict";
import test from "node:test";
import { clampPdfPage, preservePdfCandidateView, reconcilePdfTargets } from "../src/pdf-candidate-state.js";
import { sourceRegions } from "../src/reading-position.js";

test("a new preview candidate preserves the PDF view only when the source hash proves it is the same file", () => {
  const previous = { apiBase: "/api/authoring/previews/a", sourceHash: "pdf-hash" };
  const next = { apiBase: "/api/authoring/previews/b", sourceHash: "pdf-hash" };
  assert.equal(preservePdfCandidateView(previous, next), true);
  assert.equal(preservePdfCandidateView(previous, { ...next, sourceHash: "other-pdf" }), false);
  assert.equal(preservePdfCandidateView({ ...previous, sourceHash: undefined }, { ...next, sourceHash: undefined }), false);
  assert.equal(preservePdfCandidateView({ ...previous, apiBase: "/api/documents/a" }, next), false);
  assert.equal(preservePdfCandidateView(previous, previous), false);
});

test("the preserved page is clamped to the response's actual page numbers", () => {
  const pages = [{ page: 1 }, { page: 2 }, { page: 3 }];
  assert.equal(clampPdfPage(pages, 2), 2);
  assert.equal(clampPdfPage(pages, 9), 3);
  assert.equal(clampPdfPage(pages, -1), 1);
  assert.equal(clampPdfPage([{ page: 4 }, { page: 1 }], 2), 4);
});

test("candidate replacement drops deleted blocks and list items without reusing old source geometry", () => {
  const paper = { blocks: [{ id: "list", type: "list", source: [{ page: 2, box: [.1, .1, .9, .9] }], items: [
    { id: "retained", source: [{ page: 2, box: [.2, .2, .8, .3] }] },
  ] }] };
  const targets = [{ blockId: "removed", page: 2, box: [0, 0, 1, 1] },
    { blockId: "list", itemId: "deleted-item", page: 2, box: [0, 0, 1, 1] },
    { blockId: "list", itemId: "retained", page: 1, box: [0, 0, 1, 1] }];
  assert.deepEqual(reconcilePdfTargets(paper, targets, sourceRegions(paper)), [{ blockId: "list", itemId: "retained" }]);
});
