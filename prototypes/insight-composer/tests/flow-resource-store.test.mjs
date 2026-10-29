import test from "node:test";
import assert from "node:assert/strict";
import { createFlowResourceStore } from "../src/workspace/flow-resource-store.js";

const createStore = (options = {}) => createFlowResourceStore({ getOrigin: () => "http://reader.local:4191", ...options });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => queueMicrotask(resolve));
async function populate(store, url, data, version = 1) {
  const request = store.acquire(url, { version, load: async () => data });
  await request.promise;
  request.release();
  return data;
}

test("Flow caches equivalent URLs within their own origin and isolates development data", async () => {
  let origin = "http://reader.local:4191";
  const store = createStore({ getOrigin: () => origin });
  const data = await populate(store, "/api/flow/summary?days=30&timezone=UTC", { days: 30 });
  assert.equal(store.read("/api/flow/summary?timezone=UTC&days=30"), data);
  origin = "http://reader.local:4177";
  assert.equal(store.read("/api/flow/summary?days=30&timezone=UTC"), null);
  assert.throws(() => store.read("http://reader.local:4191/api/flow/summary?days=30&timezone=UTC"), /current origin/);
});

test("Flow keeps loaded pagination rows while never borrowing another query or range", async () => {
  const store = createStore();
  const url = "/api/flow/insights?query=attention&type=question&offset=0&limit=2";
  const data = { items: [{ id: "q1" }, { id: "q2" }], total: 3, hasMore: true, offset: 0, limit: 2 };
  await populate(store, url, data);
  const expanded = store.read(url.replace("limit=2", "limit=4"));
  assert.deepEqual(expanded.items, data.items);
  assert.equal(expanded.hasMore, true);
  assert.equal(store.has(url.replace("limit=2", "limit=4")), false);
  assert.equal(store.read(url.replace("attention", "transformer")), null);
  assert.equal(store.read(url.replace("question", "note")), null);
  assert.equal(store.read(url.replace("offset=0", "offset=2")), null);
  await populate(store, "/api/flow/history?from=2026-10-01&to=2026-10-22&limit=30", data);
  assert.equal(store.read("/api/flow/history?from=2026-10-20&to=2026-10-22&limit=30"), null);
});

test("returning to a smaller list caps rows and restores its load-more action", async () => {
  const store = createStore();
  await populate(store, "/api/flow/insights?limit=60", { items: [{ id: 1 }, { id: 2 }, { id: 3 }], total: 3, hasMore: false });
  const compact = store.read("/api/flow/insights?limit=2");
  assert.deepEqual(compact.items, [{ id: 1 }, { id: 2 }]);
  assert.equal(compact.hasMore, true);
  assert.equal(store.read("/api/flow/insights?limit=100").hasMore, false);
});

test("Flow cache has a bounded least-recently-used lifetime", async () => {
  const store = createStore({ maxEntries: 2 });
  await populate(store, "/api/flow/summary?days=7", { days: 7 });
  await populate(store, "/api/flow/summary?days=30", { days: 30 });
  store.read("/api/flow/summary?days=7");
  await populate(store, "/api/flow/summary?days=1", { days: 1 });
  assert.equal(store.read("/api/flow/summary?days=30"), null);
  assert.equal(store.read("/api/flow/summary?days=7").days, 7);
  assert.equal(store.read("/api/flow/summary?days=1").days, 1);
});

test("concurrent Flow readers deduplicate requests and retain another reader's request", async () => {
  const store = createStore();
  const result = deferred();
  let calls = 0, signal;
  const options = { version: 1, load: (_url, nextSignal) => { calls += 1; signal = nextSignal; return result.promise; } };
  const first = store.acquire("/api/flow/summary?days=7", options);
  const second = store.acquire("/api/flow/summary?days=7", options);
  await tick();
  assert.equal(calls, 1);
  assert.equal(first.promise, second.promise);
  first.release();
  first.release();
  await tick();
  assert.equal(signal.aborted, false);
  result.resolve({ days: 7 });
  await second.promise;
  second.release();
  assert.equal(store.read("/api/flow/summary?days=7").days, 7);
});

