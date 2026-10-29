export const COLOR_PALETTES = [
  { id: "classic", label: "经典柔彩", colors: [
    { id: "amber", label: "暖黄", value: "#f6e7b1" },
    { id: "green", label: "浅绿", value: "#d7e9d8" },
    { id: "blue", label: "雾蓝", value: "#d9e6fb" },
    { id: "rose", label: "藕粉", value: "#f0dae4" },
  ] },
  { id: "macaron", label: "马卡龙", colors: [
    { id: "macaron-yellow", label: "奶黄", value: "#f7edbd" },
    { id: "macaron-pink", label: "桃粉", value: "#f5d9e2" },
    { id: "macaron-mint", label: "薄荷", value: "#d8eee3" },
    { id: "macaron-blue", label: "天蓝", value: "#dcecf6" },
    { id: "macaron-lilac", label: "薰紫", value: "#e7def3" },
    { id: "macaron-peach", label: "奶杏", value: "#f6e1cc" },
  ] },
  { id: "earth", label: "大地色", colors: [
    { id: "earth-oat", label: "燕麦", value: "#e9dfc7" },
    { id: "earth-sage", label: "鼠尾草", value: "#dce3cc" },
    { id: "earth-clay", label: "陶土", value: "#edd5c7" },
    { id: "earth-sand", label: "沙棕", value: "#e2d7cf" },
    { id: "earth-olive", label: "浅橄榄", value: "#e5e6c9" },
  ] },
  { id: "mist", label: "冷雾色", colors: [
    { id: "mist-blue", label: "冰蓝", value: "#dce8f0" },
    { id: "mist-teal", label: "浅青", value: "#d5e8e7" },
    { id: "mist-lavender", label: "灰紫", value: "#e2dfee" },
    { id: "mist-slate", label: "雾灰", value: "#e0e4e8" },
    { id: "mist-rose", label: "冷粉", value: "#eadde6" },
  ] },
];

// Color IDs identify fixed colors, independent of the currently selected palette.
// Keeping the original four IDs preserves existing annotations and drafts.
const allColors = new Map(COLOR_PALETTES.flatMap((palette) => palette.colors.map((color) => [color.id, color])));
export const colorFor = (id) => allColors.get(id) || COLOR_PALETTES[0].colors[0];
export const PALETTE_STORAGE_KEY = "continuous-reader.highlight-palette.v1";

export function normalizePaletteSettings(value) {
  const presetId = COLOR_PALETTES.some((palette) => palette.id === value?.presetId) ? value.presetId : "classic";
  const enabledByPreset = Object.fromEntries(COLOR_PALETTES.map((palette) => {
    const saved = value?.enabledByPreset?.[palette.id];
    const valid = Array.isArray(saved) ? palette.colors.filter((color) => saved.includes(color.id)).map((color) => color.id) : [];
    return [palette.id, valid.length ? valid : palette.colors.map((color) => color.id)];
  }));
  return { version: 1, presetId, enabledByPreset };
}

export function togglePaletteColor(settings, colorId) {
  const palette = COLOR_PALETTES.find((item) => item.id === settings.presetId);
  if (!palette.colors.some((color) => color.id === colorId)) return settings;
  const enabled = settings.enabledByPreset[palette.id];
  if (enabled.length === 1 && enabled.includes(colorId)) return settings;
  return normalizePaletteSettings({ ...settings, enabledByPreset: {
    ...settings.enabledByPreset,
    [palette.id]: enabled.includes(colorId) ? enabled.filter((id) => id !== colorId) : [...enabled, colorId],
  } });
}

function readSettings() {
  try {
    return normalizePaletteSettings(JSON.parse(window.localStorage.getItem(PALETTE_STORAGE_KEY)));
  } catch {
    return normalizePaletteSettings();
  }
}

let snapshot = readSettings();
const listeners = new Set();
export const getPaletteSettings = () => snapshot;
export function getEnabledColors(settings = snapshot) {
  const palette = COLOR_PALETTES.find((item) => item.id === settings.presetId);
  return palette.colors.filter((color) => settings.enabledByPreset[palette.id].includes(color.id));
}

function onStorage(event) {
  if (event.key !== PALETTE_STORAGE_KEY && event.key !== null) return;
  snapshot = readSettings();
  listeners.forEach((listener) => listener());
}

export function subscribePalette(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// A reader with both panels closed still needs the latest choice next time it opens.
if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener("storage", onStorage));

export function updatePaletteSettings(next) {
  snapshot = normalizePaletteSettings(next);
  try {
    window.localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    snapshot = { ...snapshot, sessionOnly: true };
  }
  listeners.forEach((listener) => listener());
}
