export const OBJECT_FONT_MIN = 12;
export const OBJECT_FONT_MAX = 32;
export const objectPreferencesKey = (documentId) => "continuous-reader.objects.v1:" + documentId;

export function normalizeObjectPreferences(value) {
  const bounded = (number, min, max) => Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number * 10) / 10)) : null;
  return {
    widthPercent: bounded(value?.widthPercent, 1, 400),
    fontSize: bounded(value?.fontSize, OBJECT_FONT_MIN, OBJECT_FONT_MAX),
  };
}

function readMap(storage, key) {
  const value = JSON.parse(storage.getItem(key) || "{}");
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function readObjectPreferencesMap(documentId, storage) {
  try {
    return Object.fromEntries(Object.entries(readMap(storage || localStorage, objectPreferencesKey(documentId)))
      .filter(([id, value]) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id) && value && typeof value === "object" && !Array.isArray(value))
      .map(([id, value]) => [id, normalizeObjectPreferences(value)]));
  } catch { return {}; }
}

export function cacheObjectPreferences(documentId, objects, storage) {
  try { (storage || localStorage).setItem(objectPreferencesKey(documentId), JSON.stringify(objects)); } catch { /* Cache is optional. */ }
}

export function readObjectPreferences(documentId, blockId, storage, legacyStorage) {
  if (!documentId) return normalizeObjectPreferences();
  try {
    const values = readMap(storage || localStorage, objectPreferencesKey(documentId));
    if (Object.hasOwn(values, blockId)) return normalizeObjectPreferences(values[blockId]);
  } catch { /* Reading remains available without persistent storage. */ }
  try {
    const width = readMap(legacyStorage || sessionStorage, "reader-object-sizes:" + documentId)[blockId];
    if (Number.isFinite(width) && width > 0) return { ...normalizeObjectPreferences(), legacyWidth: width };
  } catch { /* Old tab preferences are optional. */ }
  return normalizeObjectPreferences();
}

export function saveObjectPreferences(documentId, blockId, value, storage) {
  if (!documentId) return;
  try {
    const destination = storage || localStorage;
    let values;
    try { values = readMap(destination, objectPreferencesKey(documentId)); } catch { values = {}; }
    // An explicit default entry prevents an old session width resurfacing after reset.
    const next = { ...values, [blockId]: normalizeObjectPreferences(value) };
    destination.setItem(objectPreferencesKey(documentId), JSON.stringify(next));
  } catch { /* The active reader still uses the selected size. */ }
}

export function objectWidth(preferences, bounds, expanded = false) {
  if (!bounds.base) return null;
  const requested = expanded ? bounds.max : preferences.legacyWidth ?? bounds.base * (preferences.widthPercent ?? 100) / 100;
  return Math.max(bounds.min, Math.min(bounds.max, requested));
}
