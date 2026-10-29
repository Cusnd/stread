import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import katex from "katex";
import { inlineTokens, safeLink, sourceText, sameSource, normalizeMathSource } from "../src/document-content.js";
import { attentionNotes } from "../src/attention-example.js";

const root = new URL("../public/articles/attention-is-all-you-need/", import.meta.url);
const paper = JSON.parse(readFileSync(new URL("document.json", root), "utf8"));
const block = (id) => paper.blocks.find((item) => item.id === id);
const objects = [{ ...paper.meta, id: "meta", type: "meta" }, ...paper.blocks, ...paper.blocks.flatMap((b) => (b.items || []).map((i) => ({ ...i, type: "list_item" })))];
const fields = { meta: ["title"], heading: ["text"], para: ["text"], list_item: ["text"], figure: ["src", "alt", "caption", "image_text"], table: ["head", "rows", "caption"], math: ["tex"] };
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

test("complete v7 package has stable identities, sections, references and source PDF", () => {
  assert.equal(paper.format, "continous-reader");
  assert.equal(paper.schema, 1);
  assert.equal(new Set(objects.map((b) => b.id)).size, objects.length);
  assert.deepEqual(paper.blocks.filter((b) => b.type === "heading" && /^\d$/.test(b.num || "")).map((b) => b.num), ["1", "2", "3", "4", "5", "6", "7"]);
  assert.equal(paper.blocks.filter((b) => b.role === "reference").length, 40);
  assert.equal(paper.blocks.filter((b) => b.type === "figure").length, 5);
  assert.equal(paper.blocks.filter((b) => b.type === "table").length, 4);
  assert.equal(paper.blocks.filter((b) => b.type === "math").length, 5);
  assert.ok(block("Sx1.F5"));
  assert.ok(block("S7.SS0.SSS0.Px1"));
  assert.ok(block("footnote-4") && block("footnote-5") && block("author-details"));
  assert.equal(sha256(readFileSync(new URL(paper.source.path, root))), paper.source.sha256);
  assert.equal(paper.source.sha256, "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697");
  for (const b of paper.blocks) {
    assert.ok(b.source?.length, `${b.id} has a PDF source page`);
    assert.ok(b.source.every((s) => Number.isInteger(s.page) && s.page >= 1 && s.page <= 15), b.id);
    if (b.type === "figure") {
      assert.ok(existsSync(new URL(b.src, root)), b.src);
      const size = b.extensions["continous-reader.image-size"];
      assert.ok(size.width > 0 && size.height > 0);
    }
    if (b.type === "table") assert.ok(existsSync(new URL(b.extensions["continous-reader.source-table"].image, root)));
  }
});

test("every translatable object is paired with a matching source fingerprint", () => {
  for (const b of objects.filter((b) => !["math", "list"].includes(b.type))) {
    const translated = b.translations?.["zh-CN"];
    assert.ok(translated, `${b.id} has a translation`);
    const keys = fields[b.type];
    const fingerprint = "sha256:" + sha256(JSON.stringify(["en", b.type, ...keys.map((key) => b[key] ?? null)]));
    assert.equal(translated.source_hash, fingerprint, `${b.id} source fingerprint`);
    for (const key of keys.filter((k) => k !== "src")) {
      assert.equal(typeof translated[key], typeof b[key], `${b.id}.${key}`);
      if (typeof b[key] === "string" && b[key]) assert.ok(translated[key].trim());
    }
  }
  assert.match(block("abstract1.1").text, /41\.8/);
  assert.match(block("S6.SS1.p2.1").text, /41\.0/);
  assert.match(block("bib.bib12").translations["zh-CN"].text, /2001/);
});

