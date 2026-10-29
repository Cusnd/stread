import { getReadingPreferences, normalizeReadingPreferences, subscribeReadingPreferences, updateReadingPreferences } from "./reading-preferences.js";
import { normalizeReaderView, readReaderView, saveReaderView, subscribeReaderView } from "./reader-view-preferences.js";
import { getUiScale, normalizeUiScale, subscribeUiScale, updateUiScale } from "./ui-scale.js";
import { getPdfPanelWidth, normalizePdfPanelWidth, savePdfPanelWidth, subscribePdfPanelWidth } from "./pdf-panel-width.js";
import { DEFAULT_SHORTCUTS, getReadingShortcuts, normalizeShortcuts, resetReadingShortcuts, shortcutProblem, subscribeReadingShortcuts, updateReadingShortcut } from "./reading-shortcuts.js";
import { getPaletteSettings, normalizePaletteSettings, subscribePalette, updatePaletteSettings } from "./highlight-colors.js";
import { normalizeObjectPreferences, readObjectPreferences, saveObjectPreferences } from "./object-preferences.js";
import { createObjectPreferenceSync } from "./object-preferences-sync.js";

const noop = () => {};
export function createMemoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.has(String(key)) ? values.get(String(key)) : null,
    setItem: (key, value) => values.set(String(key), String(value)), removeItem: (key) => values.delete(String(key)),
    clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null, get length() { return values.size; } };
}
function memoryStore(initial, normalize = (value) => value) {
  let snapshot = normalize(initial); const listeners = new Set();
  const update = (next) => {
    const normalized = normalize(next);
    if (JSON.stringify(snapshot) === JSON.stringify(normalized)) return;
    snapshot = normalized; listeners.forEach((listener) => listener());
  };
  return { getSnapshot: () => snapshot, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, update };
}
const browserSession = () => { try { return globalThis.sessionStorage; } catch { return undefined; } };

// The default adapter delegates to the existing workspace behavior. A preview
// supplies a separate adapter rather than patching browser storage or fetch.
export const defaultReaderRuntime = {
  mode: "workspace", capabilities: { glossary: true, insightWrites: true },
  get sessionStorage() { return browserSession(); },
  reading: { getSnapshot: getReadingPreferences, subscribe: subscribeReadingPreferences, update: updateReadingPreferences },
  uiScale: { getSnapshot: getUiScale, subscribe: subscribeUiScale, update: updateUiScale },
  pdfWidth: { getSnapshot: getPdfPanelWidth, subscribe: subscribePdfPanelWidth, update: savePdfPanelWidth },
  shortcuts: { getSnapshot: getReadingShortcuts, subscribe: subscribeReadingShortcuts, update: updateReadingShortcut, reset: resetReadingShortcuts },
  palette: { getSnapshot: getPaletteSettings, subscribe: subscribePalette, update: updatePaletteSettings },
  view: { read: readReaderView, save: saveReaderView, subscribe: subscribeReaderView },
  objects: { createSync: createObjectPreferenceSync, read: readObjectPreferences, save: saveObjectPreferences, externalStorage: true },
};

export function createPreviewReaderRuntime(previewId, initial = {}) {
  if (typeof previewId !== "string" || !previewId) throw new Error("Preview runtime requires a candidate identity.");
  const sessionStorage = createMemoryStorage();
  const reading = memoryStore(initial.reading, normalizeReadingPreferences);
  const uiScale = memoryStore(initial.uiScale, normalizeUiScale);
  const pdfWidth = memoryStore(initial.pdfWidth, normalizePdfPanelWidth);
  const shortcuts = memoryStore(initial.shortcuts, normalizeShortcuts);
  const palette = memoryStore(initial.palette, normalizePaletteSettings);
  let view = normalizeReaderView(initial.view);
  const objectStores = new Map();
  function objectSync({ documentId }) {
    if (objectStores.has(documentId)) return objectStores.get(documentId);
    const store = memoryStore({ objects: {}, status: null, error: "" });
    const sync = { getSnapshot: store.getSnapshot, subscribe: store.subscribe, start: () => noop, sync: async () => {},
      update(blockId, patch) {
        const snapshot = store.getSnapshot();
        store.update({ ...snapshot, objects: { ...snapshot.objects, [blockId]: normalizeObjectPreferences({ ...snapshot.objects[blockId], ...patch }) } });
      },
      importLegacy(blockId, value) { if (!Object.hasOwn(store.getSnapshot().objects, blockId)) sync.update(blockId, value); },
    };
    objectStores.set(documentId, sync); return sync;
  }
  return {
    mode: "preview", previewId, capabilities: { glossary: false, insightWrites: false }, sessionStorage,
    reading: { ...reading, update: (patch) => reading.update({ ...reading.getSnapshot(), ...patch }) },
    uiScale: { ...uiScale, update: (percent) => uiScale.update({ percent }) }, pdfWidth,
    shortcuts: { ...shortcuts, update(actionId, chord) {
      const problem = shortcutProblem(actionId, chord, shortcuts.getSnapshot());
      if (!problem) shortcuts.update({ ...shortcuts.getSnapshot(), [actionId]: chord });
      return problem;
    }, reset: () => shortcuts.update(DEFAULT_SHORTCUTS) },
    palette,
    // View state is already controlled by the Reader; no storage-event fanout
    // is needed in this isolated in-memory session.
    view: { read: () => view, save: (value) => { view = normalizeReaderView(value); }, subscribe: () => noop },
    objects: { createSync: objectSync, externalStorage: false,
      read: (documentId, blockId) => normalizeObjectPreferences(objectSync({ documentId }).getSnapshot().objects[blockId]),
      save: (documentId, blockId, value) => objectSync({ documentId }).update(blockId, value) },
  };
}
