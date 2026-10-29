import test from "node:test";
import assert from "node:assert/strict";
import { citationCandidateDetails, citationHash, citationIndex, externalReferenceUrl, incomingCitationSources, referencePreviewPosition } from "../src/citation-relations.js";

test("only explicit reference targets resolve and list/node identities do not collapse into their block", () => {
  const paragraph = { id: "a", source: { blockId: "ref1" }, status: "linked" };
  const item = { id: "b", source: { blockId: "references", itemId: "ref2" }, status: "unresolved" };
  const node = { id: "c", source: { blockId: "html-refs", nodeId: "ref3" }, status: "candidate" };
  const removed = { id: "d", source: { blockId: "old" }, status: "stale", sourceMissing: true };
  const changed = { id: "e", source: { blockId: "changed" }, status: "stale" };
  const index = citationIndex({ outgoing: [paragraph, item, node, removed, changed] });
  assert.equal(index.byTarget.get("ref1"), paragraph);
  assert.equal(index.byTarget.get("ref2"), item);
  assert.equal(index.byTarget.get("ref3"), node);
  assert.equal(index.byTarget.has("references"), false);
  assert.equal(index.byTarget.has("html-refs"), false);
  assert.equal(index.byTarget.has("old"), false);
  assert.equal(index.byId.has("d"), false);
  assert.equal(index.byTarget.get("changed"), changed);
  assert.equal(citationIndex(null).byId.size, 0);
});

test("hash resolution does not reinterpret external addresses or malformed encodings", () => {
  assert.equal(citationHash("#bib.bib11"), "bib.bib11");
  assert.equal(citationHash("#ref%3A2"), "ref:2");
  assert.equal(citationHash("#bad%ZZ"), null);
  assert.equal(citationHash("https://example.org/#ref1"), null);
});

test("external links are constructed only from validated academic identifiers", () => {
  assert.equal(externalReferenceUrl({ identifiers: { doi: "https://doi.org/10.1000/Example" } }), "https://doi.org/10.1000/Example");
  assert.equal(externalReferenceUrl({ identifiers: { doi: "10.1000/ref?part#one" } }), "https://doi.org/10.1000/ref%3Fpart%23one");
  assert.equal(externalReferenceUrl({ identifiers: { arxiv: "1512.03385v1" } }), "https://arxiv.org/abs/1512.03385v1");
  assert.equal(externalReferenceUrl({ identifiers: { arxiv: "hep-th/9901001" } }), "https://arxiv.org/abs/hep-th/9901001");
  assert.equal(externalReferenceUrl({ identifiers: { doi: "javascript:alert(1)", arxiv: "https://evil.example/1512.03385" } }), null);
  assert.equal(externalReferenceUrl({ identifiers: { doi: "10.1000/<script>" } }), null);
  assert.equal(externalReferenceUrl({ identifiers: { doi: "10.1000/" + String.fromCharCode(0xd800) } }), null);
  assert.equal(externalReferenceUrl({}), null);
});

test("preview stays inside desktop viewport near bottom and beside narrow reading panes", () => {
  const viewport = { width: 1000, height: 700 };
  const placed = referencePreviewPosition({ left: 850, top: 590, bottom: 610 }, { width: 384, height: 240 }, viewport, 72);
  assert.equal(placed.left, 604);
  assert.equal(placed.top, 342);
  assert.ok(placed.left + placed.width <= viewport.width - 12);
  const tall = referencePreviewPosition({ left: 100, top: 100, bottom: 150 }, { width: 384, height: 1000 }, viewport, 72);
  assert.ok(tall.top >= 72);
  assert.ok(tall.top + tall.maxHeight <= viewport.height);
});

test("backlinks preserve distinct occurrences while coalescing bilingual copies", () => {
  const source = { blockId: "p1", variant: "source", field: "text", start: 2, end: 8 };
  const second = { ...source, start: 20, end: 26 };
  const result = incomingCitationSources({ occurrences: [{ ...source, variant: "zh-CN", start: 81, end: 85 }, source, second, { blockId: "p2", variant: "source" }] });
  assert.equal(result.length, 3);
  assert.equal(result[0], source);
  assert.equal(result[1], second);
  assert.deepEqual(incomingCitationSources({ source }), [source]);
  assert.deepEqual(incomingCitationSources({}), []);
  assert.equal(incomingCitationSources({ occurrences: [{ ...source, variant: "zh-CN" }, { ...source, variant: "de", start: 30, end: 40 }] }).length, 1);
});

test("candidate evidence exposes conflicting publication years instead of implying identity", () => {
  const result = citationCandidateDetails({ authors: "Kaiming He, Xiangyu Zhang", year: 2015, evidence: [
    { kind: "title", match: "exact" }, { kind: "difference", field: "year", reference: 2016, document: 2015 },
  ] });
  assert.equal(result.metadata, "Kaiming He, Xiangyu Zhang · 2015");
  assert.deepEqual(result.differences, ["年份不同：引用 2016 · 库内 2015"]);
  assert.deepEqual(citationCandidateDetails({ evidence: [{ kind: "conflict", field: "doi" }] }).differences, ["DOI存在冲突，需核对"]);
});
