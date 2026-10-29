export const PDF_PANEL_WIDTH_KEY = "continuous-reader.pdf-panel-width.v1";
export const PDF_PANEL_MIN_WIDTH = 300;

export function pdfPanelBounds(viewportWidth, navigationWidth = 0) {
  const viewport = Math.max(0, Number.isFinite(viewportWidth) ? viewportWidth : 0);
  const navigation = Math.max(0, Number.isFinite(navigationWidth) ? navigationWidth : 0);
  const min = Math.min(PDF_PANEL_MIN_WIDTH, viewport);
  // Reserve a usable reading column, including its horizontal padding.
  const max = Math.max(min, Math.min(viewport * .7, viewport - navigation - 480));
  return { min: Math.round(min), max: Math.round(max), defaultWidth: Math.round(Math.max(min, Math.min(max, 560, (viewport - navigation) * .4))) };
}

export function normalizePdfPanelWidth(value) {
  return Number.isFinite(value) && value >= PDF_PANEL_MIN_WIDTH && value <= 8192 ? Math.round(value) : null;
}

export function resolvePdfPanelWidth(preferred, bounds) {
  return Math.round(Math.max(bounds.min, Math.min(bounds.max, normalizePdfPanelWidth(preferred) ?? bounds.defaultWidth)));
}

export function pdfPanelWidthForKey(key, width, bounds, shiftKey = false) {
  const step = shiftKey ? 64 : 16;
  const next = key === "ArrowLeft" ? width + step : key === "ArrowRight" ? width - step
    : key === "Home" ? bounds.min : key === "End" ? bounds.max : null;
  return next === null ? null : Math.round(Math.max(bounds.min, Math.min(bounds.max, next)));
}

function readWidth() {
  try { return normalizePdfPanelWidth(JSON.parse(window.localStorage.getItem(PDF_PANEL_WIDTH_KEY))?.width); }
  catch { return null; }
}

let snapshot = readWidth();
const listeners = new Set();
export const getPdfPanelWidth = () => snapshot;
export function subscribePdfPanelWidth(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function savePdfPanelWidth(width) {
  snapshot = normalizePdfPanelWidth(width);
  try {
    if (snapshot === null) window.localStorage.removeItem(PDF_PANEL_WIDTH_KEY);
    else window.localStorage.setItem(PDF_PANEL_WIDTH_KEY, JSON.stringify({ version: 1, width: snapshot }));
  } catch { /* Resizing remains usable when local storage is unavailable. */ }
  listeners.forEach((listener) => listener());
}
function onStorage(event) {
  if (event.key !== PDF_PANEL_WIDTH_KEY && event.key !== null) return;
  snapshot = readWidth();
  listeners.forEach((listener) => listener());
}
if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener("storage", onStorage));
