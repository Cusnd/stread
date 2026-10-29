import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { motionTransition } from "../src/motion-system.js";

// Exercise the hook's asynchronous ownership with a deterministic effect host.
// Motion's actual interpolation, native top-layer behavior and focus need the
// separate desktop/browser checks; these tests deliberately do not emulate them.
const source = (await readFile(new URL("../src/useMotionPresence.js", import.meta.url), "utf8"))
  .replace(/^import .+;\r?\n/gm, "").replace("export function useMotionPresence", "function useMotionPresence");

function harness({ open = false, reduced = false, onExit = () => {} } = {}) {
  const cells = [], pending = new Map(), runs = [], sets = [];
  let cursor = 0, dirty = true, output, mounted = true, committed = false, stops = 0;
  let surfaceCleanup, surfaceAllowed = true;
  const surface = {}, subscribers = new Set();
  let input = { open, reduced, onExit };
  const state = (initial) => {
    const index = cursor++;
    cells[index] ||= { value: initial };
    return [cells[index].value, (next) => {
      assert.equal(mounted, true, "a stale completion cannot update an unmounted hook");
      if (typeof next === "function") next = next(cells[index].value);
      if (Object.is(next, cells[index].value)) return;
      cells[index].value = next; dirty = true;
    }];
  };
  const ref = (initial) => {
    const index = cursor++;
    cells[index] ||= { value: { current: initial } };
    return cells[index].value;
  };
  const effect = (type) => (callback, dependencies) => {
    const index = cursor++;
    const previous = cells[index];
    const changed = !previous || dependencies.length !== previous.dependencies.length || dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]));
    cells[index] = { ...previous, callback, dependencies, type };
    if (changed) pending.set(index, type);
  };
  const memo = (factory, dependencies) => {
    const index = cursor++;
    const previous = cells[index];
    if (!previous || dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]))) {
      cells[index] = { value: factory(), dependencies };
    }
    return cells[index].value;
  };
  const controls = {
    subscribe(element) { subscribers.add(element); return () => subscribers.delete(element); },
    start(target, transition) {
      assert.equal(committed, true);
      assert.equal(output.present, true, "the motion element is present before it starts");
      assert.equal(subscribers.size, 1, "empty controls must not report a completed exit");
      let finish;
      const promise = new Promise((resolve) => { finish = resolve; });
      runs.push({ target, transition, finish });
      return promise;
    },
    set(target) { sets.push(target); },
    stop() { stops++; },
  };
  const hook = new Function("useEffect", "useLayoutEffect", "useMemo", "useRef", "useState", "useAnimationControls", "motionTransition", "useReducedMotionPreference", source + "\nreturn useMotionPresence;")(
    effect("passive"), effect("layout"), memo, ref, state, () => controls, motionTransition, () => input.reduced,
  );
  const flushEffects = (type) => {
    for (const [index, queued] of [...pending]) if (queued === type) {
      pending.delete(index);
      cells[index].cleanup?.();
      cells[index].cleanup = cells[index].callback();
    }
  };
  const flush = () => {
    for (let guard = 0; guard < 20 && (dirty || pending.size); guard++) {
      if (dirty) {
        dirty = false; cursor = 0; committed = false;
        output = hook(input.open, { onExit: input.onExit });
        committed = true;
        if (output.present && surfaceAllowed && !surfaceCleanup) surfaceCleanup = output.motionProps.animate.subscribe(surface);
        else if ((!output.present || !surfaceAllowed) && surfaceCleanup) { surfaceCleanup(); surfaceCleanup = undefined; }
      }
      flushEffects("layout");
      if (dirty) continue;
      flushEffects("passive");
    }
    assert.equal(dirty || pending.size > 0, false, "effects converge");
    return output;
  };
  flush();
  return {
    runs, sets, controls,
    get stops() { return stops; },
    get output() { return output; },
    update(patch) { input = { ...input, ...patch }; dirty = true; return flush(); },
    async finish(index = runs.length - 1) { runs[index].finish(); await Promise.resolve(); return flush(); },
    replaySurface() {
      surfaceCleanup?.();
      surfaceCleanup = output.motionProps.animate.subscribe(surface);
      return flush();
    },
    disconnectSurface() {
      surfaceAllowed = false;
      surfaceCleanup?.(); surfaceCleanup = undefined;
    },
    reconnectSurface() { surfaceAllowed = true; dirty = true; return flush(); },
    replayEffects() {
      for (const cell of cells) if (cell?.type) { cell.cleanup?.(); cell.cleanup = undefined; }
      controls.stop();
      cells.forEach((cell, index) => { if (cell?.type) pending.set(index, cell.type); });
      return flush();
    },
    unmount() {
      for (const cell of cells) if (cell?.type) cell.cleanup?.();
      surfaceCleanup?.(); surfaceCleanup = undefined;
      controls.stop(); mounted = false;
    },
  };
}

