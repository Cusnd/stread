export const READER_VIEW_KEY = "continuous-reader.view.v1";
export function normalizeReaderView(value) {
  return { tocMode: ["collapsed", "temporary"].includes(value?.tocMode) ? "collapsed" : "pinned",
    showMargins: value?.showMargins !== false, insightOpenMode: value?.insightOpenMode === "modal" ? "modal" : "sidebar",
    pdfFollow: value?.pdfFollow !== false, targetLanguage: typeof value?.targetLanguage === "string" ? value.targetLanguage : "zh-CN",
    translationFirst: value?.translationFirst === true };
}
export function createReaderViewStore(options = {}) {
  const target = options.windowTarget === undefined ? globalThis.window : options.windowTarget;
  const storage = () => Object.hasOwn(options, "storage") ? options.storage : target?.localStorage;
  const listeners = new Set();
  let saveFailed = false;
  function readStored() {
    try { return normalizeReaderView(JSON.parse(storage()?.getItem(READER_VIEW_KEY) ?? "null")); }
    catch { return normalizeReaderView(); }
  }
  let snapshot = readStored();
  function publish(next) {
    if (Object.keys(next).every((key) => next[key] === snapshot[key])) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }
  function save(value) {
    const next = normalizeReaderView(value);
    if (!saveFailed && Object.keys(next).every((key) => next[key] === snapshot[key])) return;
    try {
      const destination = storage();
      if (!destination) saveFailed = true;
      else { destination.setItem(READER_VIEW_KEY, JSON.stringify(next)); saveFailed = false; }
    } catch { saveFailed = true; }
    // The shared in-window choice also survives unavailable browser storage.
    publish(next);
  }
  function changed(event) {
    if (event.key !== READER_VIEW_KEY && event.key !== null) return;
    try { if (event.storageArea && event.storageArea !== storage()) return; }
    catch { return; }
    saveFailed = false;
    publish(readStored());
  }
  target?.addEventListener?.("storage", changed);
  return { read: () => snapshot, save,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { target?.removeEventListener?.("storage", changed); listeners.clear(); } };
}

let store;
const sharedStore = () => store ||= createReaderViewStore();
export const readReaderView = () => sharedStore().read();
export const saveReaderView = (value) => sharedStore().save(value);
export const subscribeReaderView = (listener) => sharedStore().subscribe(listener);
if (import.meta.hot) import.meta.hot.dispose(() => store?.dispose());
