import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HTML_PROFILE, parseHtml, compileHtmlCss, htmlScope, htmlFingerprint, prepareHtmlBlock, prepareReaderDocument } from "../src/html-content.js";
import { normalizeHtmlSource, sourceText, sameSource, sourceElement } from "../src/document-content.js";

const directory = new URL("../public/articles/attention-is-all-you-need/", import.meta.url);
const original = JSON.parse(readFileSync(new URL("document.json", directory), "utf8"));
const input = JSON.parse(readFileSync(new URL("document.html-sample.json", directory), "utf8"));
const document = await prepareReaderDocument(input);
const table = document.blocks.find((b) => b.id === "S6.T3");
const compiled = table.compiledHtml;
const simple = (html, extra = {}) => ({ id: "example", type: "html", html_profile: HTML_PROFILE, html, ...extra });

test("the HTML sample replaces only Table 3, keeping the canonical article and source identity", () => {
  assert.equal(original.schema, 1);
  assert.equal(document.schema, 2);
  assert.equal(document.id, original.id);
  assert.equal(document.revision, original.revision + 1);
  assert.deepEqual(document.source, original.source);
  assert.equal(document.blocks.length, 154);
  for (const block of original.blocks) if (block.id !== table.id) assert.deepEqual(document.blocks.find((b) => b.id === block.id), block);
  assert.ok(!compiled.error, compiled.error);
  assert.equal(Object.keys(compiled.source.index).length, 255);
  assert.equal(compiled.mappings.size, 536);
  assert.equal(compiled.translationStates["zh-CN"], "current");
  assert.equal(compiled.source.scaffold, compiled.variants["zh-CN"].scaffold);
});

test("real spans, header relationships, blank-cell meaning and emphasis survive", () => {
  const nodes = Object.values(compiled.source.index);
  assert.ok(nodes.some((n) => n.ast.attrs.rowspan === "4"));
  assert.ok(nodes.some((n) => n.ast.attrs.colspan === "7"));
  assert.ok(nodes.some((n) => n.ast.attrs.headers?.includes("t3-h-ppl")));
  assert.ok(nodes.some((n) => n.ast.attrs["data-same-as"] === "t3-base-n" && n.text === ""));
  assert.equal(compiled.source.index["t3-big-ppl"].text, "4.33");
  assert.equal(compiled.source.index["t3-big-ppl"].ast.children[0].tag, "strong");
  assert.equal(nodes.filter((n) => n.semantic === compiled.variants["zh-CN"].index[n.id].semantic).length, 247);
});

test("canonical text preserves Unicode, entities, block breaks, pre whitespace and atomic TeX", () => {
  const parsed = parseHtml('<p data-node-id="p">A &amp; 😀<strong>bold</strong><br><span data-tex="x^2"></span></p><pre data-node-id="code"> a\n  b</pre>');
  assert.equal(parsed.index.p.text, "A & 😀bold\n$x^2$");
  assert.equal(parsed.index.p.ast.children[1].children[0].start, 6);
  assert.equal(parsed.index.p.ast.children[3].end, parsed.index.p.text.length);
  assert.equal(parsed.index.code.text, " a\n  b");
  assert.equal(parseHtml('<div data-node-id="x"><p>One</p><p>Two</p></div>').index.x.text, "One\nTwo");
});

test("semantic changes invalidate translation fingerprints; CSS and class-only changes do not", async () => {
  const a = parseHtml('<p class="a" data-node-id="p">Hello</p>');
  const b = parseHtml('<p data-node-id="p" class="b">Hello</p>');
  assert.equal(await htmlFingerprint(a, "en"), await htmlFingerprint(b, "en"));
  assert.notEqual(await htmlFingerprint(a, "en"), await htmlFingerprint(parseHtml('<p data-node-id="p"><strong>Hello</strong></p>'), "en"));
  assert.notEqual(await htmlFingerprint(a, "en"), await htmlFingerprint(a, "fr"));
  const changedCss = await prepareHtmlBlock({ ...table, css: ".scalar { padding: 1em; }" }, "en");
  assert.equal(changedCss.compiledHtml.fingerprint, compiled.fingerprint);
  assert.equal(changedCss.compiledHtml.translationStates["zh-CN"], "current");
  for (const [hash, state] of [[undefined, "unconfirmed"], ["old", "stale"]]) {
    const block = await prepareHtmlBlock(simple('<p data-node-id="p">1</p>', { translations: { "zh-CN": { html: '<p data-node-id="p">1</p>', source_hash: hash } } }), "en");
    assert.equal(block.compiledHtml.translationStates["zh-CN"], state);
  }
});

