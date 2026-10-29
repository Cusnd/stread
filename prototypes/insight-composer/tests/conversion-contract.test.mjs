import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileAuthoring } from "../scripts/compile-authoring.mjs";
import { HTML_PROFILE_SHARED, compileHtmlCss, parseHtml, prepareReaderDocument } from "../src/html-content.js";
import { compileInput, validateDocument } from "../../../services/workspace/documents.mjs";

const sample = (html, extra = {}) => ({ format: "reader-authoring-1", key: "test-paper", meta: { title: "Test", language: "en" },
  blocks: [{ key: "object", type: "html", html, ...extra }] });

test("authoring assigns identities and a source index without agent-written offsets or hashes", async () => {
  const result = await compileAuthoring(sample('<table><thead><tr><th scope="col">Value</th></tr></thead><tbody><tr><td>0.82</td></tr></tbody></table>'));
  assert.equal(result.document.schema, 2);
  assert.equal(result.document.blocks[0].html_profile, HTML_PROFILE_SHARED);
  assert.equal(result.report.html_nodes, 2);
  assert.deepEqual(result.index.map((n) => n.text), ["Value", "0.82"]);
  assert.equal(result.document.blocks[0].css, undefined);
  assert.match(result.document.blocks[0].html, /data-node-id=/);
});

test("recompile, reorder and CSS-only changes preserve stable identities", async () => {
  const input = sample('<p>A</p><p><strong>B</strong></p>');
  const first = await compileAuthoring(input);
  const same = await compileAuthoring(input, first.registry);
  assert.deepEqual(same.document, first.document);
  assert.equal(same.document.revision, 1);
  const reordered = await compileAuthoring(sample('<p class="text-end"><strong class="note">B</strong></p><p>A</p><p>C</p>'), first.registry);
  const old = Object.fromEntries(first.index.map((r) => [r.text, r.node_id]));
  for (const row of reordered.index.filter((r) => old[r.text])) assert.equal(row.node_id, old[row.text]);
  assert.equal(reordered.document.revision, 2);
  assert.equal(reordered.report.warnings.length, 0);
});

test("explicit keys survive edits; ambiguous duplicate units never get a guessed old address", async () => {
  const first = await compileAuthoring(sample('<p data-key="main">Old</p><p>Same</p><p>Same</p>'));
  const next = await compileAuthoring(sample('<p data-key="main">New</p><p>Inserted</p><p>Same</p><p>Same</p>'), first.registry);
  assert.equal(next.index[0].node_id, first.index[0].node_id);
  const oldDuplicates = new Set(first.index.slice(1).map((r) => r.node_id));
  assert.ok(next.index.slice(1).every((r) => !oldDuplicates.has(r.node_id)));
  assert.equal(next.report.warnings[0].code, "W_IDENTITY_UNRESOLVED");
});

test("translation pairing is explicit, checked, and cannot silently refresh a stale translation", async () => {
  const source = '<p data-key="caption">Caption</p>';
  const translation = { alignment: "same-structure", html: '<p data-key="caption">题注</p>' };
  const first = await compileAuthoring(sample(source, { translations: { "zh-CN": translation } }));
  const prepared = await prepareReaderDocument(first.document);
  assert.equal(prepared.blocks[0].compiledHtml.translationStates["zh-CN"], "current");
  const changed = await compileAuthoring(sample(source.replace("Caption", "New caption"), { translations: { "zh-CN": translation } }), first.registry);
  assert.equal((await prepareReaderDocument(changed.document)).blocks[0].compiledHtml.translationStates["zh-CN"], "stale");
  const repeat = await compileAuthoring(sample(source.replace("Caption", "New caption"), { translations: { "zh-CN": translation } }), changed.registry);
  assert.equal((await prepareReaderDocument(repeat.document)).blocks[0].compiledHtml.translationStates["zh-CN"], "stale");
  await assert.rejects(compileAuthoring(sample('<p>A</p>', { translations: { "zh-CN": { html: '<p>甲</p>' } } })), /E_AUTHOR_ALIGNMENT/);
  await assert.rejects(compileAuthoring(sample('<p>A</p>', { translations: { "zh-CN": { alignment: "same-structure", html: '<div><p>甲</p></div>' } } })), /E_AUTHOR_ALIGNMENT/);
});

test("profile 2 owns appearance and accepts only scoped layout with shared spacing", () => {
  assert.match(compileHtmlCss('.custom { display:grid; grid-template-columns:1fr 2fr; gap:var(--reader-space-2); }', "sample", HTML_PROFILE_SHARED), /html-local-custom/);
  for (const css of ['.x { color:red; }', '.x { padding:2px; }', '.x { border:1px solid red; }', '.x { font-weight:700; }', '.x { gap:4px; }', '.layout-pair { display:block; }', '.x { display:none; }']) {
    assert.throws(() => compileHtmlCss(css, "sample", HTML_PROFILE_SHARED), /E_HTML_CSS/, css);
  }
});

