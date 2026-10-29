import test from "node:test";
import assert from "node:assert/strict";
import { captureArticleSelection, restoreArticleSelection, selectionContextHit } from "../src/reader-context-selection.js";

function fixture() {
  const child = { nodeType: 3 }, target = { nodeType: 1 };
  const block = { nodeType: 1, isConnected: true, contains: (node) => [block, child, target].includes(node), closest: () => block };
  child.parentElement = block;
  const root = { contains: (node) => [root, block, child, target].includes(node) };
  const rects = [
    { left: 80, top: 120, right: 200, bottom: 140, width: 120, height: 20 },
    { left: 80, top: 145, right: 130, bottom: 165, width: 50, height: 20 },
  ];
  const range = { startContainer: child, endContainer: child, toString: () => "selected words", getClientRects: () => rects, cloneRange() { return { ...this }; } };
  const selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range };
  return { root, block, child, target, range, selection, rects };
}

test("secondary-button snapshot owns its range and rejects unselected space in the same paragraph", () => {
  const f = fixture();
  const snapshot = captureArticleSelection(f.root, f.selection);
  assert.notEqual(snapshot.range, f.range);
  assert.equal(selectionContextHit(snapshot, f.target, { clientX: 110, clientY: 130 }), true);
  assert.equal(selectionContextHit(snapshot, f.target, { clientX: 180, clientY: 155 }), false);
  assert.equal(selectionContextHit(snapshot, f.target, { clientX: 110, clientY: 180 }), false);
  assert.equal(snapshot.anchorRect, f.rects[1]);
  // The live selection can be changed by the browser after pointerdown.
  f.selection.isCollapsed = true;
  assert.equal(selectionContextHit(snapshot, f.target, { clientX: 110, clientY: 130 }), true);
});

test("keyboard invocation accepts the focused article or selected source, not another source", () => {
  const f = fixture(), snapshot = captureArticleSelection(f.root, f.selection);
  assert.equal(selectionContextHit(snapshot, f.root, { keyboard: true }), true);
  assert.equal(selectionContextHit(snapshot, f.target, { keyboard: true }), true);
  const other = {};
  f.root.contains = (node) => [f.root, f.block, f.child, f.target, other].includes(node);
  assert.equal(selectionContextHit(snapshot, other, { keyboard: true }), false);
});

test("ranges spanning different cells, translations, or source nodes are never turned into one invented source", () => {
  const f = fixture();
  const otherBlock = { closest() { return this; } }, otherText = { nodeType: 3, parentElement: otherBlock };
  f.root.contains = () => true;
  f.range.endContainer = otherText;
  assert.equal(captureArticleSelection(f.root, f.selection), null);
  f.range.endContainer = f.child;
  f.selection.isCollapsed = true;
  assert.equal(captureArticleSelection(f.root, f.selection), null);
  f.selection.isCollapsed = false;
  f.range.toString = () => "  \n ";
  assert.equal(captureArticleSelection(f.root, f.selection), null);
});

test("dismissal restores the captured range only while its original source remains mounted", () => {
  const f = fixture(), snapshot = captureArticleSelection(f.root, f.selection);
  const restored = [];
  const selection = { removeAllRanges: () => restored.push("clear"), addRange: (range) => restored.push(range) };
  assert.equal(restoreArticleSelection(snapshot, selection), true);
  assert.equal(restored[0], "clear");
  assert.equal(restored[1].startContainer, f.child);
  f.block.isConnected = false;
  assert.equal(restoreArticleSelection(snapshot, selection), false);
  assert.equal(selectionContextHit(snapshot, f.target, { keyboard: true }), false);
  assert.equal(restored.length, 2);
});

test("a revision reusing a mounted element cannot restore an excerpt whose text changed", () => {
  const f = fixture(), snapshot = captureArticleSelection(f.root, f.selection);
  snapshot.range.toString = () => "new revision text";
  const selection = { removeAllRanges() { assert.fail("stale range must not clear current selection"); }, addRange() { assert.fail("stale range must not be restored"); } };
  assert.equal(restoreArticleSelection(snapshot, selection), false);
  assert.equal(selectionContextHit(snapshot, f.target, { keyboard: true }), false);
});
