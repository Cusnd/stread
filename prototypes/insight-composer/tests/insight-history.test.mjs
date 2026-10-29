import test from "node:test";
import assert from "node:assert/strict";
import { forgetRestored, readInsightHistory, reconcileInsightHistory, rememberDeleted, rememberReferences } from "../src/insight-history.js";
import { assignReference } from "../src/references.js";
import { insightFailureMessage } from "../src/insight-content.js";

test("consecutive deletions survive refresh and undo in reverse order with exact receipts", () => {
  const first = { id: "a", reference: "#Q00007", references: { Q: "#Q00007", N: "#N00012" }, version: 3, archivedAt: "2026-10-21", answer: { text: "Keep this answer" }, blockId: "paragraph", variant: "zh-CN", start: 1, end: 3 };
  const second = { id: "b", reference: "#N00013", version: 2, archivedAt: "2026-10-21" };
  let history = { deleted: [], references: [] };
  history = rememberDeleted(rememberDeleted(history, first), second);
  const refreshed = readInsightHistory({ getItem: () => JSON.stringify(history) }, "doc");
  assert.deepEqual(refreshed.deleted.at(-1), second);
  history = forgetRestored(refreshed, second.id);
  assert.deepEqual(history.deleted.at(-1), first);
  assert.equal(forgetRestored(history, first.id).deleted.length, 0);
});

test("discarding undo receipts never recycles a previously used prototype reference", () => {
  const note = { id: "last", reference: "#N00013", references: { N: "#N00013", Q: "#Q00007" }, archivedAt: "2026-10-21" };
  let history = rememberReferences({ deleted: [], references: [] }, [note]);
  history = forgetRestored(rememberDeleted(history, note), note.id);
  assert.equal(rememberReferences(history, [note]), history);
  const seen = history.references.map((reference) => ({ reference }));
  assert.equal(assignReference({ type: "annotation" }, seen).reference, "#N00014");
  assert.equal(assignReference({ type: "question" }, seen).reference, "#Q00008");
});

test("history tolerates unavailable or corrupt tab storage", () => {
  const empty = { deleted: [], references: [] };
  for (const raw of ["null", "{", "42", "{}", '{"deleted":[null,{}, {"id":"active"}],"references":[null,4]}']) {
    assert.deepEqual(readInsightHistory({ getItem: () => raw }, "doc"), empty);
  }
  assert.deepEqual(readInsightHistory({ getItem: () => { throw new Error("blocked"); } }, "doc"), empty);
});

test("unknown network outcomes describe retained work without claiming a write failed", () => {
  assert.match(insightFailureMessage(new Error("Failed to fetch")), /无法确认保存结果.*草稿已保留/);
  assert.match(insightFailureMessage(new Error("NetworkError"), "删除"), /无法确认删除结果.*仍显示在列表/);
  assert.match(insightFailureMessage(null, "恢复"), /撤销记录已保留/);
  assert.equal(insightFailureMessage(new Error("洞见版本已经改变。")), "洞见版本已经改变。");
});

test("a later server restoration retires its undo receipt; an older response cannot", () => {
  const archived = { id: "a", version: 3, archivedAt: "2026-10-21" };
  const history = rememberDeleted({ deleted: [], references: [] }, archived);
  assert.equal(reconcileInsightHistory(history, [{ id: "a", version: 2 }]), history);
  assert.equal(reconcileInsightHistory(history, [{ id: "a", version: 4, archivedAt: "2026-10-22" }]), history);
  assert.equal(reconcileInsightHistory(history, [{ id: "a", version: 4 }]).deleted.length, 0);
});
