import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createReaderViewStore, normalizeReaderView, READER_VIEW_KEY } from "../src/reader-view-preferences.js";
import { contentVariants } from "../src/reading-language.js";
import { HTML_PROFILE, prepareReaderDocument } from "../src/html-content.js";

function storage(initial) {
  const values = new Map(initial === undefined ? [] : [[READER_VIEW_KEY, JSON.stringify(initial)]]);
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), clear: () => values.clear() };
}
function target(localStorage) {
  const listeners = new Set();
  return { localStorage, addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener),
    emit: (event) => { for (const listener of listeners) listener(event); }, listenerCount: () => listeners.size };
}

test("bilingual order defaults to source first and preserves both saved choices", () => {
  assert.equal(normalizeReaderView().translationFirst, false);
  for (const translationFirst of [false, true]) {
    const data = storage({ translationFirst, targetLanguage: "fr", tocMode: "collapsed", showMargins: false });
    const store = createReaderViewStore({ storage: data, windowTarget: null });
    assert.equal(store.read().translationFirst, translationFirst);
    store.save({ ...store.read(), translationFirst: !translationFirst });
    const reloaded = createReaderViewStore({ storage: data, windowTarget: null });
    assert.equal(reloaded.read().translationFirst, !translationFirst);
    assert.equal(reloaded.read().targetLanguage, "fr");
    assert.equal(reloaded.read().tocMode, "collapsed");
    assert.equal(reloaded.read().showMargins, false);
    store.dispose(); reloaded.dispose();
  }
});

test("shared view changes notify mounted settings and Reader subscribers once without feedback writes", () => {
  const data = storage(), store = createReaderViewStore({ storage: data, windowTarget: null });
  let writes = 0, readerChanges = 0, settingsChanges = 0;
  const write = data.setItem; data.setItem = (...args) => { writes++; write(...args); };
  const unsubscribeReader = store.subscribe(() => { readerChanges++; store.save(store.read()); });
  const unsubscribeSettings = store.subscribe(() => settingsChanges++);
  store.save({ ...store.read(), translationFirst: true });
  assert.deepEqual([writes, readerChanges, settingsChanges], [1, 1, 1]);
  store.save({ ...store.read(), translationFirst: false });
  assert.deepEqual([writes, readerChanges, settingsChanges], [2, 2, 2]);
  unsubscribeReader(); unsubscribeSettings(); store.dispose();
});

test("same-origin updates and clearing synchronize bilingual order without changing unrelated storage", () => {
  const data = storage(), windowTarget = target(data), store = createReaderViewStore({ windowTarget });
  let changes = 0; store.subscribe(() => changes++);
  data.setItem(READER_VIEW_KEY, JSON.stringify({ translationFirst: true, showMargins: false }));
  windowTarget.emit({ key: "another-key", storageArea: data });
  windowTarget.emit({ key: READER_VIEW_KEY, storageArea: storage() });
  assert.equal(store.read().translationFirst, false);
  windowTarget.emit({ key: READER_VIEW_KEY, storageArea: data });
  assert.equal(store.read().translationFirst, true);
  assert.equal(store.read().showMargins, false);
  windowTarget.emit({ key: READER_VIEW_KEY, storageArea: data });
  assert.equal(changes, 1);
  data.clear(); windowTarget.emit({ key: null, storageArea: data });
  assert.equal(store.read().translationFirst, false);
  assert.equal(changes, 2);
  store.dispose(); assert.equal(windowTarget.listenerCount(), 0);
});

test("failed persistence retains the current shared choice and can retry without duplicate notifications", () => {
  const data = storage(); let blocked = true;
  const write = data.setItem;
  data.setItem = (...args) => { if (blocked) throw new Error("QuotaExceededError"); write(...args); };
  const store = createReaderViewStore({ storage: data, windowTarget: null });
  let changes = 0; store.subscribe(() => changes++);
  store.save({ ...store.read(), translationFirst: true, showMargins: false });
  assert.equal(store.read().translationFirst, true);
  assert.equal(data.getItem(READER_VIEW_KEY), null);
  blocked = false; store.save(store.read());
  assert.equal(JSON.parse(data.getItem(READER_VIEW_KEY)).translationFirst, true);
  assert.equal(changes, 1); store.dispose();
});

test("order affects bilingual content only and untranslated content retains its source identity", () => {
  const translated = { text: "Original", translations: { "zh-CN": { text: "译文" } } };
  assert.deepEqual(contentVariants(translated, "text", "bilingual", "zh-CN"), ["source", "zh-CN"]);
  assert.deepEqual(contentVariants(translated, "text", "bilingual", "zh-CN", true), ["zh-CN", "source"]);
  for (const translationFirst of [false, true]) {
    assert.deepEqual(contentVariants(translated, "text", "source", "zh-CN", translationFirst), ["source"]);
    assert.deepEqual(contentVariants(translated, "text", "translation", "zh-CN", translationFirst), ["zh-CN"]);
    assert.deepEqual(contentVariants(translated, "text", "bilingual", "fr", translationFirst), ["source"]);
  }
});

test("real renderer consistently orders standard and semantic HTML blocks while retaining source addresses", async () => {
  const [{ createServer }, { createElement }, { renderToStaticMarkup }] = await Promise.all([import("vite"), import("react"), import("react-dom/server")]);
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, watch: null, hmr: false }, appType: "custom" });
  try {
    const { PaperArticle } = await server.ssrLoadModule("/src/PaperArticle.jsx");
    const paper = await prepareReaderDocument({ format: "continous-reader", schema: 2, id: "order-test", revision: 1,
      meta: { title: "Title", language: "en" }, blocks: [
        { id: "heading", type: "heading", level: 1, text: "Original heading", translations: { "zh-CN": { text: "标题译文" } } },
        { id: "paragraph", type: "para", text: "Original paragraph", translations: { "zh-CN": { text: "段落译文" } } },
        { id: "list", type: "list", ordered: false, items: [{ id: "item", text: "Original item", translations: { "zh-CN": { text: "条目译文" } } }] },
        { id: "table", type: "table", head: [["Original header"]], rows: [["Original cell"]], translations: { "zh-CN": { head: [["表头译文"]], rows: [["单元格译文"]] } } },
        { id: "html", type: "html", html_profile: HTML_PROFILE, html: '<p data-node-id="sentence">Original HTML</p>', translations: { "zh-CN": { html: '<p data-node-id="sentence">HTML 译文</p>' } } },
      ] });
    assert.ok(!paper.blocks.at(-1).compiledHtml.error);
    const original = JSON.stringify(paper);
    const addresses = [];
    for (const translationFirst of [false, true]) {
      const markup = renderToStaticMarkup(createElement(PaperArticle, { paper, mode: "bilingual", targetLanguage: "zh-CN", translationFirst, notes: [], equation: () => null }));
      const entries = [...markup.matchAll(/data-block-id="([^"]+)" data-variant="([^"]+)" data-field="([^"]+)"/g)].map((match) => match.slice(1));
      const order = translationFirst ? ["zh-CN", "source"] : ["source", "zh-CN"];
      for (const blockId of ["heading", "paragraph", "list", "table", "html"]) {
        assert.deepEqual(entries.filter(([id]) => id === blockId).slice(0, 2).map(([, variant]) => variant), order, blockId);
      }
      assert.match(markup, /data-item-id="item"/); assert.match(markup, /data-node-id="sentence"/);
      addresses.push(entries.map((entry) => entry.join(":")).sort());
    }
    assert.deepEqual(addresses[0], addresses[1]);
    assert.equal(JSON.stringify(paper), original);
  } finally { await server.close(); }
});