test("tables retain pairing, blanks, numeric data and the original shared cost cell", () => {
  for (const b of paper.blocks.filter((b) => b.type === "table")) {
    for (const key of ["head", "rows"]) {
      const matrix = b[key], translated = b.translations["zh-CN"][key];
      assert.equal(matrix.length, translated.length, b.id);
      matrix.forEach((row, i) => {
        assert.equal(row.length, matrix[0].length, b.id);
        assert.equal(row.length, translated[i].length, b.id);
        row.forEach((cell, j) => {
          if (cell === "" || /^[\d\s.]+$/.test(cell) || /^\$[^$]+\$$/.test(cell)) assert.equal(translated[i][j], cell, `${b.id}.${key}[${i}][${j}]`);
        });
      });
    }
  }
  const table2 = paper.blocks.find((b) => b.type === "table" && b.num === "2");
  assert.equal(table2.rows.length, 10);
  assert.deepEqual(table2.rows.at(-1).slice(1, 5), ["**28.4**", "**41.8**", "", ""]);
  assert.match(table2.rows.at(-1)[5], /2\.3/);
  assert.equal(paper.blocks.find((b) => b.type === "table" && b.num === "3").rows.length, 20);
});

test("all inline and display TeX renders, and every internal link resolves", () => {
  const ids = new Set(objects.map((b) => b.id));
  for (const b of objects) {
    if (b.type === "math") assert.doesNotThrow(() => katex.renderToString(b.tex, { throwOnError: true, trust: false }), b.id);
    for (const obj of [b, b.translations?.["zh-CN"]].filter(Boolean)) {
      for (const key of fields[b.type] || []) {
        if (key === "src" || key === "tex") continue;
        for (const value of Array.isArray(obj[key]) ? obj[key].flat() : [obj[key]]) {
          if (typeof value !== "string") continue;
          assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), b.id);
          for (const token of inlineTokens(value)) {
            if (token.kind === "math") assert.doesNotThrow(() => katex.renderToString(token.text, { throwOnError: true, trust: false }), `${b.id}: ${token.text}`);
            if (token.kind === "link") {
              assert.ok(safeLink(token.href), `${b.id}: ${token.href}`);
              if (token.href.startsWith("#")) assert.ok(ids.has(token.href.slice(1)), `${b.id}: ${token.href}`);
            }
          }
        }
      }
    }
  }
});

test("bilingual source identities distinguish fields, list items, cells and languages", () => {
  for (const note of attentionNotes(paper)) {
    const text = sourceText(paper, note);
    assert.equal(note.sourceType === "math" ? text : text.slice(note.start, note.end), note.quote);
  }
  const list = paper.blocks.find((b) => b.type === "list");
  const itemSource = { blockId: list.id, itemId: list.items[1].id, variant: "zh-CN", field: "text" };
  assert.equal(sourceText(paper, itemSource), list.items[1].translations["zh-CN"].text);
  const table = paper.blocks.find((b) => b.type === "table");
  const cellSource = { blockId: table.id, variant: "zh-CN", field: "rows", row: 0, column: 0 };
  assert.equal(sourceText(paper, cellSource), table.translations["zh-CN"].rows[0][0]);
  for (const patch of [{ variant: "source" }, { field: "head" }, { row: 1 }, { column: 1 }]) assert.equal(sameSource(cellSource, { ...cellSource, ...patch }), false);
  assert.equal(sourceText(paper, { ...itemSource, itemId: "missing" }), "");
  assert.equal(sourceText(paper, { ...itemSource, variant: "fr" }), "");
});

test("inline tokens keep original-string offsets and display formulas discard presentation offsets", () => {
  const text = "取 $d_k$ 与 [文献](#bib.bib1)，**加粗**。";
  const tokens = inlineTokens(text);
  assert.equal(tokens.map((token) => text.slice(token.start, token.end)).join(""), text);
  assert.deepEqual(tokens.filter((t) => t.kind !== "text").map((t) => [t.kind, text.slice(t.start, t.end)]), [["math", "$d_k$"], ["link", "[文献](#bib.bib1)"], ["strong", "**加粗**"]]);
  for (const unsafe of ["javascript:alert(1)", "data:text/html,hi", "//example.com", "/private"]) assert.equal(safeLink(unsafe), undefined);
  const eq = block("S3.E1");
  const normalized = normalizeMathSource({ blockId: eq.id, start: 4, end: 8, quote: "katex text" }, { [eq.id]: { tex: eq.tex, number: eq.tag } });
  assert.equal(normalized.quote, eq.tex);
  assert.equal(normalized.field, "tex");
  assert.equal(normalized.sourceType, "math");
  assert.equal(normalized.start, undefined);
  assert.equal(normalized.end, undefined);
});
