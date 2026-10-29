import test from "node:test";
import assert from "node:assert/strict";
import { acquirePageScrollLock } from "../src/page-scroll-lock.js";

test("overlapping dialogs can close out of order without unlocking early or leaving the page locked", () => {
  const root = { style: { overflow: "auto", scrollbarGutter: "" } };
  const closeReference = acquirePageScrollLock(root);
  const closeQuestion = acquirePageScrollLock(root);
  closeReference();
  assert.equal(root.style.overflow, "hidden");
  assert.equal(root.style.scrollbarGutter, "stable");
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
