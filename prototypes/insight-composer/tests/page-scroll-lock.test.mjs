import test from "node:test";
import assert from "node:assert/strict";
import { acquirePageScrollLock } from "../src/page-scroll-lock.js";

test("overlapping dialogs can close out of order without unlocking early or leaving the page locked", () => {
  const root = { style: { overflow: "auto", scrollbarGutter: "" } };
  const closeReference = acquirePageScrollLock(root);
  const closeQuestion = acquirePageScrollLock(root);
  closeReference();
  assert.equal(root.style.overflow, "hidden");
  assert.equal(root.style.scrollbarGutter, "auto");
  closeQuestion();
  assert.deepEqual(root.style, { overflow: "auto", scrollbarGutter: "" });
  closeReference(); closeQuestion();
  assert.deepEqual(root.style, { overflow: "auto", scrollbarGutter: "" });
});

test("later dialog cycles preserve the current page's existing scroll policy", () => {
  const root = { style: { overflow: "", scrollbarGutter: "stable both-edges" } };
  acquirePageScrollLock(root)();
  root.style.overflow = "clip";
  const close = acquirePageScrollLock(root);
  assert.equal(root.style.overflow, "hidden");
  close();
  assert.deepEqual(root.style, { overflow: "clip", scrollbarGutter: "stable both-edges" });
});

test("reserved gutters become padding once across overlapping locks and restore existing inline padding", () => {
  const root = {
    style: { overflow: "auto", scrollbarGutter: "stable both-edges", paddingLeft: "2px", paddingRight: "4px" },
    getBoundingClientRect: () => ({ left: 8, right: 792 }),
    ownerDocument: { defaultView: { innerWidth: 800, getComputedStyle: () => ({ paddingLeft: "2px", paddingRight: "4px" }) } },
  };
  const original = { ...root.style };
  const first = acquirePageScrollLock(root);
  const second = acquirePageScrollLock(root);
  assert.equal(root.style.paddingLeft, "calc(2px + 8px)");
  assert.equal(root.style.paddingRight, "calc(4px + 8px)");
  assert.equal(root.style.scrollbarGutter, "auto");
  first();
  assert.equal(root.style.paddingRight, "calc(4px + 8px)");
  second();
  assert.deepEqual(root.style, original);
});
