import test from "node:test";
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createWorkspaceMcp } from "../mcp.mjs";
import { validateDocument } from "../documents.mjs";
import { hash } from "../errors.mjs";
import { readContextInput, readDocumentProjection, readingResponseBytes, MAX_READING_ITEMS, MAX_READING_RESPONSE_BYTES, READING_PROJECTION_VERSION } from "../mcp-reading.mjs";

async function fixture() {
  const document = { format: "continous-reader", schema: 2, id: "reading", revision: 1, meta: { title: "Reading fixture", language: "en" }, blocks: [
    { id: "preface", type: "para", text: "Untitled preface. [note](#footnote)", translations: { zh: { text: "无标题前言。[注](#footnote)" } } },
    { id: "intro", type: "heading", level: 1, text: "Introduction", translations: { zh: { text: "引言" } } },
    { id: "long", type: "para", text: "Measured α 😀 result. ".repeat(850), translations: { zh: { text: "测量 α 😀 结果。".repeat(850) } } },
    { id: "list", type: "list", ordered: true, items: [{ id: "item-a", text: "First item", translations: { zh: { text: "第一项" } } }, { id: "item-b", text: "Second item" }] },
    { id: "data", type: "heading", level: 2, text: "Data" },
    { id: "table", type: "table", head: [["Metric", "Value"]], rows: [["Accuracy", "0.98"], ["Empty", ""]], caption: "Table 1", translations: { zh: { head: [["指标", "值"]], rows: [["准确率", "0.98"], ["空", ""]], caption: "表 1" } } },
    { id: "formula", type: "math", tex: "E=mc^2", tag: "(1)" },
    { id: "figure", type: "figure", src: "figure.png", alt: "Chart", caption: "Figure 1", image_text: "Measured labels" },
    { id: "html", type: "html", html_profile: "reader-html-1", html: '<p data-node-id="html-p">Result <em>shown</em> <span data-tex="x^2"></span> <a href="#footnote">1</a>.</p><table><thead><tr><th data-node-id="html-head" colspan="2">Group</th></tr></thead><tbody><tr><td data-node-id="html-cell-a" headers="html-head" rowspan="2">A</td><td data-node-id="html-cell-b" headers="html-head">B</td></tr><tr><td data-node-id="html-cell-c" headers="html-head">C</td></tr></tbody></table><img src="inline.png" alt="Inline chart">' },
    { id: "footnote", type: "para", role: "footnote", num: "1", text: "Footnote evidence." },
    { id: "references", type: "heading", level: 1, text: "References" },
    { id: "reference", type: "para", role: "bibliography", text: "Author (2026). Study." },
  ] };
  const saved = await validateDocument(document), revisions = new Map([[1, saved]]);
  const workspace = { authorize() {}, row: () => ({ current_revision: Math.max(...revisions.keys()) }), revision: async (id, version) => {
    assert.equal(id, "reading"); const result = revisions.get(version ?? Math.max(...revisions.keys())); assert.ok(result, "requested revision exists"); return result;
  } };
  return { document, saved, revisions, workspace };
}

async function collect(workspace, args) {
  const pages = [];
  for (let i = 0; args; i++) {
    assert.ok(i < 500, "pagination advances");
    const result = await readDocumentProjection(workspace, args);
    assert.ok(result.returnedChars <= args.max_chars);
    assert.ok(readingResponseBytes(result) <= MAX_READING_RESPONSE_BYTES);
    assert.ok((result.spans || result.sections).length <= MAX_READING_ITEMS);
    if (result.next) assert.deepEqual(readContextInput.parse(result.next), result.next);
    pages.push(result); args = result.next;
  }
  return pages;
}