test("translated list citations resolve forward author keys and pass production document validation", async () => {
  const input = { format: "reader-authoring-1", key: "bilingual-list", meta: { title: "List citations", language: "en" }, blocks: [
    { key: "applications", type: "list", ordered: false, items: [
      { key: "encoder", text: "See [38](#reference38).", translations: { "zh-CN": { text: "见 [38](#reference38)。" } } },
      { key: "decoder", text: "See Figure [2](#figure2).", translations: { "zh-CN": { text: "见图 [2](#figure2)。" } } },
    ] },
    { key: "reference38", type: "para", text: "Reference 38." },
    { key: "figure2", type: "para", text: "Figure 2 description." },
  ] };
  const compiled = await compileInput(input);
  const [list, reference, figure] = compiled.document.blocks;
  assert.equal(list.items[0].text, `See [38](#${reference.id}).`);
  assert.equal(list.items[0].translations["zh-CN"].text, `见 [38](#${reference.id})。`);
  assert.equal(list.items[1].translations["zh-CN"].text, `见图 [2](#${figure.id})。`);
  assert.equal(compiled.report.internal_links, 4);
  const validated = await validateDocument(compiled.document);
  assert.deepEqual(validated.report.diagnostics, []);
  assert.ok(validated.index.filter((entry) => entry.variant === "zh-CN").every((entry) => entry.translationState === "current"));
  assert.equal(input.blocks[0].items[0].translations["zh-CN"].text, "见 [38](#reference38)。", "author input is not mutated");
});

test("list-item translations cannot bypass missing-link or math validation", async () => {
  const input = (text) => ({ format: "reader-authoring-1", key: "list-translation-validation", meta: { title: "List", language: "en" }, blocks: [
    { key: "list", type: "list", ordered: false, items: [{ key: "one", text: "Source item.", translations: { "zh-CN": { text } } }] },
  ] });
  await assert.rejects(compileAuthoring(input("见 [缺失](#missing)。")), /E_AUTHOR_LINK/);
  await assert.rejects(compileAuthoring(input("错误公式 $\\notACommand{x}$。")), /E_AUTHOR_MATH/);
});

test("invalid source, malformed grids, duplicate keys and unsupported math fail visibly", async () => {
  await assert.rejects(compileAuthoring(sample('<p data-node-id="manual">A</p>')), /E_AUTHOR_DERIVED/);
  await assert.rejects(compileAuthoring(sample('<p data-key="same">A</p><p data-key="same">B</p>')), /E_AUTHOR_KEY/);
  await assert.rejects(compileAuthoring(sample('<table><tr><td rowspan="2">x</td></tr></table>')), /E_HTML_SPAN/);
  await assert.rejects(compileAuthoring(sample('<p><span data-tex="\\notACommand{x}"></span></p>')), /E_AUTHOR_MATH/);
  const source = sample('<p>A</p>'); source.blocks[0].source = [{ page: 1, box: [0.8, 0, 0.2, 1] }];
  await assert.rejects(compileAuthoring(source), /E_AUTHOR_SOURCE/);
  await assert.rejects(compileAuthoring(sample('<p><a href="#missing">Missing</a></p>')), /E_AUTHOR_LINK/);
});

test("placement is a validated shared block choice and a body override preserves identity and translation provenance", async () => {
  const input = { format: "reader-authoring-1", key: "placement-example", meta: { title: "Notes", language: "en" }, blocks: [
    { key: "author-note", type: "para", role: "footnote", placement: "frontmatter", text: "Equal contribution.", translations: { "zh-CN": { text: "同等贡献。" } } },
    { key: "publication-context", type: "para", role: "publication", placement: "body", text: "Context belongs in the reading flow." },
  ] };
  const first = await compileInput(input), checked = await validateDocument(first.document);
  assert.deepEqual(checked.document.blocks.map((block) => block.placement), ["frontmatter", "body"]);
  const changed = structuredClone(input); changed.blocks[0].placement = "body";
  const next = await compileInput(changed, { document: first.document, identity: first.identity });
  assert.equal(next.document.blocks[0].id, first.document.blocks[0].id);
  assert.equal(next.document.blocks[0].placement, "body");
  assert.equal(next.document.blocks[0].translations["zh-CN"].source_hash, first.document.blocks[0].translations["zh-CN"].source_hash);
  assert.equal((await validateDocument(next.document)).index.find((row) => row.variant === "zh-CN").translationState, "current");
  for (const value of ["sidebar", "", null, 1]) {
    const invalidInput = structuredClone(input); invalidInput.blocks[0].placement = value;
    await assert.rejects(compileAuthoring(invalidInput), /E_AUTHOR_PLACEMENT/);
    const invalidDocument = structuredClone(first.document); invalidDocument.blocks[0].placement = value;
    await assert.rejects(validateDocument(invalidDocument), { code: "VALIDATION_FAILED" });
  }
  const translatedPlacement = structuredClone(input); translatedPlacement.blocks[0].translations["zh-CN"].placement = "body";
  await assert.rejects(compileAuthoring(translatedPlacement), /E_AUTHOR_PLACEMENT/);
  const invalidTranslation = structuredClone(first.document); invalidTranslation.blocks[0].translations["zh-CN"].placement = "body";
  await assert.rejects(validateDocument(invalidTranslation), { code: "VALIDATION_FAILED" });
});

