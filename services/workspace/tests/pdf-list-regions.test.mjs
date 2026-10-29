import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { defaultPython, ResourceFiles, runPdf } from "../resources.mjs";

const fixtureRoot = fileURLToPath(new URL("../../../prototypes/insight-composer/public/articles/attention-is-all-you-need/", import.meta.url));
const boxed = (regions, id, itemId) => regions.filter((region) => region.blockId === id && (itemId === undefined || region.itemId === itemId) && region.box);

test("original-paper list items get independent regions and exact bold headings fill repeated-word gaps", async () => {
  const paper = JSON.parse(await readFile(join(fixtureRoot, "document.html-sample.json"), "utf8"));
  const before = JSON.stringify(paper);
  const { regions } = await runPdf({ action: "regions", path: join(fixtureRoot, "source.pdf"), blocks: paper.blocks });
  assert.equal(JSON.stringify(paper), before);
  const list = paper.blocks.find((block) => block.id === "S3.I1");
  const items = list.items.map((item) => boxed(regions, list.id, item.id));
  assert.deepEqual(items.map((entries) => entries.length), [5, 4, 5]);
  assert.ok(items.flat().every((entry) => entry.page === 5 && entry.provenance === "pdf-text"));
  assert.ok(Math.max(...items[0].map((entry) => entry.box[3])) < Math.min(...items[1].map((entry) => entry.box[1])));
  assert.ok(Math.max(...items[1].map((entry) => entry.box[3])) < Math.min(...items[2].map((entry) => entry.box[1])));
  assert.ok(!regions.some((region) => region.blockId === list.id && !region.itemId), "precise children must not be hidden under a duplicate parent hit area");
  for (const block of paper.blocks.filter((block) => block.type === "heading")) assert.ok(boxed(regions, block.id).length, block.id);
  for (const id of ["S3", "S3.SS1.SSS0.Px1", "S5", "S6"]) assert.equal(boxed(regions, id)[0].provenance, "pdf-heading");
});

test("list matching keeps item scopes, explicit boxes, crop/rotation and rejects ambiguity; heading fallback needs unique bold evidence", async (t) => {
  const tempRoot = resolve(tmpdir()), directory = await mkdtemp(join(tempRoot, "reader-pdf-list-test-"));
  t.after(async () => { const within = relative(tempRoot, resolve(directory)); assert.ok(within && !isAbsolute(within) && !within.startsWith("..") && within.startsWith("reader-pdf-list-test-")); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, "list.pdf");
  const generated = spawnSync(defaultPython, ["-B", "-c", `import fitz,sys
d=fitz.open()
p=d.new_page(width=400,height=500)
p.insert_text((60,70),'First unique list item from the source.',fontsize=10)
p.insert_text((60,110),'Duplicated list item without unique evidence.',fontsize=10)
p.insert_text((60,140),'Duplicated list item without unique evidence.',fontsize=10)
p.insert_text((60,180),'Short',fontsize=12,fontname='hebo')
p.insert_text((60,210),'Short',fontsize=10)
p.insert_text((60,240),'Repeat',fontsize=12,fontname='hebo')
p.insert_text((60,270),'Repeat',fontsize=12,fontname='hebo')
p.insert_text((60,300),'Plain',fontsize=10)
p.insert_text((60,340),'Cross-page list item begins here.',fontsize=10)
p.set_cropbox(fitz.Rect(40,40,360,460)); p.set_rotation(90)
p=d.new_page(width=400,height=500)
p.insert_text((60,70),'The same list item finishes here.',fontsize=10)
d.save(sys.argv[1])`, path], { encoding: "utf8", windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  const explicit = [.2, .2, .7, .3];
  const blocks = [
    { id: "list", type: "list", source: [{ page: 1 }], items: [
      { id: "first", text: "First unique list item from the source." },
      { id: "duplicate", text: "Duplicated list item without unique evidence." },
      { id: "wrong-page", text: "First unique list item from the source.", source: [{ page: 2 }] },
      { id: "explicit", text: "An explicit source region is authoritative.", source: [{ page: 2, box: explicit }] },
      { id: "empty", text: "No item mapping", source: [] },
      { id: "split", text: "Cross-page list item begins here. The same list item finishes here.", source: [{ page: 1 }, { page: 2 }] },
    ] },
    { id: "item-only", type: "list", items: [{ id: "item-only-child", text: "The same list item finishes here.", source: [{ page: 2 }] }] },
    { id: "user-list", type: "list", origin: "user", source: [{ page: 1 }], items: [{ id: "user-item", text: "First unique list item from the source." }] },
    { id: "short-heading", type: "heading", text: "Short", source: [{ page: 1 }] },
    { id: "ambiguous-heading", type: "heading", text: "Repeat", source: [{ page: 1 }] },
    { id: "nonbold-heading", type: "heading", text: "Plain", source: [{ page: 1 }] },
    { id: "wrong-page-heading", type: "heading", text: "Short", source: [{ page: 2 }] },
  ];
  const { regions } = await runPdf({ action: "regions", path, blocks });
  assert.equal(boxed(regions, "list", "first").length, 1);
  assert.ok(boxed(regions, "list", "first")[0].box[0] > .9, "rotation must be applied to item geometry");
  assert.equal(boxed(regions, "list", "duplicate").length, 0);
  assert.equal(boxed(regions, "list", "wrong-page").length, 0);
  assert.deepEqual(boxed(regions, "list", "explicit")[0].box, explicit);
  assert.equal(boxed(regions, "list", "explicit")[0].provenance, "source");
  assert.ok(!regions.some((region) => region.itemId === "empty"));
  assert.deepEqual([...new Set(boxed(regions, "list", "split").map((region) => region.page))], [1, 2]);
  assert.equal(boxed(regions, "item-only", "item-only-child").length, 1);
  assert.ok(!regions.some((region) => region.blockId === "user-list"));
  assert.equal(boxed(regions, "short-heading")[0].provenance, "pdf-heading");
  for (const id of ["ambiguous-heading", "nonbold-heading", "wrong-page-heading"]) assert.equal(boxed(regions, id).length, 0, id);
  for (const region of regions.filter((entry) => entry.box)) assert.ok(region.box.every((number) => number >= 0 && number <= 1));

  const resources = new ResourceFiles(directory); await resources.initialize(); const file = await resources.putPath(path);
  const first = await resources.regions(file, { blocks: [blocks[0]] });
  const changedText = structuredClone(blocks[0]); changedText.items[0].text = "This unrelated item cannot be found in this source PDF.";
  const changedSource = structuredClone(blocks[0]); changedSource.items[0].source = [{ page: 2 }];
  assert.equal(boxed(first, "list", "first").length, 1);
  assert.equal(boxed(await resources.regions(file, { blocks: [changedText] }), "list", "first").length, 0);
  assert.equal(boxed(await resources.regions(file, { blocks: [changedSource] }), "list", "first").length, 0);
});
