import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inlineTokens } from "../src/document-content.js";
import { insightWrite, mergeSavedInsights, reconcileInsight, sourceCitation, upsertInsight } from "../src/reader-state.js";

test("editing insight content preserves independent review membership until its authoritative update arrives", () => {
  const original = { id: "reviewed-note", type: "note", body: "Before", version: 1, review: { pending: true, addedAt: "2026-10-22T12:00:00Z", lastReviewedAt: null } };
  const outgoing = insightWrite(original, "document-one", 1);
  assert.equal(outgoing.review, undefined);
  const edited = upsertInsight([original], { ...outgoing, body: "After", version: 2 });
  assert.equal(edited[0].body, "After");
  assert.equal(edited[0].review.pending, true);
  const completed = upsertInsight(edited, { ...edited[0], review: { pending: false, addedAt: original.review.addedAt, lastReviewedAt: "2026-10-22T12:10:00Z" } });
  assert.equal(completed[0].review.pending, false);
  assert.equal(completed[0].version, 2);
});
import { contentVariants, documentLanguages, standardFingerprintInput, standardTranslationStates } from "../src/reading-language.js";
import { blockAtPage, createScrollOwnership, regionForBlock, restoreReadingPosition, sourceNavigationAnchor, sourceRegions, validBox } from "../src/reading-position.js";
import { documentAssetUrl, revisionResourceUrl } from "../src/document-resource.js";
import { HTML_PROFILE, prepareReaderDocument } from "../src/html-content.js";
import { normalizeReaderView } from "../src/reader-view-preferences.js";

const paper = { id: "doc", revision: 2, meta: { title: "Title", language: "en" }, blocks: [
  { id: "p", type: "para", text: "Alpha beta gamma", source: [{ page: 1 }] },
  { id: "math", type: "math", tex: "x+y", source: [{ page: 1, box: [.1, .2, .4, .3] }, { page: 2, box: [.2, .1, .6, .2] }] },
  { id: "user", type: "para", origin: "user", text: "Own thoughts", source: [{ page: 1, box: [.1, .1, .2, .2] }] },
  { id: "missing", type: "para", text: "No mapping" },
] };

test("revision refresh preserves old quotations and rejects changed or missing source addresses", () => {
  const anchored = { id: "one", blockId: "p", variant: "source", field: "text", revision: 1, start: 6, end: 10, quote: "beta", body: "Keep this" };
  assert.equal(reconcileInsight(paper, anchored), anchored);
  const changed = reconcileInsight(paper, { ...anchored, quote: "old word" });
  assert.equal(changed.referenceStatus, "unresolved");
  assert.equal(changed.quote, "old word");
  const math = reconcileInsight(paper, { ...anchored, blockId: "math", sourceType: "math", field: "tex", quote: "old + formula" });
  assert.equal(math.quote, "old + formula");
  assert.equal(math.referenceStatus, "unresolved");
  assert.equal(reconcileInsight(paper, { ...anchored, blockId: "removed" }).referenceStatus, "unresolved");
  assert.equal(reconcileInsight(paper, { body: "Document question", type: "question" }).referenceStatus, undefined);
  assert.equal(reconcileInsight(paper, { sources: [anchored], body: "MCP note" }).blockId, "p");
});

test("canonical saves strip only UI geometry and keep reference identity and extension fields", () => {
  const input = { id: "one", version: 4, revision: 1, body: "  note  ", reference: "N123", references: { N: "N123" }, left: 20, top: 30, bottom: 40, width: 500, height: 32, custom: { keep: true } };
  const saved = insightWrite(input, "doc", 2);
  assert.equal(saved.body, "note");
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.custom, { keep: true });
  assert.equal(saved.reference, "N123");
  for (const name of ["left", "top", "bottom", "width", "height"]) assert.equal(name in saved, false);
  const current = [{ id: "one", version: 6, body: "latest" }];
  assert.equal(upsertInsight(current, { id: "one", version: 5 }), current);
  assert.equal(mergeSavedInsights(current, [{ id: "one", version: 5, archivedAt: "old" }])[0].body, "latest");
  assert.deepEqual(mergeSavedInsights(current, [{ id: "one", version: 7, archivedAt: "now" }]), []);
  assert.deepEqual(upsertInsight(current, { id: "one", version: 7, archivedAt: "now" }), []);
  const citation = JSON.parse(sourceCitation(paper, { blockId: "math" }));
  assert.equal(citation.field, "tex"); assert.equal(citation.revision, 2);
});

