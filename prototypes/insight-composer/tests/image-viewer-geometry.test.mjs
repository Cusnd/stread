import assert from "node:assert/strict";
import test from "node:test";
import { getImageViewerFit } from "../src/image-viewer-geometry.js";

const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);

// Project all four corners, independently of the helper's bounding-box formula,
// so a fit that centers the wrong dimensions cannot pass the containment check.
function transformedBounds({ width, height, rotation }, fit) {
  const angle = rotation * Math.PI / 180;
  const centerX = fit.x + width * fit.ratio / 2, centerY = fit.y + height * fit.ratio / 2;
  const corners = [-1, 1].flatMap((horizontal) => [-1, 1].map((vertical) => {
    const x = horizontal * width * fit.ratio / 2, y = vertical * height * fit.ratio / 2;
    return { x: centerX + x * Math.cos(angle) - y * Math.sin(angle), y: centerY + x * Math.sin(angle) + y * Math.cos(angle) };
  }));
  return { left: Math.min(...corners.map(({ x }) => x)), right: Math.max(...corners.map(({ x }) => x)), top: Math.min(...corners.map(({ y }) => y)), bottom: Math.max(...corners.map(({ y }) => y)) };
}

function assertFits(input, expectedArea) {
  const fit = getImageViewerFit(input);
  assert.ok(fit && fit.ratio > 0 && fit.ratio <= 1);
  const bounds = transformedBounds({ ...input, rotation: input.rotation || 0 }, fit);
  assert.ok(bounds.left >= expectedArea.left - 1e-8 && bounds.right <= expectedArea.right + 1e-8, "rotated width stays between side controls");
  assert.ok(bounds.top >= expectedArea.top - 1e-8 && bounds.bottom <= expectedArea.bottom + 1e-8, "rotated height stays between header and toolbar");
  closeTo((bounds.left + bounds.right) / 2, (expectedArea.left + expectedArea.right) / 2);
  closeTo((bounds.top + bounds.bottom) / 2, (expectedArea.top + expectedArea.bottom) / 2);
  return fit;
}

test("portrait image rotated 90 degrees fits its new landscape bounds", () => {
  const fit = assertFits({ width: 800, height: 1400, rotation: 90, viewportWidth: 1200, viewportHeight: 800 }, { left: 72, right: 1128, top: 64, bottom: 696 });
  closeTo(fit.ratio, 1056 / 1400);
  assert.ok(fit.y < 0, "unrotated top may be outside the viewport while all rotated corners remain visible");
});

test("landscape image rotated 90 degrees fits vertically and preserves toolbar clearance", () => {
  const fit = assertFits({ width: 1600, height: 900, rotation: 90, viewportWidth: 1200, viewportHeight: 800 }, { left: 72, right: 1128, top: 64, bottom: 696 });
  closeTo(fit.ratio, 632 / 1600);
  closeTo(fit.x + 1600 * fit.ratio / 2, 600);
  closeTo(fit.y + 900 * fit.ratio / 2, 380);
});

test("270-degree and repeated clockwise/counterclockwise turns keep the same fit", () => {
  const input = { width: 800, height: 1400, viewportWidth: 1200, viewportHeight: 800 };
  const expected = getImageViewerFit({ ...input, rotation: 90 });
  for (const rotation of [270, -90, 630, -450]) {
    const fit = assertFits({ ...input, rotation }, { left: 72, right: 1128, top: 64, bottom: 696 });
    for (const key of ["ratio", "x", "y"]) closeTo(fit[key], expected[key]);
  }
});

test("arbitrary rotation contains all four corners rather than fitting original dimensions", () => {
  const fit = assertFits({ width: 1200, height: 800, rotation: 45, viewportWidth: 1200, viewportHeight: 800 }, { left: 72, right: 1128, top: 64, bottom: 696 });
  closeTo(fit.ratio, 632 / (1000 * Math.SQRT2));
});

test("small source images retain native size and center inside the available area", () => {
  const fit = assertFits({ width: 200, height: 100, viewportWidth: 1200, viewportHeight: 800 }, { left: 72, right: 1128, top: 64, bottom: 696 });
  assert.deepEqual(fit, { ratio: 1, x: 500, y: 330 });
});

test("tiny viewports proportionally reduce insets and retain finite visible image bounds", () => {
  for (const [viewportWidth, viewportHeight] of [[100, 100], [1, 1], [0.5, 0.25]]) {
    const top = viewportHeight * 64 / 336, bottom = viewportHeight * 104 / 336;
    assertFits({ width: 1600, height: 900, rotation: 90, viewportWidth, viewportHeight }, { left: viewportWidth / 4, right: viewportWidth * 3 / 4, top, bottom: viewportHeight - bottom });
  }
});

test("invalid source or viewport dimensions and rotation do not produce transforms", () => {
  const valid = { width: 1200, height: 800, viewportWidth: 1000, viewportHeight: 700 };
  assert.equal(getImageViewerFit(), null);
  for (const key of ["width", "height", "viewportWidth", "viewportHeight"]) {
    for (const value of [0, -1, NaN, Infinity, -Infinity, undefined, null, "100"]) assert.equal(getImageViewerFit({ ...valid, [key]: value }), null, `${key}: ${value}`);
  }
  for (const rotation of [NaN, Infinity, -Infinity, null, "90"]) assert.equal(getImageViewerFit({ ...valid, rotation }), null);
});
