import test from "node:test";
import assert from "node:assert/strict";
import { readViewState, writeViewState } from "../src/workspace-api.js";
import { createWorkspaceNavigationStore, WORKSPACE_NAVIGATION_KEY } from "../src/workspace-navigation.js";

const VIEWS_KEY = "continuous-reader:views";
function storage(initial = {}) {
  const values = new Map(Object.entries(initial)), writes = [];
  return { writes, getItem: (key) => values.get(key) ?? null, setItem(key, value) { values.set(key, value); writes.push([key, value]); }, removeItem: (key) => values.delete(key), clear: () => values.clear() };
}
function target(localStorage, sessionStorage = storage(), search = "") {
  const listeners = new Set();
  return { localStorage, sessionStorage, innerWidth: 1440, location: { search },
    addEventListener(event, callback) { if (event === "storage") listeners.add(callback); },
    removeEventListener(event, callback) { if (event === "storage") listeners.delete(callback); },
    emit(event) { for (const listener of listeners) listener(event); }, listenerCount: () => listeners.size };
}

test("legacy per-page navigation migrates from the current page while retaining filters, selection and scroll", () => {
  const source = { collection: { navigationExpanded: false, query: "papers", selectedId: "doc-a", listScrollTop: 142 }, flow: { navigationExpanded: true, section: "history", historyScrollTop: 290 } };
  const data = storage({ [VIEWS_KEY]: JSON.stringify(source) });
  const collection = readViewState(data, "collection"), flow = readViewState(data, "flow");
  assert.equal(collection.navigationExpanded, false);
  assert.equal(flow.navigationExpanded, true);
  assert.deepEqual(collection.collection, { query: "papers", selectedId: "doc-a", listScrollTop: 142 });
  assert.deepEqual(collection.flow, { section: "history", historyScrollTop: 290 });
  assert.equal(data.writes.length, 0, "reading a view must not rewrite storage");
  assert.equal(source.collection.navigationExpanded, false);
  assert.equal(readViewState(storage({ [VIEWS_KEY]: JSON.stringify({ flow: { navigationExpanded: false } }) }), "collection").navigationExpanded, false);
});

test("the session mirror stores one shared navigation field and never resets per-page content or Reader preferences", () => {
  const reader = JSON.stringify({ tocMode: "collapsed", translationFirst: true });
  const data = storage({ "reader-view": reader });
  assert.equal(writeViewState(data, { navigationExpanded: false, collection: { navigationExpanded: true, query: "saved" }, flow: { navigationExpanded: true, overviewDays: 30 } }), true);
  assert.deepEqual(JSON.parse(data.getItem(VIEWS_KEY)), { collection: { query: "saved" }, flow: { overviewDays: 30 }, navigationExpanded: false });
  assert.equal(readViewState(data, "flow").navigationExpanded, false);
  assert.equal(data.getItem("reader-view"), reader);
  assert.deepEqual(data.writes.map(([key]) => key), [VIEWS_KEY]);
  assert.equal(writeViewState({ setItem() { throw new Error("QuotaExceededError"); } }, {}), false);
});

test("shared local preference wins over conflicting sessions and restores immediately in either page", () => {
  const local = storage({ [WORKSPACE_NAVIGATION_KEY]: JSON.stringify({ version: 1, navigationExpanded: false }) });
  for (const page of ["collection", "flow"]) {
    const session = storage({ [VIEWS_KEY]: JSON.stringify({ navigationExpanded: true, [page]: { navigationExpanded: true } }) });
    const store = createWorkspaceNavigationStore({ windowTarget: target(local, session, "?view=" + page) });
    assert.deepEqual(store.getSnapshot(), { navigationExpanded: false, sessionOnly: false });
    store.migrate();
    assert.equal(local.writes.length, 0);
    store.dispose();
  }
});

test("migration is explicit and uses the first actual page before both pages share later changes", () => {
  const local = storage(), session = storage({ [VIEWS_KEY]: JSON.stringify({ collection: { navigationExpanded: true }, flow: { navigationExpanded: false } }) });
  const first = createWorkspaceNavigationStore({ windowTarget: target(local, session, "?view=flow") });
  assert.equal(first.getSnapshot().navigationExpanded, false);
  assert.equal(local.writes.length, 0, "module initialization remains read-only for preview isolation");
  first.migrate();
  assert.deepEqual(JSON.parse(local.getItem(WORKSPACE_NAVIGATION_KEY)), { version: 1, navigationExpanded: false });
  first.migrate(); assert.equal(local.writes.length, 1);
  const collection = createWorkspaceNavigationStore({ windowTarget: target(local, session, "?view=collection") });
  assert.equal(collection.getSnapshot().navigationExpanded, false);
  collection.setExpanded(true);
  const restored = createWorkspaceNavigationStore({ windowTarget: target(local, session, "?view=flow") });
  assert.equal(restored.getSnapshot().navigationExpanded, true);
  first.dispose(); collection.dispose(); restored.dispose();
});