test("HTML rejects active content, identity spoofing, unsafe resources and broken table relationships", () => {
  const invalid = [
    '<script>alert(1)</script>', '<p data-node-id="p" onclick="x()">Hi</p>', '<p data-node-id="p" style="color:red">Hi</p>',
    '<p data-node-id="p" data-block-id="other">Hi</p>', '<p data-node-id="p"><span data-node-id="q">Hi</span></p>',
    '<p data-node-id="p">A</p><p data-node-id="p">B</p>', '<p>Unowned</p>', '<img data-node-id="p" src="ok.png" alt="x">',
    '<p data-node-id="p"><a href="javascript:alert(1)">X</a></p>', '<img src="../secret.png" alt="X">',
    '<p data-node-id="p"><span data-node-id="math" data-tex="x"></span></p>',
    '<table><tbody><tr><td data-node-id="c" rowspan="2">x</td></tr></tbody></table>',
    '<table><tbody><tr><td data-node-id="a">x</td><td data-node-id="b">y</td></tr><tr><td data-node-id="c">z</td></tr></tbody></table>',
    '<table><tbody><tr><td data-node-id="c" headers="missing">x</td></tr></tbody></table>',
    '<table><tbody><tr><td data-node-id="c" data-same-as="missing"></td></tr></tbody></table>',
  ];
  for (const html of invalid) assert.throws(() => parseHtml(html), /^Error: E_HTML_/, html);
});

test("CSS is parsed, namespaced and fully validated including theme-variable declarations", () => {
  const css = compileHtmlCss(".metric > td { border: 1px solid var(--html-rule); padding: .3em; }", htmlScope("S6.T3"));
  assert.ok(css.includes('[data-html-scope="html-53-36-2e-54-33"] .html-content .html-local-metric>td'));
  for (const rule of [
    "@import 'https://example.test/x.css';", "body { color: red; }", ".x { position: fixed; }", ".x { font-size: 1px; }",
    ".x { display: none; }", ".x { color: red!important; }", ".x { background-color: url(x); }", ".x { margin-top: -1em; }",
    ".x { color: var(--unknown); }", ".x { border: nonsense var(--html-rule); }", ".x::before { color: red; }", ".x { order: 1; }",
  ]) assert.throws(() => compileHtmlCss(rule, "test"), /^Error: E_HTML_CSS/, rule);
});

test("all nonempty legacy addresses map by verified text with the original address snapshot retained", () => {
  let count = 0;
  for (const mapping of table.reference_mappings) {
    if (!mapping.previous_text.trim()) continue;
    const old = { blockId: table.id, revision: 1, variant: mapping.variant, field: mapping.field, row: mapping.row, column: mapping.column, start: 0, end: mapping.previous_text.length, quote: mapping.previous_text };
    const next = normalizeHtmlSource(document, old);
    assert.notEqual(next.referenceStatus, "unresolved", JSON.stringify(old));
    assert.equal(next.nodeId, mapping.node_id);
    assert.equal(next.field, "html_text");
    assert.equal(sourceText(document, next).slice(next.start, next.end), next.quote);
    assert.equal(next.previousSource.quote, old.quote);
    assert.equal(next.previousSource.revision, 1);
    assert.equal(next.revision, 2);
    assert.equal(next.row, undefined);
    count++;
  }
  assert.ok(count > 150);
});

test("unproven, stale, out-of-range and ambiguous old references remain unresolved", async () => {
  const base = { blockId: table.id, revision: 1, variant: "source", field: "rows", row: 0, column: 0, start: 0, end: 4, quote: "base" };
  for (const change of [{ revision: 99 }, { quote: "other" }, { start: -1 }, { end: 99 }, { start: 0, end: 0, quote: "" }]) {
    const old = { ...base, ...change }, result = normalizeHtmlSource(document, old);
    assert.equal(result.referenceStatus, "unresolved");
    assert.equal(result.quote, old.quote);
    assert.equal(result.nodeId, undefined);
  }
  const b = await prepareHtmlBlock(simple('<p data-node-id="p">Hi Hi</p>', { reference_mappings: [{ from_revision: 1, variant: "source", field: "text", node_id: "p", kind: "reformatted", previous_text: "**Hi**" }] }), "en");
  assert.equal(normalizeHtmlSource({ blocks: [b], revision: 2 }, { blockId: "example", revision: 1, field: "text", start: 0, end: 6, quote: "**Hi**" }).referenceStatus, "unresolved");
});

