import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { cancelFrame, visualElementStore } from "motion/react";

const source = (await readFile(new URL("../src/useImmediateReducedMotion.js", import.meta.url), "utf8"))
  .replace(/^import .+;\r?\n/gm, "").replaceAll("export function ", "function ");

test("the installed Motion exports the scoped store and frame cancellation APIs", () => {
  assert.equal(typeof visualElementStore.get, "function");
  assert.equal(typeof cancelFrame, "function");
});

test("enabling reduced motion completes a live exit and projection without remounting or cancelling its promise", async () => {
  const store = new WeakMap(), cancelled = [], cells = [];
  let cursor = 0, effect, deps, reduced = false, callbacks = 0;
  const forwarded = { current: null }, node = {}, unrelated = {};
  let settle;
  const finished = new Promise((resolve) => { settle = resolve; }).then(() => callbacks++);
  const projected = [];
  const pending = () => {};
  const projection = { currentAnimation: {}, pendingAnimation: pending,
    mixTargetDelta: (value) => projected.push(value),
    finishAnimation() { projected.push("finish"); this.currentAnimation = undefined; },
    scheduleRender: () => projected.push("render"),
  };
  store.set(node, { values: new Map([["x", { animation: { complete: settle, stop() { assert.fail("exit promise must remain completable"); } } }]]), projection });
  store.set(unrelated, { values: new Map([["x", { animation: { complete() { assert.fail("unrelated element must keep animating"); } } }]]) });
  const hook = new Function("useCallback", "useLayoutEffect", "useRef", "cancelFrame", "visualElementStore", source + "\nreturn useImmediateReducedMotion;")(
    (fn) => fn,
    (fn, next) => { if (!deps || next.some((value, index) => value !== deps[index])) effect = fn; deps = next; },
    (initial) => cells[cursor++] ||= { current: initial },
    (frame) => cancelled.push(frame), store,
  );
  const render = () => { cursor = 0; const ref = hook(reduced, forwarded); ref(node); effect?.(); effect = null; return ref; };
  render();
  assert.equal(callbacks, 0);
  reduced = true; render();
  await finished;
  assert.equal(callbacks, 1);
  assert.equal(forwarded.current, node);
  assert.deepEqual(cancelled, [pending]);
  assert.equal(projection.pendingAnimation, undefined);
  assert.deepEqual(projected, [1000, "finish", "render"]);
  reduced = false; render();
  assert.equal(callbacks, 1);
  assert.deepEqual(projected, [1000, "finish", "render"]);
});
