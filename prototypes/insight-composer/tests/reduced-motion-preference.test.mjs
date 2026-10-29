import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../src/useReducedMotionPreference.js", import.meta.url), "utf8"))
  .replace(/^import .+;\r?\n/gm, "").replace("export function useReducedMotionPreference", "function useReducedMotionPreference");

test("reduced-motion external store reports both live preference directions and removes its listener", () => {
  const listeners = new Set();
  let current, queries = 0, release;
  const media = { matches: false,
    addEventListener(type, listener) { assert.equal(type, "change"); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, "change"); listeners.delete(listener); },
  };
  const browser = { matchMedia(query) { queries++; assert.equal(query, "(prefers-reduced-motion: reduce)"); return media; } };
  const subscribeStore = (subscribe, snapshot, serverSnapshot) => {
    assert.equal(serverSnapshot(), false);
    current = snapshot();
    release = subscribe(() => { current = snapshot(); });
    return current;
  };
  const hook = new Function("useSyncExternalStore", "window", source + "\nreturn useReducedMotionPreference;")(subscribeStore, browser);
  assert.equal(hook(), false);
  media.matches = true;
  for (const listener of listeners) listener();
  assert.equal(current, true);
  media.matches = false;
  for (const listener of listeners) listener();
  assert.equal(current, false);
  assert.equal(queries, 1);
  release();
  assert.equal(listeners.size, 0);
});

test("the reduced-motion store has a stable server snapshot without a browser", () => {
  const hook = new Function("useSyncExternalStore", "window", source + "\nreturn useReducedMotionPreference;")(
    (subscribe, snapshot, serverSnapshot) => { const release = subscribe(() => {}); release(); assert.equal(snapshot(), false); return serverSnapshot(); },
    undefined,
  );
  assert.equal(hook(), false);
});
