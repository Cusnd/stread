import assert from "node:assert/strict";
import test from "node:test";
import { buildMarginGroups, layoutMarginGroups, marginGroupKey, measureMarginSources } from "../src/margin-groups.js";

const note = (id, source = {}, extra = {}) => ({ id, documentId: "fixture", revision: 2, version: 3, reference: `#N${id}`, type: "annotation", body: "Original annotation", color: "blue", blockId: "paragraph", field: "text", variant: "source", start: 0, end: 5, quote: "Quote", ...source, ...extra });
const geometry = (source, top, bottom, paper, order = 0) => ({ key: marginGroupKey(source, paper), source, top, bottom, order });

test("a paragraph group retains each independent record, duplicate color and saved source", () => {
  const notes = [note("3", {}, { color: "amber" }), note("4", { start: 20 }), note("5", { start: 40 }), note("6", { start: 60 }, { color: "rose" })];
  const before = JSON.stringify(notes);
  notes.forEach(Object.freeze); Object.freeze(notes);
  const groups = buildMarginGroups(notes);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].notes.map(n => n.color), ["amber", "blue", "blue", "rose"]);
  assert.deepEqual(groups[0].notes.map(n => n.reference), ["#N3", "#N4", "#N5", "#N6"]);
  assert.ok(groups[0].notes.every((n, i) => n === notes[i]));
  assert.equal(JSON.stringify(notes), before);
});

test("source variants share a logical paragraph without changing selection addresses or unstable order", () => {
  const notes = [note("translated", { variant: "zh-CN", start: 1 }), note("later", { start: 20 }), note("early-b", { start: 1 }), note("early-a", { start: 1 })];
  const first = buildMarginGroups(notes)[0];
  const reordered = buildMarginGroups([...notes].reverse())[0];
  assert.equal(first.key, marginGroupKey({ ...notes[0], variant: "source" }));
  assert.deepEqual(first.notes.map(n => n.id), ["early-a", "early-b", "later", "translated"]);
  assert.deepEqual(reordered.notes, first.notes);
  assert.equal(first.notes.at(-1).variant, "zh-CN");
});

test("empty highlights, unresolved, archived and document-wide entries remain outside margins", () => {
  const entries = [
    note("highlight", {}, { body: " \n " }),
    note("titled", {}, { body: "", title: "User-written title" }),
    note("unresolved", {}, { referenceStatus: "unresolved" }),
    note("archived", {}, { archivedAt: "2026-10-25" }),
    note("deleted", {}, { deletedAt: "2026-10-25" }),
    note("document", { blockId: undefined }),
  ];
  assert.deepEqual(buildMarginGroups(entries).flatMap(g => g.notes.map(n => n.id)), ["titled"]);
});

test("list items and HTML paragraphs stay separate even under the same block ID", () => {
  const items = [note("one", { blockId: "list", itemId: "one" }), note("two", { blockId: "list", itemId: "two" }), note("p", { blockId: "html", field: "html_text", nodeId: "p" }), note("q", { blockId: "html", field: "html_text", nodeId: "q" })];
  assert.equal(buildMarginGroups(items).length, 4);
  assert.notEqual(marginGroupKey(items[0]), marginGroupKey(items[1]));
  assert.notEqual(marginGroupKey(items[2]), marginGroupKey(items[3]));
  const available = [geometry(items[0], 100, 150), geometry(items[2], 200, 300)];
  assert.deepEqual(layoutMarginGroups(buildMarginGroups(items), available).flatMap(g => g.notes.map(n => n.id)), ["one", "p"]);
});

test("bilingual bounds set the budget but long notes never push the next paragraph", () => {
  const longNotes = Array.from({ length: 12 }, (_, i) => note(String(i), { start: i }, { body: "A very long annotation. ".repeat(600) }));
  const translated = note("translation", { variant: "zh-CN" });
  const next = note("next", { blockId: "next" });
  const sources = [geometry(longNotes[0], 100, 300), geometry(translated, 320, 700), geometry(next, 740, 920, undefined, 2)];
  const layouts = layoutMarginGroups(buildMarginGroups([...longNotes, translated, next]), sources, { railTop: 20, maxHeight: 380 });
  assert.equal(layouts[0].top, 83);
  assert.equal(layouts[0].sourceBottom, 700);
  assert.equal(layouts[0].previewCount, 3);
  assert.equal(layouts[0].notes.length, 13);
  assert.equal(layouts[0].height, 368);
  assert.equal(layouts[1].top, 723);
  assert.ok(layouts.every(g => g.top + g.height + 20 <= g.sourceBottom));
  assert.equal(layouts[0].sourceOverlap, false);
});