test("shared bilingual cells keep both addresses and never fall back to a different cell", () => {
  const element = { dataset: { blockId: table.id, variant: "source", field: "html_text", nodeId: "t3-big-ppl", sharedVariants: "source zh-CN" } };
  const root = { querySelectorAll: () => [element] };
  const source = { blockId: table.id, variant: "zh-CN", field: "html_text", nodeId: "t3-big-ppl" };
  assert.equal(sourceElement(root, source, false), element);
  assert.equal(sourceElement(root, { ...source, nodeId: "missing" }), null);
  assert.equal(sourceElement(root, { ...source, referenceStatus: "unresolved" }), null);
  assert.equal(sameSource(source, { ...source, nodeId: "another-cell" }), false);
  assert.equal(sameSource(source, { ...source, variant: "source" }), false);
});

test("invalid profiles/content preserve the original payload and expose diagnostics", async () => {
  for (const block of [simple('<script>x</script>'), { ...table, html_profile: "unknown" }, { ...table, css: ".x { display: none; }" }]) {
    const result = await prepareHtmlBlock(block, "en");
    assert.match(result.compiledHtml.error, /^E_HTML_/);
    assert.equal(result.html, block.html);
  }
  assert.ok((await prepareHtmlBlock(table, "en", 1)).compiledHtml.error);
});

test("the actual React component pairs current nodes, keeps uncertain translations separate and renders diagnostics", async () => {
  const [{ createServer }, { createElement }, { renderToStaticMarkup }] = await Promise.all([import("vite"), import("react"), import("react-dom/server")]);
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, watch: null, hmr: false }, appType: "custom" });
  try {
    const { HtmlBlock } = await server.ssrLoadModule("/src/HtmlBlock.jsx");
    const render = (block, mode = "bilingual") => renderToStaticMarkup(createElement(HtmlBlock, { block, mode, language: "en", notes: [], assetBase: "/article/" }));
    const paired = render(table);
    assert.equal((paired.match(/data-shared-variants=/g) || []).length, 247);
    assert.equal((paired.match(/data-field="html_text"/g) || []).length, 263);
    assert.equal((paired.match(/<table/g) || []).length, 1);
    assert.ok(!render(table, "source").includes('data-variant="zh-CN"'));
    assert.ok(!render(table, "translation").includes('data-variant="source"'));
    const figure = await prepareHtmlBlock(simple('<p data-node-id="p">Description</p>', { role: "figure", num: "2" }), "en");
    assert.ok(render(figure, "source").includes('class="figure-number">Figure 2'));
    for (const [hash, label] of [[undefined, "译文来源版本未确认"], ["old", "原文已更新，译文待核对"]]) {
      const uncertain = await prepareHtmlBlock({ ...table, translations: { "zh-CN": { ...table.translations["zh-CN"], source_hash: hash } } }, "en");
      const markup = render(uncertain);
      assert.ok(markup.includes(label));
      assert.ok(!markup.includes("data-shared-variants"));
      assert.equal((markup.match(/data-field="html_text"/g) || []).length, 510);
    }
    const different = await prepareHtmlBlock(simple('<p data-node-id="p">Hello</p>', { translations: { "zh-CN": { html: '<section><p data-node-id="p">你好</p></section>' } } }), "en");
    assert.equal((render(different).match(/class="html-content"/g) || []).length, 2);
    const missing = await prepareHtmlBlock(simple('<p data-node-id="p">Hello<img src="image.png" alt="Diagram"></p>'), "en");
    assert.ok(render(missing).includes("此处尚未翻译，显示原文"));
    assert.ok(render(missing).includes('src="/article/image.png"'));
    const invalid = await prepareHtmlBlock({ ...table, css: ".x { display: none; }" }, "en");
    assert.ok(render(invalid).includes("此处的 HTML 内容暂时无法显示，原始内容已保留。"));
    assert.ok(render(invalid).includes("E_HTML_CSS"));
    assert.ok(render(invalid).includes("table-3.png"));
  } finally { await server.close(); }
});
