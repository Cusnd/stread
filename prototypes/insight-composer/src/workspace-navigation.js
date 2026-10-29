import { parseRoute, readViewState } from "./workspace-api.js";

export const WORKSPACE_NAVIGATION_KEY = "continuous-reader.workspace-navigation.v1";
const serverSnapshot = Object.freeze({ navigationExpanded: true, sessionOnly: false });

/** Collection and Flow share this preference; Reader's article TOC is separate. */
export function createWorkspaceNavigationStore(options = {}) {
  const target = options.windowTarget === undefined ? globalThis.window : options.windowTarget;
  const explicitStorage = Object.hasOwn(options, "storage");
  const storage = () => explicitStorage ? options.storage : target?.localStorage;
  const legacyStorage = () => Object.hasOwn(options, "sessionStorage") ? options.sessionStorage : target?.sessionStorage;
  const preferredPage = options.preferredPage || parseRoute(target?.location?.search || "").page;
  const defaultExpanded = typeof options.defaultExpanded === "boolean" ? options.defaultExpanded : !target || target.innerWidth === undefined || target.innerWidth > 640;
  const listeners = new Set();

  function readStored() {
    let raw;
    try {
      const source = storage();
      if (!source) return { available: !target && !explicitStorage };
      raw = source.getItem(WORKSPACE_NAVIGATION_KEY);
    } catch { return { available: false }; }
    try {
      const saved = JSON.parse(raw);
      return { available: true, value: saved?.version === 1 && typeof saved.navigationExpanded === "boolean" ? saved.navigationExpanded : undefined };
    } catch { return { available: true }; }
  }

  const initial = readStored();
  let legacy;
  if (initial.value === undefined) {
    try { legacy = readViewState(legacyStorage(), preferredPage).navigationExpanded; } catch {}
  }
  let migrationPending = initial.value === undefined && typeof legacy === "boolean";
  let snapshot = Object.freeze({ navigationExpanded: initial.value ?? legacy ?? defaultExpanded, sessionOnly: !initial.available });

  function publish(next) {
    if (next.navigationExpanded === snapshot.navigationExpanded && next.sessionOnly === snapshot.sessionOnly) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  }

  function setExpanded(navigationExpanded) {
    if (typeof navigationExpanded !== "boolean") return;
    let sessionOnly = false;
    try {
      const destination = storage();
      if (!destination) sessionOnly = true;
      else destination.setItem(WORKSPACE_NAVIGATION_KEY, JSON.stringify({ version: 1, navigationExpanded }));
    } catch { sessionOnly = true; }
    migrationPending = false;
    publish({ navigationExpanded, sessionOnly });
  }

  function migrate() {
    if (!migrationPending) return;
    // Another window may have established the shared preference after import.
    const latest = readStored();
    if (latest.value !== undefined) {
      migrationPending = false;
      publish({ navigationExpanded: latest.value, sessionOnly: false });
    } else setExpanded(snapshot.navigationExpanded);
  }

  function onStorage(event) {
    if (event.key !== WORKSPACE_NAVIGATION_KEY && event.key !== null) return;
    try { if (event.storageArea && event.storageArea !== storage()) return; } catch { return; }
    const next = readStored();
    migrationPending = false;
    // A deliberate clear resets the preference; do not resurrect this window's
    // obsolete session mirror and diverge from other same-origin windows.
    publish({ navigationExpanded: next.value ?? defaultExpanded, sessionOnly: !next.available });
  }
  target?.addEventListener?.("storage", onStorage);

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setExpanded, migrate,
    dispose() { target?.removeEventListener?.("storage", onStorage); listeners.clear(); },
  };
}

const workspaceNavigation = createWorkspaceNavigationStore();
export const getWorkspaceNavigationSnapshot = workspaceNavigation.getSnapshot;
export const getServerWorkspaceNavigationSnapshot = workspaceNavigation.getServerSnapshot;
export const subscribeWorkspaceNavigation = workspaceNavigation.subscribe;
export const updateWorkspaceNavigation = workspaceNavigation.setExpanded;
export const migrateWorkspaceNavigation = workspaceNavigation.migrate;
if (import.meta.hot) import.meta.hot.dispose(() => workspaceNavigation.dispose());
