import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createServer as createPortProbe } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceServer } from "../../../services/workspace/server.mjs";
import { publishAuthoringFixture } from "../../../services/workspace/tests/authoring-fixture.mjs";
import { createServer } from "../node_modules/vite/dist/node/index.js";

// All writes go to a freshly created synthetic workspace; neither the desktop
// profile nor the normal development service is contacted by this runner.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const frontend = resolve(root, "prototypes/insight-composer");
const output = resolve(root, ".audit/article-notes");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_TEST_NODE_MODULES
  ? resolve(process.env.READER_TEST_NODE_MODULES, "playwright")
  : "playwright");
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(resolve(output, "browser-data-"));
const server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false, authToken: "" });
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const backend = `http://127.0.0.1:${server.address().port}`;
// Vite treats configuration port 0 as its default, so allocate an ephemeral
// candidate explicitly and use strictPort rather than ever taking over 5173.
const portProbe = createPortProbe();
await new Promise((done) => portProbe.listen(0, "127.0.0.1", done));
const frontendPort = portProbe.address().port;
await new Promise((done) => portProbe.close(done));
process.env.WORKSPACE_API_URL = backend;
const { default: config } = await import("../vite.config.mjs");
const vite = await createServer({ ...config, configFile: false, root: frontend, clearScreen: false,
  server: { ...config.server, host: "127.0.0.1", port: frontendPort, strictPort: true, open: false,
    // This local proxy owns the frontend requests, just as the desktop bridge
    // does. Its upstream Origin is its own loopback endpoint.
    proxy: Object.fromEntries(["/api", "/mcp", "/health"].map((path) => [path, { target: backend, changeOrigin: true, headers: { Origin: backend } }])),
  },
});
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.READER_TEST_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "zh-CN" });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const evidence = { dataDir, origin, desktop: "Browser exercises desktop CSS reservation; native Electron controls are not simulated", checks: [], pageErrors: [] };
const commands = [], blockedMedia = [];
page.on("pageerror", (error) => evidence.pageErrors.push(error.message));
page.on("request", (request) => {
  if (new URL(request.url()).pathname === "/api/commands" && request.method() === "POST") commands.push(request.postDataJSON());
  if (new URL(request.url()).hostname === "notes.invalid") blockedMedia.push(request.url());
});
page.on("response", async (response) => {
  if (response.status() < 400 || !new URL(response.url()).pathname.startsWith("/api/")) return;
  try { (evidence.httpErrors ||= []).push({ status: response.status(), path: new URL(response.url()).pathname, response: await response.json() }); } catch {}
});
const check = (name, detail) => { evidence.checks.push({ name, passed: true, ...(detail ? { detail } : {}) }); console.log("PASS " + name); };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function request(path, body) {
  const response = await fetch(backend + path, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result)); return result;
}
const command = (input) => request("/api/commands", { requestId: randomUUID(), ...input });
const envelope = (id) => request("/api/documents/" + encodeURIComponent(id));
const savedNotes = async (id) => (await envelope(id)).insights.filter((item) => item.type === "note" && !item.archivedAt);
async function waitSaved(id, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const notes = await savedNotes(id);
    const found = notes.find(predicate);
    if (found) return found;
    await pause(100);
  }
  throw new Error("Saved note was not observed");
}
async function author(title) {
  return publishAuthoringFixture({ base: backend, authoring: { format: "reader-authoring-1", key: title.replaceAll(" ", "-"), meta: { title, language: "en" }, blocks: [
    { key: "title", type: "heading", level: 1, text: title },
    ...Array.from({ length: 36 }, (_, index) => ({ key: `paragraph-${index}`, type: "para", text: `Paragraph ${index + 1}. A reading workspace should preserve source identities and deliberate user choices. A note can be revised independently of its source. `.repeat(3) })),
  ] } });
}
const editor = () => page.getByRole("textbox", { name: "笔记正文", exact: true });
const editorDocument = () => page.evaluate(async () => {
  const { EditorView } = await import("/node_modules/@codemirror/view/dist/index.js");
  return EditorView.findFromDOM(document.querySelector(".cm-content"))?.state.doc.toString();
});
async function replaceBody(body) { await editor().click(); await page.keyboard.press("Control+a"); await page.keyboard.insertText(body); }
async function openNotes() { await page.getByRole("button", { name: "文章笔记", exact: true }).click(); await page.waitForURL((url) => url.searchParams.get("view") === "notes"); await editor().waitFor(); }
async function newNote(title, body) {
  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  await page.getByRole("textbox", { name: "笔记标题", exact: true }).fill(title);
  await replaceBody(body);
}
async function selectNote(title) { await page.locator(".article-notes-list").getByRole("button").filter({ hasText: title }).first().click(); await page.locator(".note-editor").waitFor(); }

