import assert from "node:assert/strict";
import test from "node:test";
import { syncConflictRows, syncRecordPreview, syncRecordReferences } from "../src/sync-view.js";

test("conflict previews preserve untitled content, deletion state and readable plan order", () => {
  const row = { payload: JSON.stringify({ body: "My own untitled note", quote: "Source quote" }) };
  const preview = syncRecordPreview("insights", row);
  assert.equal(preview.title, "洞见"); assert.deepEqual(preview.lines, ["My own untitled note", "Source quote"]);
  assert.equal(syncRecordPreview("insights", null).title, "已移除");
  const plan = syncRecordPreview("metadata", { key: "plan", value: '["b","a"]' }, { documents: { a: { title: "Attention" }, b: { title: "Residual Networks" } } });
  assert.deepEqual(plan.lines, ["1. Residual Networks", "2. Attention"]);
  const term = syncRecordPreview("glossary", { payload: '{"term":"Gradient","definition":"Rate of change","deletedAt":"2026-01-01"}' });
  assert.equal(term.title, "Gradient"); assert.deepEqual(term.lines, ["Rate of change", "已删除"]);
});

test("reading positions show source text and a paragraph offset without a fabricated article progress", () => {
  const preview = syncRecordPreview("reading", { document_id: "article", payload: '{"revision":2,"blockId":"p1","offsetRatio":0.25,"mode":"bilingual"}' }, { documents: { article: { title: "Attention" } }, positions: { "article:2": { blocks: [{ id: "h1", type: "heading", text: "Background" }, { id: "p1", type: "para", text: "The source paragraph." }] } } });
  assert.deepEqual(preview.lines, ["双语对照", "Background", "The source paragraph.", "段落内 25%"]);
  assert.ok(!JSON.stringify(preview).includes("p1"));
});

test("immutable body references load only document objects and render their source content", () => {
  const sha256 = "a".repeat(64), ref = { key: "objects/sha256/" + sha256, sha256, size: 123, version: 1 };
  const local = { entity: "revisions", key: '["article",2]', value: { document_id: "article", revision: 2, content: JSON.stringify({ $readerObject: ref }) } };
  const rows = syncConflictRows({ local: [local, { entity: "receipts", key: '["r"]', value: { payload: "private internal receipt" } }], remote: [{ ...local, value: null }] });
  assert.equal(rows.length, 1); assert.deepEqual(syncRecordReferences(rows), [ref]);
  const preview = syncRecordPreview("revisions", local.value, { objects: { [ref.key]: { meta: { title: "Article" }, blocks: [{ type: "para", text: "The full paragraph." }] } } });
  assert.equal(preview.title, "Article"); assert.deepEqual(preview.lines, ["正文第 2 版", "The full paragraph."]);
});