test("a shared preference established by another window wins a pending legacy migration", () => {
  const local = storage(), session = storage({ [VIEWS_KEY]: JSON.stringify({ navigationExpanded: false }) });
  const store = createWorkspaceNavigationStore({ windowTarget: target(local, session) });
  local.setItem(WORKSPACE_NAVIGATION_KEY, JSON.stringify({ version: 1, navigationExpanded: true }));
  store.migrate();
  assert.equal(store.getSnapshot().navigationExpanded, true);
  assert.equal(local.writes.length, 1);
  store.dispose();
});

test("same-origin storage events synchronize navigation and a deliberate clear cannot revive stale session state", () => {
  const local = storage({ [WORKSPACE_NAVIGATION_KEY]: JSON.stringify({ version: 1, navigationExpanded: true }) });
  const session = storage({ [VIEWS_KEY]: JSON.stringify({ navigationExpanded: false }) });
  const windowTarget = target(local, session), store = createWorkspaceNavigationStore({ windowTarget });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++), initial = store.getSnapshot();
  local.setItem(WORKSPACE_NAVIGATION_KEY, JSON.stringify({ version: 1, navigationExpanded: false }));
  windowTarget.emit({ key: "reader-toc", storageArea: local });
  windowTarget.emit({ key: WORKSPACE_NAVIGATION_KEY, storageArea: storage() });
  assert.equal(store.getSnapshot(), initial);
  windowTarget.emit({ key: WORKSPACE_NAVIGATION_KEY, storageArea: local });
  assert.equal(store.getSnapshot().navigationExpanded, false);
  windowTarget.emit({ key: WORKSPACE_NAVIGATION_KEY, storageArea: local });
  assert.equal(notifications, 1);
  local.clear(); windowTarget.emit({ key: null, storageArea: local });
  assert.equal(store.getSnapshot().navigationExpanded, true);
  assert.equal(notifications, 2);
  unsubscribe(); store.dispose(); assert.equal(windowTarget.listenerCount(), 0);
});

test("corrupt or unsupported shared preferences fall back to valid legacy data and invalid values do not become collapsed", () => {
  for (const raw of ["broken", "null", "[]", '{"version":2,"navigationExpanded":true}', '{"version":1,"navigationExpanded":"false"}']) {
    const local = storage({ [WORKSPACE_NAVIGATION_KEY]: raw });
    const session = storage({ [VIEWS_KEY]: JSON.stringify({ navigationExpanded: false }) });
    const store = createWorkspaceNavigationStore({ windowTarget: target(local, session) });
    assert.deepEqual(store.getSnapshot(), { navigationExpanded: false, sessionOnly: false });
    store.migrate();
    assert.deepEqual(JSON.parse(local.getItem(WORKSPACE_NAVIGATION_KEY)), { version: 1, navigationExpanded: false });
    store.setExpanded("true"); assert.equal(store.getSnapshot().navigationExpanded, false);
    store.dispose();
  }
  assert.deepEqual(readViewState(storage({ [VIEWS_KEY]: '{"collection":{"navigationExpanded":"false"},"flow":[]}' })), { collection: {}, flow: {} });
});

test("blocked local storage retains an in-window choice and recovers persistence without changing Reader settings", () => {
  let blocked = true;
  const local = storage(), session = storage({ [VIEWS_KEY]: JSON.stringify({ navigationExpanded: false }) });
  const windowTarget = target(local, session);
  Object.defineProperty(windowTarget, "localStorage", { get() { if (blocked) throw new Error("SecurityError"); return local; } });
  const store = createWorkspaceNavigationStore({ windowTarget });
  assert.deepEqual(store.getSnapshot(), { navigationExpanded: false, sessionOnly: true });
  store.migrate(); store.setExpanded(true);
  assert.deepEqual(store.getSnapshot(), { navigationExpanded: true, sessionOnly: true });
  writeViewState(session, { collection: { selectedId: "doc-a" }, flow: {}, navigationExpanded: true });
  const restored = createWorkspaceNavigationStore({ windowTarget });
  assert.equal(restored.getSnapshot().navigationExpanded, true);
  blocked = false; store.setExpanded(true);
  assert.deepEqual(store.getSnapshot(), { navigationExpanded: true, sessionOnly: false });
  assert.deepEqual(local.writes.map(([key]) => key), [WORKSPACE_NAVIGATION_KEY]);
  store.dispose(); restored.dispose();
});
