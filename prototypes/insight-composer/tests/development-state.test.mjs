import assert from "node:assert/strict";
import test from "node:test";
import { createReadingCheckpointQueue } from "../src/reading-checkpoints.js";
import {
  developmentReadingState, installDevelopmentState, persistDevelopmentEntry,
  restoreDevelopmentEntry, sameDevelopmentCheckpoint, snapshotDevelopmentState,
  verifyDevelopmentCheckpoint,
} from "../src/development-state.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    snapshot: () => Object.fromEntries(values),
  };
}

function windowStub({ storage = memoryStorage(), url = "reader://app/?document=paper#S3", state = null, development = true } = {}) {
  const target = new EventTarget();
  target.CustomEvent = CustomEvent;
  target.sessionStorage = storage;
  target.location = { href: url };
  target.history = { state, replaceState(value) { this.state = structuredClone(value); } };
  target.errors = [];
  target.console = { error: (...args) => target.errors.push(args) };
  target.disk = [];
  target.continuousReaderDesktop = { development, persistSessionNow() {
    target.disk.push(storage.snapshot());
    return { ok: true };
  } };
  return target;
}

function hotStub() {
  const listeners = new Map();
  let dispose;
  return {
    data: {},
    on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    off(name, callback) { listeners.get(name)?.delete(callback); },
    dispose(callback) { dispose = callback; },
    emit(name, data) { return [...listeners.get(name) || []].map((callback) => callback(data)); },
    count(name) { return listeners.get(name)?.size || 0; },
    unloadModule() { dispose?.(); },
  };
}

const oldPosition = { documentId: "paper", revision: 2, blockId: "S1", offsetRatio: 0, mode: "source", targetLanguage: "zh-CN", translationFirst: false };
const latestPosition = { ...oldPosition, blockId: "S3", offsetRatio: 0.42, mode: "bilingual" };

test("production and ordinary browser windows do not install HMR persistence", () => {
  for (const development of [false, undefined]) {
    const target = windowStub({ development: false });
    target.continuousReaderDesktop.development = development;
    target.sessionStorage.getItem = () => { throw new Error("must not read browser state"); };
    const hot = hotStub();
    const stop = installDevelopmentState(hot, target);
    hot.emit("vite:beforeFullReload", {});
    target.dispatchEvent(new Event("beforeunload"));
    assert.equal(hot.count("vite:beforeFullReload"), 0);
    assert.equal(target.disk.length, 0);
    assert.equal(target.errors.length, 0);
    stop();
  }
});

test("JS updates synchronously snapshot local state once, CSS updates do not, and disposal removes every listener", () => {
  const target = windowStub();
  const hot = hotStub();
  const reasons = [];
  target.addEventListener("continuous-reader:flush", (event) => {
    reasons.push(event.detail.reason);
    assert.equal(event.detail.enqueueOnly, true);
    target.sessionStorage.setItem("reader-draft:paper", JSON.stringify({ body: "latest typed draft" }));
  });
  const previousStop = installDevelopmentState(hot, target);
  installDevelopmentState(hot, target);
  previousStop();
  assert.equal(hot.count("vite:beforeUpdate"), 1);
  assert.equal(hot.count("vite:beforeFullReload"), 1);
  hot.emit("vite:beforeUpdate", { updates: [{ type: "css-update" }] });
  assert.equal(target.disk.length, 0);
  hot.emit("vite:beforeUpdate", { updates: [{ type: "js-update" }, { type: "js-update" }] });
  assert.deepEqual(reasons, ["update"]);
  assert.equal(JSON.parse(target.disk[0]["reader-draft:paper"]).body, "latest typed draft");
  hot.emit("vite:beforeFullReload", {});
  target.dispatchEvent(new Event("beforeunload"));
  assert.deepEqual(reasons, ["update", "full-reload", "beforeunload"]);
  hot.unloadModule();
  hot.emit("vite:beforeFullReload", {});
  target.dispatchEvent(new Event("beforeunload"));
  assert.equal(target.disk.length, 3);
  assert.equal(hot.count("vite:beforeUpdate"), 0);
  assert.equal(hot.count("vite:beforeFullReload"), 0);
});