test("document-level notes retain canonical identity across refreshes without a fabricated source", () => {
  const note = { id: "article-note", version: 1, documentId: "doc", revision: 2, type: "note", body: "Whole-document note", quote: "", reference: "#N00001", references: { N: "#N00001" } };
  const local = upsertInsight([], note);
  const refreshed = mergeSavedInsights(local, [{ ...note }]).map((item) => reconcileInsight(paper, item));
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].reference, "#N00001");
  assert.equal(refreshed[0].blockId, undefined);
  assert.equal(refreshed[0].body, note.body);
  assert.equal(insightWrite(refreshed[0], "doc", 3).revision, 2);
});

test("historical documents pin managed assets and PDF requests to their revision without changing sample URLs", () => {
  assert.equal(revisionResourceUrl("/api/documents/doc/pdf", 2), "/api/documents/doc/pdf?revision=2");
  assert.equal(revisionResourceUrl("/api/documents/doc/pdf?download=1&revision=9#page=3", 2), "/api/documents/doc/pdf?download=1&revision=2#page=3");
  assert.equal(documentAssetUrl({ ...paper, assetBase: "/api/documents/doc/assets/" }, "figure.png"), "/api/documents/doc/assets/figure.png?revision=2");
  assert.equal(documentAssetUrl({ ...paper, assetBase: "/articles/sample/" }, "figure.png"), "/articles/sample/figure.png");
  assert.equal(revisionResourceUrl("/unchanged", undefined), "/unchanged");
});

test("source navigation restores the exact variant or reports absence without jumping to a neighboring source", () => {
  const moved = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { scrollBy: (change) => moved.push(change) } });
  try {
    const details = { open: false, parentElement: null };
    const source = { blockId: "p", variant: "de", field: "text" };
    const original = { dataset: { blockId: "p", variant: "source", field: "text" }, getBoundingClientRect: () => ({ top: 100, height: 40 }), closest: () => null };
    const translated = { dataset: { ...source }, getBoundingClientRect: () => ({ top: 450, height: 60 }), closest: () => details };
    const root = { querySelectorAll: () => [original, translated] };
    const anchor = sourceNavigationAnchor(source, 102);
    assert.equal(restoreReadingPosition(root, anchor, { exactTop: true }), true);
    assert.deepEqual(moved, [{ top: 348, behavior: "instant" }]);
    assert.equal(details.open, true);
    assert.equal(restoreReadingPosition(root, sourceNavigationAnchor({ ...source, variant: "ja" }, 102), { exactTop: true }), false);
    assert.equal(restoreReadingPosition(root, sourceNavigationAnchor({ ...source, referenceStatus: "unresolved" }, 102), { exactTop: true }), false);
    assert.equal(moved.length, 1);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
});

test("translation variants use actual language, order, inheritance and exact source fingerprints", async () => {
  const sample = JSON.parse(await readFile(new URL("../public/articles/attention-is-all-you-need/document.json", import.meta.url), "utf8"));
  const states = await standardTranslationStates(sample);
  assert.equal(states.$meta["zh-CN"], "current");
  assert.equal(states[sample.blocks.find((block) => block.type === "para").id]["zh-CN"], "current");
  const value = { text: "Bonjour", language: "fr", translations: { de: { text: "Guten Tag" } } };
  assert.deepEqual(contentVariants(value, "text", "bilingual", "de", true), ["de", "source"]);
  assert.deepEqual(contentVariants(value, "text", "bilingual", "de", false), ["source", "de"]);
  assert.deepEqual(contentVariants(value, "text", "translation", "ja"), ["source"]);
  const custom = { ...paper, blocks: [{ id: "list", type: "list", language: "fr", items: [{ id: "li", ...value }] }, { id: "fr", type: "para", ...value, translations: { de: { text: "alt", source_hash: "sha256:old" } } }] };
  const actual = await standardTranslationStates(custom);
  assert.equal(actual.li.de, "unconfirmed"); assert.equal(actual.fr.de, "stale");
  assert.deepEqual(documentLanguages(custom), ["de"]);
  assert.deepEqual(standardFingerprintInput({ type: "figure", src: "a.png", caption: "" }, "en"), ["en", "figure", "a.png", null, "", null]);
});

