import test from "node:test";
import assert from "node:assert/strict";
import { documentSourceRegions } from "../document-sources.mjs";
import { Workspace } from "../workspace-core.mjs";

test("saved source geometry retains page-only, item and cross-page identities without inference", () => {
  const document = { blocks: [
    { id: "paragraph", source: [{ page: 2 }, { page: 3, box: [0.1, 0.2, 0.8, 0.3] }] },
    { id: "list", source: [{ page: 1 }], items: [{ id: "item", source: [{ page: 1, box: [0.2, 0.1, 0.7, 0.2] }] }, { id: "supplement", origin: "user", source: [{ page: 1 }] }] },
    { id: "user", origin: "user", source: [{ page: 1 }] },
  ] };
  const before = structuredClone(document), regions = documentSourceRegions(document);
  assert.equal(regions.length, 4);
  assert.deepEqual(regions.map(({ blockId, itemId, page }) => [blockId, itemId, page]), [["list", "item", 1], ["list", undefined, 1], ["paragraph", undefined, 2], ["paragraph", undefined, 3]]);
  assert.equal(Object.hasOwn(regions[2], "box"), false);
  assert.deepEqual(regions[3].box, [0.1, 0.2, 0.8, 0.3]);
  assert.deepEqual(document, before);
});

test("local Agent page resource convenience never calls runtime region matching", async () => {
  const resources = { manifest: async () => ({ pages: [{ page: 1, width: 600, height: 800 }] }),
    regions: () => { throw new Error("source inference must not run"); }, page: () => { throw new Error("page image must not render for metadata"); } };
  const workspace = new Workspace({ resources });
  const saved = { document: { source: { path: "source.pdf" }, blocks: [{ id: "p", source: [{ page: 1 }] }] }, resourceMap: { "source.pdf": { mediaType: "application/pdf", sha256: "a".repeat(64) } } };
  const result = await workspace.resourceForSaved(saved, { kind: "pdf" }, "/api/documents/doc", "?revision=2");
  assert.equal(result.sourceUrl, "/api/documents/doc/assets/source.pdf?revision=2");
  assert.deepEqual(result.regions, [{ blockId: "p", page: 1, regionIndex: 0 }]);
  assert.equal(result.pages[0].imageUrl, "/api/documents/doc/pages/1.png?revision=2");
});
