import assert from "node:assert/strict";
import test from "node:test";
import { getDesktopControlsWidth, hasDesktopTitlebar, observeDesktopHeader } from "../src/desktop-chrome.js";

test("desktop chrome is enabled only by the Windows preload capability", () => {
  assert.equal(hasDesktopTitlebar(undefined), false);
  assert.equal(hasDesktopTitlebar({ platform: "win32" }), false);
  assert.equal(hasDesktopTitlebar({ platform: "darwin", titleBarOverlay: true }), false);
  assert.equal(hasDesktopTitlebar({ platform: "win32", titleBarOverlay: true }), true);
});

test("native controls reserve follows resized overlay geometry and clears in fullscreen", () => {
  let rect = { x: 0, width: 1062 };
  const overlay = { visible: true, getTitlebarAreaRect: () => rect };
  assert.equal(getDesktopControlsWidth({ overlay, viewportWidth: 1200 }), 138);
  rect = { x: 0, width: 745.5 };
  assert.equal(getDesktopControlsWidth({ overlay, viewportWidth: 900 }), 155);
  assert.equal(getDesktopControlsWidth({ overlay, viewportWidth: 900, fullscreen: true }), 0);
  overlay.visible = false;
  assert.equal(getDesktopControlsWidth({ overlay, viewportWidth: 900 }), 0);
  overlay.visible = true;
  rect = { x: 0, width: 0 };
  assert.equal(getDesktopControlsWidth({ overlay, viewportWidth: 900 }), 138);
  assert.equal(getDesktopControlsWidth({ viewportWidth: 900 }), 138);
});

test("header height uses measured CSS pixels, updates after interface scaling and disconnects", () => {
  let height = 56;
  let notify;
  let observed;
  let disconnected = false;
  const calls = [];
  const header = { getBoundingClientRect: () => ({ height }) };
  class ResizeObserverStub {
    constructor(callback) { notify = callback; }
    observe(value) { observed = value; }
    disconnect() { disconnected = true; }
  }
  const stop = observeDesktopHeader(header, { platform: "win32", titleBarOverlay: true, setTitlebarHeight: (value) => calls.push(value) }, ResizeObserverStub);
  assert.equal(observed, header);
  notify();
  height = 84;
  notify();
  height = 0;
  notify();
  assert.deepEqual(calls, [56, 84]);
  stop();
  assert.equal(disconnected, true);
});

test("ordinary browser headers neither observe nor call native APIs", () => {
  const stop = observeDesktopHeader({ getBoundingClientRect() { throw new Error("browser measured"); } }, undefined, class { constructor() { throw new Error("browser observed"); } });
  assert.equal(typeof stop, "function");
  stop();
});
