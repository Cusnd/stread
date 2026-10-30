import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "../node_modules/vite/dist/node/index.js";

const require = createRequire(process.env.READER_TEST_NODE_MODULES ? `${process.env.READER_TEST_NODE_MODULES}/reader-tests.cjs` : import.meta.url);
const { chromium } = require("playwright");
const output = fileURLToPath(new URL("../../../.audit/workspace-design-system/", import.meta.url));
const vite = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), cacheDir: `${output}/vite-cache`, server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/dist/**"] } }, clearScreen: false });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const tasks = Array.from({ length: 35 }, (_, index) => ({ id: `task-${index}`, reference: `#T${String(index + 1).padStart(5, "0")}`, type: "conversion", status: "pending", version: 1, title: `Synthetic task ${index + 1}`, body: "Read and review the complete source. Keep the original text and translation.", documentId: "document-1", createdAt: "2026-10-30T12:00:00Z" }));
const note = { id: "note-1", reference: "#N00001", documentId: "document-1", type: "note", title: "Synthetic insight", body: "This note belongs to a synthetic document.", version: 1 };
const results = [], errors = [];
let browser, page, responseDelay = 250;
const pass = (name, evidence = {}) => { results.push({ name, ...evidence }); console.log(`PASS ${name}`); };
const waitFrames = (count = 3) => page.evaluate(async count => { for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame); }, count);
const settle = async () => { await page.waitForTimeout(750); await waitFrames(); };
async function openFixture({ scale = 80, width = 1800, view = "collection", loading = false } = {}) {
  await page.setViewportSize({ width, height: 1100 });
  await page.goto(`${origin}/tests/fixtures/workspace-design-system.html?scale=${scale}&page=${view}&loading=${loading ? 1 : 0}`);
  await page.locator(".workspace-header").waitFor();
  await settle();
}
async function geometry(selector) {
  return page.locator(selector).evaluate(element => {
    const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, columns: css.gridTemplateColumns, font: css.fontSize, background: css.backgroundColor, shadow: css.boxShadow };
  });
}
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
  page = await browser.newPage();
  page.setDefaultTimeout(7000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    await new Promise(resolve => setTimeout(resolve, responseDelay));
    if (url.pathname === "/api/queue") await route.fulfill({ json: { tasks, total: tasks.length, counts: { all: tasks.length, pending: tasks.length }, allCounts: { pending: tasks.length }, typeCounts: { all: tasks.length, conversion: tasks.length } } });
    else if (url.pathname.startsWith("/api/queue/")) await route.fulfill({ json: { task: tasks.find(item => item.id === url.pathname.split("/").at(-1)) } });
    else if (url.pathname === "/api/flow/summary") await route.fulfill({ json: { totals: { activeMs: 0, documentCount: 0, sessionCount: 0, insightCount: 1 }, daily: [] } });
    else if (url.pathname === "/api/flow/insights") await route.fulfill({ json: { items: [note], total: 1, hasMore: false } });
    else if (url.pathname === "/api/flow/history") await route.fulfill({ json: { items: [], total: 0, hasMore: false } });
    else if (url.pathname.endsWith("/insights/note-1")) await route.fulfill({ json: { insight: note } });
    else if (url.pathname === "/api/flow/reviews") await route.fulfill({ json: { items: [], total: 0, hasMore: false } });
    else { errors.push(`Unexpected API ${url.pathname}`); await route.fulfill({ status: 404, json: { error: "Synthetic resource missing" } }); }
  });

  for (const scale of [80, 100, 120]) for (const width of [1800, 1500]) {
    await openFixture({ scale, width });
    const styles = [];
    for (const view of ["collection", "flow", "queue"]) {
      await page.getByRole("link", { name: view[0].toUpperCase() + view.slice(1), exact: true }).click();
      await settle();
      const heading = await geometry(view === "collection" ? ".workspace-catalog-heading" : view === "flow" ? ".flow-overview-heading" : ".queue-page-heading");
      const title = await geometry(view === "collection" ? "#workspace-collection-title" : view === "flow" ? "#workspace-flow-title" : "#workspace-queue-title");
      const selected = await geometry(view === "collection" ? ".workspace-category-column .workspace-nav-selection" : view === "flow" ? ".flow-nav .workspace-nav-selection" : ".queue-sidebar .workspace-nav-selection");
      styles.push({ view, heading, title, selected });
    }
    for (const item of styles.slice(1)) {
      assert.ok(Math.abs(item.heading.height - styles[0].heading.height) < 1, `${scale}% ${item.view}: shared content heading height`);
      assert.ok(Math.abs(item.title.x - styles[0].title.x) < 1, `${scale}% ${item.view}: shared heading alignment at ${width}px`);
      assert.equal(item.title.font, styles[0].title.font, `${scale}% ${item.view}: shared content heading typography`);
      assert.equal(item.selected.background, styles[0].selected.background, `${scale}% ${item.view}: shared navigation selected surface`);
      assert.equal(item.selected.shadow, styles[0].selected.shadow, `${scale}% ${item.view}: shared navigation selection treatment`);
    }
    await page.screenshot({ path: `${output}/queue-${scale}-${width}.png`, fullPage: true });
    pass(`three workspace headers and navigation share their recipe at ${scale}% and ${width}px`, { styles });
  }

  // Before lazy data or modules complete, the shell uses the saved Flow view.
  for (const state of [{ section: "overview", panelWidth: 420 }, { section: "insights", selectedInsightId: "note-1", panelWidth: 380 }, { section: "plan" }, { section: "history" }]) {
    await openFixture({ scale: 120, view: "flow", loading: true });
    await page.evaluate(state => window.workspaceDesign.setView("flow", state), state);
    await waitFrames();
    const before = await geometry(".workspace-flow-placeholder-content");
    await page.evaluate(() => window.workspaceDesign.setLoading(false));
    await page.locator(".flow-page").waitFor();
    const first = await geometry(".flow-page .flow-workspace");
    await settle();
    const after = await geometry(".flow-page .flow-workspace");
    assert.equal(after.columns, before.columns, `${state.section}: shell and page share saved columns`);
    assert.equal(first.columns, before.columns, `${state.section}: first content frame does not animate from unrelated widths`);
    pass(`Flow ${state.section} loading shell matches the first and settled content geometry`, { before, first, after });
  }

  for (const view of ["collection", "flow", "queue"]) {
    await openFixture({ scale: 120, width: 900, view });
    const toggle = page.locator(`[data-focus-key="${view}-navigation-toggle"]`);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await toggle.click();
    const dialog = page.locator(".workspace-navigation-dialog[open]");
    await dialog.waitFor();
    await settle();
    assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, `${view}: focus enters compact navigation`);
    for (let index = 0; index < 12; index++) { await page.keyboard.press("Tab"); assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, `${view}: Tab stays in navigation`); }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".workspace-navigation-dialog[open]"));
    assert.equal(await toggle.evaluate(node => document.activeElement === node), true, `${view}: Escape returns to navigation toggle`);
    assert.equal(await page.evaluate(() => window.workspaceDesign.getState().desktopNavigation), true, `${view}: compact close preserves desktop preference`);
    await toggle.click(); await dialog.waitFor();
    await page.setViewportSize({ width: 1800, height: 1100 });
    await settle();
    assert.equal(await page.locator(".workspace-navigation-dialog[open]").count(), 0, `${view}: resizing wide closes temporary navigation`);
    assert.equal(await toggle.getAttribute("aria-expanded"), "true", `${view}: desktop preference restored`);
    pass(`${view} scale-aware compact navigation traps focus and preserves the desktop preference`);
  }

  responseDelay = 1400;
  await openFixture({ scale: 120, width: 700, view: "flow" });
  await page.evaluate(() => window.workspaceDesign.setView("flow", { compactOverviewScrollTop: 220 }));
  await page.setViewportSize({ width: 700, height: 800 });
  await page.locator(".flow-overview-workspace").hover({ position: { x: 10, y: 10 } });
  await page.mouse.wheel(0, 130);
  await page.waitForTimeout(120);
  const userScroll = await page.locator(".flow-overview-workspace").evaluate(node => node.scrollTop);
  assert.ok(userScroll > 0, "the user can move the compact overview before data arrives");
  await page.waitForFunction(() => window.workspaceDesign.loadingSnapshot().pendingCount === 0);
  await waitFrames();
  const afterLoadScroll = await page.locator(".flow-overview-workspace").evaluate(node => ({ top: node.scrollTop, maximum: node.scrollHeight - node.clientHeight }));
  assert.ok(Math.abs(afterLoadScroll.top - Math.min(userScroll, afterLoadScroll.maximum)) < 2, "late data does not restore over a user's scrolling decision");
  pass("slow Flow responses respect user scroll input before restoration finishes");
  responseDelay = 250;

  await openFixture({ scale: 120, width: 700, view: "flow" });
  assert.equal(await page.locator(".flow-overview-workspace.flow-compact-content").count(), 1);
  assert.ok(await page.locator(".flow-overview-workspace").evaluate(node => node.scrollHeight > node.clientHeight), "compact overview keeps all sections reachable by scrolling");
  await page.screenshot({ path: `${output}/flow-compact-120.png`, fullPage: true });
  await page.locator(".flow-overview-workspace").evaluate(node => { node.scrollTop = node.scrollHeight; });
  await waitFrames();
  const compactScroll = await page.evaluate(() => window.workspaceDesign.getState().views.flow.compactOverviewScrollTop);
  assert.ok(compactScroll > 0);
  await page.getByRole("link", { name: "Queue", exact: true }).click(); await settle();
  await page.getByRole("link", { name: "Flow", exact: true }).click(); await settle();
  assert.ok(Math.abs(await page.locator(".flow-overview-workspace").evaluate(node => node.scrollTop) - compactScroll) < 3, "compact overview restores parent scroll on return");
  await page.evaluate(() => window.workspaceDesign.setView("flow", { section: "insights", selectedInsightId: "note-1" }));
  await page.locator(".flow-insight-dialog[open]").waitFor();
  await page.getByRole("dialog").getByText("Synthetic insight", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".flow-insight-dialog[open]"));
  assert.equal(await page.evaluate(() => window.workspaceDesign.getState().views.flow.selectedInsightId), null);
  pass("compact Flow keeps overview sections reachable, restores scroll and opens insight details in a modal");

  await openFixture({ scale: 120, width: 700, view: "queue" });
  assert.equal(await page.locator(".queue-workspace.queue-compact-content").count(), 1, "Queue content thresholds use available width in UI units");
  assert.equal(await page.locator(".queue-task-time:visible").count(), 0, "narrow scaled task rows hide secondary time metadata");
  const narrowHeading = await geometry(".queue-page-heading"), narrowSearch = await geometry(".queue-search");
  assert.ok(narrowHeading.width > 650 && narrowSearch.width > 560, "the compact Queue content occupies the available column");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "compact header and contents do not create horizontal overflow");
  assert.ok(narrowSearch.y > narrowHeading.y && narrowSearch.x + narrowSearch.width <= 700, "scaled narrow search wraps into the heading without overflowing");
  await page.screenshot({ path: `${output}/queue-compact-120.png`, fullPage: true });
  pass("Queue content and navigation breakpoints respond to the actual space at 120%", { narrowHeading, narrowSearch });

  await openFixture({ view: "queue" });
  const row = page.locator('[data-task-id="task-0"]');
  await row.locator(".queue-task-title").waitFor();
  const originalHeight = (await row.boundingBox()).height;
  await row.locator(".queue-task-summary").click({ position: { x: 700, y: 30 } });
  await page.waitForTimeout(90);
  const middle = (await row.boundingBox()).height;
  await settle();
  const expandedHeight = (await row.boundingBox()).height;
  assert.ok(middle > originalHeight && middle < expandedHeight, "Queue disclosure has a real intermediate frame");
  await page.screenshot({ path: `${output}/queue-expanded.png`, fullPage: true });
  await row.locator(".queue-task-title").click(); await settle();
  await row.locator(".queue-task-title").evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await row.locator(".queue-task-title").dispatchEvent("click", { detail: 1 });
  assert.equal(await row.locator(".queue-task-title").getAttribute("aria-expanded"), "false", "native text selection does not expand a task");
  pass("Queue preserves full-row interaction, native selection and continuous disclosure", { originalHeight, middle, expandedHeight });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await row.locator(".queue-task-title").click(); await waitFrames();
  assert.equal(await row.locator(".queue-task-title").getAttribute("aria-expanded"), "true");
  assert.ok(await row.locator(".motion-feedback").evaluate(node => Math.abs(node.getBoundingClientRect().height - node.scrollHeight) < 2));
  pass("live reduced motion settles the task disclosure without spatial interpolation");
  await page.waitForFunction(() => window.workspaceDesign.loadingSnapshot().pendingCount === 0);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/report.json`, JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser?.close();
  await vite.close();
}
