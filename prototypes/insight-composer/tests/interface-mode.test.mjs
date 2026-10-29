import test from "node:test";
import assert from "node:assert/strict";
import { createInterfaceModeStore, INTERFACE_MODE_KEY } from "../src/interface-mode.js";

function storage(initial) {
  const values = new Map(initial === undefined ? [] : [[INTERFACE_MODE_KEY, initial]]);
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key), clear: () => values.clear() };
}

function target(localStorage) {
  const listeners = new Set();
  return { localStorage, addEventListener: (event, callback) => { if (event === "storage") listeners.add(callback); },
    removeEventListener: (event, callback) => { if (event === "storage") listeners.delete(callback); },
    emit: (event) => { for (const listener of listeners) listener(event); }, listenerCount: () => listeners.size };
}

test("default is minimal, selections persist, and reloading restores normal mode", () => {
  const data = storage(), first = createInterfaceModeStore({ storage: data, windowTarget: null });
  assert.deepEqual(first.getSnapshot(), { mode: "minimal", sessionOnly: false });
  first.setMode("normal");
  assert.deepEqual(JSON.parse(data.getItem(INTERFACE_MODE_KEY)), { version: 1, mode: "normal" });
  const second = createInterfaceModeStore({ storage: data, windowTarget: null });
  assert.deepEqual(second.getSnapshot(), { mode: "normal", sessionOnly: false });
  second.setMode("minimal");
  assert.equal(JSON.parse(data.getItem(INTERFACE_MODE_KEY)).mode, "minimal");
  first.dispose(); second.dispose();
});

test("corrupt, obsolete and unsupported persisted preferences fall back and remain writable", () => {
  for (const raw of ["broken-json", "null", "[]", '{"version":9,"mode":"normal"}', '{"version":1,"mode":"unrecognized"}']) {
    const data = storage(raw), store = createInterfaceModeStore({ storage: data, windowTarget: null });
    assert.deepEqual(store.getSnapshot(), { mode: "minimal", sessionOnly: false });
    store.setMode("normal");
    assert.deepEqual(store.getSnapshot(), { mode: "normal", sessionOnly: false });
    assert.equal(JSON.parse(data.getItem(INTERFACE_MODE_KEY)).mode, "normal");
    store.dispose();
  }
});

test("blocked storage preserves a working session preference and recovers when writes become available", () => {
  let blocked = true;
  const data = storage(), windowTarget = target(data);
  Object.defineProperty(windowTarget, "localStorage", { get() { if (blocked) throw new Error("SecurityError"); return data; } });
  const store = createInterfaceModeStore({ windowTarget });
  assert.deepEqual(store.getSnapshot(), { mode: "minimal", sessionOnly: true });
  store.setMode("normal");
  assert.deepEqual(store.getSnapshot(), { mode: "normal", sessionOnly: true });
  blocked = false; store.setMode("normal");
  assert.deepEqual(store.getSnapshot(), { mode: "normal", sessionOnly: false });
  assert.equal(JSON.parse(data.getItem(INTERFACE_MODE_KEY)).mode, "normal");
  store.dispose();
});

test("same-origin storage changes synchronize modes, while other keys/storage areas do not", () => {
  const data = storage(), windowTarget = target(data), store = createInterfaceModeStore({ windowTarget });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  const initial = store.getSnapshot();
  data.setItem(INTERFACE_MODE_KEY, JSON.stringify({ version: 1, mode: "normal" }));
  windowTarget.emit({ key: "another-preference", storageArea: data });
  windowTarget.emit({ key: INTERFACE_MODE_KEY, storageArea: storage() });
  assert.equal(store.getSnapshot(), initial);
  windowTarget.emit({ key: INTERFACE_MODE_KEY, storageArea: data });
  assert.deepEqual(store.getSnapshot(), { mode: "normal", sessionOnly: false });
  assert.equal(notifications, 1);
  const normal = store.getSnapshot();
  windowTarget.emit({ key: INTERFACE_MODE_KEY, storageArea: data });
  assert.equal(store.getSnapshot(), normal);
  assert.equal(notifications, 1);
  data.clear(); windowTarget.emit({ key: null, storageArea: data });
  assert.equal(store.getSnapshot().mode, "minimal");
  assert.equal(notifications, 2);
  unsubscribe(); store.setMode("normal");
  assert.equal(notifications, 2);
  store.dispose(); assert.equal(windowTarget.listenerCount(), 0);
});

test("quota failure keeps the chosen mode in memory and reports session-only persistence", () => {
  const data = storage();
  data.setItem = () => { throw new Error("QuotaExceededError"); };
  const store = createInterfaceModeStore({ storage: data, windowTarget: null });
  store.setMode("normal");
  assert.deepEqual(store.getSnapshot(), { mode: "normal", sessionOnly: true });
  store.dispose();
});