test("short or tiny sources use compact bounds without inventing room below them", () => {
  const n = note("short");
  for (const height of [12, 27, 70, 150]) {
    const [layout] = layoutMarginGroups(buildMarginGroups([n]), [geometry(n, 100, 100 + height)], { railTop: 45 });
    assert.equal(layout.compact, true);
    assert.equal(layout.previewCount, 0);
    assert.ok(layout.height <= 32);
    assert.ok(layout.top + layout.height + 45 <= 100 + height);
  }
  assert.equal(layoutMarginGroups(buildMarginGroups([n]), [geometry(n, 100, 100)]).length, 0);
});

test("preview capacity stays bounded for one note, large groups, and narrow height budgets", () => {
  const notes = Array.from({ length: 20 }, (_, i) => note(String(i)));
  const bounds = [geometry(notes[0], 0, 1000)];
  assert.equal(layoutMarginGroups(buildMarginGroups(notes), bounds, { maxHeight: 220 })[0].previewCount, 1);
  assert.equal(layoutMarginGroups(buildMarginGroups(notes), bounds, { maxHeight: 1000, maxPreview: 12 })[0].previewCount, 3);
  const single = layoutMarginGroups(buildMarginGroups([notes[0]]), bounds)[0];
  assert.equal(single.previewCount, 1);
  assert.equal(single.height, 152);
});

test("authored tables and figures use object groups, retaining every cell or field address", () => {
  const paper = { blocks: [{ id: "table", type: "table", head: [["A", "B"]], rows: [["one", "two"]], caption: "Caption", caption_pos: "below" }, { id: "figure", type: "figure" }] };
  const table = [note("a", { blockId: "table", field: "head", row: 0, column: 0 }), note("b", { blockId: "table", field: "rows", row: 0, column: 1 }), note("c", { blockId: "table", field: "caption" })];
  const figure = [note("d", { blockId: "figure", field: "caption" }), note("e", { blockId: "figure", field: "image_text" })];
  const before = JSON.stringify([...table, ...figure]);
  const groups = buildMarginGroups([...figure, ...table].reverse(), paper);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].notes.map(n => n.id), ["a", "b", "c"]);
  assert.equal(groups[0].notes[1].column, 1);
  assert.equal(JSON.stringify([...table, ...figure]), before);
  const ghost = note("ghost", { blockId: "table", field: "rows", row: 0, column: 9 });
  const actual = table.map(n => geometry(n, 50, 400, paper));
  const [layout] = layoutMarginGroups(buildMarginGroups([...table, ghost], paper), actual);
  assert.deepEqual(layout.notes.map(n => n.id), ["a", "b", "c"]);
});

test("semantic HTML tables group their cells but never merge surrounding paragraphs or another table", () => {
  const node = (tag, nodeId, children = []) => ({ kind: "element", tag, ...(nodeId ? { nodeId } : {}), children });
  const paper = { blocks: [{ id: "html", type: "html", compiledHtml: { source: { tree: [node("p", "p1"), node("table", null, [node("tr", null, [node("td", "a"), node("td", "b")])]), node("p", "p2"), node("table", null, [node("tr", null, [node("td", "c")])])] } } }] };
  const notes = ["p1", "a", "b", "p2", "c"].map(id => note(id, { blockId: "html", field: "html_text", nodeId: id }));
  const groups = buildMarginGroups(notes, paper);
  assert.deepEqual(groups.map(g => g.notes.map(n => n.nodeId)), [["p1"], ["a", "b"], ["p2"], ["c"]]);
  assert.notEqual(marginGroupKey(notes[1], paper), marginGroupKey(notes[4], paper));
});

test("two parallel paragraphs use distinct compact lanes without merging or vertical displacement", () => {
  const a = note("a", { blockId: "html", field: "html_text", nodeId: "a" });
  const b = note("b", { blockId: "html", field: "html_text", nodeId: "b" });
  const layouts = layoutMarginGroups(buildMarginGroups([a, b]), [geometry(a, 10, 500), geometry(b, 10, 500, undefined, 1)]);
  assert.equal(layouts.length, 2);
  assert.ok(layouts.every(g => g.sourceOverlap && g.top === 13));
  assert.ok(layouts.every(g => g.compact && g.overlapCompact && g.previewCount === 0 && g.height === 32));
  assert.deepEqual(layouts.map(g => [g.laneIndex, g.laneCount]), [[0, 2], [1, 2]]);
  assert.deepEqual(layouts.map(g => g.notes.map(n => n.id)), [["a"], ["b"]]);
});