test("React effect replay reacquires a pending request before cancellation", async () => {
  const store = createStore();
  const result = deferred();
  let calls = 0, signal;
  const options = { version: 1, load: (_url, nextSignal) => { calls += 1; signal = nextSignal; return result.promise; } };
  const first = store.acquire("/api/flow/summary", options);
  first.release();
  const replay = store.acquire("/api/flow/summary", options);
  await tick();
  assert.equal(calls, 1);
  assert.equal(signal.aborted, false);
  result.resolve({ value: "ready" });
  await replay.promise;
  replay.release();
});

test("abandoned Flow loads cannot enter the cache even if a loader ignores abort", async () => {
  const store = createStore();
  const result = deferred();
  let signal;
  const request = store.acquire("/api/flow/insights?query=old", { version: 1, load: (_url, nextSignal) => { signal = nextSignal; return result.promise; } });
  await tick();
  request.release();
  await tick();
  assert.equal(signal.aborted, true);
  result.resolve({ items: [{ id: "old" }] });
  await request.promise;
  assert.equal(store.read("/api/flow/insights?query=old"), null);
});

test("an older workspace revision finishing last cannot replace a newer cached result", async () => {
  const store = createStore();
  const old = deferred(), fresh = deferred();
  const url = "/api/flow/insights?review=pending&limit=30";
  const first = store.acquire(url, { version: 1, load: () => old.promise });
  const second = store.acquire(url, { version: 2, load: () => fresh.promise });
  fresh.resolve({ items: [], total: 0 });
  await second.promise;
  old.resolve({ items: [{ id: "reviewed" }], total: 1 });
  await first.promise;
  assert.deepEqual(store.read(url).items, []);
  first.release(); second.release();
});

test("failed revalidation preserves cached content and leaves retries available", async () => {
  const store = createStore();
  const url = "/api/flow/summary?days=7";
  const cached = await populate(store, url, { days: 7, total: 2 });
  const failed = store.acquire(url, { version: 1, load: async () => { throw new Error("offline"); } });
  await assert.rejects(failed.promise, /offline/);
  failed.release();
  assert.equal(store.read(url), cached);
  await populate(store, url, { days: 7, total: 3 });
  assert.equal(store.read(url).total, 3);
});

test("selected insight identity survives list filtering and independent readers across page mounts", async () => {
  const store = createStore();
  const detailUrl = "/api/flow/insights/n1";
  const detail = await populate(store, detailUrl, { insight: { id: "n1", type: "note", body: "Selected outside the current filter" } });
  await populate(store, "/api/flow/insights?type=question&limit=30", { items: [], total: 0 });
  assert.equal(store.read(detailUrl), detail);
  assert.equal(store.read("/api/flow/insights/n2"), null);
  const remounted = store.acquire(detailUrl, { version: 2, load: async () => ({ insight: { ...detail.insight, body: "Updated while in Collection" } }) });
  assert.equal(store.read(detailUrl), detail);
  await remounted.promise;
  remounted.release();
  assert.equal(store.read(detailUrl).insight.body, "Updated while in Collection");
});

test("an authoritative unavailable detail replaces old content and cannot be resurrected by an older fetch", async () => {
  const store = createStore();
  const url = "/api/flow/insights/n1";
  await populate(store, url, { insight: { id: "n1", body: "Before archive" } });
  const stale = deferred();
  const old = store.acquire(url, { version: 1, load: () => stale.promise });
  const fresh = store.acquire(url, { version: 2, load: async () => ({ insight: null, unavailable: true }) });
  await fresh.promise;
  stale.resolve({ insight: { id: "n1", body: "Stale response" } });
  await old.promise;
  old.release(); fresh.release();
  assert.deepEqual(store.read(url), { insight: null, unavailable: true });
  await populate(store, url, { insight: { id: "n1", body: "Restored" } }, 3);
  assert.equal(store.read(url).insight.body, "Restored");
});