test("PDF mapping preserves distinct regions, page-only precision and absence without guessing", () => {
  const regions = sourceRegions(paper);
  assert.equal(regions.length, 3); assert.equal(regions.some((item) => item.blockId === "user"), false);
  assert.equal(regionForBlock(regions, "math", 2).page, 2);
  assert.equal(regionForBlock(regions, "missing"), null);
  assert.equal(blockAtPage(regions, 99, .5), null);
  assert.equal(blockAtPage(regions.filter((item) => !item.box), 1, .9).blockId, "p");
  assert.equal(validBox([.1, .1, .1, .9]), false);
  assert.equal(validBox([.1, .1, .5, 1.1]), false);
});

test("scroll ownership follows the last real input and programmatic receiver moves cannot reverse control", () => {
  const ownership = createScrollOwnership();
  ownership.user("reader"); ownership.programmatic("pdf", 100);
  assert.equal(ownership.drives("reader", 101), true);
  assert.equal(ownership.drives("pdf", 1000), false);
  ownership.user("pdf"); ownership.programmatic("reader", 200);
  assert.equal(ownership.drives("pdf", 201), true);
  assert.equal(ownership.drives("reader", 1000), false);
  ownership.user("reader"); ownership.programmatic(undefined, 300);
  assert.equal(ownership.drives("reader", 301), false);
  ownership.user("reader"); assert.equal(ownership.drives("reader", 302), true);
});

test("PDF runtime ignores external geometry and preserves the reading file's exact source precision", () => {
  const before = JSON.stringify(paper);
  const derived = [
    { blockId: "p", page: 1, box: [.1, .4, .8, .6] },
    { blockId: "math", page: 1, box: [.2, .3, .7, .8] },
    { blockId: "user", page: 1, box: [.1, .1, .8, .2] },
    { blockId: "foreign", page: 1, box: [.1, .1, .8, .2] },
    { blockId: "missing", page: 1, box: [.2, .9, .7, .8] },
  ];
  const regions = sourceRegions(paper, derived);
  assert.equal(regionForBlock(regions, "p").box, undefined);
  assert.deepEqual(regionForBlock(regions, "math", 1).box, [.1, .2, .4, .3]);
  assert.equal(regions.length, 3);
  assert.equal(blockAtPage(regions, 1, .45).blockId, "math");
  assert.deepEqual(regions, sourceRegions(paper));
  assert.equal(regionForBlock(regions, "user"), null);
  assert.equal(regionForBlock(regions, "foreign"), null);
  assert.equal(regionForBlock(regions, "missing"), null);
  assert.equal(JSON.stringify(paper), before);
});

test("fenced code keeps original offsets, whitespace and literal markup without treating code as math", () => {
  const text = "Intro\n```python\n  total = '$x$'\n  **literal**\n```\nAfter $y$";
  const tokens = inlineTokens(text), code = tokens.find((item) => item.kind === "fenced-code");
  assert.equal(code.language, "python");
  assert.equal(code.text, "  total = '$x$'\n  **literal**");
  assert.equal(text.slice(code.contentStart, code.contentEnd), code.text);
  assert.equal(text.slice(code.start, code.end), "```python\n  total = '$x$'\n  **literal**\n```");
  assert.deepEqual(tokens.filter((item) => item.kind === "math").map((item) => item.text), ["y"]);
});

test("view preferences migrate temporary TOC state without erasing useful user choices", () => {
  const choices = { showMargins: false, insightOpenMode: "modal", targetLanguage: "fr", translationFirst: true, pdfFollow: false };
  for (const tocMode of ["pinned", "collapsed"]) {
    assert.deepEqual(normalizeReaderView({ tocMode, ...choices }), { tocMode, ...choices });
  }
  assert.deepEqual(normalizeReaderView({ tocMode: "temporary", ...choices }), { tocMode: "collapsed", ...choices });
  assert.equal(normalizeReaderView({ tocMode: "invalid" }).tocMode, "pinned");
});