test("three real conversions preserve separate table captions, figures, code, references and missing translations", async () => {
  const all = {};
  for (const key of ["resnet", "mapreduce", "crispr"]) {
    const doc = JSON.parse(readFileSync(new URL(`../public/articles/${key}/document.json`, import.meta.url), "utf8"));
    all[key] = doc;
    const prepared = await prepareReaderDocument(doc);
    assert.ok(prepared.blocks.every((b) => !b.compiledHtml?.error));
    assert.ok(doc.blocks.filter((b) => b.type === "para").length > 100);
    assert.ok(doc.blocks.some((b) => b.translations));
    assert.ok(doc.blocks.some((b) => !b.translations && b.type === "para"));
    assert.equal(doc.blocks.filter((b) => b.css?.trim()).length, 0);
    assert.ok(doc.blocks.filter((b) => b.type === "html").every((b) => b.html_profile === HTML_PROFILE_SHARED));
  }
  assert.deepEqual(all.resnet.blocks.filter((b) => b.type === "table" || b.role === "table").map((b) => Number(b.num)).sort((a,b) => a-b), Array.from({length:14},(_,i) => i+1));
  assert.equal(all.resnet.blocks.filter((b) => b.type === "figure").length, 7);
  const figure = all.mapreduce.blocks.find((b) => b.role === "figure" && b.num === "3");
  assert.equal((figure.html.match(/<img /g) || []).length, 3);
  assert.ok(all.mapreduce.blocks.some((b) => b.role === "code" && b.html.includes('class WordCounter')));
  assert.equal(all.crispr.blocks.filter((b) => b.role === "reference").length, 110);
  const layered = all.resnet.blocks.find((b) => b.num === "14" && b.type === "html");
  assert.ok(Object.values(parseHtml(layered.html).index).some((n) => n.ast.attrs.rowspan === "2"));
});

test("authoring rejects unknown, generated and type-specific translation fields with aggregated repair paths", async () => {
  const input = { format: "reader-authoring-1", key: "strict-fields", revision: 1, meta: { title: "Test", language: "en" }, blocks: [
    { key: "paragraph", type: "para", text: "Text", placment: "frontmatter", layout: "columns", id: "manual", translations: { "zh-CN": { content: "文字" } } },
    { key: "figure", type: "figure", src: "image.png", translations: { "zh-CN": { text: "不可显示的字段", source_hash: "manual" } } },
  ] };
  await assert.rejects(compileAuthoring(input), (error) => {
    assert.ok(error.diagnostics.length >= 7);
    const typo = error.diagnostics.find((issue) => issue.path === "$.blocks[0].placment");
    assert.equal(typo.key, "paragraph"); assert.equal(typo.code, "E_AUTHOR_FIELD"); assert.equal(typo.suggestion, "placement");
    assert.ok(typo.allowedFields.includes("placement")); assert.ok(typo.hint);
    assert.ok(error.diagnostics.some((issue) => issue.code === "E_AUTHOR_DERIVED" && issue.path === "$.revision"));
    assert.ok(error.diagnostics.some((issue) => issue.path.endsWith('.translations["zh-CN"].content')));
    assert.ok(error.diagnostics.some((issue) => issue.path.endsWith('.translations["zh-CN"].text') && issue.key === "figure"));
    return true;
  });
  const valid = { format: "reader-authoring-1", key: "extension", meta: { title: "Test" }, blocks: [{ key: "p", type: "para", text: "Text", extensions: { "example.metadata": { layout: "archived observation", id: "external ID" } } }] };
  const compiled = await compileAuthoring(valid);
  assert.deepEqual(compiled.document.blocks[0].extensions, valid.blocks[0].extensions);
});

