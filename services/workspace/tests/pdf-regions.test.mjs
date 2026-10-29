import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { defaultPython, PDF_REGION_ALGORITHM_VERSION, ResourceFiles, runPdf } from "../resources.mjs";
import { createWorkspaceServer } from "../server.mjs";

const fixtureRoot = fileURLToPath(new URL("../../../prototypes/insight-composer/public/articles/attention-is-all-you-need/", import.meta.url));
const sourcePath = join(fixtureRoot, "source.pdf");
const mapped = (regions, id) => regions.filter((region) => region.blockId === id && region.box);

test("derived regions map real paragraphs, split pages and source markup without changing content", async () => {
  const paper = JSON.parse(await readFile(join(fixtureRoot, "document.json"), "utf8"));
  const before = JSON.stringify(paper);
  const { regions } = await runPdf({ action: "regions", path: sourcePath, blocks: paper.blocks });
  assert.equal(JSON.stringify(paper), before);
  const hardware = mapped(regions, "S5.SS2.p1.1");
  assert.equal(hardware.length, 5);
  assert.ok(hardware.every((region) => region.page === 7 && region.provenance === "pdf-text"));
  // The region lies beneath the hardware heading, above the optimizer heading.
  assert.ok(hardware.every((region) => region.box[1] > .60 && region.box[3] < .69));
  for (const [id, pages] of [["S3.SS2.p1.1", [3, 4]], ["S3.SS2.SSS2.p1.1", [4, 5]], ["S6.SS2.p1.1", [8, 9]], ["S6.SS3.p3.1", [9, 10]]]) {
    assert.deepEqual([...new Set(mapped(regions, id).map((region) => region.page))], pages);
  }
  for (const region of regions.filter((region) => region.box)) {
    assert.ok(region.box.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
    assert.ok(region.box[0] < region.box[2] && region.box[1] < region.box[3]);
  }
  const paragraphs = paper.blocks.filter((block) => block.type === "para");
  assert.ok(paragraphs.filter((block) => mapped(regions, block.id).length).length >= 100);
});

test("mapping rejects ambiguous, wrong-page and missing text, retains explicit coordinates and rotated crop geometry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reader-region-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, "matching.pdf");
  const generated = spawnSync(defaultPython, ["-B", "-c", `import fitz,sys
doc=fitz.open()
p=doc.new_page(width=400,height=500)
p.insert_text((70,100),'Unique mapped text on rotated cropped paper.',fontsize=12)
p.insert_text((70,160),'Duplicated heading',fontsize=12)
p.insert_text((70,200),'Duplicated heading',fontsize=12)
p.set_cropbox(fitz.Rect(40,50,360,450))
p.set_rotation(90)
doc.new_page(width=400,height=500)
doc.save(sys.argv[1])`, fixture], { encoding: "utf8", windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  const explicit = [.2, .2, .7, .4];
  const blocks = [
    { id: "unique", type: "para", text: "Unique mapped text on rotated cropped paper.", source: [{ page: 1 }] },
    { id: "duplicate", type: "heading", text: "Duplicated heading", source: [{ page: 1 }] },
    { id: "absent", type: "para", text: "Completely unrelated invented prose must never highlight random source text.", source: [{ page: 1 }] },
    { id: "wrong-page", type: "para", text: "Unique mapped text on rotated cropped paper.", source: [{ page: 2 }] },
    { id: "explicit", type: "figure", source: [{ page: 1, box: explicit }] },
    { id: "caption-only", type: "figure", text: "Unique mapped text on rotated cropped paper.", source: [{ page: 1 }] },
    { id: "user", type: "para", origin: "user", text: "Unique mapped text on rotated cropped paper.", source: [{ page: 1 }] },
  ];
  const { regions } = await runPdf({ action: "regions", path: fixture, blocks });
  assert.equal(mapped(regions, "unique").length, 1);
  const box = mapped(regions, "unique")[0].box;
  assert.ok(box[0] > .8 && box[1] < .15 && box[2] < 1 && box[3] > .7, JSON.stringify(box));
  for (const id of ["duplicate", "absent", "wrong-page", "caption-only"]) {
    assert.equal(mapped(regions, id).length, 0, id);
    assert.equal(regions.filter((region) => region.blockId === id).length, 1, id);
  }
  assert.deepEqual(mapped(regions, "explicit")[0].box, explicit);
  assert.equal(mapped(regions, "explicit")[0].provenance, "source");
  assert.ok(!regions.some((region) => region.blockId === "user"));

  const resources = new ResourceFiles(directory); await resources.initialize();
  const file = await resources.putPath(fixture);
  const first = await resources.regions(file, { blocks: blocks.slice(0, 1) });
  const changed = await resources.regions(file, { blocks: [{ ...blocks[0], text: "Changed source content has no corresponding passage in this original PDF." }] });
  assert.equal(mapped(first, "unique").length, 1);
  assert.equal(mapped(changed, "unique").length, 0);
});

test("PDF HTTP manifest reads only revision-bound authored sources and leaves page-only locations intact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reader-region-http-"));
  const server = await createWorkspaceServer({ dataDir: directory, bootstrap: true, glossaryPath: false, staticRoot: false });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => { await server.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/documents/doc_attention_is_all_you_need_v7`;
  const before = await (await fetch(base + "/export?revision=2")).text();
  server.workspace.resources.regions = () => { throw new Error("Reading must not infer source rectangles"); };
  const response = await fetch(base + "/pdf?revision=2");
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.equal(manifest.pages.length, 15);
  assert.equal(mapped(manifest.regions, "S5.SS2.p1.1").length, 0);
  assert.ok(manifest.regions.some((region) => region.blockId === "S5.SS2.p1.1" && region.page === 7 && !region.box));
  for (const [id, page] of [["S4.T1", 6], ["S6.T2", 8], ["S6.T3", 9], ["S6.T4", 10]]) {
    const source = JSON.parse(before).blocks.find((block) => block.id === id).source;
    const stored = manifest.regions.filter((region) => region.blockId === id);
    assert.deepEqual(stored.map(({ page, box }) => ({ page, ...(box ? { box } : {}) })), source);
    assert.ok(stored.some((region) => region.page === page));
    assert.ok(stored.every((region) => !region.provenance));
  }
  assert.match(manifest.pages[0].imageUrl, /revision=2$/);
  assert.equal(manifest.sourceHash, JSON.parse(before).source.sha256);
  const after = await (await fetch(base + "/export?revision=2")).text();
  assert.equal(after, before);
});

test("all real source tables and semantic HTML Table 3 match complete PDF borders, independently of captions and ids", async () => {
  const papers = await Promise.all(["document.json", "document.html-sample.json"].map(async (name) => JSON.parse(await readFile(join(fixtureRoot, name), "utf8"))));
  const expected = {
    "S4.T1": [6, [118.57 / 612, 113.24 / 792, 493.43 / 612, 186.88 / 792]],
    "S6.T2": [8, [130.69 / 612, 94.52 / 792, 481.31 / 612, 243.61 / 792]],
    "S6.T3": [9, [108 / 612, 129.87 / 792, 508.74 / 612, 384.18 / 792]],
    "S6.T4": [10, [145.05 / 612, 93.94 / 792, 466.96 / 612, 236.57 / 792]],
  };
  for (const paper of papers) {
    const blocks = paper.blocks.filter((block) => block.type === "table" || block.type === "html");
    // Captions and identities are not matching evidence; the actual table body is.
    const inputs = blocks.map((block, index) => ({ ...block, id: "unrelated-id-" + index, caption: "No caption matching evidence", html: block.html?.replace(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/, "") }));
    const before = JSON.stringify(inputs);
    const { regions } = await runPdf({ action: "regions", path: sourcePath, blocks: inputs });
    assert.equal(JSON.stringify(inputs), before);
    for (let index = 0; index < blocks.length; index++) {
      const entries = mapped(regions, inputs[index].id), [page, box] = expected[blocks[index].id];
      assert.equal(entries.length, 1, blocks[index].id);
      assert.equal(entries[0].page, page);
      assert.equal(entries[0].provenance, "pdf-table");
      entries[0].box.forEach((value, coordinate) => assert.ok(Math.abs(value - box[coordinate]) < .0001, `${blocks[index].id}: ${entries[0].box}`));
    }
  }
});

test("table mapping rejects duplicate candidates, wrong pages/content and numeric lookalikes, and respects crop/rotation and explicit boxes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reader-table-regions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, "tables.pdf");
  const generated = spawnSync(defaultPython, ["-B", "-c", `import fitz,json,sys
doc=fitz.open()
def table(page,top=100):
 for y in [top,top+25,top+80]: page.draw_line((80,y),(380,y),width=.5)
 for values,y in [(['Name','Value','Rate'],top+18),(['Alpha','-5','1.2'],top+43),(['Beta','12','20%'],top+68)]:
  for value,x in zip(values,[90,225,300]): page.insert_text((x,y),value,fontsize=10)
page=doc.new_page(width=600,height=700); table(page)
page=doc.new_page(width=600,height=700); table(page,80); table(page,300)
page=doc.new_page(width=600,height=700); page.insert_text((80,100),'Name Value Rate Alpha -5 1.2 Beta 12 20%',fontsize=10)
expected=[]
for rotation in [0,90,180,270]:
 page=doc.new_page(width=600,height=700); table(page)
 page.set_cropbox(fitz.Rect(40,40,500,600)); page.set_rotation(rotation)
 box=fitz.Rect(40,60,340,140)*page.rotation_matrix
 expected.append([box.x0/page.rect.width,box.y0/page.rect.height,box.x1/page.rect.width,box.y1/page.rect.height])
doc.save(sys.argv[1]); print(json.dumps(expected))`, fixture], { encoding: "utf8", windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  const expected = JSON.parse(generated.stdout);
  const base = { id: "table", type: "table", head: [["Name", "Value", "Rate"]], rows: [["Alpha", "-5", "1.2"], ["Beta", "12", "20%"]], source: [{ page: 1 }] };
  const html = '<figure><figcaption>Ignored caption</figcaption><table><thead><tr><th>Name</th><th>Value</th><th>Rate</th></tr></thead><tbody><tr><th scope="row">Alpha</th><td><span data-tex="-5"></span></td><td>1.2</td></tr><tr><th scope="row">Beta</th><td>12</td><td>20%</td></tr></tbody></table></figure>';
  const explicit = [.1, .2, .7, .6];
  const blocks = [base,
    { ...base, id: "duplicate", source: [{ page: 2 }] },
    { ...base, id: "wrong-page", source: [{ page: 3 }] },
    { ...base, id: "wrong-content", rows: [["Gamma", "700", "3.8"], ["Delta", "100", "90%"]] },
    { ...base, id: "minus-lookalike", rows: [["Alpha", "5", "1.2"], ["Beta", "12", "20%"]] },
    { ...base, id: "decimal-lookalike", rows: [["Alpha", "-5", "12"], ["Beta", "12", "20%"]] },
    { ...base, id: "percent-lookalike", rows: [["Alpha", "-5", "1.2"], ["Beta", "12", "20"]] },
    { ...base, id: "wrong-association", rows: [["Beta", "-5", "1.2"], ["Alpha", "12", "20%"]] },
    { ...base, id: "caption-only", rows: [], caption: "Name Value Rate Alpha -5 1.2 Beta 12 20%" },
    { ...base, id: "explicit", rows: [], source: [{ page: 1, box: explicit }] },
    { id: "html", type: "html", role: "table", html, source: [{ page: 1 }] },
    ...expected.map((box, index) => ({ ...base, id: "rotation-" + index, source: [{ page: index + 4 }] })),
  ];
  const { regions } = await runPdf({ action: "regions", path: fixture, blocks });
  for (const id of ["table", "html"]) assert.equal(mapped(regions, id).length, 1, id);
  for (const id of ["duplicate", "wrong-page", "wrong-content", "minus-lookalike", "decimal-lookalike", "percent-lookalike", "wrong-association", "caption-only"]) assert.equal(mapped(regions, id).length, 0, id);
  assert.deepEqual(mapped(regions, "explicit")[0].box, explicit);
  assert.equal(mapped(regions, "explicit")[0].provenance, "source");
  for (let index = 0; index < expected.length; index++) {
    const entries = mapped(regions, "rotation-" + index);
    assert.equal(entries.length, 1, "rotation " + index);
    entries[0].box.forEach((value, coordinate) => assert.ok(Math.abs(value - expected[index][coordinate]) < .0001));
  }
  const resources = new ResourceFiles(directory); await resources.initialize();
  const file = await resources.putPath(fixture);
  const standard = await resources.regions(file, { blocks: [base] });
  const changedHead = await resources.regions(file, { blocks: [{ ...base, head: [["Unrelated", "Header", "Columns"]] }] });
  const changedBody = await resources.regions(file, { blocks: [{ ...base, rows: [["Gamma", "700", "3.8"], ["Delta", "100", "90%"]] }] });
  const semantic = await resources.regions(file, { blocks: [blocks.find((block) => block.id === "html")] });
  const changedHtml = await resources.regions(file, { blocks: [{ ...blocks.find((block) => block.id === "html"), html: html.replace("Alpha", "Gamma") }] });
  assert.equal(mapped(standard, "table").length, 1);
  assert.equal(mapped(changedHead, "table").length, 0);
  assert.equal(mapped(changedBody, "table").length, 0);
  assert.equal(mapped(semantic, "html").length, 1);
  assert.equal(mapped(changedHtml, "html").length, 0);
  assert.ok([...resources.regionMaps.keys()].every((key) => key.startsWith(PDF_REGION_ALGORITHM_VERSION + ":")));
});

test("whole-table geometry retains short upper header rows and every repeated body row", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reader-table-boundaries-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, "boundaries.pdf");
  const generated = spawnSync(defaultPython, ["-B", "-c", `import fitz,sys
doc=fitz.open(); page=doc.new_page(width=400,height=500)
for y in [100,130,160,220]: page.draw_line((50,y),(350,y),width=.5)
for values,y in [(['A','B'],120),(['Method','Accuracy'],150),(['Alpha','0.81'],180),(['Beta','0.90'],210)]:
 for value,x in zip(values,[60,220]): page.insert_text((x,y),value,fontsize=10)
page=doc.new_page(width=400,height=500)
for y in [100,130,160,190]: page.draw_line((50,y),(350,y),width=.5)
for values,y in [(['Type','State'],120),(['Alpha','Ready'],150),(['Alpha','Ready'],180)]:
 for value,x in zip(values,[60,220]): page.insert_text((x,y),value,fontsize=10)
page=doc.new_page(width=400,height=500)
for y in [100,130,190]: page.draw_line((50,y),(350,y),width=.5)
for values,y in [(['Model','Value'],120),(['Control','1.234'],150),(['Other','2.345'],180)]:
 for value,x in zip(values,[60,220]): page.insert_text((x,y),value,fontsize=10)
page=doc.new_page(width=400,height=500)
for y in [100,130,190]: page.draw_line((50,y),(350,y),width=.5)
for values,y in [(['Model','Ratio'],120),(['Alpha','12'],150),(['Beta','34'],180)]:
 for value,x in zip(values,[60,220]): page.insert_text((x,y),value,fontsize=10)
doc.save(sys.argv[1])`, fixture], { encoding: "utf8", windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  const blocks = [
    { id: "multi-header", type: "table", head: [["A", "B"], ["Method", "Accuracy"]], rows: [["Alpha", "0.81"], ["Beta", "0.90"]], source: [{ page: 1 }] },
    { id: "repeat-rows", type: "table", head: [["Type", "State"]], rows: [["Alpha", "Ready"], ["Alpha", "Ready"]], source: [{ page: 2 }] },
    { id: "row-labels", type: "table", head: [["Model", "Value"]], rows: [["Control", "1.234"], ["Other", "2.345"]], source: [{ page: 3 }] },
    { id: "wrong-repeated-label", type: "table", head: [["Model", "Value"]], rows: [["Control", "1.234"], ["Control", "2.345"]], source: [{ page: 3 }] },
    { id: "integer-values", type: "table", head: [["Model", "Ratio"]], rows: [["Alpha", "12"], ["Beta", "34"]], source: [{ page: 4 }] },
    { id: "fraction-lookalike", type: "table", head: [["Model", "Ratio"]], rows: [["Alpha", "1/2"], ["Beta", "3/4"]], source: [{ page: 4 }] },
    { id: "tex-fraction-lookalike", type: "table", head: [["Model", "Ratio"]], rows: [["Alpha", "$\\frac{1}{2}$"], ["Beta", "$\\frac{3}{4}$"]], source: [{ page: 4 }] },
  ];
  const { regions } = await runPdf({ action: "regions", path: fixture, blocks });
  assert.deepEqual(mapped(regions, "multi-header")[0]?.box, [.125, .2, .875, .44]);
  assert.deepEqual(mapped(regions, "repeat-rows")[0]?.box, [.125, .2, .875, .38]);
  for (const id of ["row-labels", "integer-values"]) assert.equal(mapped(regions, id).length, 1, id);
  for (const id of ["wrong-repeated-label", "fraction-lookalike", "tex-fraction-lookalike"]) assert.equal(mapped(regions, id).length, 0, id);
});
