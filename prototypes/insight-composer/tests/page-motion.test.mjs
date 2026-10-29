import test from "node:test";
import assert from "node:assert/strict";
import { animateReaderContent, commitPageMotion, stopPageMotion, stopReaderContentMotion } from "../src/page-motion.js";

function environment({ reduced = false, fail = false } = {}) {
  const transitions = [];
  const attributes = new Map();
  return { transitions, window: { matchMedia: () => ({ matches: reduced }) }, document: {
    documentElement: { setAttribute: (name, value) => attributes.set(name, value), removeAttribute: (name) => attributes.delete(name), getAttribute: (name) => attributes.get(name) ?? null },
    startViewTransition(update) {
      if (fail) { update(); throw new Error("unavailable snapshot"); }
      let finish;
      const item = { update, skipped: false, ready: Promise.resolve(), finished: new Promise((resolve) => { finish = resolve; }), finish() { finish(); }, skipTransition() { this.skipped = true; finish(); } };
      transitions.push(item); return item;
    },
  } };
}

test("page snapshots never duplicate business commits, including snapshot failures", () => {
  const env = environment({ fail: true }); let commits = 0;
  assert.equal(commitPageMotion(() => commits++, env), null);
  assert.equal(commits, 1);
});

test("a new route discards the previous visual snapshot without delaying either route commit", () => {
  const env = environment(), commits = [];
  const first = commitPageMotion(() => commits.push("collection"), env);
  first.update();
  const second = commitPageMotion(() => commits.push("flow"), env);
  second.update(); second.update();
  assert.equal(first.skipped, true);
  assert.deepEqual(commits, ["collection", "flow"]);
  stopPageMotion();
  assert.equal(second.skipped, true);
});

test("reduced motion and unsupported browsers commit synchronously without snapshots", () => {
  for (const env of [environment({ reduced: true }), { document: {}, window: {} }, { ...environment(), enabled: false }]) {
    let commits = 0;
    assert.equal(commitPageMotion(() => commits++, env), null);
    assert.equal(commits, 1);
    assert.equal(env.transitions?.length || 0, 0);
  }
});

test("a skipped callback that has not run cannot restore an obsolete route", () => {
  const env = environment(), commits = [];
  const first = commitPageMotion(() => commits.push("old"), env);
  const second = commitPageMotion(() => commits.push("latest"), env);
  second.update(); first.update();
  assert.deepEqual(commits, ["latest"]);
  stopPageMotion();
});

test("stopping page motion invalidates an uncaptured route update", () => {
  const env = environment(); let commits = 0;
  const transition = commitPageMotion(() => commits++, env);
  stopPageMotion();
  transition.update();
  assert.equal(transition.skipped, true);
  assert.equal(commits, 0);
});

test("Reader viewport scope survives until its snapshot finishes and resets for workspace routes", async () => {
  const env = environment(), root = env.document.documentElement;
  const content = commitPageMotion(() => {}, { ...env, scope: "reader-page" });
  assert.equal(root.getAttribute("data-page-motion-scope"), "reader-page");
  content.update();
  const page = commitPageMotion(() => {}, env);
  page.update();
  await content.finished;
  await Promise.resolve();
  assert.equal(content.skipped, true);
  assert.equal(root.getAttribute("data-page-motion-scope"), "page", "old completion cannot clear a replacement's scope");
  page.finish();
  await page.finished;
  await Promise.resolve();
  assert.equal(root.getAttribute("data-page-motion-scope"), null);
});

test("cancellation, snapshot failure and reduced motion leave no stale Reader scope", () => {
  for (const options of [{}, { fail: true }, { reduced: true }]) {
    const env = environment(options), root = env.document.documentElement;
    commitPageMotion(() => {}, { ...env, scope: "reader-page" });
    if (!options.fail && !options.reduced) stopPageMotion();
    assert.equal(root.getAttribute("data-page-motion-scope"), null);
  }
});

function articleMotion() {
  let opacity = "1";
  const animations = [];
  const window = { getComputedStyle: () => ({ opacity }) };
  const element = { animate(frames, options) {
    const animation = { frames, options, playState: "running", cancel() { this.playState = "idle"; opacity = "1"; } };
    animations.push(animation); return animation;
  } };
  return { element, window, animations, opacity: (next) => { opacity = next; } };
}

test("language changes fade the live article without a page snapshot or persistent opacity", () => {
  const env = articleMotion();
  const animation = animateReaderContent(env.element, env);
  assert.deepEqual(animation.frames, [{ opacity: 0.65 }, { opacity: 1 }]);
  assert.equal(animation.options.fill, undefined);
  assert.equal(env.animations.length, 1);
  stopReaderContentMotion(env.element);
  assert.equal(animation.playState, "idle");
});

test("rapid language switching starts at the visible opacity before cancelling the old fade", () => {
  const env = articleMotion(), first = animateReaderContent(env.element, env);
  env.opacity("0.82");
  const second = animateReaderContent(env.element, env);
  assert.equal(first.playState, "idle");
  assert.equal(second.frames[0].opacity, 0.82);
  second.playState = "finished";
  assert.equal(animateReaderContent(env.element, env).frames[0].opacity, 0.65);
  stopReaderContentMotion(env.element);
});

test("reduced motion cancels an active fade and unsupported animation stays fully visible", () => {
  const env = articleMotion(), first = animateReaderContent(env.element, env);
  assert.equal(animateReaderContent(env.element, { ...env, reduced: true }), null);
  assert.equal(first.playState, "idle");
  assert.equal(env.window.getComputedStyle().opacity, "1");
  assert.equal(env.animations.length, 1);
  assert.equal(animateReaderContent({}), null);
  assert.equal(animateReaderContent(null), null);
});
