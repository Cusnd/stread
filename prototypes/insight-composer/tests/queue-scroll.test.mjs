import test from "node:test";
import assert from "node:assert/strict";
import { restoreQueueScroll } from "../src/workspace/queue-scroll.js";

function fixture(top = 116, isSettled = () => true) {
  const scroll = new EventTarget(), content = {};
  let position = 0, maximum = 0, resize, disconnected = 0;
  Object.defineProperty(scroll, "scrollTop", { get: () => position, set: (value) => { position = Math.max(0, Math.min(value, maximum)); } });
  const ready = [];
  const controller = restoreQueueScroll({ scroll, content, top, isSettled, onReady: (value) => ready.push(value), ResizeObserver: class {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() { disconnected++; }
  } });
  return { scroll, ready, ...controller, resize: (value) => { maximum = value; resize(); }, disconnected: () => disconnected };
}

test("Queue restores the saved position only when the expanded content can hold it", () => {
  const view = fixture();
  assert.equal(view.scroll.scrollTop, 0);
  assert.deepEqual(view.ready, []);
  view.resize(60);
  assert.equal(view.scroll.scrollTop, 60);
  assert.deepEqual(view.ready, []);
  view.resize(200);
  assert.equal(view.scroll.scrollTop, 116);
  assert.deepEqual(view.ready, [{ interrupted: false, scrollTop: 116 }]);
  assert.equal(view.disconnected(), 1);
  view.scroll.scrollTop = 150;
  view.resize(300);
  assert.equal(view.scroll.scrollTop, 150);
});

test("user scrolling takes over before an unreachable saved position settles", () => {
  const view = fixture(500);
  view.resize(60);
  view.scroll.dispatchEvent(new Event("wheel"));
  assert.deepEqual(view.ready, [{ interrupted: true, scrollTop: 60 }]);
  view.scroll.scrollTop = 30;
  view.resize(800);
  assert.equal(view.scroll.scrollTop, 30);
  assert.equal(view.ready.length, 1);
});

test("keyboard navigation cancels pending restoration and unmount ignores later resizes", () => {
  const view = fixture();
  const key = new Event("keydown");
  key.key = "PageDown";
  view.scroll.dispatchEvent(key);
  assert.deepEqual(view.ready, [{ interrupted: true, scrollTop: 0 }]);
  const removed = fixture();
  removed.dispose();
  removed.resize(300);
  assert.equal(removed.scroll.scrollTop, 0);
  assert.deepEqual(removed.ready, []);
});

test("a saved top position completes immediately", () => {
  const view = fixture(0);
  assert.deepEqual(view.ready, [{ interrupted: false, scrollTop: 0 }]);
});

test("a transient reachable height does not replace the saved target during expansion", () => {
  let settled = false;
  const view = fixture(116, () => settled);
  view.resize(150);
  assert.equal(view.scroll.scrollTop, 116);
  assert.deepEqual(view.ready, []);
  view.resize(72.8);
  assert.equal(view.scroll.scrollTop, 72.8);
  assert.deepEqual(view.ready, []);
  view.resize(116);
  settled = true;
  view.refresh();
  assert.equal(view.scroll.scrollTop, 116);
  assert.deepEqual(view.ready, [{ interrupted: false, scrollTop: 116 }]);
});