test("continuous reading covers all indexed complex content at the exact 6000 UTF-16 budget", async () => {
  const { workspace, saved } = await fixture();
  const pages = await collect(workspace, { view: "content", document_id: "reading", max_chars: 6000 });
  const received = new Map();
  for (const page of pages) {
    assert.equal(page.text.length, page.returnedChars);
    for (const span of page.spans) {
      if (span.status !== "available") continue;
      const text = page.text.slice(span.textStart, span.textEnd);
      assert.ok(!/[\uD800-\uDBFF]$/.test(text)); assert.ok(!/^[\uDC00-\uDFFF]/.test(text));
      assert.equal(text.length, span.sourceEnd - span.sourceStart);
      const key = JSON.stringify(span.address), previous = received.get(key) || "";
      assert.equal(previous.length, span.sourceStart);
      received.set(key, previous + text);
    }
  }
  const fields = ["blockId", "field", "itemId", "nodeId", "row", "column"];
  for (const entry of saved.index.filter((entry) => entry.variant === "source" && entry.blockId !== "$meta")) {
    const key = JSON.stringify(Object.fromEntries(fields.filter((field) => entry[field] !== undefined).map((field) => [field, entry[field]])));
    assert.equal(received.get(key), entry.text, key);
  }
  assert.equal(pages.at(-1).coverage.documentTraversed, true);
  assert.equal(pages.at(-1).coverage.documentComplete, false, "enumerating image descriptors is not reading their bytes");
  assert.equal(pages.at(-1).coverage.unavailableEntries, 2, "figure and inline image bytes are explicitly unread");
  const spans = pages.flatMap((page) => page.spans);
  assert.deepEqual(spans.find((span) => span.address.blockId === "table").table, { headerRows: 1, bodyRows: 2, columns: 2 });
  assert.equal(spans.find((span) => span.address.nodeId === "html-cell-a").html.headers, "html-head");
  assert.equal(spans.find((span) => span.address.nodeId === "html-cell-a").html.rowspan, "2");
  assert.equal(spans.find((span) => span.address.nodeId === "html-head").html.colspan, "2");
  assert.deepEqual(spans.find((span) => span.address.nodeId === "html-p").html.links, ["#footnote"]);
  assert.equal(spans.find((span) => span.address.blockId === "footnote").num, "1");
  assert.equal(spans.find((span) => span.address.blockId === "formula").tag, "(1)");
});

test("outline preserves an unnamed preamble, real hierarchy and disjoint chapter ranges", async () => {
  const { workspace } = await fixture();
  const outline = await readDocumentProjection(workspace, { view: "outline", document_id: "reading", max_chars: 6000 });
  assert.deepEqual(outline.sections.map((section) => [section.title, section.level]), [["", 0], ["Introduction", 1], ["Data", 2], ["References", 1]]);
  const ranges = outline.sections.map((section) => [section.startBlock, section.endBlock]);
  assert.deepEqual(ranges, [[0, 1], [1, 4], [4, 10], [10, 12]]);
  const chapter = await collect(workspace, { view: "content", document_id: "reading", section_id: outline.sections[2].sectionId, max_chars: 6000 });
  assert.ok(chapter.flatMap((page) => page.spans).every((span) => span.blockIndex >= 4 && span.blockIndex < 10));
  assert.equal(chapter.at(-1).coverage.complete, true); assert.equal(chapter.at(-1).coverage.documentComplete, false);
});

test("continuations stay on the original revision and reject changed selection, language or malformed cursor", async () => {
  const { workspace, document, revisions } = await fixture();
  const first = await readDocumentProjection(workspace, { view: "content", document_id: "reading", variant: "source", max_chars: 100 });
  const update = structuredClone(document); update.revision = 2; update.blocks[2].text = "New current text.";
  revisions.set(2, await validateDocument(update));
  const second = await readDocumentProjection(workspace, first.next);
  assert.equal(second.revision, 1); assert.equal(second.currentRevision, 2);
  assert.equal(second.projectionVersion, READING_PROJECTION_VERSION);
  for (const patch of [{ variant: "zh" }, { revision: 2 }, { section_id: "heading:intro" }, { view: "outline" }]) {
    await assert.rejects(readDocumentProjection(workspace, { ...first.next, ...patch }), { code: "CURSOR_MISMATCH" });
  }
  await assert.rejects(readDocumentProjection(workspace, { ...first.next, cursor: "broken" }), { code: "INVALID_CURSOR" });
  assert.deepEqual(await readDocumentProjection(workspace, first.next), second, "retry returns the same page");
});

