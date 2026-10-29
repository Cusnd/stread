const idleSnapshot = Object.freeze({ phase: "idle", pendingCount: 0, visible: false, busy: false });

/**
 * Shared navigation activity, independent of request completion and React.
 * begin() returns an idempotent finish callback; always call it in finally.
 * Display delays affect only the indicator, never the work being tracked.
 */
export function createNavigationLoadingTracker({ clock, delayMs = 120, minVisibleMs = 180, fadeMs = 180 } = {}) {
  if (![delayMs, minVisibleMs, fadeMs].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new RangeError("Navigation loading timings must be finite and non-negative");
  }
  const time = clock || {
    now: () => globalThis.performance?.now() ?? Date.now(),
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  };
  const listeners = new Set();
  let snapshot = idleSnapshot, phase = "idle", pendingCount = 0, visibleSince = 0, timer = null, disposed = false;

  function publish() {
    if (snapshot.phase === phase && snapshot.pendingCount === pendingCount) return;
    snapshot = phase === "idle" ? idleSnapshot : Object.freeze({
      phase, pendingCount, visible: phase === "active" || phase === "fading", busy: pendingCount > 0,
    });
    for (const listener of listeners) listener();
  }

  function clearTimer() {
    if (timer !== null) time.clearTimeout(timer);
    timer = null;
  }

  function schedule(callback, delay) {
    clearTimer();
    timer = time.setTimeout(() => { timer = null; callback(); }, Math.max(0, delay));
  }

  function fade() {
    if (disposed || pendingCount > 0) return;
    phase = "fading";
    publish();
    schedule(() => { if (!disposed && pendingCount === 0) { phase = "idle"; publish(); } }, fadeMs);
  }

  function begin() {
    if (disposed) return () => {};
    pendingCount += 1;
    if (phase === "idle") {
      phase = "pending";
      schedule(() => {
        if (disposed || pendingCount === 0) return;
        visibleSince = time.now(); phase = "active"; publish();
      }, delayMs);
    } else if (phase === "fading") {
      // Keep the mounted line and its animation; only reverse its opacity fade.
      clearTimer(); visibleSince = time.now(); phase = "active";
    } else if (phase === "active") {
      // Work can resume while the completed line waits out its minimum duration.
      clearTimer();
    }
    publish();
    let finished = false;
    return function finish() {
      if (finished || disposed) return;
      finished = true;
      pendingCount -= 1;
      if (pendingCount > 0) { publish(); return; }
      if (phase === "pending") {
        clearTimer(); phase = "idle"; publish(); return;
      }
      const remaining = minVisibleMs - (time.now() - visibleSince);
      if (remaining > 0) { publish(); schedule(fade, remaining); }
      else fade();
    };
  }

  return {
    begin,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => idleSnapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      if (disposed) return;
      disposed = true; clearTimer(); pendingCount = 0; phase = "idle"; publish(); listeners.clear();
    },
  };
}

const navigationLoading = createNavigationLoadingTracker();
export const beginNavigationLoading = navigationLoading.begin;
export const subscribe = navigationLoading.subscribe;
export const getSnapshot = navigationLoading.getSnapshot;
export const getServerSnapshot = navigationLoading.getServerSnapshot;
export default navigationLoading;
if (import.meta.hot) import.meta.hot.dispose(() => navigationLoading.dispose());
