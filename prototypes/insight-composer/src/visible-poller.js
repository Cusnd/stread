// One in-flight refresh per surface. Hidden views do no network work; an explicit
// focus/visibility wake checks promptly without losing mounted Reader state.
export function createVisiblePoller({ run, isVisible, intervalMs = 2000, maxIntervalMs = 30000,
  setTimer = setTimeout, clearTimer = clearTimeout, onError = () => {} } = {}) {
  let disposed = false, started = false, active = null, timer, idle = 0, failures = 0, paused = false, requested = false;
  function schedule(delay) {
    if (timer !== undefined) clearTimer(timer); timer = undefined;
    if (disposed || !started || paused || !isVisible()) return;
    timer = setTimer(() => { timer = undefined; void tick(); }, delay);
  }
  async function tick() {
    if (disposed || active || !isVisible()) return;
    const controller = new AbortController(); active = controller; requested = false;
    try {
      const changed = await run(controller.signal);
      if (controller.signal.aborted || disposed) return;
      failures = 0; idle = changed ? 0 : Math.min(idle + 1, 16);
    } catch (error) {
      if (!controller.signal.aborted && !disposed) {
        failures++; paused = error.status === 401 || error.status === 403;
        onError(error);
      }
    } finally {
      if (active === controller) active = null;
      const delay = failures ? Math.min(300000, intervalMs * 2 ** Math.min(failures, 8)) : Math.min(maxIntervalMs, intervalMs * 2 ** idle);
      schedule(requested ? 0 : delay);
    }
  }
  return {
    start({ immediate = true } = {}) { if (started || disposed) return; started = true; schedule(immediate ? 0 : intervalMs); },
    wake() {
      if (disposed) return;
      if (!isVisible()) { if (timer !== undefined) clearTimer(timer); timer = undefined; active?.abort(); return; }
      // Focus/visibility is an explicit fresh probe after a user may have
      // restored their session elsewhere; failed auth never loops on a timer.
      idle = 0; paused = false;
      if (active) requested = true; else schedule(0);
    },
    dispose() { disposed = true; if (timer !== undefined) clearTimer(timer); timer = undefined; active?.abort(); },
  };
}
