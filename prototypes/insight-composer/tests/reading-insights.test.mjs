import test from "node:test";
import assert from "node:assert/strict";
import { canSaveInsight, isHighlightOnly } from "../src/insight-content.js";
import { assignReference } from "../src/references.js";
import { normalizeReadingPreferences, getReadingPreferences, subscribeReadingPreferences, updateReadingPreferences } from "../src/reading-preferences.js";

test("empty commentary saves only an anchored annotation, never an empty question or note", () => {
  const source = { blockId: "p-1", quote: "an excerpt", start: 2, end: 12, body: " \n " };
  assert.equal(canSaveInsight({ ...source, type: "annotation" }), true);
  for (const type of ["question", "note"]) assert.equal(canSaveInsight({ ...source, type }), false);
  assert.equal(canSaveInsight({ type: "annotation", body: "" }), false);
  assert.equal(canSaveInsight({ type: "annotation", blockId: "p-1", quote: "  ", body: "" }), false);
  assert.equal(canSaveInsight({ type: "question", body: "Why?" }), true);
  assert.equal(canSaveInsight(null), false);
});

test("adding commentary retains the original source, language, color, ID and reference", () => {
  const highlight = assignReference({ id: "h-1", type: "annotation", blockId: "html-1", nodeId: "n-4", variant: "zh-CN", field: "html_text", quote: "计数", start: 3, end: 5, body: "", color: "macaron-lilac" }, [{ reference: "#N00009" }]);
  const restored = JSON.parse(JSON.stringify(highlight));
  const annotated = assignReference({ ...restored, body: "这里按键分组。" }, [restored]);
  assert.equal(highlight.reference, "#N00010");
  assert.equal(isHighlightOnly(restored), true);
  assert.equal(isHighlightOnly(annotated), false);
  assert.deepEqual({ ...annotated, body: "" }, highlight);
  assert.equal(canSaveInsight(annotated), true);
});

test("formula-only highlights retain whole-equation source and original TeX", () => {
  const formula = { type: "annotation", sourceType: "math", blockId: "eq-2", tex: "x^2+y^2", quote: "", body: "" };
  assert.equal(canSaveInsight(formula), true);
  assert.equal(isHighlightOnly(formula), true);
  assert.equal(assignReference(formula, []).tex, formula.tex);
});

test("corrupt and out-of-range reading settings recover bounded independent values", () => {
  assert.deepEqual(normalizeReadingPreferences(null), { version: 2, fontSize: 20, readingWidthPercent: 80 });
  assert.deepEqual(normalizeReadingPreferences({ fontSize: 12, readingWidthPercent: 5000 }), { version: 2, fontSize: 14, readingWidthPercent: 100 });
  assert.deepEqual(normalizeReadingPreferences({ fontSize: 50, readingWidthPercent: 30 }), { version: 2, fontSize: 24, readingWidthPercent: 50 });
  assert.deepEqual(normalizeReadingPreferences({ fontSize: NaN, readingWidthPercent: "90" }), { version: 2, fontSize: 20, readingWidthPercent: 80 });
  assert.deepEqual(normalizeReadingPreferences(JSON.parse(JSON.stringify({ fontSize: 14, readingWidthPercent: 85 }))), { version: 2, fontSize: 14, readingWidthPercent: 85 });
  assert.equal(normalizeReadingPreferences({ readingWidthPercent: 83 }).readingWidthPercent, 85);
});

test("legacy pixel widths migrate to a responsive default without changing the chosen font", () => {
  for (const readingWidth of [680, 800, 860]) {
    assert.deepEqual(normalizeReadingPreferences({ version: 1, fontSize: 14, readingWidth }), { version: 2, fontSize: 14, readingWidthPercent: 80 });
  }
});

test("width changes preserve font size and continue working without storage", () => {
  let notifications = 0;
  const unsubscribe = subscribeReadingPreferences(() => notifications++);
  updateReadingPreferences({ fontSize: 14 });
  updateReadingPreferences({ readingWidthPercent: 100 });
  assert.deepEqual(getReadingPreferences(), { version: 2, fontSize: 14, readingWidthPercent: 100 });
  const current = getReadingPreferences();
  updateReadingPreferences({ readingWidthPercent: 100 });
  assert.equal(getReadingPreferences(), current);
  assert.equal(notifications, 2);
  unsubscribe();
  updateReadingPreferences({ fontSize: 20, readingWidthPercent: 80 });
});
