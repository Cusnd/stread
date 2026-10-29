export const INTERFACE_MODE_KEY = "continuous-reader.interface-mode.v1";
export const DEFAULT_INTERFACE_MODE = "minimal";
export const INTERFACE_MODES = Object.freeze([
  Object.freeze({ id: "minimal", label: "极简模式" }),
  Object.freeze({ id: "normal", label: "正常模式" }),
]);

const serverSnapshot = Object.freeze({ mode: DEFAULT_INTERFACE_MODE, sessionOnly: false });

export function normalizeInterfaceMode(value) {
  return value === "normal" ? "normal" : DEFAULT_INTERFACE_MODE;
}

/** An external store shared by settings and decorative icons, with no reader remount. */
export function createInterfaceModeStore(options = {}) {
  const target = options.windowTarget === undefined ? globalThis.window : options.windowTarget;
  const explicitStorage = Object.hasOwn(options, "storage");
  const storage = () => explicitStorage ? options.storage : target?.localStorage;
  const listeners = new Set();

  function readPreference() {
    let raw;
    try {
      const source = storage();
      if (!source) return { mode: DEFAULT_INTERFACE_MODE, sessionOnly: Boolean(target || explicitStorage) };
      raw = source.getItem(INTERFACE_MODE_KEY);
    } catch { return { mode: DEFAULT_INTERFACE_MODE, sessionOnly: true }; }
    // Corrupt or obsolete preference data falls back safely, without pretending
    // otherwise working storage is blocked. The next selection can replace it.
    try {
      const stored = JSON.parse(raw);
      return { mode: stored?.version === 1 ? normalizeInterfaceMode(stored.mode) : DEFAULT_INTERFACE_MODE, sessionOnly: false };
    } catch { return { mode: DEFAULT_INTERFACE_MODE, sessionOnly: false }; }
  }

  let snapshot = Object.freeze(readPreference());
  function publish(next) {
    if (next.mode === snapshot.mode && next.sessionOnly === snapshot.sessionOnly) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  }

  function setMode(value) {
    const mode = normalizeInterfaceMode(value);
    let sessionOnly = false;
    try {
      const destination = storage();
      if (!destination) sessionOnly = true;
      else destination.setItem(INTERFACE_MODE_KEY, JSON.stringify({ version: 1, mode }));
    } catch { sessionOnly = true; }
    // A blocked store must not prevent a usable in-window preference.
    publish({ mode, sessionOnly });
  }

  function onStorage(event) {
    if (event.key !== INTERFACE_MODE_KEY && event.key !== null) return;
    try { if (event.storageArea && event.storageArea !== storage()) return; }
    catch { return; }
    publish(readPreference());
  }
  target?.addEventListener?.("storage", onStorage);

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setMode,
    dispose() { target?.removeEventListener?.("storage", onStorage); listeners.clear(); },
  };
}

const interfaceModeStore = createInterfaceModeStore();
export const getInterfaceModeSnapshot = interfaceModeStore.getSnapshot;
export const getServerInterfaceModeSnapshot = interfaceModeStore.getServerSnapshot;
export const subscribeInterfaceMode = interfaceModeStore.subscribe;
export const updateInterfaceMode = interfaceModeStore.setMode;
if (import.meta.hot) import.meta.hot.dispose(() => interfaceModeStore.dispose());