test("selected translation reports missing fields without silently substituting source text", async () => {
  const { workspace } = await fixture();
  const pages = await collect(workspace, { view: "content", document_id: "reading", variant: "zh", max_chars: 6000 });
  assert.ok(!pages.map((page) => page.text).join("").includes("Second item"));
  const missing = pages.flatMap((page) => page.spans).find((span) => span.address.itemId === "item-b");
  assert.equal(missing.status, "unavailable"); assert.equal(missing.reason, "translation_missing");
  assert.equal(pages.at(-1).coverage.complete, true); assert.ok(pages.at(-1).coverage.unavailableEntries > 2);
  assert.equal(pages.at(-1).coverage.contentComplete, false);
  const outline = await readDocumentProjection(workspace, { view: "outline", document_id: "reading", variant: "zh", max_chars: 6000 });
  assert.equal(outline.sections[1].title, "引言"); assert.equal(outline.sections[2].title, ""); assert.equal(outline.sections[2].status, "unavailable");
});

test("empty and unsupported ranges terminate explicitly; item-heavy pages keep bounded progress", async () => {
  const { workspace, revisions, document } = await fixture();
  const many = structuredClone(document); many.blocks = Array.from({ length: 130 }, (_, i) => ({ id: "empty-" + i, type: "para", text: "" }));
  revisions.set(1, await validateDocument(many));
  const pages = await collect(workspace, { view: "content", document_id: "reading", max_chars: 100 });
  assert.equal(pages.length, 5); assert.equal(pages.flatMap((page) => page.spans).length, 130);
  const unsupported = structuredClone(document); unsupported.blocks = [{ id: "future", type: "future-structure", opaque: "Retained" }];
  revisions.set(1, await validateDocument(unsupported, { allowUnsupported: true }));
  const result = await readDocumentProjection(workspace, { view: "content", document_id: "reading", max_chars: 100 });
  assert.equal(result.spans[0].status, "unsupported"); assert.equal(result.coverage.unsupportedEntries, 1); assert.equal(result.next, null);
  const empty = structuredClone(document); empty.blocks = [];
  revisions.set(1, { document: empty, index: [], fingerprints: {} });
  const emptyResult = await readDocumentProjection(workspace, { view: "content", document_id: "reading", max_chars: 100 });
  assert.equal(emptyResult.coverage.complete, true); assert.deepEqual(emptyResult.spans, []);
});

test("long titles, empty chapters and unavailable variants remain discoverable without manufacturing titles", async () => {
  const { workspace, revisions, document } = await fixture();
  const headings = structuredClone(document);
  headings.blocks = Array.from({ length: 38 }, (_, i) => ({ id: "heading-" + i, type: "heading", level: i % 6 + 1, text: i === 0 ? "" : "章😀".repeat(110), translations: i === 1 ? { zh: { text: "章节" } } : {} }));
  revisions.set(1, await validateDocument(headings));
  const pages = await collect(workspace, { view: "outline", document_id: "reading", max_chars: 100 });
  const sections = pages.flatMap((page) => page.sections);
  assert.equal(sections.length, 38); assert.equal(sections[0].title, ""); assert.equal(sections[0].status, "available");
  assert.ok(sections.slice(1).every((section) => section.titleTruncated));
  for (const section of sections) assert.ok(!/[\uD800-\uDBFF]$/.test(section.title));
  const emptyChapter = await readDocumentProjection(workspace, { view: "content", document_id: "reading", section_id: sections[0].sectionId, max_chars: 100 });
  assert.equal(emptyChapter.text, ""); assert.equal(emptyChapter.next, null); assert.equal(emptyChapter.sectionPolicy, "heading_to_next_heading");
  const unavailable = await readDocumentProjection(workspace, { view: "outline", document_id: "reading", variant: "fr", max_chars: 100 });
  assert.equal(unavailable.variantAvailable, false); assert.deepEqual(unavailable.variants, ["source", "zh"]);
  assert.ok(unavailable.sections.every((section) => section.title === "" && section.status === "unavailable"));
});