test("strict scalar and container types fail before compiler internals", async () => {
  const input = { format: "reader-authoring-1", key: "typed-fields", meta: { title: "Test" }, blocks: [
    { key: "list", type: "list", ordered: "yes", items: null },
    { key: "table", type: "table", head: [], rows: [[1]], translations: { "zh-CN": { rows: "wrong" } } },
    { key: "paragraph", type: "para", text: 12, cont: "true" },
  ] };
  await assert.rejects(compileInput(input), (error) => {
    assert.equal(error.code, "VALIDATION_FAILED");
    assert.ok(error.details.diagnostics.length >= 6);
    assert.ok(error.details.diagnostics.every((issue) => issue.path && issue.key && issue.code && issue.hint));
    return true;
  });
});

test("standard text rejects raw semantic HTML without rejecting mathematics or literal code", async () => {
  for (const text of ["<strong>Bold</strong>", "<h2>Section</h2>", "**<sup>2</sup>**", "<!-- hidden -->"]) {
    await assert.rejects(compileAuthoring({ format: "reader-authoring-1", key: "raw", meta: { title: "Test" }, blocks: [{ key: "p", type: "para", text }] }), (error) => {
      assert.equal(error.diagnostics[0].code, "E_AUTHOR_RAW_HTML"); assert.equal(error.diagnostics[0].path, "$.blocks[0].text"); return true;
    });
  }
  const text = 'Compare a < b > c and $a<b>c$; literal `<strong>`.\n```html\n<h2>Example</h2>\n```';
  const compiled = await compileAuthoring({ format: "reader-authoring-1", key: "literal", meta: { title: "Test" }, blocks: [{ key: "p", type: "para", text }] });
  assert.equal(compiled.document.blocks[0].text, text);
});

test("semantic role and unconsumed class warnings preserve permitted author-local layout", async () => {
  const result = await compileAuthoring(sample('<div class="layout-piar custom"><p>Text</p></div>', { role: "research-panel", css: '.custom { display:grid; grid-template-columns:1fr 2fr; } .unused { display:flex; }' }));
  assert.ok(result.report.warnings.some((warning) => warning.code === "W_AUTHOR_ROLE"));
  const typo = result.report.warnings.find((warning) => warning.className === "layout-piar");
  assert.equal(typo.code, "W_AUTHOR_CLASS"); assert.equal(typo.suggestion, "layout-pair");
  assert.ok(result.report.warnings.some((warning) => warning.code === "W_AUTHOR_CSS_UNUSED" && warning.className === "unused"));
  assert.ok(!result.report.warnings.some((warning) => warning.className === "custom"));
  assert.ok((await prepareReaderDocument(result.document)).blocks.every((block) => !block.compiledHtml?.error));
});

test("current authoring fixtures, including the full Attention input, satisfy the strict contract", async () => {
  for (const relative of ["../../../services/workspace/authoring-example.json", "./fixtures/attention-authoring.json", ...["resnet", "mapreduce", "crispr"].map((name) => `../samples/conversion-contract/${name}.authoring.json`)]) {
    const input = JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
    const compiled = await compileInput(input), validated = await validateDocument(compiled.document);
    assert.equal(validated.document.blocks.length, input.blocks.length, relative);
    assert.ok(compiled.report.warnings.every((warning) => warning.code === "W_AUTHOR_DERIVED_HINT"), relative);
  }
});

test("title and list translations honor explicit review while stripping the author-only flag", async () => {
  const original = { format: "reader-authoring-1", key: "reviewed", meta: { title: "Original", language: "en", translations: { "zh-CN": { title: "原文" } } }, blocks: [
    { key: "list", type: "list", ordered: false, items: [{ key: "one", text: "Original", translations: { "zh-CN": { text: "原文" } } }] },
  ] };
  const first = await compileInput(original), changed = structuredClone(original); changed.meta.title = "Changed"; changed.blocks[0].items[0].text = "Changed";
  const stale = await compileInput(changed, first);
  assert.equal((await validateDocument(stale.document)).index.find((entry) => entry.blockId === "$meta" && entry.variant === "zh-CN").translationState, "stale");
  changed.meta.translations["zh-CN"].reviewed = true; changed.blocks[0].items[0].translations["zh-CN"].reviewed = true;
  const reviewed = await compileInput(changed, stale), validated = await validateDocument(reviewed.document);
  assert.ok(validated.index.filter((entry) => entry.variant === "zh-CN").every((entry) => entry.translationState === "current"));
  assert.equal(reviewed.document.meta.translations["zh-CN"].reviewed, undefined);
  assert.equal(reviewed.document.blocks[0].items[0].translations["zh-CN"].reviewed, undefined);
});
