import test from "node:test";
import assert from "node:assert/strict";
import { animateReaderNavigation } from "../src/reader-navigation-motion.js";

function withBrowser(run, { top = 0, reduced = false, height = 12000, viewport = 900 } = {}) {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const frames = new Map(), listeners = new Map(), scrolls = [];
  let nextFrame = 0;
  const page = { scrollHeight: height, clientHeight: viewport };
  const browser = {
    scrollY: top,
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    matchMedia() { return { matches: reduced }; },
    scrollTo(options) { this.scrollY = options.top; scrolls.push(options); },
  };
  globalThis.window = browser;
  globalThis.document = { scrollingElement: page, documentElement: page };
  const harness = {
    browser, page, scrolls,
    step(time) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(time)); },
    input(type, event = {}) { for (const callback of [...(listeners.get(type) || [])]) callback(event); },
    pending: () => frames.size,
    listeners: () => [...listeners.values()].reduce((count, values) => count + values.size, 0),
  };
  try { run(harness); }
  finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
}

test("navigation waits for committed layout, renders intermediate frames, and finishes in bounded time even across a long article", () => {
  withBrowser(({ browser, step, scrolls, pending, listeners }) => {
    let target = 500;
    animateReaderNavigation(() => target);
    assert.equal(scrolls.length, 0);
    target = 10000; browser.scrollY = 200;
    step(100);
    assert.equal(browser.scrollY, 200);
    step(205);
    assert.ok(browser.scrollY > 200 && browser.scrollY < 10000);
    const intermediate = browser.scrollY;
    step(310);
    assert.ok(browser.scrollY > intermediate && browser.scrollY < 10000);
    step(1000);
    assert.equal(browser.scrollY, 10000);
    assert.ok(scrolls.every((scroll) => scroll.behavior === "instant"));
    assert.equal(pending(), 0); assert.equal(listeners(), 0);
  });
});

test("target reflow is measured during the transition and final destination uses the latest geometry", () => {
  withBrowser(({ browser, step, page }) => {
    let target = 8000;
    animateReaderNavigation(() => target);
    step(0); step(16);
    const beforeReflow = browser.scrollY;
    assert.ok(beforeReflow > 0 && beforeReflow < 1000);
    target = 6000;
    step(32);
    assert.ok(browser.scrollY > beforeReflow && browser.scrollY - beforeReflow < 1000);
    page.scrollHeight = 6000;
    step(900);
    assert.equal(browser.scrollY, 5100);
  });
});

test("destinations clamp at both document boundaries", () => {
  for (const [target, expected] of [[-50, 0], [20000, 11100]]) withBrowser(({ browser, step }) => {
    animateReaderNavigation(() => target);
    step(0); step(900);
    assert.equal(browser.scrollY, expected);
  }, { top: 500 });
});

test("reduced motion and an already reached destination complete in the first frame", () => {
  for (const options of [{ reduced: true, top: 0 }, { top: 3000 }]) withBrowser(({ browser, step, pending, listeners }) => {
    animateReaderNavigation(() => 3000);
    step(100);
    assert.equal(browser.scrollY, 3000);
    assert.equal(pending(), 0); assert.equal(listeners(), 0);
  }, options);
});

test("wheel, touch, pointer and page-scroll keys cancel without overriding the user's next position", () => {
  for (const [type, event] of [["wheel", {}], ["touchstart", {}], ["pointerdown", {}], ["keydown", { key: "PageDown" }]]) {
    withBrowser(({ browser, step, input, pending, listeners }) => {
      animateReaderNavigation(() => 6000);
      step(0); step(210);
      input(type, event);
      browser.scrollY = 3200;
      step(420);
      assert.equal(browser.scrollY, 3200);
      assert.equal(pending(), 0); assert.equal(listeners(), 0);
    });
  }
});

test("typing, editing navigation and unrelated shortcuts do not interrupt article movement", () => {
  withBrowser(({ browser, step, input, pending }) => {
    animateReaderNavigation(() => 6000);
    step(0);
    for (const event of [
      { key: "a" }, { key: "PageDown", ctrlKey: true }, { key: "Home", defaultPrevented: true },
      { key: "ArrowDown", isComposing: true }, { key: "Home", target: { closest: () => ({}) } },
      { key: " ", target: { isContentEditable: true } },
    ]) input("keydown", event);
    assert.equal(pending(), 1);
    step(900);
    assert.equal(browser.scrollY, 6000);
  });
});

test("browser Back cancels movement before history restores the earlier reading position", () => {
  withBrowser(({ browser, step, input, pending, listeners }) => {
    animateReaderNavigation(() => 6000);
    step(0); step(210);
    assert.ok(browser.scrollY > 0 && browser.scrollY < 6000);
    input("popstate");
    browser.scrollY = 900;
    step(420);
    assert.equal(browser.scrollY, 900);
    assert.equal(pending(), 0); assert.equal(listeners(), 0);
  });
});

test("a new destination retains current position and velocity instead of restarting at zero", () => {
  withBrowser(({ browser, step, pending, listeners }) => {
    animateReaderNavigation(() => 9000);
    step(0); step(100);
    const current = browser.scrollY, target = current - 100;
    animateReaderNavigation(() => target);
    step(100);
    assert.equal(browser.scrollY, current);
    step(116);
    // The prior forward momentum decelerates before changing direction.
    assert.ok(browser.scrollY > current);
    step(1000);
    assert.equal(browser.scrollY, target);
    assert.equal(pending(), 0); assert.equal(listeners(), 0);
  });
});

test("missing or removed targets stop cleanly and report the unavailable destination once", () => {
  for (const missingInitially of [true, false]) withBrowser(({ step, pending, listeners, scrolls }) => {
    let target = missingInitially ? null : 6000, misses = 0;
    animateReaderNavigation(() => target, { onMissing: () => misses++ });
    step(0);
    target = undefined;
    step(210); step(420);
    assert.equal(misses, 1);
    assert.equal(scrolls.length, missingInitially ? 0 : 1);
    assert.equal(pending(), 0); assert.equal(listeners(), 0);
  });
});

test("caller cleanup is idempotent and prevents pending or mid-flight work after unmount", () => {
  for (const begin of [false, true]) withBrowser(({ step, pending, listeners, scrolls }) => {
    const cancel = animateReaderNavigation(() => 6000);
    if (begin) { step(0); step(210); }
    const previousCount = scrolls.length;
    cancel(); cancel(); step(420);
    assert.equal(scrolls.length, previousCount);
    assert.equal(pending(), 0); assert.equal(listeners(), 0);
  });
});
