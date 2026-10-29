import test from "node:test";
import assert from "node:assert/strict";
import { normalizePdfPanelWidth, pdfPanelBounds, pdfPanelWidthForKey, resolvePdfPanelWidth } from "../src/pdf-panel-width.js";

test("a desktop PDF can grow to a readable page while reserving a reading column and pinned outline", () => {
  const bounds = pdfPanelBounds(1700, 232);
  assert.equal(bounds.defaultWidth, 560);
  assert.ok(bounds.max >= 800);
  assert.ok(1700 - bounds.max - 232 >= 480);
  assert.equal(resolvePdfPanelWidth(810, bounds), 810);
});

test("saved panel width clamps to the current desktop without destroying the larger preference", () => {
  const preferred = 850;
  const narrow = pdfPanelBounds(1200, 232);
  assert.equal(resolvePdfPanelWidth(preferred, narrow), 488);
  assert.equal(resolvePdfPanelWidth(preferred, pdfPanelBounds(1700, 232)), 850);
  assert.equal(resolvePdfPanelWidth(0, narrow), narrow.defaultWidth);
  assert.equal(normalizePdfPanelWidth("680"), null);
  assert.equal(normalizePdfPanelWidth(Infinity), null);
  assert.equal(normalizePdfPanelWidth(-50), null);
});

test("leftward separator keys grow the right pane and keyboard extremes honor its bounds", () => {
  const bounds = pdfPanelBounds(1700, 232);
  assert.equal(pdfPanelWidthForKey("ArrowLeft", 560, bounds), 576);
  assert.equal(pdfPanelWidthForKey("ArrowRight", 560, bounds), 544);
  assert.equal(pdfPanelWidthForKey("ArrowLeft", 560, bounds, true), 624);
  assert.equal(pdfPanelWidthForKey("Home", 560, bounds), 300);
  assert.equal(pdfPanelWidthForKey("End", 560, bounds), bounds.max);
  assert.equal(pdfPanelWidthForKey("ArrowLeft", bounds.max, bounds), bounds.max);
  assert.equal(pdfPanelWidthForKey("Escape", 560, bounds), null);
});
