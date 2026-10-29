import test from "node:test";
import assert from "node:assert/strict";
import { captureReadingPosition, restoreReadingPosition } from "../src/reading-position.js";

const block = (id, { top = 150, bottom = 250, closed = null, visible = true } = {}) => ({
  dataset: { articleBlock: id }, getClientRects: () => [{ top, bottom }],
  getBoundingClientRect: () => ({ top, bottom, height: bottom - top }), checkVisibility: () => visible,
  closest: (selector) => selector === "details:not([open])" || selector === "details" ? closed : null,
});

test("automatic reading capture ignores closed disclosures even when the browser returns layout rectangles", () => {
  const hidden = block("author-notes", { top: 120, closed: { open: false }, visible: false });
  const body = block("abstract", { top: 300, bottom: 600 });
  const root = { querySelectorAll: () => [hidden, body] };
  assert.deepEqual(captureReadingPosition(root, 100), { blockId: "abstract", offsetRatio: 0, viewportOffset: 300 });
  const noVisibilityApi = { ...hidden, checkVisibility: undefined };
  assert.equal(captureReadingPosition({ querySelectorAll: () => [noVisibilityApi, body] }, 100).blockId, "abstract");
  assert.equal(captureReadingPosition({ querySelectorAll: () => [hidden] }, 100), null);
});

test("explicit reading restoration still opens a saved disclosure target", () => {
  const details = { open: false, parentElement: null }, target = block("author-notes", { closed: details, visible: false });
  const previousWindow = globalThis.window, previousDocument = globalThis.document, scrolls = [];
  globalThis.window = { scrollBy: (options) => scrolls.push(options) };
  globalThis.document = { querySelector: () => null };
  try {
    assert.equal(restoreReadingPosition({ querySelectorAll: () => [target] }, { blockId: "author-notes", offsetRatio: 0 }), true);
    assert.equal(details.open, true); assert.equal(scrolls.length, 1); assert.equal(scrolls[0].top, 48);
  } finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
});
