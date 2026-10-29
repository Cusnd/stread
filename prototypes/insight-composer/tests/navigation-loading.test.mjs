import test from "node:test";
import assert from "node:assert/strict";
import { createNavigationLoadingTracker } from "../src/navigation-loading.js";

function controlledTime() {
  let now = 0, nextId = 0;
  const timers = new Map();
  return {
    clock: {
      now: () => now,
      setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback();
      }
      now = target;
    },
    get timerCount() { return timers.size; },
  };
}

test("fast navigation completes without ever displaying or leaving an indicator timer", () => {
  const time = controlledTime(), tracker = createNavigationLoadingTracker({ clock: time.clock });
  const frames = [];
  tracker.subscribe(() => frames.push(tracker.getSnapshot()));
  const finish = tracker.begin();
  time.advance(119); finish(); time.advance(1000);
  assert.equal(frames.some((frame) => frame.visible), false);
  assert.deepEqual(tracker.getSnapshot(), { phase: "idle", pendingCount: 0, visible: false, busy: false });
  assert.equal(time.timerCount, 0);
});

test("a shown line preserves its minimum duration without delaying completed work", () => {
  const time = controlledTime(), tracker = createNavigationLoadingTracker({ clock: time.clock });
  const finish = tracker.begin();
  time.advance(120);
  assert.equal(tracker.getSnapshot().phase, "active");
  time.advance(1); finish();
  assert.equal(tracker.getSnapshot().pendingCount, 0);
  assert.equal(tracker.getSnapshot().busy, false);
  assert.equal(tracker.getSnapshot().visible, true);
  time.advance(178); assert.equal(tracker.getSnapshot().phase, "active");
  time.advance(1); assert.equal(tracker.getSnapshot().phase, "fading");
  time.advance(179); assert.equal(tracker.getSnapshot().visible, true);
  time.advance(1); assert.equal(tracker.getSnapshot().phase, "idle");
  assert.equal(time.timerCount, 0);
});

test("a long request starts fading as soon as it finishes", () => {
  const time = controlledTime(), tracker = createNavigationLoadingTracker({ clock: time.clock });
  const finish = tracker.begin(); time.advance(1000); finish();
  assert.equal(tracker.getSnapshot().phase, "fading");
  assert.equal(tracker.getSnapshot().pendingCount, 0);
  time.advance(180); assert.equal(tracker.getSnapshot().phase, "idle");
});

test("overlapping requests share the original delay and only the final idempotent finish can end loading", () => {
  const time = controlledTime(), tracker = createNavigationLoadingTracker({ clock: time.clock });
  const first = tracker.begin(); time.advance(110);
  const second = tracker.begin(); time.advance(10);
  assert.equal(tracker.getSnapshot().phase, "active");
  first(); first();
  assert.equal(tracker.getSnapshot().pendingCount, 1);
  time.advance(1000); assert.equal(tracker.getSnapshot().phase, "active");
  second(); second();
  assert.equal(tracker.getSnapshot().phase, "fading");
  assert.equal(tracker.getSnapshot().pendingCount, 0);
  time.advance(180); assert.equal(tracker.getSnapshot().phase, "idle");
});

test("new work during the minimum visible hold cancels the scheduled fade", () => {
  const time = controlledTime(), tracker = createNavigationLoadingTracker({ clock: time.clock });
  const first = tracker.begin(); time.advance(130); first(); time.advance(100);
  const second = tracker.begin(); time.advance(200);
  assert.equal(tracker.getSnapshot().phase, "active");
  assert.equal(tracker.getSnapshot().pendingCount, 1);
  second(); assert.equal(tracker.getSnapshot().phase, "fading");
  time.advance(180); assert.equal(tracker.getSnapshot().visible, false);
});

test("new work during fade keeps the line mounted and cancels stale removal", () => {
  const time = controlledTime(), tracker = createNavigationLoadingTracker({ clock: time.clock });
  const first = tracker.begin(); time.advance(500); first(); time.advance(179);
  const frames = [];
  tracker.subscribe(() => frames.push(tracker.getSnapshot()));
  const second = tracker.begin();
  assert.equal(tracker.getSnapshot().phase, "active");
  time.advance(1); second();
  assert.equal(tracker.getSnapshot().visible, true, "the previous removal deadline cannot hide new work");
  time.advance(178); assert.equal(tracker.getSnapshot().phase, "active");
  time.advance(1); assert.equal(tracker.getSnapshot().phase, "fading");
  assert.equal(frames.every((frame) => frame.visible), true);
  time.advance(180); assert.equal(tracker.getSnapshot().phase, "idle");
});

test("error and cancellation finally callbacks release concurrent work", async () => {
  const time = controlledTime(), tracker = createNavigationLoadingTracker({ clock: time.clock });
  const run = async (error) => { const finish = tracker.begin(); try { await Promise.resolve(); throw error; } finally { finish(); } };
  const results = await Promise.allSettled([run(new Error("request failed")), run(new DOMException("cancelled", "AbortError"))]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
  assert.equal(tracker.getSnapshot().pendingCount, 0);
  assert.equal(tracker.getSnapshot().visible, false);
  assert.equal(time.timerCount, 0);
});

test("snapshots remain cached and subscriptions and disposal release resources", () => {
  const time = controlledTime(), tracker = createNavigationLoadingTracker({ clock: time.clock });
  const initial = tracker.getSnapshot();
  assert.equal(initial, tracker.getSnapshot());
  let notices = 0;
  const unsubscribe = tracker.subscribe(() => notices++);
  const finish = tracker.begin();
  assert.equal(notices, 1);
  const pending = tracker.getSnapshot();
  time.advance(119); assert.equal(tracker.getSnapshot(), pending);
  assert.equal(tracker.getServerSnapshot(), initial);
  unsubscribe(); time.advance(1); assert.equal(notices, 1);
  tracker.dispose(); finish(); tracker.begin()(); time.advance(1000);
  assert.equal(tracker.getSnapshot(), initial);
  assert.equal(time.timerCount, 0);
});
