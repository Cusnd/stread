export const READING_PREFERENCES_KEY = "continuous-reader.reading.v1";
export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 24;
export const READING_WIDTH_PERCENT_MIN = 50;
export const READING_WIDTH_PERCENT_MAX = 100;
export const READING_WIDTH_PERCENT_STEP = 5;
export const READING_WIDTH_PERCENT_DEFAULT = 80;

export function normalizeReadingPreferences(value) {
  const bounded = (number, fallback, min, max, step = 1) => Number.isFinite(number)
    ? Math.max(min, Math.min(max, min + Math.round((number - min) / step) * step)) : fallback;
  return { version: 2,
    fontSize: bounded(value?.fontSize, 20, FONT_SIZE_MIN, FONT_SIZE_MAX),
    // Legacy pixel widths have no viewport-independent percentage equivalent.
    // Preserve the chosen font size and start the new width setting at 80%.
    readingWidthPercent: bounded(value?.readingWidthPercent, READING_WIDTH_PERCENT_DEFAULT, READING_WIDTH_PERCENT_MIN, READING_WIDTH_PERCENT_MAX, READING_WIDTH_PERCENT_STEP),
  };
}
function read() {
  try { return normalizeReadingPreferences(JSON.parse(window.localStorage.getItem(READING_PREFERENCES_KEY))); }
  catch { return normalizeReadingPreferences(); }
}
let snapshot = read();
const listeners = new Set();
export const getReadingPreferences = () => snapshot;
export function subscribeReadingPreferences(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function updateReadingPreferences(patch) {
  const next = normalizeReadingPreferences({ ...snapshot, ...patch });
  if (next.fontSize === snapshot.fontSize && next.readingWidthPercent === snapshot.readingWidthPercent) return;
  snapshot = next;
  try { window.localStorage.setItem(READING_PREFERENCES_KEY, JSON.stringify(next)); }
  catch { /* The current page still uses the chosen settings. */ }
  listeners.forEach((listener) => listener());
}
function onStorage(event) {
  if (event.key !== READING_PREFERENCES_KEY && event.key !== null) return;
  snapshot = read();
  listeners.forEach((listener) => listener());
}
if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener("storage", onStorage));
