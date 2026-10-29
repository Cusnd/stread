const MAX_DURATION = 900;
const FREQUENCY = 26;
const activeByWindow = new WeakMap();
const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"]);

// Intentional navigation owns a short transition; layout restoration remains
// synchronous. Resolve on every frame so a closing panel can reflow the target.
export function animateReaderNavigation(resolveTop, { onMissing } = {}) {
  const previous = activeByWindow.get(window);
  let velocity = previous?.velocity() || 0;
  previous?.cancel();
  let frame = null, started = null, previousTime = null, position = 0, stopped = false;
  const cancelEvents = ["wheel", "touchstart", "pointerdown", "popstate"];
  const controller = { cancel, velocity: () => velocity };
  activeByWindow.set(window, controller);

  function cancel() {
    if (stopped) return;
    stopped = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    for (const type of cancelEvents) window.removeEventListener(type, cancel);
    window.removeEventListener("keydown", keydown);
    if (activeByWindow.get(window) === controller) activeByWindow.delete(window);
  }
  function keydown(event) {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !scrollKeys.has(event.key)) return;
    if (event.target?.isContentEditable || event.target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']")) return;
    cancel();
  }
  function step(now) {
    frame = null;
    if (stopped) return;
    const resolved = resolveTop();
    if (!Number.isFinite(resolved)) {
      cancel();
      onMissing?.();
      return;
    }
    const page = document.scrollingElement || document.documentElement;
    const maximum = Math.max(0, page.scrollHeight - page.clientHeight);
    const target = Math.max(0, Math.min(maximum, resolved));
    if (started === null) {
      started = now;
      previousTime = now;
      position = window.scrollY;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const elapsed = Math.max(0, now - previousTime) / 1000;
    previousTime = now;
    if (reduced || now - started >= MAX_DURATION) { position = target; velocity = 0; }
    else if (elapsed > 0) {
      // Exact critically-damped spring integration. Reflow changes the force,
      // never the displayed position or velocity; it cannot teleport the page.
      const displacement = position - target;
      const combined = velocity + FREQUENCY * displacement;
      const decay = Math.exp(-FREQUENCY * elapsed);
      position = target + (displacement + combined * elapsed) * decay;
      velocity = (velocity - FREQUENCY * combined * elapsed) * decay;
    }
    const bounded = Math.max(0, Math.min(maximum, position));
    if (bounded !== position) { position = bounded; velocity = 0; }
    const settled = Math.abs(target - position) < 0.35 && Math.abs(velocity) < 5;
    if (settled) { position = target; velocity = 0; }
    window.scrollTo({ top: position, behavior: "instant" });
    if (settled || reduced) cancel();
    else frame = window.requestAnimationFrame(step);
  }

  for (const type of cancelEvents) window.addEventListener(type, cancel, { passive: true });
  window.addEventListener("keydown", keydown);
  frame = window.requestAnimationFrame(step);
  return cancel;
}