try {
  const first = await author("Notes fixture: reading and writing");
  const second = await author("A different article");
  const id = first.document.id;
  const anchor = first.blockIds["paragraph-18"];
  const sourceNote = (await command({ kind: "insight.save", documentId: id, insight: { type: "note", title: "Source-linked note", body: "A retained source note.", color: "amber", blockId: anchor, variant: "source", field: "text", quote: "Paragraph 19.", start: 0, end: 13, revision: 1 } })).insight;
  await command({ kind: "insight.save", documentId: id, insight: { type: "note", title: "Whole article note", body: "A note for the entire article.", color: "amber" } });
  await command({ kind: "insight.save", documentId: id, insight: { type: "question", body: "Not a note", color: "amber" } });
  await command({ kind: "insight.save", documentId: second.document.id, insight: { type: "note", title: "Other article secret", body: "Only the second article.", color: "amber" } });

  await page.goto(`${origin}/?document=${encodeURIComponent(id)}`);
  await page.getByRole("button", { name: "文章笔记", exact: true }).waitFor();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".article").evaluate((article, blockId) => article.querySelector(`[id="${blockId}"]`).scrollIntoView(), anchor);
  await pause(700);
  const beforeY = await page.evaluate(() => window.scrollY);
  await page.locator(".article").focus();
  await page.keyboard.press("r");
  await page.getByRole("textbox", { name: "请求内容", exact: true }).fill("Keep this Reader request draft while writing notes.");
  await openNotes();
  assert.equal(await page.getByText("Other article secret", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Not a note", { exact: true }).count(), 0);
  const startsInNotes = commands.filter((item) => item.kind === "reading.session.start").length;
  check("Reader topbar opens only the current article's notes");

  await selectNote("Source-linked note");
  const body = "# Reading notes\n\nA **careful** synthesis with 中文内容.\n\n- Stable source\n- Independent editing\n\n> A useful quoted idea.\n\n```js\nconst preserved = true;\n```\n\n![Reference illustration](https://notes.invalid/tracker.png)\n\n<script>window.noteScriptExecuted = true</script>";
  await replaceBody(body);
  await page.keyboard.press("Control+s");
  const saved = await waitSaved(id, (note) => note.id === sourceNote.id && note.body === body);
  assert.equal(saved.reference, sourceNote.reference);
  assert.equal(saved.blockId, sourceNote.blockId);
  assert.equal(saved.quote, sourceNote.quote);
  assert.ok(saved.version > sourceNote.version);
  await page.getByRole("tab", { name: "预览", exact: true }).click();
  await page.getByRole("heading", { name: "Reading notes", exact: true }).waitFor();
  assert.equal(await page.locator(".note-editor-preview strong").textContent(), "careful");
  assert.equal(await page.locator(".note-editor-preview ul").evaluate((element) => getComputedStyle(element).listStyleType), "disc");
  assert.equal(await page.locator(".note-editor-preview img, .note-editor-preview script").count(), 0);
  assert.deepEqual(blockedMedia, []);
  assert.equal(await page.evaluate(() => window.noteScriptExecuted), undefined);
  await page.screenshot({ path: resolve(output, "notes-preview.png") });
  await page.getByRole("tab", { name: "编辑", exact: true }).click();
  check("Editing and Markdown preview preserve a note's identity, version and source");

  const longBody = "# A continuous document\n\n" + "Long-form 中文笔记. Each paragraph remains editable and persists locally.\n\n".repeat(240);
  await newNote("Long document", longBody);
  const longSaved = await waitSaved(id, (note) => note.title === "Long document" && note.body === longBody);
  await newNote("Second independent note", "A second note for the same paper.");
  await waitSaved(id, (note) => note.title === "Second independent note");
  await editor().click(); await page.keyboard.press("Control+End"); await page.keyboard.insertText(" 中文撤销检查");
  await page.getByRole("tab", { name: "预览", exact: true }).click();
  await page.getByRole("tab", { name: "编辑", exact: true }).click();
  await editor().focus(); await page.keyboard.press("Control+z");
  assert.equal(await editor().textContent(), "A second note for the same paper.");
  await page.keyboard.press("Control+s");
  check("Chinese text entry and undo survive the edit/preview switch");
  await selectNote("Long document");
  await page.reload(); await editor().waitFor();
  assert.equal((await savedNotes(id)).find((note) => note.id === longSaved.id).body, longBody);
  assert.equal(await editorDocument(), longBody, "The same long note must be selected and complete in the editor after reload");
  await page.locator(".cm-scroller").evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
  await pause(150);
  const editScroll = await page.locator(".cm-scroller").evaluate((element) => element.scrollTop);
  assert.ok(editScroll > 1000);
  await selectNote("Second independent note");
  await selectNote("Long document"); await pause(150);
  assert.equal(await page.getByRole("tab", { name: "编辑", exact: true }).getAttribute("aria-selected"), "true");
  const restoredEditScroll = await page.locator(".cm-scroller").evaluate((element) => element.scrollTop);
  assert.ok(Math.abs(restoredEditScroll - editScroll) < 4, `Editor scroll ${editScroll} -> ${restoredEditScroll}`);
  await page.getByRole("tab", { name: "预览", exact: true }).click();
  await page.locator(".note-editor-preview").evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
  await pause(150);
  const previewScroll = await page.locator(".note-editor-preview").evaluate((element) => element.scrollTop);
  assert.ok(previewScroll > 1000);
  await selectNote("Second independent note");
  await selectNote("Long document"); await pause(150);
  assert.equal(await page.getByRole("tab", { name: "预览", exact: true }).getAttribute("aria-selected"), "true");
  const restoredPreviewScroll = await page.locator(".note-editor-preview").evaluate((element) => element.scrollTop);
  assert.ok(Math.abs(restoredPreviewScroll - previewScroll) < 4, `Preview scroll ${previewScroll} -> ${restoredPreviewScroll}`);
  await page.getByRole("tab", { name: "编辑", exact: true }).click();
  await pause(100);
  assert.ok(Math.abs(await page.locator(".cm-scroller").evaluate((element) => element.scrollTop) - editScroll) < 4);
  check("Each long note restores independent editor and preview scroll positions and display mode", { editScroll, restoredEditScroll, previewScroll, restoredPreviewScroll });
  await selectNote("Second independent note");
  assert.equal(commands.filter((item) => item.kind === "reading.session.start").length, startsInNotes);
  check("Multiple long notes survive switching and reload; writing does not start reading activity", { characters: longBody.length });

  const removable = (await savedNotes(id)).find((note) => note.title === "Second independent note");
  await page.getByRole("button", { name: "移除笔记", exact: true }).click();
  await page.getByRole("button", { name: "撤销", exact: true }).waitFor();
  assert.equal((await savedNotes(id)).some((note) => note.id === removable.id), false);
  await selectNote("Whole article note");
  const secondRemovable = (await savedNotes(id)).find((note) => note.title === "Whole article note");
  await page.getByRole("button", { name: "移除笔记", exact: true }).click();
  await page.getByRole("button", { name: "撤销", exact: true }).waitFor();
  assert.equal((await savedNotes(id)).some((note) => note.id === secondRemovable.id), false);
  await page.reload(); await editor().waitFor();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  const secondRestored = await waitSaved(id, (note) => note.id === secondRemovable.id);
  assert.equal(secondRestored.reference, secondRemovable.reference);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  const restored = await waitSaved(id, (note) => note.id === removable.id);
  assert.equal(restored.reference, removable.reference);
  check("Consecutive archives and undo survive reload while preserving both note identities");

  let loseResponse = true;
  const unknownRequests = [];
  const unknown = async (route) => {
    const input = route.request().postDataJSON();
    if (input.kind === "insight.save" && input.insight?.title === "Unknown response") {
      unknownRequests.push(input);
      if (loseResponse) { loseResponse = false; await route.fetch(); await route.abort("failed"); return; }
    }
    await route.continue();
  };
  await page.route("**/api/commands", unknown);
  await newNote("Unknown response", "The first save is committed even if its response disappears.");
  await waitSaved(id, (note) => note.title === "Unknown response");
  await page.getByRole("button", { name: "重试保存", exact: true }).waitFor();
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await page.getByRole("button", { name: "重试保存", exact: true }).waitFor({ state: "hidden" });
  await page.unroute("**/api/commands", unknown);
  assert.equal((await savedNotes(id)).filter((note) => note.title === "Unknown response").length, 1);
  assert.ok(unknownRequests.length >= 2);
  assert.equal(unknownRequests[0].requestId, unknownRequests[1].requestId);
  const rowIds = await page.locator(".article-note-row[data-note-id]").evaluateAll((rows) => rows.map((row) => row.dataset.noteId));
  assert.equal(new Set(rowIds).size, rowIds.length, "Confirmed notes must not appear twice after an unknown outcome");
  check("A committed save with a lost response retries the same request without duplicating the note");

  await selectNote("Source-linked note");
  const latest = (await savedNotes(id)).find((note) => note.id === sourceNote.id);
  const localConflict = "Local text must remain after the concurrent write.";
  await replaceBody(localConflict);
  await command({ kind: "insight.save", documentId: id, expectedVersion: latest.version, insight: { id: latest.id, body: "A newer version written elsewhere." } });
  await page.keyboard.press("Control+s");
  await page.getByRole("button", { name: "另存新笔记", exact: true }).waitFor();
  assert.ok((await editor().textContent()).includes(localConflict));
  assert.equal((await savedNotes(id)).find((note) => note.id === sourceNote.id).body, "A newer version written elsewhere.");
  await page.getByRole("button", { name: "另存新笔记", exact: true }).click();
  const copied = await waitSaved(id, (note) => note.id !== sourceNote.id && note.body === localConflict);
  assert.notEqual(copied.reference, sourceNote.reference);
  check("Concurrent edits preserve the current draft and require an explicit new note identity");

  await page.getByRole("button", { name: "返回文章", exact: true }).click();
  await page.locator(".article").waitFor();
  await pause(350);
  const afterY = await page.evaluate(() => window.scrollY);
  assert.ok(Math.abs(afterY - beforeY) < 12, `reading position changed: ${beforeY} -> ${afterY}`);
  assert.equal(await page.getByRole("textbox", { name: "请求内容", exact: true }).inputValue(), "Keep this Reader request draft while writing notes.");
  check("Returning to Reader restores the original scroll position and independent request draft", { beforeY, afterY });

  const trail = [{ route: { page: "reader", documentId: second.document.id }, title: "A different article",
    readingState: { documentId: second.document.id, revision: 1, blockId: second.blockIds["paragraph-2"], offsetRatio: 0.2, mode: "source" } }];
  await page.evaluate((readerTrail) => history.replaceState({ ...history.state, readerTrail }, ""), trail);
  await page.reload(); await page.locator(".article").waitFor();
  await page.locator(".article").evaluate((article, blockId) => article.querySelector(`[id="${blockId}"]`).scrollIntoView(), first.blockIds["paragraph-5"]);
  await pause(750);
  const originEntry = await page.evaluate(() => ({ state: history.state, scrollY }));
  await openNotes();
  const firstNotesEntry = await page.evaluate(() => history.state);
  assert.deepEqual(firstNotesEntry.notesReturn.trail, trail);
  await page.locator(`.article-note-row[data-note-id="${sourceNote.id}"]`).click();
  await page.getByRole("button", { name: "回到原文", exact: true }).click();
  await page.locator(".article").waitFor(); await pause(750);
  const sourceEntry = await page.evaluate(() => ({ state: history.state, scrollY }));
  assert.equal(sourceEntry.state.readerPosition.blockId, anchor);
  assert.deepEqual(sourceEntry.state.readerTrail, trail);
  await openNotes();
  const secondNotesEntry = await page.evaluate(() => history.state);
  const noteStarts = commands.filter((item) => item.kind === "reading.session.start").length;
  await pause(250);
  assert.equal(commands.filter((item) => item.kind === "reading.session.start").length, noteStarts);
  await page.goBack(); await page.locator(".article").waitFor(); await pause(250);
  assert.equal(await page.evaluate(() => history.state.readerPosition.blockId), sourceEntry.state.readerPosition.blockId);
  assert.deepEqual(await page.evaluate(() => history.state.readerTrail), trail);
  await page.goBack(); await editor().waitFor();
  assert.equal(await page.evaluate(() => history.state.notesReturn.readingState.blockId), firstNotesEntry.notesReturn.readingState.blockId);
  await page.goBack(); await page.locator(".article").waitFor(); await pause(250);
  const returnedEntry = await page.evaluate(() => ({ state: history.state, scrollY }));
  assert.equal(returnedEntry.state.readerPosition.blockId, originEntry.state.readerPosition.blockId);
  assert.deepEqual(returnedEntry.state.readerTrail, trail);
  assert.ok(Math.abs(returnedEntry.scrollY - originEntry.scrollY) < 12);
  await page.goForward(); await editor().waitFor();
  await page.goForward(); await page.locator(".article").waitFor(); await pause(250);
  assert.equal(await page.evaluate(() => history.state.readerPosition.blockId), sourceEntry.state.readerPosition.blockId);
  await page.goForward(); await editor().waitFor();
  assert.equal(await page.evaluate(() => history.state.notesReturn.readingState.blockId), secondNotesEntry.notesReturn.readingState.blockId);
  assert.deepEqual(await page.evaluate(() => history.state.notesReturn.trail), trail);
  check("Browser Back and Forward retain each Reader anchor and related-article trail across notes and source navigation");
  await page.getByRole("button", { name: "返回文章", exact: true }).click();
  await page.locator(".article").waitFor();

  await page.addInitScript(() => {
    window.continuousReaderDesktop = { platform: "win32", titleBarOverlay: true, setTitlebarHeight() {}, persistSession() {}, persistSessionNow: () => ({ ok: true }) };
    Object.defineProperty(navigator, "windowControlsOverlay", { configurable: true, value: { visible: true,
      getTitlebarAreaRect: () => ({ x: 0, y: 0, width: innerWidth - 138, height: 56 }), addEventListener() {}, removeEventListener() {} } });
  });
  await page.reload(); await page.getByRole("button", { name: "文章笔记", exact: true }).waitFor();
  const toolbar = await page.evaluate(() => {
    const modes = document.querySelector(".reader-mode-switch").getBoundingClientRect();
    const notes = document.querySelector(".notes-tool").getBoundingClientRect();
    const tools = document.querySelector(".reader-tools").getBoundingClientRect();
    return { modeCenter: modes.x + modes.width / 2, center: innerWidth / 2, notesRight: notes.right, toolsRight: tools.right,
      reserve: getComputedStyle(document.documentElement).getPropertyValue("--desktop-controls-width"), captionLeft: innerWidth - 138 };
  });
  assert.ok(Math.abs(toolbar.modeCenter - toolbar.center) < 2, JSON.stringify(toolbar));
  assert.ok(toolbar.notesRight <= toolbar.captionLeft, JSON.stringify(toolbar));
  assert.equal(toolbar.reserve, "138px");
  assert.ok(toolbar.toolsRight <= toolbar.captionLeft, JSON.stringify(toolbar));
  check("Reader modes remain window-centered and notes action clears the native caption reservation", toolbar);
  await openNotes();
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.evaluate(async () => { const { updateUiScale } = await import("/src/ui-scale.js"); updateUiScale(120); });
  await pause(250);
  const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
    settingsRight: document.querySelector('.article-notes-header [aria-label="设置"]').getBoundingClientRect().right,
    captionLeft: innerWidth - 138, editor: document.querySelector(".note-editor").getBoundingClientRect().toJSON() }));
  assert.ok(geometry.scrollWidth <= geometry.width + 1 && geometry.bodyWidth <= geometry.width + 1, JSON.stringify(geometry));
  assert.ok(geometry.editor.width > 350);
  assert.ok(geometry.settingsRight <= geometry.captionLeft, JSON.stringify(geometry));
  await page.screenshot({ path: resolve(output, "notes-1100-scale120.png") });
  check("Desktop notes layout fits 1100px at 120% interface scale and reduced motion", geometry);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(async () => { const { updateUiScale } = await import("/src/ui-scale.js"); updateUiScale(80); });
  await page.screenshot({ path: resolve(output, "notes-editor.png") });

  const finalBody = "# 核心思路\n\n先明确文章试图回答的问题，再区分作者提出的解释、实验支持的结论，以及仍需要验证的假设。阅读过程中保留疑问，比急于写出一个完整结论更有帮助。\n\n## 论证结构\n\n- **问题**：现有方法在哪些条件下失效？\n- **方法**：新的假设如何改变模型或实验设计？\n- **证据**：主要结果是否覆盖作者声称的适用范围？\n\n> 把结论与支持它的证据放在一起，回看时就不需要重新寻找论证的起点。\n\n## 后续问题\n\n1. 对照不同实验设置，确认提升来自哪个具体改变。\n2. 回到方法部分，检查关键假设是否与实际使用条件一致。\n3. 将仍不确定的地方整理为下一次阅读的问题。\n\n" + "## 延伸记录\n\n持续补充阅读时的观察，保留原始出处，并用自己的语言解释推理过程。新的证据可以改变结论，但不应抹去此前的疑问与判断依据。\n\n".repeat(30);
  await newNote("论证结构与后续问题", finalBody);
  const finalNote = await waitSaved(id, (note) => note.title === "论证结构与后续问题" && note.body === finalBody);
  await page.locator(`.article-note-row[data-note-id="${finalNote.id}"]`).scrollIntoViewIfNeeded();
  await page.getByRole("tab", { name: "预览", exact: true }).click();
  await page.locator(".note-editor-preview").evaluate((element) => { element.scrollTop = 0; });
  await pause(200);
  await page.screenshot({ path: resolve(output, "notes-final.png") });

  assert.deepEqual(evidence.pageErrors, []);
  check("No uncaught browser errors");
} catch (error) {
  evidence.error = error.stack;
  console.error(error);
  try { evidence.failure = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 4000), geometry: Object.fromEntries([".article-note-document", ".note-editor", ".note-editor-stage", ".note-editor-host", ".cm-content"].map((selector) => [selector, document.querySelector(selector)?.getBoundingClientRect().toJSON()])) })); } catch {}
  try { await page.screenshot({ path: resolve(output, "failure.png") }); } catch {}
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, "browser-checks.json"), JSON.stringify(evidence, null, 2));
  await browser.close(); await vite.close(); await server.shutdown();
}
