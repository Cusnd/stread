import test from "node:test";
import assert from "node:assert/strict";
import { availableParents, canRemoveCollection, collectionLabel, deriveCollection, documentCategories, parseTags, readingPosition } from "./model.js";

function fixture() {
  const material = (id, title, status, collectionIds, tags, extra = {}) => ({ id, title, status, collectionIds, tags, summary: "", kind: "论文", readingState: null, version: 1, ...extra });
  return {
    revision: 12,
    planVersion: 3,
    currentId: "b",
    collections: [
      { id: "theory", label: "理论", parentId: null, version: 1 },
      { id: "learning", label: "机器学习", parentId: "theory", version: 1 },
      { id: "attention", label: "注意力", parentId: "learning", version: 1 },
      { id: "history", label: "历史", parentId: null, version: 1 },
      { id: "empty", label: "待整理", parentId: null, version: 1 },
    ],
    documents: [
      material("a", "Attention Is All You Need", "unread", ["attention"], ["英文", "经典"], { summary: "Transformer architecture" }),
      material("b", "Sparsely-Gated Mixture-of-Experts", "reading", ["theory", "learning"], ["英文", "综述"], { readingState: { blockId: "methods", offsetRatio: 0.4 } }),
      material("c", "数字史料", "done", ["history"], ["经典"]),
      material("d", "尚未分类的资料", "reading", [], ["英文"]),
      material("e", "已归档的注意力研究", "done", ["attention"], ["英文", "经典"], { archivedAt: "2026-10-18T09:00:00Z" }),
    ],
    planIds: ["c", "b", "a", "c", "e", "missing"],
  };
}

test("Nested categories include descendants once; labels suppress redundant ancestor memberships", () => {
  const workspace = fixture();
  const model = deriveCollection(workspace, { collectionId: "theory" });
  assert.deepEqual(model.rows.map((item) => item.id), ["a", "b"]);
  assert.equal(model.counts.theory, 2);
  assert.equal(model.counts.learning, 2);
  assert.equal(model.counts.attention, 1);
  assert.equal(collectionLabel(workspace.collections, "attention"), "理论 / 机器学习 / 注意力");
  assert.deepEqual(documentCategories(workspace.documents[1], workspace.collections), ["理论 / 机器学习"]);
});

test("Category, status, query and every selected tag combine; selection always belongs to visible rows", () => {
  const workspace = fixture();
  const view = { collectionId: "theory", status: "unread", query: "  TRANSFORMER  ", tags: ["英文", "经典"], selectedId: "b" };
  const model = deriveCollection(workspace, view);
  assert.deepEqual(model.rows.map((item) => item.id), ["a"]);
  assert.equal(model.selected.id, "a");
  assert.equal(model.filtered, true);
  assert.equal(model.counts.theory, 2);
  const noMatch = deriveCollection(workspace, { ...view, tags: ["英文", "综述"] });
  assert.equal(noMatch.rows.length, 0);
  assert.equal(noMatch.selected, null);
  assert.equal(view.selectedId, "b");
});

test("Plan default order and explicit sorting preserve selection and never mutate document order", () => {
  const workspace = fixture();
  const original = workspace.documents.map((item) => item.id);
  assert.deepEqual(deriveCollection(workspace, { collectionId: "plan" }).rows.map((item) => item.id), ["c", "b", "a"]);
  const byStatus = deriveCollection(workspace, { collectionId: "plan", sort: "status", selectedId: "c" });
  assert.deepEqual(byStatus.rows.map((item) => item.id), ["b", "a", "c"]);
  assert.equal(byStatus.selected.id, "c");
  assert.deepEqual(workspace.documents.map((item) => item.id), original);
  assert.deepEqual(deriveCollection(workspace, { collectionId: "uncategorized" }).rows.map((item) => item.id), ["d"]);
});

test("Archive and restore change one shared membership model and tolerate a removed selected category", () => {
  const workspace = fixture();
  assert.equal(deriveCollection(workspace, { collectionId: "all" }).counts.all, 4);
  const archived = deriveCollection(workspace, { collectionId: "archived", selectedId: "a" });
  assert.deepEqual(archived.rows.map((item) => item.id), ["e"]);
  assert.equal(archived.selected.id, "e");
  workspace.documents.find((item) => item.id === "e").archivedAt = null;
  assert.equal(deriveCollection(workspace, { collectionId: "archived" }).selected, null);
  assert.equal(deriveCollection(workspace, { collectionId: "theory" }).counts.theory, 3);
  assert.deepEqual(deriveCollection(workspace, { collectionId: "plan" }).rows.map((item) => item.id), ["c", "b", "a", "e"]);
  const stale = deriveCollection(workspace, { collectionId: "removed-category", selectedId: "e" });
  assert.equal(stale.collectionId, "all");
  assert.equal(stale.selected.id, "e");
});

test("Category edit excludes descendants and safe removal checks archived memberships too", () => {
  const workspace = fixture();
  assert.deepEqual(availableParents(workspace.collections, "theory").map((item) => item.id), ["history", "empty"]);
  assert.equal(canRemoveCollection(workspace, "theory"), false);
  assert.equal(canRemoveCollection(workspace, "attention"), false);
  assert.equal(canRemoveCollection(workspace, "empty"), true);
  workspace.documents = workspace.documents.filter((item) => item.id === "e");
  assert.equal(canRemoveCollection(workspace, "attention"), false);
});

test("Tag entry deduplicates user separators, and reading labels never invent a numeric progress", () => {
  assert.deepEqual(parseTags(" 英文，经典; 英文； 综述\n方法, "), ["英文", "经典", "综述", "方法"]);
  assert.equal(readingPosition({ status: "unread" }), "尚未开始");
  assert.equal(readingPosition({ status: "reading" }), "从开头阅读");
  assert.equal(readingPosition({ status: "reading", readingState: { blockId: "intro", offsetRatio: 0.7 } }), "已保存阅读位置");
  assert.equal(readingPosition({ status: "done", readingState: { blockId: "intro" } }), "已读完");
});