test("wire budget limits metadata-heavy HTML pages and follows every node without exceeding the text budget", async () => {
  const { workspace, revisions, document } = await fixture();
  const heavy = structuredClone(document), href = "https://example.test/" + "文".repeat(350);
  heavy.blocks = [{ id: "heavy", type: "html", html_profile: "reader-html-1", html: Array.from({ length: 24 }, (_, i) => `<p data-node-id="node-${i}">${Array.from({ length: 6 }, () => `<a href="${href}">X</a>`).join("")}</p>`).join("") }];
  revisions.set(1, await validateDocument(heavy));
  const pages = await collect(workspace, { view: "content", document_id: "reading", max_chars: 6000 });
  assert.ok(pages.length > 1, "wire budget, not 6000 characters or 32 items, causes pagination");
  assert.equal(pages.flatMap((page) => page.spans).length, 24);
  assert.ok(pages.every((page) => page.returnedChars < 6000));
  heavy.blocks = [{ id: "dense", type: "html", html_profile: "reader-html-1", role: "文".repeat(128), num: "文".repeat(128), html: `<p data-node-id="dense-node">${"文".repeat(6000)}${Array.from({ length: 6 }, () => `<a href="${href}">X</a>`).join("")}${Array.from({ length: 2 }, () => `<img src="${"图".repeat(490)}.png" alt="image">`).join("")}</p>` }];
  revisions.set(1, await validateDocument(heavy));
  const densePages = await collect(workspace, { view: "content", document_id: "reading", max_chars: 6000 });
  assert.equal(densePages.map((page) => page.text.replace(/\n\n/g, "")).join(""), "文".repeat(6000) + "XXXXXX");
});

test("cursor validates projection version, sequence and Unicode offsets even with a recomputed checksum", async () => {
  const { workspace } = await fixture();
  const first = await readDocumentProjection(workspace, { view: "content", document_id: "reading", block_id: "long", max_chars: 100 });
  const original = JSON.parse(Buffer.from(first.next.cursor.split(".")[0], "base64url").toString("utf8"));
  const corrupt = (patch) => { const body = Buffer.from(JSON.stringify({ ...original, ...patch })).toString("base64url"); return body + "." + hash(body).slice(0, 24); };
  for (const patch of [{ p: "reader-reading-next" }, { i: 999999 }, { o: 12 }, { unexpected: true }]) {
    // The long entry has an emoji at offsets 11..13; 12 splits its surrogate pair.
    await assert.rejects(readDocumentProjection(workspace, { ...first.next, cursor: corrupt(patch) }), { code: "INVALID_CURSOR" });
  }
});

test("real MCP read_context advertises and dispatches all three views while preserving omitted exact", async (t) => {
  const { workspace } = await fixture(), server = createWorkspaceMcp(workspace), client = new Client({ name: "reading-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  for (const args of [{ view: "outline", document_id: "reading" }, { view: "content", document_id: "reading" }, { view: "exact", document_id: "reading", block_id: "preface" }, { document_id: "reading", block_id: "preface" }]) {
    const response = await client.callTool({ name: "read_context", arguments: args });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
  }
  const projected = (await client.callTool({ name: "read_context", arguments: { view: "content", document_id: "reading", block_id: "html", max_chars: 6000 } })).structuredContent;
  assert.equal(projected.readOnlyProjection, true);
  const footnote = projected.spans.find((span) => span.address.blockId === "footnote");
  const exactFootnote = (await client.callTool({ name: "read_context", arguments: { view: "exact", document_id: projected.documentId, revision: projected.revision, block_id: footnote.address.blockId, field: footnote.address.field, before_chars: 0 } })).structuredContent;
  assert.equal(exactFootnote.segments[0].text, projected.text.slice(footnote.textStart, footnote.textEnd));
  const reference = projected.spans.find((span) => span.address.blockId === "reference");
  assert.equal(reference.role, "bibliography");
  const exactReference = (await client.callTool({ name: "read_context", arguments: { document_id: projected.documentId, revision: projected.revision, block_id: reference.address.blockId, before_chars: 0 } })).structuredContent;
  assert.equal(exactReference.segments[0].text, "Author (2026). Study.");
  assert.throws(() => readContextInput.parse({ view: "content", document_id: "reading", field: "text" }));
  assert.throws(() => readContextInput.parse({ view: "outline", document_id: "reading", max_chars: 6001 }));
});