test("presence starts only after mounting, keeps exit content, and removes it at actual completion", async () => {
  let exits = 0;
  const h = harness({ onExit: () => exits++ });
  assert.equal(h.output.present, false);
  assert.equal(h.runs.length, 0);
  h.update({ open: true });
  assert.equal(h.output.present, true);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].target.opacity, 1);
  await h.finish();
  assert.equal(exits, 0);
  h.update({ open: false });
  assert.equal(h.output.present, true);
  assert.equal(h.output.entered, false);
  assert.equal(exits, 0);
  await h.finish();
  assert.equal(h.output.present, false);
  assert.equal(exits, 1);
});

test("rapid close/open/close ignores old completions and never stops a retargeted spring", async () => {
  let exits = 0;
  const h = harness({ open: true, onExit: () => exits++ });
  h.update({ open: false });
  h.update({ open: true });
  await h.finish(1);
  assert.equal(h.output.present, true);
  assert.equal(exits, 0);
  h.update({ open: false });
  await h.finish(0);
  await h.finish(2);
  assert.equal(h.output.present, true);
  assert.equal(exits, 0);
  assert.equal(h.stops, 0, "retargeting must preserve the current MotionValue velocity");
  await h.finish(3);
  assert.equal(h.output.present, false);
  assert.equal(exits, 1);
});

test("exit completion uses the current callback without starting another animation", async () => {
  const calls = [];
  const h = harness({ open: true, onExit: () => calls.push("old") });
  h.update({ open: false });
  h.update({ onExit: () => calls.push("current") });
  assert.equal(h.runs.length, 2);
  await h.finish();
  assert.deepEqual(calls, ["current"]);
});

test("switching reduced motion on stops the live animation and finishes exit once", async () => {
  let exits = 0;
  const h = harness({ open: true, onExit: () => exits++ });
  h.update({ open: false });
  h.update({ reduced: true });
  assert.equal(h.stops, 1);
  assert.equal(h.sets.at(-1).opacity, 0);
  assert.equal(h.output.present, false);
  assert.equal(exits, 1);
  await h.finish(1);
  assert.equal(exits, 1);
  h.update({ open: true });
  assert.equal(h.sets.at(-1).opacity, 1);
  h.update({ reduced: false });
  assert.equal(h.output.motionProps.transition.reduceMotion, false);
  assert.equal(h.runs.at(-1).target.opacity, 1);
});

test("StrictMode effect replay and true unmount invalidate the previous completion", async () => {
  let exits = 0;
  const h = harness({ open: true, onExit: () => exits++ });
  h.update({ open: false });
  h.replayEffects();
  await h.finish(1);
  assert.equal(exits, 0);
  assert.equal(h.output.present, true);
  await h.finish(2);
  assert.equal(exits, 1);
  const other = harness({ open: true, onExit: () => exits++ });
  other.update({ open: false });
  other.unmount();
  await other.finish(1);
  assert.equal(exits, 1);
});

test("a new child's StrictMode subscription replay restarts its current target without replaying the owner", async () => {
  let exits = 0;
  const h = harness({ onExit: () => exits++ });
  const animate = h.output.motionProps.animate;
  h.update({ open: true });
  assert.equal(h.runs.length, 1);
  h.replaySurface();
  assert.equal(h.output.motionProps.animate, animate, "ordinary renders retain the same controls identity");
  assert.equal(h.runs.length, 2, "the child replay must issue a replacement animation");
  assert.equal(h.runs[1].target.opacity, 1);
  await h.finish(0);
  assert.equal(h.output.present, true);
  h.update({ open: false });
  h.replaySurface();
  await h.finish(2);
  assert.equal(exits, 0, "the detached child's exit cannot unmount its replacement");
  await h.finish(3);
  assert.equal(exits, 1);
  assert.equal(h.output.present, false);
});

test("a disconnected surface cannot complete an empty animation and reconnects to the latest intent", async () => {
  let exits = 0;
  const h = harness({ open: true, onExit: () => exits++ });
  h.disconnectSurface();
  h.update({ open: false });
  assert.equal(h.runs.length, 1);
  assert.equal(exits, 0);
  await h.finish(0);
  assert.equal(h.output.present, true);
  h.reconnectSurface();
  assert.equal(h.runs.at(-1).target.opacity, 0, "reconnection must not replay an obsolete open intent");
  await h.finish();
  assert.equal(exits, 1);
});

test("reduced-motion reconnect sets the latest target immediately", () => {
  const h = harness({ open: true, reduced: true });
  assert.equal(h.sets.at(-1).opacity, 1);
  const previousSets = h.sets.length;
  h.replaySurface();
  assert.equal(h.sets.length, previousSets + 1);
  assert.equal(h.sets.at(-1).opacity, 1);
  assert.equal(h.runs.length, 0);
});
