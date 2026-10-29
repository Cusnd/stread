const FALLBACK_CONTROLS_WIDTH = 138;

export function hasDesktopTitlebar(bridge) {
  return bridge?.platform === "win32" && bridge.titleBarOverlay === true;
}

export function getDesktopControlsWidth({ overlay, viewportWidth, fullscreen = false }) {
  if (fullscreen || overlay?.visible === false) return 0;
  const rect = overlay?.getTitlebarAreaRect?.();
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.width) || rect.width <= 0 || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return FALLBACK_CONTROLS_WIDTH;
  const width = viewportWidth - rect.x - rect.width;
  return width >= 0 && width < viewportWidth ? Math.ceil(width) : FALLBACK_CONTROLS_WIDTH;
}

// Geometry is expressed in CSS pixels, as is Electron's DIP height. Do not
// multiply by devicePixelRatio: Windows already applies display scaling.
export function observeDesktopHeader(header, bridge, ResizeObserverClass = globalThis.ResizeObserver) {
  if (!header || !hasDesktopTitlebar(bridge) || typeof bridge.setTitlebarHeight !== "function") return () => {};
  let previousHeight;
  const measure = () => {
    const measured = header.getBoundingClientRect().height;
    if (!Number.isFinite(measured) || measured <= 0) return;
    const height = Math.min(120, Math.max(32, Math.round(measured)));
    if (height === previousHeight) return;
    previousHeight = height;
    bridge.setTitlebarHeight(height);
  };
  measure();
  const observer = new ResizeObserverClass(measure);
  observer.observe(header);
  return () => observer.disconnect();
}
