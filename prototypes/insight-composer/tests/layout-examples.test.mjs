import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { compileInput, validateDocument } from "../../../services/workspace/documents.mjs";
import { prepareReaderDocument, parseHtml } from "../src/html-content.js";

const root = new URL("../../../services/workspace/authoring-examples/", import.meta.url);
const bytes = (path) => readFile(new URL(path, root));
const json = async (path) => JSON.parse((await bytes(path)).toString("utf8"));
const manifest = await json("manifest.json");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function fixture(descriptor) {
  const input = await json(descriptor.input), resourceMap = {};
  for (const resource of descriptor.resources) {
    const content = await bytes(resource.path);
    assert.equal(content.length, resource.size, resource.path);
    assert.equal(sha256(content), resource.sha256, resource.path);
    assert.equal(resource.mediaType, "image/png");
    assert.equal(content.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.ok(content.readUInt32BE(16) >= 600 && content.readUInt32BE(20) >= 400, "usable diagram dimensions");
    resourceMap[resource.path] = { sha256: resource.sha256, size: resource.size };
  }
  const compiled = await compileInput(input);
  const checked = await validateDocument(compiled.document, { resourceMap });
  return { input, compiled, checked, resourceMap };
}

test("downloadable layout examples are complete inputs with real local assets and matching bilingual identities", async () => {
  assert.equal(manifest.examples.length, 5);
  let bilingual = 0;
  for (const descriptor of manifest.examples) {
    const { input, compiled, checked } = await fixture(descriptor);
    assert.equal(input.source, undefined, "illustrations must not pretend to have an uploaded original");
    assert.ok(input.blocks.every((block) => !block.source));
    assert.equal(compiled.report.result, "PASS", descriptor.id);
    assert.deepEqual(compiled.report.warnings, [], descriptor.id);
    assert.deepEqual(checked.report.diagnostics, [], descriptor.id);
    assert.deepEqual([...checked.assets].sort(), descriptor.resources.map((resource) => resource.path).sort());
    assert.equal(compiled.report.custom_css_blocks, 0);
    const prepared = await prepareReaderDocument(compiled.document);
    for (const block of prepared.blocks.filter((block) => block.type === "html")) {
      assert.ok(!block.compiledHtml.error, descriptor.id);
      for (const [language, variant] of Object.entries(block.compiledHtml.variants)) {
        if (language === "source") continue;
        assert.deepEqual(Object.keys(variant.index).sort(), Object.keys(block.compiledHtml.source.index).sort(), descriptor.id);
        assert.equal(block.compiledHtml.translationStates[language], "current");
      }
    }
    if (descriptor.languages.includes("zh-CN")) {
      bilingual++;
      const translated = checked.index.filter((entry) => entry.variant === "zh-CN");
      assert.ok(translated.length > 1 && translated.every((entry) => entry.translationState === "current"));
    }
  }
  assert.ok(bilingual >= 2);
});

test("shared pair-to-stack changes preserve node identities, links and current translations", async () => {
  const { input, compiled, resourceMap } = await fixture(manifest.examples.find((item) => item.id === "image-text"));
  const changed = structuredClone(input), object = changed.blocks.find((block) => block.type === "html");
  object.html = object.html.replaceAll("layout-pair", "layout-stack");
  for (const value of Object.values(object.translations)) value.html = value.html.replaceAll("layout-pair", "layout-stack");
  const next = await compileInput(changed, { document: compiled.document, identity: compiled.identity });
  const oldBlock = compiled.document.blocks.find((block) => block.type === "html");
  const newBlock = next.document.blocks.find((block) => block.type === "html");
  assert.equal(newBlock.id, oldBlock.id);
  assert.deepEqual(Object.keys(parseHtml(newBlock.html).index), Object.keys(parseHtml(oldBlock.html).index));
  assert.equal(newBlock.translations["zh-CN"].source_hash, oldBlock.translations["zh-CN"].source_hash);
  const checked = await validateDocument(next.document, { resourceMap });
  assert.deepEqual(checked.report.danglingLinks, []);
  assert.equal(next.report.internal_links, 2);
  assert.ok(checked.index.filter((entry) => entry.variant === "zh-CN").every((entry) => entry.translationState === "current"));
});

test("grouped-table and procedure examples retain semantic spans, genuine blanks and code order", async () => {
  const { compiled: table } = await fixture(manifest.examples.find((item) => item.id === "grouped-table"));
  const tableBlock = table.document.blocks.find((block) => block.type === "html");
  const cells = Object.values(parseHtml(tableBlock.html).index);
  assert.equal(cells.filter((cell) => cell.ast.attrs.rowspan === "2").length, 3);
  assert.equal(cells.filter((cell) => cell.ast.attrs.colspan === "2").length, 1);
  const blank = cells.find((cell) => cell.ast.tag === "td" && cell.text === "");
  assert.ok(blank && blank.ast.attrs.headers, "the missing measurement keeps its cell and header relationships");
  const { compiled: steps } = await fixture(manifest.examples.find((item) => item.id === "steps-notes"));
  const nodes = Object.values(parseHtml(steps.document.blocks.find((block) => block.type === "html").html).index);
  assert.deepEqual(nodes.filter((node) => node.ast.tag === "li").map((node) => node.text), [
    "Check that every weight is nonnegative and the total weight is positive.",
    "Multiply each value by its weight, then add those products.",
    "Divide the sum of products by the total weight.",
  ]);
  assert.equal(nodes.find((node) => node.ast.tag === "pre").text, "total = sum(weights)\nrequire total > 0\nresult = sum(value * weight) / total");
});

test("an incomplete example resource binding fails instead of silently losing the figure", async () => {
  const input = await json("image-text.json"), compiled = await compileInput(input);
  await assert.rejects(validateDocument(compiled.document, { resourceMap: {} }), { code: "RESOURCE_MISSING" });
});

test("offline example bundle contains exactly the current editable inputs, resources and guide", async () => {
  // package.py writes bounded, ordinary ZIP local records without data descriptors.
  const archive = await bytes(manifest.bundle), entries = new Map();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const flags = archive.readUInt16LE(offset + 6), method = archive.readUInt16LE(offset + 8);
    const compressed = archive.readUInt32LE(offset + 18), length = archive.readUInt16LE(offset + 26), extra = archive.readUInt16LE(offset + 28);
    assert.equal(flags & 8, 0);
    const name = archive.subarray(offset + 30, offset + 30 + length).toString("utf8");
    const start = offset + 30 + length + extra, raw = archive.subarray(start, start + compressed);
    assert.equal(method, 8);
    entries.set(name, inflateRawSync(raw));
    offset = start + compressed;
  }
  const expected = new Set(["index.md", "manifest.json", "package.py"]);
  for (const example of manifest.examples) {
    expected.add(example.input);
    for (const resource of example.resources) expected.add(resource.path);
  }
  assert.deepEqual([...entries.keys()].sort(), [...expected].sort());
  for (const name of expected) assert.deepEqual(entries.get(name), await bytes(name), `stale bundle entry: ${name}; rerun package.py`);
});
