import assert from "node:assert/strict";
import test from "node:test";
import { sourceRegions, regionForBlock } from "../src/reading-position.js";
import { paragraphRegions } from "../src/pdf-paragraph-regions.js";

test("list item geometry comes only from authored sources, including page-only and excluded user items", () => {
  const paper = { blocks: [{ id: "list", type: "list", source: [{ page: 2, box: [.1, .1, .9, .8] }], items: [
    { id: "one", source: [{ page: 2, box: [.2, .2, .8, .3] }] },
    { id: "two", source: [{ page: 2 }] },
    { id: "own", origin: "user", source: [{ page: 2, box: [.1, .4, .9, .5] }] },
  ] }] };
  const before = JSON.stringify(paper);
  const derived = [
    { blockId: "list", itemId: "one", page: 2, box: [.1, .2, .9, .4] },
    { blockId: "list", itemId: "two", page: 2, box: [.2, .5, .8, .7] },
    { blockId: "list", itemId: "foreign", page: 2, box: [.1, .1, .9, .9] },
    { blockId: "list", itemId: "own", page: 2, box: [.1, .1, .9, .9] },
  ];
  const regions = sourceRegions(paper, derived);
  assert.equal(regions.length, 3);
  assert.deepEqual(regionForBlock(regions, "list", 2, "one").box, [.2, .2, .8, .3]);
  assert.equal(regionForBlock(regions, "list", 2, "two").box, undefined);
  assert.deepEqual(paragraphRegions(regions).map((item) => item.itemId), ["one"]);
  assert.deepEqual(regions, sourceRegions(paper));
  assert.equal(JSON.stringify(paper), before);
});

test("item envelopes stay separate across siblings and pages while merging a single item's lines", () => {
  const regions = [
    { blockId: "list", itemId: "one", page: 2, box: [.2, .2, .7, .22] },
    { blockId: "list", itemId: "one", page: 2, box: [.2, .23, .8, .25] },
    { blockId: "list", itemId: "two", page: 2, box: [.2, .3, .8, .4] },
    { blockId: "list", itemId: "two", page: 3, box: [.2, .1, .8, .2] },
  ];
  const areas = paragraphRegions(regions);
  assert.equal(areas.length, 3);
  assert.deepEqual(areas[0].box, [.2, .2, .8, .25]);
  assert.equal(regionForBlock(regions, "list", 3, "two").page, 3);
  assert.equal(regionForBlock(regions, "list", 2).itemId, "one");
});