test("an offline full reload restores draft, current entry, view state and the original in-flight checkpoint identity", async () => {
  const storage = memoryStorage();
  const sentBeforeReload = [];
  const queue = createReadingCheckpointQueue({ storage, createId: () => "original-request", send: async (command) => {
    sentBeforeReload.push(command);
    throw new Error("offline after server may have committed");
  } });
  queue.enqueue("paper", oldPosition);
  assert.equal((await queue.flush()).pending, 1);
  const target = windowStub({ storage, state: {
    readerEntryKey: "reader-entry", readerPosition: oldPosition,
    readerTrail: [{ route: { page: "reader", documentId: "source-paper" }, readingState: { blockId: "S2" } }],
  } });
  const draft = { clientIntentId: "draft-intent", id: null, body: "unsaved after last render" };
  const views = { collection: { query: "transformer", selectedId: "paper", listScrollTop: 214 },
    flow: { section: "overview", overviewScrollTop: 121, overviewPlanScrollTop: 82, overviewReviewScrollTop: 64, selectedInsightId: "note-1" }, navigationExpanded: false };
  target.addEventListener("continuous-reader:flush", (event) => {
    storage.setItem("reader-draft:paper", JSON.stringify(draft));
    storage.setItem("continuous-reader:views", JSON.stringify(views));
    target.history.replaceState({ ...target.history.state, readerPosition: latestPosition });
    queue.enqueue("paper", latestPosition);
    verifyDevelopmentCheckpoint(storage, "paper", queue.position("paper"));
    assert.equal(event.detail.enqueueOnly, true);
  });
  const result = snapshotDevelopmentState(target, "full-reload");
  assert.equal(result.ok, true);
  assert.equal(sentBeforeReload.length, 1, "snapshot must not start a save command");
  const reloadedStorage = memoryStorage(target.disk.at(-1));
  const reopened = windowStub({ storage: reloadedStorage });
  installDevelopmentState(hotStub(), reopened);
  assert.equal(reopened.history.state.readerEntryKey, "reader-entry");
  assert.equal(reopened.history.state.readerTrail[0].route.documentId, "source-paper");
  assert.deepEqual(developmentReadingState(reopened.history.state, "paper", 2, oldPosition), latestPosition);
  assert.deepEqual(JSON.parse(reloadedStorage.getItem("reader-draft:paper")), draft);
  assert.deepEqual(JSON.parse(reloadedStorage.getItem("continuous-reader:views")), views);
  const sentAfterReload = [];
  const restoredQueue = createReadingCheckpointQueue({ storage: reloadedStorage, createId: () => "latest-request", send: async (command) => { sentAfterReload.push(command); } });
  assert.deepEqual(restoredQueue.position("paper"), latestPosition);
  assert.equal((await restoredQueue.flush()).pending, 0);
  assert.deepEqual(sentAfterReload.map((command) => command.requestId), ["original-request", "latest-request"]);
  assert.deepEqual(sentAfterReload[0], sentBeforeReload[0]);
  assert.deepEqual(sentAfterReload[1].readingState, latestPosition);
});

test("entry restoration requires the exact URL and never replaces existing browser history", () => {
  const target = windowStub({ state: { readerEntryKey: "old-entry", readerPosition: latestPosition } });
  persistDevelopmentEntry(target);
  for (const url of ["reader://app/?view=collection", "reader://app/?document=other#S3", "reader://app/?document=paper#S4"]) {
    const different = windowStub({ storage: target.sessionStorage, url });
    assert.equal(restoreDevelopmentEntry(different), false);
    assert.equal(different.history.state, null);
  }
  const same = windowStub({ storage: target.sessionStorage, state: { readerEntryKey: "current-entry" } });
  assert.equal(restoreDevelopmentEntry(same), false);
  assert.equal(same.history.state.readerEntryKey, "current-entry");
  target.sessionStorage.setItem("continuous-reader:development-entry:v1", "{invalid");
  const invalid = windowStub({ storage: target.sessionStorage });
  assert.doesNotThrow(() => installDevelopmentState(hotStub(), invalid));
  assert.equal(invalid.errors.length, 1);
});

test("component remount reads the newest matching entry while other documents or revisions keep their requested position", () => {
  assert.deepEqual(developmentReadingState({ readerPosition: latestPosition }, "paper", 2, oldPosition), latestPosition);
  assert.equal(developmentReadingState({ readerPosition: latestPosition }, "paper", 3, oldPosition), oldPosition);
  assert.equal(developmentReadingState({ readerPosition: latestPosition }, "other", 2, oldPosition), oldPosition);
  assert.equal(developmentReadingState({ readerPosition: { ...latestPosition, blockId: null } }, "paper", 2, oldPosition), oldPosition);
  assert.equal(sameDevelopmentCheckpoint(structuredClone(latestPosition), latestPosition), true);
  assert.equal(sameDevelopmentCheckpoint(oldPosition, latestPosition), false);
});

test("a swallowed queue storage failure is reported even when the desktop session write succeeds", () => {
  const storage = memoryStorage();
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === "continuous-reader:reading-checkpoints:v1") throw new Error("quota exceeded");
    setItem(key, value);
  };
  const queue = createReadingCheckpointQueue({ storage, send: () => { throw new Error("snapshot must not send"); } });
  const target = windowStub({ storage });
  target.addEventListener("continuous-reader:flush", (event) => {
    queue.enqueue("paper", latestPosition);
    try { verifyDevelopmentCheckpoint(storage, "paper", queue.position("paper")); }
    catch (error) { event.detail.errors.push(error); }
  });
  const result = snapshotDevelopmentState(target, "update");
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /待同步队列/);
  assert.equal(target.disk.length, 1, "other recoverable state is still copied to disk");
  assert.equal(target.errors.length, 1);
});

test("view and disk persistence errors remain explicit rather than claiming Vite reload was cancelled", () => {
  const target = windowStub();
  target.addEventListener("continuous-reader:flush", (event) => { event.detail.errors.push(new Error("view storage unavailable")); });
  target.continuousReaderDesktop.persistSessionNow = () => { throw new Error("disk full"); };
  const result = snapshotDevelopmentState(target, "before-close");
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.message), ["view storage unavailable", "disk full"]);
  assert.match(target.errors[0][0], /Vite 仍可能继续刷新/);
});