test("real renderer handles optional source/captions, ordered languages, table alignment and fenced code", async () => {
  const [{ createServer }, { createElement }, { renderToStaticMarkup }] = await Promise.all([import("vite"), import("react"), import("react-dom/server")]);
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    esbuild: { jsx: "automatic" },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const [{ PaperArticle }, { composerAnchor }, { InsightQuote }] = await Promise.all([server.ssrLoadModule("/src/PaperArticle.jsx"), server.ssrLoadModule("/src/ComposerSurface.jsx"), server.ssrLoadModule("/src/InsightQuote.jsx")]);
    const document = await prepareReaderDocument({ format: "continous-reader", schema: 2, id: "safe", revision: 1, assetBase: "/api/documents/safe/assets/", meta: { title: "Safe", language: "fr" }, blocks: [
      { id: "h", type: "heading", level: 1, text: "Origine", translations: { de: { text: "Ursprung" } } },
      { id: "p", type: "para", language: "de", text: "Source\n```js\nx + y\n```", origin: "user" },
      { id: "figure", type: "figure", src: "figure.png" },
      { id: "html-image", type: "html", html_profile: HTML_PROFILE, html: '<figure><img src="html.png" alt="Source image"><figcaption data-node-id="caption">Caption</figcaption></figure>' },
      { id: "table", type: "table", head: [["A", "B"]], rows: [["1", "2"]], align: "lr", caption: "Below" },
      { id: "table-top", type: "table", head: [], rows: [["value"]], caption: "Above", caption_pos: "above" },
      { id: "author-note-id7", type: "para", role: "footnote", placement: "frontmatter", text: "† Author affiliation note.", translations: { de: { text: "† Autorenhinweis." } } },
      { id: "generated-footnote-identity", type: "para", role: "footnote", placement: "body", num: "4", text: "Technical explanation." },
      { id: "body-rights", type: "para", role: "rights", placement: "body", text: "Author-chosen body placement." },
    ] });
    const render = (mode, translationFirst = false) => renderToStaticMarkup(createElement(PaperArticle, { paper: document, mode, translationFirst, targetLanguage: "de", notes: [], equation: () => null }));
    const source = render("source");
    assert.equal(source.includes("undefined"), false); assert.equal(source.includes("<figcaption></figcaption>"), false);
    assert.ok(source.includes('style="text-align:right"')); assert.ok(source.includes('lang="de"'));
    assert.ok(source.includes("source-fenced-code")); assert.ok(source.includes("用户补充"));
    assert.ok(source.includes('src="/api/documents/safe/assets/figure.png?revision=1"'));
    assert.ok(source.includes('src="/api/documents/safe/assets/html.png?revision=1"'));
    assert.ok(source.indexOf("Below") > source.indexOf("</table>"));
    assert.ok(source.indexOf("Above") < source.lastIndexOf("<table>"));
    const visibleText = source.replace(/<[^>]*>/g, "");
    assert.doesNotMatch(visibleText, /author-note-id7|generated-footnote-identity|Footnote |脚注 /);
    assert.match(source, /class="footnote-marker" aria-hidden="true">4<\/span>/);
    const frontmatter = source.match(/<details class="paper-source-details">([\s\S]*?)<\/details>/)?.[1];
    assert.ok(frontmatter?.includes("Author affiliation note."));
    assert.ok(!frontmatter.includes("Technical explanation."));
    assert.ok(!frontmatter.includes("Author-chosen body placement."));
    const translated = render("translation"); assert.equal(translated.includes(">Origine<"), false); assert.ok(translated.includes(">Ursprung<"));
    const reversed = render("bilingual", true); assert.ok(reversed.indexOf(">Ursprung<") < reversed.indexOf(">Origine<"));
    assert.equal(composerAnchor(undefined, 56, 800), "document");
    assert.equal(composerAnchor({ top: 600, bottom: 660 }, 56, 800), "above");
    const math = renderToStaticMarkup(createElement(InsightQuote, { note: { blockId: "math", field: "tex", quote: "x+y", referenceStatus: "unresolved" } }));
    assert.ok(math.includes("insight-formula-quote")); assert.ok(math.includes("原文已变更，保留原公式")); assert.ok(math.includes("katex"));
    const articleNote = renderToStaticMarkup(createElement(InsightQuote, { note: { type: "note", body: "Document note", quote: "" } }));
    assert.ok(articleNote.includes("关联整篇文档"));
  } finally { await server.close(); }
});

test("prepared documents include freshness before first paint and retain unknown blocks for diagnostics", async () => {
  const { prepareReaderDocument } = await import("../src/html-content.js");
  const sample = JSON.parse(await readFile(new URL("../public/articles/attention-is-all-you-need/document.json", import.meta.url), "utf8"));
  const ready = await prepareReaderDocument(sample);
  assert.equal(ready.compiledTranslationStates.$meta["zh-CN"], "current");
  const future = { ...paper, format: "continous-reader", schema: 99, blocks: [...paper.blocks, { id: "future", type: "unknown-extension", payload: { preserved: true } }] };
  const readOnly = await prepareReaderDocument(future);
  assert.equal(readOnly.unsupportedSchema, true);
  assert.deepEqual(readOnly.blocks.at(-1), future.blocks.at(-1));
});
