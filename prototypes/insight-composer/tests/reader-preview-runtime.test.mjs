import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryStorage, createPreviewReaderRuntime, defaultReaderRuntime } from "../src/reader-runtime.js";
import { getReadingPreferences } from "../src/reading-preferences.js";
import { getUiScale } from "../src/ui-scale.js";
import { visiblePreviewImages, waitForInitialPreviewRender } from "../src/reader-preview-ready.js";

function replaceGlobals(values) {
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => { for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; };
}

test("preview runtime edits every preference surface without browser storage or network writes", async () => {
  const calls = [], storage = { getItem: (key) => { calls.push(["get", key]); return null; }, setItem: (key) => calls.push(["set", key]), removeItem: (key) => calls.push(["remove", key]) };
  const restore = replaceGlobals({ localStorage: storage, sessionStorage: storage, fetch: () => { calls.push(["fetch"]); throw new Error("Unexpected network request"); } });
  try {
    const preview = createPreviewReaderRuntime("preview-a"), second = createPreviewReaderRuntime("preview-b");
    let changes = 0;
    const unsubscribe = preview.reading.subscribe(() => changes++);
    preview.reading.update({ fontSize: 24, readingWidthPercent: 100 });
    preview.uiScale.update(120); preview.pdfWidth.update(640);
    preview.view.save({ tocMode: "collapsed", translationFirst: true, showMargins: false });
    assert.equal(preview.shortcuts.update("settings", "Mod+;"), "");
    preview.palette.update({ presetId: "mist" });
    preview.sessionStorage.setItem("reader-draft:preview-a", "draft");
    const sync = preview.objects.createSync({ documentId: "doc-a", documentRevision: 1 });
    const stop = sync.start(); sync.update("table-one", { widthPercent: 145, fontSize: 27 }); await sync.sync(); stop();
    assert.deepEqual(sync.getSnapshot().objects["table-one"], { widthPercent: 145, fontSize: 27 });
    assert.equal(sync.getSnapshot().status, null, "temporary object changes must not claim a server save");
    assert.equal(preview.objects.createSync({ documentId: "doc-a", documentRevision: 2 }), sync, "live candidates retain temporary per-object preferences");
    assert.equal(changes, 1); unsubscribe();
    assert.equal(preview.uiScale.getSnapshot().percent, 120); assert.equal(preview.pdfWidth.getSnapshot(), 640);
    assert.equal(preview.view.read().translationFirst, true); assert.equal(preview.palette.getSnapshot().presetId, "mist");
    assert.equal(preview.capabilities.glossary, false); assert.equal(preview.capabilities.insightWrites, false);
    assert.equal(second.reading.getSnapshot().fontSize, 20); assert.equal(second.uiScale.getSnapshot().percent, 80);
    assert.equal(second.sessionStorage.getItem("reader-draft:preview-a"), null);
    assert.deepEqual(calls, []);
  } finally { restore(); }
});

test("workspace runtime delegates to existing stores and memory storage follows browser value semantics", () => {
  assert.equal(defaultReaderRuntime.reading.getSnapshot, getReadingPreferences);
  assert.equal(defaultReaderRuntime.uiScale.getSnapshot, getUiScale);
  assert.equal(defaultReaderRuntime.capabilities.glossary, true); assert.equal(defaultReaderRuntime.objects.externalStorage, true);
  const memory = createMemoryStorage(); memory.setItem(1, 42);
  assert.equal(memory.getItem("1"), "42"); assert.equal(memory.key(0), "1"); assert.equal(memory.length, 1);
  memory.removeItem(1); assert.equal(memory.getItem("1"), null);
});

test("preview readiness checks visible image decoding without claiming offscreen coverage", async () => {
  let decoded = 0;
  const img = (top, width = 200, valid = true) => ({ complete: true, naturalWidth: valid ? 200 : 0, decode: async () => decoded++, removeEventListener() {},
    getClientRects: () => width ? [{}] : [], getBoundingClientRect: () => ({ top, bottom: top + 100, left: 10, right: 10 + width, width, height: 100 }) });
  const images = [img(120), img(1200), img(150, 0)];
  const root = { querySelectorAll: () => images, querySelector: () => ({ getBoundingClientRect: () => ({ width: 900, height: 2400 }) }) };
  const restore = replaceGlobals({ window: { innerHeight: 900, innerWidth: 1440 }, document: { fonts: { ready: Promise.resolve() } }, requestAnimationFrame: (callback) => setTimeout(callback, 0) });
  try {
    assert.equal(visiblePreviewImages(root).length, 1);
    assert.deepEqual(await waitForInitialPreviewRender(root), { scope: "initial-viewport", imageCount: 1 });
    assert.equal(decoded, 1);
    images[0] = img(120, 200, false);
    await assert.rejects(waitForInitialPreviewRender(root), /无法解码/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(waitForInitialPreviewRender(root, aborted.signal), { name: "AbortError" });
  } finally { restore(); }
});
