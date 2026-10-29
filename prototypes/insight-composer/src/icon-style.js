export const ICON_STYLE_KEY = "continuous-reader.icon-style.v1";
export const DEFAULT_ICON_STYLE = "lucide";
export const ICON_STYLES = Object.freeze([
  { id: "lucide", label: "清线", description: "利落轮廓，轻盈而清晰", family: "Lucide" },
  { id: "iconoir", label: "书卷", description: "纤细笔触，舒展留白", family: "Iconoir" },
  { id: "ink", label: "墨印", description: "实心剪影，沉静有分量", family: "Phosphor" },
]);

export function normalizeIconStyle(value) {
  return ICON_STYLES.some((item) => item.id === value) ? value : DEFAULT_ICON_STYLE;
}

function readPreference() {
  if (typeof window === "undefined") return { style: DEFAULT_ICON_STYLE, sessionOnly: false };
  try {
    const stored = JSON.parse(window.localStorage.getItem(ICON_STYLE_KEY));
    return { style: normalizeIconStyle(stored?.style), sessionOnly: false };
  } catch {
    return { style: DEFAULT_ICON_STYLE, sessionOnly: true };
  }
}

let snapshot = readPreference();
const serverSnapshot = { style: DEFAULT_ICON_STYLE, sessionOnly: false };
const listeners = new Set();
export const getIconStyleSnapshot = () => snapshot;
export const getServerIconStyleSnapshot = () => serverSnapshot;
export function subscribeIconStyle(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateIconStyle(style) {
  const normalized = normalizeIconStyle(style);
  let sessionOnly = false;
  try { window.localStorage.setItem(ICON_STYLE_KEY, JSON.stringify({ version: 1, style: normalized })); }
  catch { sessionOnly = true; }
  if (snapshot.style === normalized && snapshot.sessionOnly === sessionOnly) return;
  snapshot = { style: normalized, sessionOnly };
  listeners.forEach((listener) => listener());
}

function onStorage(event) {
  if (event.key !== ICON_STYLE_KEY && event.key !== null) return;
  // sessionStorage has its own storage events; this preference belongs to localStorage.
  try { if (event.storageArea && event.storageArea !== window.localStorage) return; }
  catch { return; }
  const next = readPreference();
  if (next.style === snapshot.style && next.sessionOnly === snapshot.sessionOnly) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener("storage", onStorage));
