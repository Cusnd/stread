import test from "node:test";
import assert from "node:assert/strict";
import { createReadingActivityTracker } from "../src/reading-activity.js";

function memoryStorage() {
  const values = new Map();
  return { get length() { return values.size; }, key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

class Target {
  listeners = new Map();
  visibilityState = "visible";
  focused = true;
  hasFocus() { return this.focused; }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  emit(name, extra = {}) { for (const listener of this.listeners.get(name) || []) listener({ type: name, ...extra }); }
  listenerCount() { return [...this.listeners.values()].reduce((total, values) => total + values.size, 0); }
}

function setup(overrides = {}) {
  let wall = Date.UTC(2026, 9, 22), mono = 0, serial = 0;
  const commands = [], errors = [], timers = new Set(), windowTarget = new Target(), documentTarget = new Target();
  const storage = overrides.storage || memoryStorage();
  const tracker = createReadingActivityTracker({
    sendCommand: async (command) => { commands.push(command); }, storage, windowTarget, documentTarget,
    wallNow: () => wall, monotonicNow: () => mono, createId: () => "test-" + (++serial),
    setInterval: (callback) => { timers.add(callback); return callback; }, clearInterval: (callback) => timers.delete(callback),
    onError: (error) => errors.push(error), ...overrides,
  });
  const advance = (ms, wallMs = ms) => { mono += ms; wall += wallMs; };
  const tick = async (ms = 15_000, wallMs = ms) => { advance(ms, wallMs); for (const callback of timers) callback(); await tracker.flush(); };
  const start = (documentId = "paper-one", extra = {}) => tracker.start({ documentId, documentRevision: 2, position: { blockId: "intro", mode: "source" }, mode: "source", ...extra });
  return { tracker, start, commands, errors, storage, windowTarget, documentTarget, timers, advance, tick,
    time: () => ({ wall, mono }), activity: () => commands.filter((command) => command.kind === "reading.session.activity"),
    total: () => commands.filter((command) => command.kind === "reading.session.activity").reduce((total, command) => total + command.activeMs, 0) };
}

test("a foreground reader counts quiet reading, reports source position, and starts before activity", async () => {
  const h = setup();
  h.start();
  await h.tick();
  h.advance(5_000);
  h.tracker.updatePosition({ blockId: "methods", mode: "translation" });
  h.tracker.end("leave");
  await h.tracker.flush();
  assert.equal(h.total(), 20_000);
  assert.deepEqual(h.commands.map((command) => command.kind), ["reading.session.start", "reading.session.activity", "reading.session.activity", "reading.session.end"]);
  assert.deepEqual(h.activity().map((command) => command.sequence), [1, 2]);
  assert.deepEqual(h.commands.at(-1).position, { blockId: "methods", mode: "translation" });
  assert.equal(h.timers.size, 0);
  h.tracker.dispose();
});

test("blur/hidden time is excluded and foreground return starts a fresh interval", async () => {
  const h = setup(); h.start();
  h.advance(4_000); h.documentTarget.focused = false; h.windowTarget.emit("blur");
  await h.tick(30_000);
  h.documentTarget.visibilityState = "hidden"; h.documentTarget.emit("visibilitychange");
  await h.tick(30_000);
  h.documentTarget.visibilityState = "visible"; h.documentTarget.emit("visibilitychange");
  await h.tick(30_000); // visible but unfocused is still inactive
  h.documentTarget.focused = true; h.windowTarget.emit("focus");
  await h.tick(10_000);
  assert.equal(h.total(), 14_000);
  assert.equal(h.activity().at(-1).startedAt, new Date(h.time().wall - 10_000).toISOString());
  h.tracker.dispose(); await h.tracker.flush();
});

test("idle cutoff is exact; wheel/key input revives reading without backfilling idle", async () => {
  const h = setup(); h.start();
  for (let index = 0; index < 22; index++) await h.tick();
  assert.equal(h.total(), 300_000);
  assert.equal(h.tracker.getStatus().pausedReason, "idle");
  h.advance(2_000); h.documentTarget.emit("keydown");
  await h.tick(8_000);
  assert.equal(h.total(), 308_000);
  h.advance(2_000); h.documentTarget.emit("wheel");
  h.advance(2_000); h.documentTarget.emit("wheel");
  await h.tick(11_000);
  assert.equal(h.total(), 323_000);
  assert.equal(h.activity().length, 22); // ordinary wheel events create no extra intervals
  h.tracker.dispose(); await h.tracker.flush();
});

test("sleep jumps and wall/monotonic disagreement never inflate recorded reading", async () => {
  for (const [mono, wall] of [[3_600_000, 3_600_000], [15_000, 3_600_000], [15_000, -10_000]]) {
    const h = setup(); h.start(); await h.tick();
    await h.tick(mono, wall);
    await h.tick();
    assert.equal(h.total(), 15_000);
    assert.equal(h.tracker.getStatus().pausedReason, "suspended");
    h.documentTarget.emit("pointerdown");
    await h.tick();
    assert.equal(h.total(), 30_000);
    h.tracker.dispose(); await h.tracker.flush();
  }
});

test("offline retries preserve exact requests and drain in session order on online", async () => {
  let connected = false;
  const attempts = [], received = [];
  const h = setup({ sendCommand: async (command) => {
    attempts.push(structuredClone(command));
    if (!connected) { const error = new Error("offline"); error.status = 503; throw error; }
    received.push(command);
  } });
  h.start(); await h.tick(); h.tracker.end("leave"); await h.tracker.flush();
  assert.equal(h.storage.length, 3);
  assert.ok(h.errors.length > 0);
  assert.ok(attempts.length > 1);
  assert.deepEqual(attempts[0], attempts[1]);
  connected = true; h.windowTarget.emit("online"); await h.tracker.flush();
  assert.deepEqual(received.map((command) => command.kind), ["reading.session.start", "reading.session.activity", "reading.session.end"]);
  assert.deepEqual(attempts[0], received[0]);
  assert.equal(h.storage.length, 0);
  assert.equal(h.tracker.getStatus().error, null);
  h.tracker.dispose();
});

test("unknown permanent-looking failures remain durable and a new mount replays exact commands", async () => {
  const h = setup({ sendCommand: async () => { const error = new Error("unexpected validation"); error.status = 400; throw error; } });
  h.start(); await h.tick(); h.tracker.dispose(); await h.tracker.flush();
  const saved = Array.from({ length: h.storage.length }, (_, index) => JSON.parse(h.storage.getItem(h.storage.key(index))).command);
  assert.equal(saved.length, 3);
  const replay = setup({ storage: h.storage });
  await replay.tracker.flush();
  assert.deepEqual(replay.commands, saved);
  assert.equal(h.storage.length, 0);
  replay.tracker.dispose();
});

test("switching articles closes the previous session; repeat start and dispose are safe", async () => {
  const h = setup(); const first = h.start();
  await h.tick();
  assert.equal(h.start(), first);
  const second = h.start("paper-two");
  assert.notEqual(second, first);
  await h.tick(7_000);
  h.tracker.dispose(); h.tracker.dispose(); await h.tracker.flush();
  assert.equal(h.commands.filter((command) => command.kind === "reading.session.start").length, 2);
  const endings = h.commands.filter((command) => command.kind === "reading.session.end");
  assert.deepEqual(endings.map((command) => command.reason), ["document-switch", "unmount"]);
  assert.equal(h.total(), 22_000);
  assert.equal(h.timers.size, 0);
  assert.equal(h.windowTarget.listenerCount() + h.documentTarget.listenerCount(), 0);
  await h.tick(); assert.equal(h.total(), 22_000);
  assert.throws(() => h.start(), /disposed/);
});

test("an unresponsive transport cannot grow the outbox forever; closing retains an end slot", async () => {
  const h = setup({ maxPending: 4, sendCommand: async () => { throw new Error("offline"); } });
  h.start(); await h.tick(); await h.tick(); await h.tick();
  assert.equal(h.storage.length, 3);
  assert.equal(h.tracker.getStatus().pausedReason, "buffer-full");
  assert.equal(h.errors.at(-2)?.code === "READING_ACTIVITY_BUFFER_FULL" || h.errors.some((error) => error.code === "READING_ACTIVITY_BUFFER_FULL"), true);
  h.tracker.dispose(); await h.tracker.flush();
  assert.equal(h.storage.length, 4);
  assert.equal(JSON.parse(h.storage.getItem(h.storage.key(3))).command.kind, "reading.session.end");
});

test("two live instances share durable entries without overwriting or changing retries", async () => {
  const storage = memoryStorage();
  const a = setup({ storage, createId: (() => { let id = 0; return () => "a-" + (++id); })(), sendCommand: async () => { throw new Error("offline"); } });
  const b = setup({ storage, createId: (() => { let id = 0; return () => "b-" + (++id); })(), sendCommand: async () => { throw new Error("offline"); } });
  a.start(); b.start("paper-two"); await a.tick(); await b.tick();
  assert.equal(storage.length, 4);
  a.tracker.dispose(); b.tracker.dispose(); await Promise.all([a.tracker.flush(), b.tracker.flush()]);
  assert.equal(storage.length, 6);
  const recovered = setup({ storage }); await recovered.tracker.flush();
  assert.equal(recovered.commands.length, 6);
  for (const prefix of ["a-", "b-"]) {
    assert.deepEqual(recovered.commands.filter((command) => command.sessionId.startsWith(prefix)).map((command) => command.kind), ["reading.session.start", "reading.session.activity", "reading.session.end"]);
  }
  recovered.tracker.dispose();
});

test("restoring a back/forward-cache page opens a fresh session without the hidden gap", async () => {
  const h = setup(); h.start(); await h.tick();
  h.windowTarget.emit("pagehide", { persisted: true }); await h.tracker.flush();
  h.advance(3_600_000);
  h.windowTarget.emit("pageshow", { persisted: true }); await h.tick();
  h.tracker.dispose(); await h.tracker.flush();
  assert.equal(h.total(), 30_000);
  assert.equal(h.commands.filter((command) => command.kind === "reading.session.start").length, 2);
  assert.equal(h.commands.filter((command) => command.kind === "reading.session.end")[0].reason, "pagehide");
});

test("clock rollback cannot produce an end before acknowledged activity or overlapping intervals", async () => {
  const h = setup(); h.start(); await h.tick();
  const firstEnd = h.activity()[0].endedAt;
  await h.tick(15_000, -30_000);
  h.documentTarget.emit("keydown"); await h.tick(5_000);
  assert.equal(h.total(), 15_000);
  h.tracker.dispose(); await h.tracker.flush();
  assert.equal(h.commands.at(-1).endedAt, firstEnd);
});

test("delivery keeps retrying after leaving the reader without adding reading time", async () => {
  let connected = false;
  const received = [];
  const h = setup({ sendCommand: async (command) => {
    if (!connected) throw new Error("temporary failure while still online");
    received.push(command);
  } });
  h.start(); await h.tick(); h.tracker.end("leave"); await h.tracker.flush();
  assert.equal(h.timers.size, 1); // delivery-only retry survives the reading heartbeat
  connected = true;
  await h.tick(30_000);
  assert.equal(received.filter((command) => command.kind === "reading.session.activity").reduce((sum, command) => sum + command.activeMs, 0), 15_000);
  assert.equal(h.storage.length, 0);
  assert.equal(h.timers.size, 0);
  h.tracker.dispose();
});

test("a permanently rejected old session is retained without poisoning later valid sessions", async () => {
  let firstSession;
  const received = [];
  const h = setup({ sendCommand: async (command) => {
    if (command.sessionId === firstSession) { const error = new Error("expired offline session"); error.status = 400; throw error; }
    received.push(command);
  } });
  firstSession = h.start(); await h.tick(); h.tracker.end("leave"); await h.tracker.flush();
  const secondSession = h.start("paper-two"); await h.tick(); h.tracker.end("leave"); await h.tracker.flush();
  assert.equal(h.storage.length, 3);
  assert.deepEqual(received.filter((command) => command.sessionId === secondSession).map((command) => command.kind), ["reading.session.start", "reading.session.activity", "reading.session.end"]);
  assert.match(h.tracker.getStatus().error.message, /expired/);
  h.tracker.dispose(); await h.tracker.flush();
});

test("a start deferred by the full outbox resumes at recovery time and preserves its latest position", async () => {
  let connected = false;
  const received = [];
  const h = setup({ maxPending: 4, sendCommand: async (command) => {
    if (!connected) throw new Error("offline");
    received.push(command);
  } });
  h.start(); await h.tick(); h.tracker.end("leave"); await h.tracker.flush();
  assert.equal(h.storage.length, 3);
  assert.equal(h.start("paper-two"), null);
  assert.equal(h.tracker.getStatus().documentId, "paper-two");
  assert.equal(h.tracker.getStatus().pausedReason, "buffer-full");
  h.tracker.updatePosition({ documentId: "paper-two", blockId: "latest", offsetRatio: 0.4 });
  h.advance(60_000);
  const recoveryTime = new Date(h.time().wall).toISOString();
  connected = true; await h.tracker.flush();
  assert.equal(h.tracker.getStatus().documentId, "paper-two");
  assert.equal(h.tracker.getStatus().recording, true);
  const resumed = received.find((command) => command.kind === "reading.session.start" && command.documentId === "paper-two");
  assert.equal(resumed.startedAt, recoveryTime);
  assert.equal(resumed.position.blockId, "latest");
  await h.tick();
  assert.equal(received.filter((command) => command.kind === "reading.session.activity" && command.sessionId === resumed.sessionId).reduce((total, command) => total + command.activeMs, 0), 15_000);
  h.tracker.dispose(); await h.tracker.flush();
});

test("recovery of a deferred start does not revive an idle reader until fresh input", async () => {
  let connected = false;
  const received = [];
  const h = setup({ maxPending: 4, sendCommand: async (command) => {
    if (!connected) throw new Error("offline");
    received.push(command);
  } });
  h.start(); await h.tick(); h.tracker.end("leave"); await h.tracker.flush();
  h.start("paper-two"); h.advance(600_000);
  connected = true; await h.tracker.flush(); await h.tick();
  const resumed = received.find((command) => command.kind === "reading.session.start" && command.documentId === "paper-two");
  assert.equal(h.tracker.getStatus().pausedReason, "idle");
  assert.equal(received.filter((command) => command.kind === "reading.session.activity" && command.sessionId === resumed.sessionId).length, 0);
  h.documentTarget.emit("wheel"); await h.tick();
  assert.equal(received.filter((command) => command.kind === "reading.session.activity" && command.sessionId === resumed.sessionId).reduce((total, command) => total + command.activeMs, 0), 15_000);
  h.tracker.dispose(); await h.tracker.flush();
});

test("leaving or disposing a deferred Reader cancels its restart after outbox recovery", async () => {
  for (const action of ["end", "dispose"]) {
    let connected = false;
    const received = [];
    const h = setup({ maxPending: 4, sendCommand: async (command) => {
      if (!connected) throw new Error("offline");
      received.push(command);
    } });
    h.start(); await h.tick(); h.tracker.end("leave"); await h.tracker.flush();
    h.start("paper-two"); h.tracker[action]();
    connected = true; await h.tracker.flush(); await h.tick();
    assert.equal(h.tracker.getStatus().sessionId, null);
    assert.equal(h.tracker.getStatus().documentId, null);
    assert.equal(received.some((command) => command.kind === "reading.session.start" && command.documentId === "paper-two"), false);
    assert.equal(h.timers.size, 0);
    h.tracker.dispose();
  }
});

test("the newest Reader replaces an earlier deferred start without opening the stale article", async () => {
  let connected = false;
  const received = [];
  const h = setup({ maxPending: 4, sendCommand: async (command) => {
    if (!connected) throw new Error("offline");
    received.push(command);
  } });
  h.start(); await h.tick(); h.tracker.end("leave"); await h.tracker.flush();
  h.start("paper-two"); h.start("paper-three");
  connected = true; await h.tracker.flush();
  assert.equal(received.some((command) => command.kind === "reading.session.start" && command.documentId === "paper-two"), false);
  assert.equal(h.tracker.getStatus().documentId, "paper-three");
  h.tracker.dispose(); await h.tracker.flush();
});
