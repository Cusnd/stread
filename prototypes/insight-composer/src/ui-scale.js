export const UI_SCALE_STORAGE_KEY = "continuous-reader.ui-scale.v1";
export const UI_SCALE_MIN = 80;
export const UI_SCALE_MAX = 120;
export const UI_SCALE_STEP = 5;
// The current compact design is the 80% baseline, not the standard 100% size.
export const UI_SCALE_BASE = 80;
export const UI_SCALE_DEFAULT = 80;

export function normalizeUiScale(value) {
  const percent = Number.isFinite(value?.percent) ? Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(value.percent / UI_SCALE_STEP) * UI_SCALE_STEP)) : UI_SCALE_DEFAULT;
  return { version: 1, percent };
}
function read() {
  if (typeof window === "undefined") return normalizeUiScale();
  try { return normalizeUiScale(JSON.parse(window.localStorage.getItem(UI_SCALE_STORAGE_KEY))); }
  catch { return normalizeUiScale(); }
}

let snapshot = read();
const listeners = new Set();
export const getUiScale = () => snapshot;
export function subscribeUiScale(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function updateUiScale(percent) {
  const next = normalizeUiScale({ percent });
  if (next.percent === snapshot.percent) return;
  snapshot = next;
  try { window.localStorage.setItem(UI_SCALE_STORAGE_KEY, JSON.stringify(next)); }
  catch { snapshot = { ...next, sessionOnly: true }; }
  listeners.forEach((listener) => listener());
}
function onStorage(event) {
  if (event.key !== UI_SCALE_STORAGE_KEY && event.key !== null) return;
  snapshot = read();
  listeners.forEach((listener) => listener());
}
if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener("storage", onStorage));
