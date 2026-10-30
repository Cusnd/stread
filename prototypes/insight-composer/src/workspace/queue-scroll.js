export function restoreQueueScroll({ scroll, content, top, onReady, isSettled = () => true, ResizeObserver = globalThis.ResizeObserver }) {
  const target = Math.max(0, Number(top) || 0);
  let active = true, observer;
  const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Tab"]);
  const cleanup = () => {
    observer?.disconnect();
    scroll.removeEventListener("wheel", interrupt);
    scroll.removeEventListener("touchstart", interrupt);
    scroll.removeEventListener("pointerdown", interrupt);
    scroll.removeEventListener("keydown", keyboard);
  };
  const finish = (interrupted) => {
    if (!active) return;
    active = false;
    cleanup();
    onReady({ interrupted, scrollTop: scroll.scrollTop });
  };
  const interrupt = () => finish(true);
  const keyboard = (event) => { if (scrollKeys.has(event.key)) interrupt(); };
  const restore = () => {
    if (!active) return;
    scroll.scrollTop = target;
    if (Math.abs(scroll.scrollTop - target) < 1 && isSettled()) finish(false);
  };
  scroll.addEventListener("wheel", interrupt, { passive: true });
  scroll.addEventListener("touchstart", interrupt, { passive: true });
  scroll.addEventListener("pointerdown", interrupt, { passive: true });
  scroll.addEventListener("keydown", keyboard);
  if (ResizeObserver) {
    observer = new ResizeObserver(restore);
    observer.observe(content);
    observer.observe(scroll);
  }
  restore();
  return { refresh: restore, dispose: () => { active = false; cleanup(); } };
}
