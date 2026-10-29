import assert from "node:assert/strict";
import test from "node:test";
import { createVisiblePoller } from "../src/visible-poller.js";
import { createRefreshCoordinator } from "../src/refresh-coordinator.js";
import { requestJson } from "../src/workspace-api.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function clock() {
  let sequence = 0; const scheduled = new Map();
  return { scheduled, setTimer: (fn, delay) => { const id = ++sequence; scheduled.set(id, { fn, delay }); return id; }, clearTimer: (id) => scheduled.delete(id),
    async fire() { const [id, value] = scheduled.entries().next().value; scheduled.delete(id); value.fn(); await settle(); return value.delay; } };
}

test("visible polling backs off unchanged work, aborts on hiding and wakes once after visibility returns", async () => {
  const timers = clock(); let visible = true, calls = 0, pending;
  const poller = createVisiblePoller({ ...timers, isVisible: () => visible, intervalMs: 1000, maxIntervalMs: 8000,
    run: async (signal) => { calls++; if (calls === 3) return new Promise((resolve, reject) => { pending = signal; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); return false; } });
  poller.start(); assert.equal(await timers.fire(), 0); assert.equal(await timers.fire(), 2000);
  assert.equal(await timers.fire(), 4000); assert.equal(calls, 3);
  visible = false; poller.wake(); await settle(); assert.equal(pending.aborted, true); assert.equal(timers.scheduled.size, 0);
  visible = true; poller.wake(); assert.equal(await timers.fire(), 0); assert.equal(calls, 4);
  poller.dispose(); assert.equal(timers.scheduled.size, 0);
});

test("authentication failure pauses timers but a focus wake can recover a restored session", async () => {
  const timers = clock(); let authorized = false, calls = 0;
  const poller = createVisiblePoller({ ...timers, isVisible: () => true, run: async () => { calls++; if (!authorized) throw Object.assign(new Error("Login required"), { status: 401 }); return true; } });
  poller.start(); await timers.fire(); assert.equal(timers.scheduled.size, 0);
  authorized = true; poller.wake(); await timers.fire(); assert.equal(calls, 2); assert.equal(timers.scheduled.size, 1); poller.dispose();
});

test("background cancellation spans all downstream awaits and never commits an aborted refresh", async () => {
  const coordinator = createRefreshCoordinator(), owner = new AbortController(); let next, commits = 0, seen;
  const operation = coordinator.run(async (signal) => { seen = signal; await new Promise((resolve) => { next = resolve; }); signal.throwIfAborted(); commits++; }, { signal: owner.signal });
  await settle(); owner.abort(); next(); await assert.rejects(operation, { name: "AbortError" });
  assert.equal(seen.aborted, true); assert.equal(commits, 0);
  await coordinator.run(async () => { commits++; }); assert.equal(commits, 1);
});

test("a command promotes shared background refresh without letting its old owner cancel save feedback", async () => {
  const coordinator = createRefreshCoordinator(), owner = new AbortController(); let finish, calls = 0;
  const first = coordinator.run(async (signal) => { calls++; await new Promise((resolve) => { finish = resolve; }); signal.throwIfAborted(); return "updated"; }, { signal: owner.signal });
  const command = coordinator.run(async () => { throw new Error("must share"); }); assert.equal(command, first);
  await settle(); owner.abort(); finish(); assert.equal(await command, "updated"); assert.equal(calls, 1);
});

test("a save waits for a representation at least as new as its receipt, even when an older refresh is in flight", async () => {
  const coordinator = createRefreshCoordinator(), owner = new AbortController(); let finish, calls = 0;
  const background = coordinator.run(async () => { calls++; await new Promise((resolve) => { finish = resolve; }); return { revision: 1 }; }, { signal: owner.signal });
  await settle();
  const saved = coordinator.run(async () => { calls++; return { revision: 2 }; }, { minimumRevision: 2 });
  owner.abort(); finish(); assert.equal((await background).revision, 1);
  assert.equal((await saved).revision, 2); assert.equal(calls, 2);
});

test("conditional JSON requests reuse an authenticated 304 representation and advance on a changed tag", async (t) => {
  const calls = []; let version = 1;
  t.mock.method(globalThis, "fetch", async (path, options) => {
    calls.push({ path, options }); const tag = 'W/"test-' + version + '"';
    if (options.headers.get("if-none-match") === tag) return new Response(null, { status: 304, headers: { ETag: tag } });
    return new Response(JSON.stringify({ version }), { headers: { "Content-Type": "application/json", ETag: tag } });
  });
  const path = "/api/workspace?conditional-test=1", first = await requestJson(path, { conditional: true });
  assert.equal(await requestJson(path, { conditional: true }), first);
  assert.equal(calls[1].options.credentials, "same-origin"); assert.equal(Object.hasOwn(calls[1].options, "conditional"), false);
  version = 2; const second = await requestJson(path, { conditional: true }); assert.equal(second.version, 2); assert.notEqual(first, second);
});
