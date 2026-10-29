import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { validateDocument } from "../documents.mjs";
import { createWorkspaceServer } from "../server.mjs";
import { defaultPython } from "../resources.mjs";

function document(items, block = {}) {
  return { format: "continous-reader", schema: 2, id: "list-source-doc", revision: 1,
    meta: { title: "List source validation", language: "en" },
    blocks: [{ id: "list", type: "list", ordered: false, ...block, items }] };
}

test("list items validate their own PDF regions and inherit the list origin", async () => {
  const invalid = [
    { source: [{ page: 3 }] }, { source: [{ page: 0 }] }, { source: [{ page: 1.5 }] },
    { source: [{ page: 1, box: [0.2, 0.1, 0.1, 0.5] }] },
    { source: [{ page: 1, box: [0.1, 0.1, 1.1, 0.5] }] },
    { source: [{ page: 1, box: [0.1, 0.1, 0.5] }] }, { source: {} },
    { origin: "user" }, { origin: "unknown" },
  ];
  for (const fields of invalid) {
    await assert.rejects(validateDocument(document([{ id: "item", text: "Source item", ...fields }]), { pageCount: 2 }),
      (error) => error.code === "VALIDATION_FAILED", JSON.stringify(fields));
  }
  for (const fields of [{ source: [{ page: 1 }] }, { origin: "source" }, { origin: "user", source: [{ page: 1 }] }]) {
    await assert.rejects(validateDocument(document([{ id: "item", text: "Supplement", ...fields }], { origin: "user" }), { pageCount: 2 }),
      (error) => error.code === "VALIDATION_FAILED", JSON.stringify(fields));
  }
  const supplement = await validateDocument(document([{ id: "item", text: "Supplement", origin: "user", source: [] }], { origin: "user" }));
  assert.equal(supplement.index.find((entry) => entry.itemId).origin, "user");
  assert.deepEqual(supplement.index.find((entry) => entry.itemId).source, []);
});

test("list item indexes use explicit item geometry and only inherit omitted geometry", async () => {
  const inherited = [{ page: 1, box: [0.1, 0.1, 0.9, 0.6] }], own = [{ page: 2, box: [0.2, 0.2, 0.8, 0.4] }];
  const input = document([
    { id: "inherited", text: "Inherits list mapping" },
    { id: "specific", text: "Has precise mapping", source: own, origin: "source", translations: { zh: { text: "精确来源" } } },
    { id: "unmapped", text: "Explicitly unmapped", source: [] },
  ], { source: inherited });
  const before = structuredClone(input), result = await validateDocument(input, { pageCount: 2 });
  assert.deepEqual(input, before, "validation must not mutate caller input");
  assert.deepEqual(result.index.find((entry) => entry.itemId === "inherited").source, inherited);
  for (const entry of result.index.filter((entry) => entry.itemId === "specific")) {
    assert.equal(entry.blockId, "list"); assert.equal(entry.origin, "source"); assert.deepEqual(entry.source, own);
  }
  assert.equal(result.index.filter((entry) => entry.itemId === "specific").length, 2);
  assert.deepEqual(result.index.find((entry) => entry.itemId === "unmapped").source, []);
});

test("HTTP authoring rejects orphan and invalid item source mappings before publication", async (t) => {
  const taskTempRoot = resolve(tmpdir()), dataDir = await mkdtemp(join(taskTempRoot, "reader-list-source-test-"));
  const server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    await server.shutdown();
    const pathWithin = relative(taskTempRoot, resolve(dataDir));
    assert.ok(pathWithin && !isAbsolute(pathWithin) && !pathWithin.startsWith("..") && pathWithin.startsWith("reader-list-source-test-"));
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, status = 200) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const upload = async (bytes, filename, mediaType = "application/json") => {
    const response = await fetch(base + "/api/sources?filename=" + filename, { method: "POST", headers: { "Content-Type": mediaType }, body: bytes });
    const value = await response.json(); assert.equal(response.status, 201, JSON.stringify(value)); return value;
  };
  const originalPath = join(dataDir, "original.pdf");
  const created = spawnSync(defaultPython, ["-B", "-c", "import fitz,sys\nd=fitz.open()\np=d.new_page()\np.insert_text((50,80),'First list item')\nd.new_page()\nd.save(sys.argv[1])", originalPath], { encoding: "utf8", windowsHide: true });
  assert.equal(created.status, 0, created.stderr);
  const original = await upload(await readFile(originalPath), "original.pdf", "application/pdf");
  const input = { format: "reader-authoring-1", key: "list-only-source", meta: { title: "List only source", language: "en" },
    blocks: [{ key: "list", type: "list", ordered: false, items: [{ key: "first", text: "First list item", source: [{ page: 2, box: [0.1, 0.1, 0.8, 0.2] }] }] }] };
  const submit = async (value) => ({ authoringSourceId: (await upload(Buffer.from(JSON.stringify(value)), "authoring.json")).sourceId, resources: { "source.pdf": original.sourceId } });
  const orphan = await submit(input);
  assert.equal((await request("/api/authoring/validate", orphan, 400)).code, "SOURCE_REQUIRED");
  assert.equal((await request("/api/authoring/publish", { ...orphan, requestId: randomUUID() }, 400)).code, "SOURCE_REQUIRED");
  input.source = { path: "source.pdf", sha256: original.sha256, media_type: "application/pdf" };
  const invalid = [
    (value) => { value.blocks[0].items[0].source[0].page = 3; },
    (value) => { value.blocks[0].items[0].source[0].box = [0.8, 0.1, 0.2, 0.2]; },
    (value) => { value.blocks[0].origin = "user"; },
    (value) => { value.blocks[0].items[0].origin = "user"; },
  ];
  for (const mutate of invalid) {
    const value = structuredClone(input); mutate(value); const submission = await submit(value);
    assert.equal((await request("/api/authoring/validate", submission, 400)).code, "VALIDATION_FAILED");
    assert.equal((await request("/api/authoring/publish", { ...submission, requestId: randomUUID() }, 400)).code, "VALIDATION_FAILED");
  }
  assert.equal((await request("/api/workspace")).documents.length, 0);
  const valid = await submit(input), validation = await request("/api/authoring/validate", valid);
  assert.equal(validation.valid, true); assert.equal(validation.summary.pageCount, 2);
  const receipt = await request("/api/authoring/publish", { ...valid, requestId: randomUUID() }, 201);
  const saved = await request("/api/documents/" + receipt.document.id);
  assert.deepEqual(saved.document.blocks[0].items[0].source, input.blocks[0].items[0].source);
  const index = (await server.workspace.revision(receipt.document.id)).index;
  assert.deepEqual(index.find((entry) => entry.itemId).source, input.blocks[0].items[0].source);
});
