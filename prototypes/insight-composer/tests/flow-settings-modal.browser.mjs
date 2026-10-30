import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "../node_modules/vite/dist/node/index.js";

const require = createRequire(process.env.READER_TEST_NODE_MODULES ? `${process.env.READER_TEST_NODE_MODULES}/reader-tests.cjs` : import.meta.url);
const { chromium } = require("playwright");
const output = fileURLToPath(new URL("../../../.audit/flow-settings-modal/", import.meta.url));
const vite = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), cacheDir: `${output}/vite-cache`, server: { host: "127.0.0.1", port: 0 }, clearScreen: false });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const note = { id: "note-1", reference: "#N00001", documentId: "document-1", type: "note", title: "Synthetic insight", body: "Retain this selected insight while changing interface size.", version: 1 };
const results = [], errors = [];
let browser, page;
const pass = (name, evidence = {}) => { results.push({ name, ...evidence }); console.log(`PASS ${name}`); };
const settled = () => page.waitForTimeout(650);
async function openFixture(scale = 80) {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(`${origin}/tests/fixtures/workspace-design-system.html?scale=${scale}&page=flow`);
  await page.locator(".workspace-header").waitFor();
  await page.evaluate(() => window.workspaceDesign.setView("flow", { section: "insights", selectedInsightId: "note-1" }));
  await page.waitForFunction(() => document.querySelector(".flow-detail-copy")?.textContent.includes("Retain this selected insight"));
  await settled();
}
async function openSettings() {
  await page.keyboard.press("Control+,");
  await page.locator(".settings-overlay[open]").waitFor();
  await page.getByRole("tab", { name: "界面", exact: true }).click();
  await settled();
}
async function enlargeWithinSettings() {
  await openSettings();
  await page.getByRole("slider", { name: "界面大小", exact: true }).focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.querySelector(".flow-workspace")?.classList.contains("flow-compact-content"));
  await settled();
  assert.equal(await page.locator(".flow-insight-dialog[open]").count(), 0, "background responsive detail cannot open over settings");
  assert.equal(await page.locator("dialog[open]").count(), 1);
  assert.equal(await page.getByRole("slider", { name: "界面大小", exact: true }).inputValue(), "120");
}
async function closeAndSample() {
  await page.evaluate(() => {
    const settings = document.querySelector(".settings-overlay");
    window.flowSettingsFrames = [];
    window.flowSettingsSampleDone = false;
    window.flowSettingsNativeClosed = false;
    settings.addEventListener("close", () => { window.flowSettingsNativeClosed = true; }, { once: true });
    const start = performance.now();
    const record = () => {
      window.flowSettingsFrames.push({ time: performance.now() - start, settingsOpen: Boolean(settings.open),
        settingsState: settings.dataset.state, detailOpen: Boolean(document.querySelector(".flow-insight-dialog[open]")), nativeClosed: window.flowSettingsNativeClosed });
      if (performance.now() - start < 900) requestAnimationFrame(record);
      else window.flowSettingsSampleDone = true;
    };
    document.querySelector("[data-settings-close]").click();
    record();
  });
  await page.waitForFunction(() => window.flowSettingsSampleDone);
  return page.evaluate(() => window.flowSettingsFrames);
}
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
  page = await browser.newPage({ reducedMotion: "no-preference" });
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/flow/summary") await route.fulfill({ json: { totals: { activeMs: 0, documentCount: 0, sessionCount: 0, insightCount: 1 }, daily: [] } });
    else if (url.pathname === "/api/flow/insights") await route.fulfill({ json: { items: [note], total: 1, hasMore: false } });
    else if (url.pathname.endsWith("/insights/note-1")) await route.fulfill({ json: { insight: note } });
    else if (["/api/flow/history", "/api/flow/reviews"].includes(url.pathname)) await route.fulfill({ json: { items: [], total: 0, hasMore: false } });
    else { errors.push(`Unexpected API ${url.pathname}`); await route.fulfill({ status: 404, json: { error: "Synthetic resource missing" } }); }
  });

  // These are the actual Flow, Settings, native dialog and scale components;
  // the fixture mirrors WorkspaceApp's overlayActive + background inert boundary.
  await openFixture();
  await enlargeWithinSettings();
  await page.getByRole("tab", { name: "高亮", exact: true }).click();
  await page.getByRole("tab", { name: "界面", exact: true }).click();
  assert.equal(await page.locator(".settings-overlay").evaluate(node => node.contains(document.activeElement)), true, "settings remains operable and owns focus");
  const deferred = await closeAndSample();
  assert.ok(deferred.some(frame => frame.settingsOpen && frame.settingsState === "closing"), "observe the real settings exit");
  assert.ok(deferred.every(frame => !frame.settingsOpen || !frame.detailOpen), "new detail waits for the native settings layer to close");
  assert.ok(deferred.every(frame => !frame.detailOpen || frame.nativeClosed), "no fixed-delay opening before the native close event");
  assert.equal(deferred.at(-1).detailOpen, true);
  assert.equal(await page.locator(".flow-insight-dialog").evaluate(node => node.contains(document.activeElement)), true);
  assert.equal((await page.evaluate(() => window.workspaceDesign.getState())).views.flow.selectedInsightId, "note-1");
  pass("80% to 120% retains settings ownership through native exit, then presents the selected Flow detail", { frames: deferred });

  // A lower modal already exists before Settings opens: keep its identity and
  // native session throughout the nested settings lifetime and animated exit.
  await openFixture(120);
  await page.locator(".flow-insight-dialog[open]").waitFor();
  await page.evaluate(() => { window.originalFlowDialog = document.querySelector(".flow-insight-dialog"); });
  await openSettings();
  assert.equal(await page.locator("dialog[open]").count(), 2);
  assert.equal(await page.evaluate(() => window.originalFlowDialog.open && window.originalFlowDialog === document.querySelector(".flow-insight-dialog")), true);
  assert.equal(await page.locator(".settings-overlay").evaluate(node => node.contains(document.activeElement)), true);
  const nested = await closeAndSample();
  assert.ok(nested.every(frame => frame.detailOpen), "existing lower detail never closes when settings state changes");
  assert.equal(await page.evaluate(() => window.originalFlowDialog === document.querySelector(".flow-insight-dialog")), true);
  pass("an already open Flow detail survives settings nesting with the same native dialog", { frames: nested });

  for (const cancellation of ["selection", "section", "width"]) {
    await openFixture();
    await enlargeWithinSettings();
    if (cancellation === "selection") await page.evaluate(() => window.workspaceDesign.setView("flow", { selectedInsightId: null }));
    else if (cancellation === "section") await page.evaluate(() => window.workspaceDesign.setView("flow", { section: "plan" }));
    else await page.setViewportSize({ width: 1800, height: 900 });
    await settled();
    const frames = await closeAndSample();
    assert.ok(frames.every(frame => !frame.detailOpen), `${cancellation}: an obsolete compact request must not open after settings exits`);
    pass(`${cancellation} change cancels the deferred compact detail request`);
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report.json`, JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser?.close();
  await vite.close();
}
