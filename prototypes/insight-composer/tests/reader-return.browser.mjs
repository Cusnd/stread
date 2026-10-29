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

// A disposable backend and browser profile keep every navigation and edit away
// from the user's actual library, insights, activity and desktop session.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const frontend = resolve(root, "prototypes/insight-composer");
const output = resolve(root, ".audit/reader-return");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_TEST_NODE_MODULES
  ? resolve(process.env.READER_TEST_NODE_MODULES, "playwright")
  : "playwright");
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(resolve(output, "browser-data-"));
const server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false, authToken: "" });
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const backend = `http://127.0.0.1:${server.address().port}`;
const probe = createPortProbe();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
process.env.WORKSPACE_API_URL = backend;
const { default: config } = await import("../vite.config.mjs");
const vite = await createServer({ ...config, configFile: false, root: frontend, clearScreen: false,
  server: { ...config.server, host: "127.0.0.1", port, strictPort: true, open: false,
    proxy: Object.fromEntries(["/api", "/mcp", "/health"].map((path) => [path, { target: backend, changeOrigin: true, headers: { Origin: backend } }])),
  },
});
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.READER_TEST_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const evidence = { dataDir, origin, checks: [], pageErrors: [], httpErrors: [] };
page.on("pageerror", (error) => evidence.pageErrors.push(error.message));
page.on("response", async (response) => {
  if (response.status() < 400 || !new URL(response.url()).pathname.startsWith("/api/")) return;
  evidence.httpErrors.push({ status: response.status(), path: new URL(response.url()).pathname });
});
const check = (name, detail) => { evidence.checks.push({ name, passed: true, ...(detail ? { detail } : {}) }); console.log("PASS " + name); };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function request(path, body) {
  const response = await fetch(backend + path, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
}
const command = (input) => request("/api/commands", { requestId: randomUUID(), ...input });
const readerBack = () => page.locator(".reader-back");
async function assertFlow(section) {
  await page.waitForURL((url) => url.searchParams.get("view") === "flow" && (url.searchParams.get("section") || "overview") === section);
  await page.locator(`.flow-scroll-${section}`).waitFor();
}
async function editSelected() {
  await page.locator(".flow-rail").getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("dialog", { name: "编辑洞见", exact: true }).waitFor();
}
async function openCollection() {
  await page.locator(".workspace-header").getByRole("link", { name: "Collection", exact: true }).click();
  await page.locator(".workspace-collection").waitFor();
}

try {
  const first = await publishAuthoringFixture({ base: backend, authoring: {
    format: "reader-authoring-1", key: "navigation-return-fixture", meta: { title: "Navigation return fixture", language: "en" }, blocks: [
      { key: "title", type: "heading", level: 1, text: "Navigation return fixture" },
      ...Array.from({ length: 28 }, (_, index) => ({ key: `paragraph-${index}`, type: "para", text: `Paragraph ${index + 1}. An insight retains its source and the workspace retains the place it was opened from. `.repeat(3) })),
    ],
  } });
  const id = first.document.id, blockId = first.blockIds["paragraph-8"];
  const opened = await command({ kind: "reading.open", documentId: id });
  await command({ kind: "document.update", documentId: id, expectedVersion: opened.record.version, patch: { status: "done" } });
  const second = await publishAuthoringFixture({ base: backend, authoring: {
    format: "reader-authoring-1", key: "collection-return-fixture", meta: { title: "Collection return fixture", language: "en" },
    blocks: [{ key: "paragraph", type: "para", text: "An unfinished article retains its Collection status filter and selection." }],
  } });
  await command({ kind: "reading.open", documentId: second.document.id });
  const notes = [];
  for (let index = 0; index < 24; index++) notes.push((await command({ kind: "insight.save", documentId: id, insight: {
    type: "annotation", title: `Navigation insight ${String(index).padStart(2, "0")}`, body: `Independent insight ${index}. Preserve the list filters, current selection, scroll and source when returning from the Reader.`,
    color: "amber", blockId, variant: "source", field: "text", quote: "Paragraph 9.", start: 0, end: 12, revision: 1,
  } })).insight);
  await command({ kind: "plan.add", documentId: id });
  await page.goto(origin + "/?view=flow&section=insights");
  await page.locator(".flow-insight-row").first().waitFor();
  await page.getByRole("group", { name: "洞见类型" }).getByRole("button", { name: "批注与高亮", exact: true }).click();
  await page.getByRole("searchbox", { name: "搜索洞见" }).fill("Navigation");
  await page.waitForFunction(() => document.querySelectorAll(".flow-insight-row").length === 24);
  const selected = notes[8];
  const selectedRow = () => page.locator(`[data-focus-key="flow-insight-${selected.id}"]`);
  await selectedRow().click();
  await page.locator(".flow-rail").getByRole("heading", { name: selected.title, exact: true }).waitFor();
  await pause(150);
  const scrollBefore = await page.locator(".flow-scroll-insights").evaluate((element) => element.scrollTop);
  assert.ok(scrollBefore > 300, `Long insight list should scroll, got ${scrollBefore}`);
  await page.screenshot({ path: resolve(output, "flow-before-edit.png") });
  await editSelected();
  const revisedBody = selected.body + " Edited from Flow.";
  await page.getByRole("textbox", { name: "洞见内容", exact: true }).fill(revisedBody);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.composer:not([inert])'));
  await readerBack().click();
  await assertFlow("insights");
  await selectedRow().waitFor();
  await pause(180);
  assert.equal(await selectedRow().getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("searchbox", { name: "搜索洞见" }).inputValue(), "Navigation");
  assert.equal(await page.getByRole("group", { name: "洞见类型" }).getByRole("button", { name: "批注与高亮", exact: true }).getAttribute("aria-pressed"), "true");
  const scrollAfter = await page.locator(".flow-scroll-insights").evaluate((element) => element.scrollTop);
  assert.ok(Math.abs(scrollAfter - scrollBefore) <= 3, `Scroll ${scrollBefore} -> ${scrollAfter}`);
  await page.locator(".flow-rail").getByText(revisedBody, { exact: true }).waitFor();
  const savedEnvelope = await request("/api/documents/" + encodeURIComponent(id));
  const saved = savedEnvelope.insights.find((item) => item.id === selected.id);
  assert.equal(saved.reference, selected.reference); assert.equal(saved.blockId, selected.blockId);
  assert.equal(savedEnvelope.record.status, "done", "Editing an insight must retain its article's completed status");
  await page.screenshot({ path: resolve(output, "flow-after-return.png") });
  check("Flow insight edit returns to the original filtered list, selected insight and scroll", { scrollBefore, scrollAfter });

  await editSelected();
  await page.reload();
  await readerBack().waitFor();
  await readerBack().click();
  await assertFlow("insights");
  assert.equal(await selectedRow().getAttribute("aria-pressed"), "true");
  check("Reloading the Reader retains its Flow return destination");

  // Opening notes in the middle of the journey must retain its outer workspace.
  await page.locator(".flow-detail-source").click();
  await readerBack().waitFor();
  await page.getByRole("button", { name: "文章笔记", exact: true }).click();
  await page.getByRole("button", { name: "返回文章", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "返回文章", exact: true }).click();
  await readerBack().waitFor(); await readerBack().click();
  await assertFlow("insights");
  check("Reader to notes and back, including reload, preserves the original Flow entry");

  await page.locator('[data-focus-key="flow-section-plan"]').click();
  await assertFlow("plan");
  await page.locator(".flow-plan-title").first().click();
  await readerBack().waitFor(); await readerBack().click();
  await assertFlow("plan");
  check("Reading from Flow's plan returns to that exact section");

  await openCollection();
  await page.getByRole("group", { name: "资料筛选" }).getByRole("button", { name: "已读", exact: true }).click();
  await page.locator(`[data-material-id="${id}"]`).waitFor();
  assert.equal(await page.locator(`[data-material-id="${id}"] .workspace-row-status`).textContent(), "已读");
  await page.screenshot({ path: resolve(output, "completed-after-insight-edit.png") });
  check("A completed article remains in Collection's 已读 filter after Flow edit and source/plan revisits");
  await page.getByRole("group", { name: "资料筛选" }).getByRole("button", { name: "在读", exact: true }).click();
  const material = page.locator(`[data-material-id="${second.document.id}"]`);
  await material.click(); await material.dblclick();
  await readerBack().waitFor(); await readerBack().click();
  await page.waitForURL((url) => url.searchParams.get("view") === "collection");
  await material.waitFor();
  assert.equal(await material.getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("group", { name: "资料筛选" }).getByRole("button", { name: "在读", exact: true }).getAttribute("aria-pressed"), "true");
  check("A fresh Collection entry replaces the older Flow origin and retains its status filter and selection");

  const direct = await context.newPage();
  direct.on("pageerror", (error) => evidence.pageErrors.push(error.message));
  await direct.goto(origin + "/?document=" + encodeURIComponent(id));
  await direct.locator(".reader-back").click();
  await direct.waitForURL((url) => url.searchParams.get("view") === "collection");
  await direct.locator(".workspace-collection").waitFor();
  await direct.close();
  check("A direct Reader link without a known origin falls back to Collection");
  assert.deepEqual(evidence.pageErrors, []); assert.deepEqual(evidence.httpErrors, []);
  check("No uncaught browser or API errors");
} catch (error) {
  evidence.error = error.stack; console.error(error);
  try { evidence.failure = await page.evaluate(() => ({ url: location.href, state: history.state, text: document.body.innerText.slice(0, 6000) })); } catch {}
  try { await page.screenshot({ path: resolve(output, "failure.png") }); } catch {}
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, "browser-checks.json"), JSON.stringify(evidence, null, 2));
  await browser.close(); await vite.close(); await server.shutdown();
}