test("a connected three-entry overlap cluster shares one lane count even when first and last do not touch", () => {
  const notes = ["a", "b", "c", "next"].map(id => note(id, { blockId: id }));
  const sources = [geometry(notes[0], 10, 500), geometry(notes[1], 35, 500), geometry(notes[2], 60, 500), geometry(notes[3], 600, 900)];
  const layouts = layoutMarginGroups(buildMarginGroups(notes), sources);
  assert.deepEqual(layouts.slice(0, 3).map(g => [g.top, g.height, g.laneIndex, g.laneCount]), [[13, 32, 0, 3], [38, 32, 1, 3], [63, 32, 2, 3]]);
  assert.equal(layouts[3].compact, false);
  assert.deepEqual([layouts[3].laneIndex, layouts[3].laneCount], [0, 1]);
  assert.ok(layouts.every(g => g.top + g.height <= g.sourceBottom));
});

test("overlapping source envelopes alone do not compress nonintersecting preview rectangles", () => {
  const a = note("a", { blockId: "a" }), b = note("b", { blockId: "b" });
  const layouts = layoutMarginGroups(buildMarginGroups([a, b]), [geometry(a, 10, 900), geometry(b, 200, 900)]);
  assert.ok(layouts.every(g => g.sourceOverlap));
  assert.ok(layouts.every(g => !g.compact && !g.overlapCompact && g.previewCount === 1 && g.laneCount === 1));
  assert.deepEqual(layouts.map(g => g.top), [13, 203]);
});

test("separate short-entry clusters cannot give inconsistent lane widths", () => {
  const notes = ["a", "b", "c", "d", "e"].map(id => note(id, { blockId: id }));
  const sources = [geometry(notes[0], 10, 200), geometry(notes[1], 10, 200), geometry(notes[2], 80, 200), geometry(notes[3], 80, 200), geometry(notes[4], 80, 200)];
  const layouts = layoutMarginGroups(buildMarginGroups(notes), sources);
  assert.deepEqual(layouts.map(g => [g.laneIndex, g.laneCount]), [[0, 2], [1, 2], [0, 3], [1, 3], [2, 3]]);
  assert.deepEqual(layouts.map(g => g.top), [13, 13, 83, 83, 83]);
});

test("normal bilingual envelopes remain one full-width group per logical paragraph", () => {
  const a = note("a", { blockId: "a" }), translated = note("a-zh", { blockId: "a", variant: "zh-CN" }), b = note("b", { blockId: "b" });
  const groups = buildMarginGroups([translated, b, a]);
  const layouts = layoutMarginGroups(groups, [geometry(a, 10, 220), geometry(translated, 230, 450), geometry(b, 480, 700)]);
  assert.equal(layouts.length, 2);
  assert.deepEqual(layouts[0].notes.map(n => n.id), ["a", "a-zh"]);
  assert.ok(layouts.every(g => !g.compact && !g.sourceOverlap && g.laneCount === 1 && g.laneIndex === 0));
  assert.equal(layouts[0].sourceBottom, 450);
  assert.equal(layouts[1].top, 483);
});

function element(dataset, top, bottom, { visible = true, closed = false, owner = null, table = null } = {}) {
  return {
    dataset, getClientRects: () => visible ? [{}] : [], getBoundingClientRect: () => ({ top, bottom }),
    closest: (selector) => selector === "details:not([open])" ? (closed ? {} : null) : selector === "[data-article-block]" ? owner : selector === "table" ? table : null,
  };
}

test("DOM measurement excludes hidden nodes and uses exact identities with explicit object bounds", () => {
  const paper = { blocks: [{ id: "table", type: "table", head: [], rows: [["a", "b"]] }] };
  const owner = { getBoundingClientRect: () => ({ top: 200, bottom: 500 }) };
  const els = [
    element({ blockId: "paragraph", variant: "source", field: "text" }, 10, 80),
    element({ blockId: "paragraph", variant: "zh-CN", field: "text" }, 90, 170),
    element({ blockId: "table", field: "rows", row: "0", column: "0" }, 250, 280, { owner }),
    element({ blockId: "table", field: "rows", row: "0", column: "1" }, 250, 280, { owner }),
    element({ blockId: "hidden" }, 600, 700, { visible: false }),
    element({ blockId: "folded" }, 600, 700, { closed: true }),
    element({ blockId: "zero" }, 800, 800),
  ];
  const measured = measureMarginSources({ querySelectorAll: () => els }, paper);
  assert.equal(measured.length, 4);
  assert.deepEqual(measured.slice(2).map(s => [s.top, s.bottom]), [[200, 500], [200, 500]]);
  assert.equal(measured[2].key, measured[3].key);
  assert.notEqual(measured[2].exactSourceKey, measured[3].exactSourceKey);
  assert.equal(measured[3].source.column, 1);
  assert.deepEqual(measureMarginSources(null, paper), []);
});
