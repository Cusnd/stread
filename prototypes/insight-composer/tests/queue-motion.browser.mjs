import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_TEST_NODE_MODULES ? resolve(process.env.READER_TEST_NODE_MODULES, "playwright") : "playwright");
const baseline = process.env.READER_TEST_BASELINE === "1";
const output = resolve(frontend, "../../.audit/queue-motion");
const bundle = await build({ stdin: { contents: `
  import React, { useState } from "react";
  import { createRoot } from "react-dom/client";
  import { QueuePage } from "./src/workspace/QueuePage.jsx";
  import { ContinuousMotion } from "./src/Motion.jsx";
  import { ReaderRuntimeProvider } from "./src/ReaderRuntime.jsx";
  import { createPreviewReaderRuntime } from "./src/reader-runtime.js";
  import "./src/styles.css";
  const params = new URLSearchParams(location.search);
  const scale = Number(params.get("scale") || 1);
  document.documentElement.style.setProperty("--ui-scale", scale);
  const runtime = createPreviewReaderRuntime("queue-motion-fixture", { uiScale: { percent: scale * 80 } });
  function Fixture() {
    const [view, setView] = useState({ type: "conversion", status: "pending", navigationExpanded: innerWidth > 640 * scale, selectedId: params.get("selected"), scrollTop: Number(params.get("scroll") || 0) });
    window.fixtureView = view;
    window.setFixtureView = setView;
    return <ContinuousMotion><header style={{ height: 56 * scale }}>Queue</header><QueuePage workspace={{ revision: 1, documents: [] }} view={view} setView={setView} command={async () => { throw new Error("Read-only fixture"); }} openDocument={async () => {}} /></ContinuousMotion>;
  }
  createRoot(document.getElementById("root")).render(<React.StrictMode><ReaderRuntimeProvider value={runtime}><Fixture /></ReaderRuntimeProvider></React.StrictMode>);
`, resolveDir: frontend, loader: "jsx" }, bundle: true, write: false, outdir: "queue-fixture", format: "iife", platform: "browser", jsx: "automatic", logLevel: "silent" });
const javascript = bundle.outputFiles.find(file => file.path.endsWith(".js")).text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css")).text;
const server = createServer((request, response) => {
  const script = request.url === "/fixture.js", css = request.url === "/fixture.css";
  response.setHeader("Content-Type", script ? "text/javascript" : css ? "text/css" : "text/html; charset=utf-8");
  response.end(script ? javascript : css ? stylesheet : '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const tasks = [
  { id: "first", reference: "#T00002", type: "conversion", sourceId: "source-first", sourceFilename: "Attention Is All You Need.pdf" },
  { id: "second", reference: "#T00001", type: "conversion", sourceFilename: "Deep Residual Learning for Image Recognition.pdf" },
  { id: "correction", reference: "#T00003", type: "correction", title: "核对表 2 中的复杂度描述" },
].map(task => ({ ...task, status: "pending", version: 1, createdAt: "2026-10-29T09:33:00Z", body: "完整保留正文、公式、图表与参考文献，转换后在 Reader 中核对。保留附录。", uploadedSource: { size: 2048000 }, outputLanguages: ["source", "zh-CN"] }));
let browser;
const results = [], errors = [];
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let failPreview = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    assert.equal(route.request().method(), "GET", "fixture must not write");
    if (url.pathname === "/api/queue") {
      const type = url.searchParams.get("type"), status = url.searchParams.get("status");
      const visible = tasks.filter(task => (type === "all" || task.type === type) && (status === "all" || task.status === status));
      await new Promise(done => setTimeout(done, 35));
      await route.fulfill({ json: { tasks: visible, revision: 1, total: visible.length, counts: { pending: visible.length }, allCounts: { pending: 3 }, typeCounts: { all: 3, conversion: 2, correction: 1 } } });
    } else if (url.pathname.startsWith("/api/queue/")) {
      // Resolve details during expansion, as the real Queue does.
      await new Promise(done => setTimeout(done, 85));
      await route.fulfill({ json: { task: tasks.find(task => task.id === url.pathname.split("/").at(-1)) } });
    } else if (url.pathname === "/api/sources/source-first/pages/1.png") {
      await new Promise(done => setTimeout(done, 140));
      await route.fulfill(failPreview ? { status: 404, body: "Unavailable" } : { contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="780"><rect width="600" height="780" fill="white"/><text x="40" y="80">Preview fixture</text></svg>' });
    } else { errors.push(`Unexpected API request: ${url.pathname}`); await route.abort(); }
  });
  async function sample(name, selector, { reverse, category = false, expanded = [], ids = ["first", "second"] } = {}) {
    const frames = await page.evaluate(async ({ selector, reverse }) => {
      const measure = () => {
        const rows = [...document.querySelectorAll('.queue-task-row[data-motion-present="true"]')];
        const first = rows.find(row => row.dataset.taskId === "first"), second = rows.find(row => row.dataset.taskId === "second");
        const list = document.querySelector(".queue-task-list"), scroll = document.querySelector(".queue-scroll");
        return { time: performance.now(), gap: first && second ? second.getBoundingClientRect().top - first.getBoundingClientRect().bottom - parseFloat(getComputedStyle(first).marginBottom) : null,
          secondY: second?.getBoundingClientRect().top, firstHeight: first?.getBoundingClientRect().height, detailHeight: first?.querySelector('.motion-feedback')?.style.height, top: rows[0] ? rows[0].getBoundingClientRect().top - list.getBoundingClientRect().top : null,
          ids: rows.map(row => row.dataset.taskId), scrollTop: scroll.scrollTop, overflow: scroll.scrollWidth - scroll.clientWidth,
          expanded: rows.filter(row => row.classList.contains("is-expanded")).map(row => row.dataset.taskId),
          details: rows.filter(row => row.classList.contains("is-expanded")).map(row => ({ height: row.querySelector('.motion-feedback')?.getBoundingClientRect().height || 0, settled: row.querySelector('.motion-feedback')?.style.height === "auto" })),
          exiting: [...list.querySelectorAll('[data-motion-present="false"]')].map(row => ({ inert: row.inert, position: getComputedStyle(row).position })),
        };
      };
      const frames = [measure()], start = performance.now();
      document.querySelector(selector).click();
      let reversed = false;
      do {
        await new Promise(requestAnimationFrame);
        if (reverse && !reversed && performance.now() - start > 70) { document.querySelector(reverse).click(); reversed = true; }
        frames.push(measure());
      } while (performance.now() - start < 1100);
      return frames;
    }, { selector, reverse });
    const gaps = frames.filter(frame => frame.gap !== null).map(frame => Math.abs(frame.gap));
    const maxGap = Math.max(0, ...gaps), maxTop = Math.max(0, ...frames.map(frame => Math.abs(frame.top || 0)));
    const settleJump = Math.max(0, ...frames.slice(1).map((frame, i) => frame.detailHeight === "auto" && frames[i].detailHeight && frames[i].detailHeight !== "auto" ? Math.abs(frame.firstHeight - frames[i].firstHeight) : 0));
    results.push({ name, maxGap, maxTop, settleJump, frames });
    console.log(`${name}: row separation error=${maxGap.toFixed(2)}px, first row offset=${maxTop.toFixed(2)}px, settle jump=${settleJump.toFixed(2)}px`);
    if (baseline) return;
    assert.deepEqual(frames.at(-1).ids, ids, `${name}: expected tasks are visible`);
    assert.deepEqual(frames.at(-1).expanded, expanded, `${name}: requested expansion state reached`);
    assert.ok(frames.at(-1).details.every(detail => detail.settled && detail.height > 0), `${name}: open details finish expanding`);
    assert.ok(maxGap <= 1, `${name}: lower row separates from the expanding/collapsing row`);
    assert.ok(settleJump <= 1, `${name}: expansion jumps when its height settles`);
    if (category) assert.ok(maxTop <= 7, `${name}: new category is displaced by exiting rows`);
    assert.ok(frames.every(frame => frame.overflow <= 1), `${name}: horizontal overflow`);
    assert.ok(frames.every(frame => frame.exiting.every(row => row.inert)), `${name}: exiting rows accept input`);
    assert.equal(frames.at(-1).exiting.length, 0, `${name}: exit did not finish`);
  }
  const first = '[data-focus-key="queue-expand-first"]', second = '[data-focus-key="queue-expand-second"]';
  for (const scale of baseline ? [1] : [1, 1.5]) {
    await page.goto(`http://127.0.0.1:${server.address().port}/?scale=${scale}`);
    await page.locator(second).waitFor(); await page.waitForTimeout(700);
    await sample(`${scale}: expand first`, first, { expanded: ["first"] });
    await page.screenshot({ path: resolve(output, `${baseline ? "before" : "after"}-expanded-${scale}.png`) });
    await sample(`${scale}: collapse first`, first);
    await sample(`${scale}: reverse expansion`, first, { reverse: first });
    await sample(`${scale}: switch category`, '[data-focus-key="queue-type-correction"]', { category: true, ids: ["correction"] });
    await sample(`${scale}: return category`, '[data-focus-key="queue-type-conversion"]', { category: true });
    await sample(`${scale}: rapid categories`, '[data-focus-key="queue-type-correction"]', { reverse: '[data-focus-key="queue-type-conversion"]', category: true });
    await page.screenshot({ path: resolve(output, `${baseline ? "before" : "after"}-${scale}.png`) });
  }
  if (!baseline) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await sample("reduced motion expand", first, { expanded: ["first"] });
    await sample("reduced motion collapse", first);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 480, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator(second).waitFor(); await page.waitForTimeout(700);
    await sample("narrow expand", first, { expanded: ["first"] });
    await sample("narrow collapse", first);
    failPreview = true;
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator(second).waitFor(); await page.waitForTimeout(700);
    await sample("narrow preview failure", first, { expanded: ["first"] });
    assert.equal(await page.locator(".queue-source-preview.is-unavailable").count(), 1, "failed preview is hidden without changing geometry");
    failPreview = false;
    await page.setViewportSize({ width: 1440, height: 420 });
    await page.goto(`http://127.0.0.1:${server.address().port}/?scale=1.5&selected=first&scroll=120`);
    await page.waitForFunction(() => document.querySelector('.queue-task-row.is-expanded .motion-feedback')?.style.height === "auto" && Math.abs(document.querySelector('.queue-scroll').scrollTop - 120) < 1);
    assert.equal(await page.evaluate(() => window.fixtureView.scrollTop), 120, "restoring expanded content preserves saved scroll");
    await sample("switch expanded task while scrolled", second, { expanded: ["second"] });
    await sample("leave scrolled category", '[data-focus-key="queue-type-correction"]', { category: true, ids: ["correction"] });
    assert.equal(await page.locator(".queue-scroll").evaluate(node => node.scrollTop), 0, "filter change resets scroll");

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('[data-focus-key="queue-type-correction"]').click();
    const correctionTitle = '[data-task-id="correction"] .queue-task-title';
    await page.locator(correctionTitle).waitFor(); await page.waitForTimeout(700);
    for (const trigger of ["title", "arrow", "keyboard"]) {
      const selector = trigger === "arrow" ? '[data-focus-key="queue-expand-correction"]' : correctionTitle;
      await page.evaluate(selector => {
        window.disclosureFrames = [];
        document.querySelector(selector).addEventListener("click", () => {
          const start = performance.now();
          const record = () => {
            const detail = document.querySelector('[data-task-id="correction"] .motion-feedback');
            window.disclosureFrames.push({ time: performance.now() - start, height: detail?.getBoundingClientRect().height || 0 });
            if (performance.now() - start < 1100) requestAnimationFrame(record);
          };
          record();
        }, { once: true, capture: true });
      }, selector);
      if (trigger === "keyboard") { await page.locator(selector).focus(); await page.keyboard.press("Enter"); }
      else await page.locator(selector).click();
      await page.waitForFunction(() => window.disclosureFrames.at(-1)?.time >= 1100);
      const frames = await page.evaluate(() => window.disclosureFrames);
      const height = frames.at(-1).height;
      assert.ok(height > 100, `${trigger}: actual task details opened`);
      const at = fraction => frames.find(frame => frame.height >= height * fraction).time;
      const visibleDuration = at(0.9) - at(0.1);
      assert.ok(visibleDuration >= 200 && visibleDuration <= 500, `${trigger}: opening must remain visibly gradual without lingering (${visibleDuration.toFixed(0)}ms)`);
      assert.ok(frames.slice(1).every((frame, index) => frame.height >= frames[index].height - 1), `${trigger}: opening must not reverse`);
      assert.equal(await page.locator(selector).getAttribute("aria-expanded"), "true");
      results.push({ name: `correction ${trigger} disclosure`, visibleDuration, frames });
      console.log(`${trigger} disclosure: 10–90% opening=${visibleDuration.toFixed(0)}ms`);
      await page.locator(selector).click();
      await page.locator('[data-task-id="correction"] .motion-feedback').waitFor({ state: "detached" });
    }

    const row = page.locator('[data-task-id="correction"]'), summary = row.locator(".queue-task-summary"), title = row.locator(".queue-task-title");
    await page.locator(".queue-search input").focus();
    await page.mouse.move(5, 5); await page.waitForTimeout(160);
    const restingBackground = await summary.evaluate(node => getComputedStyle(node).backgroundColor);
    const box = await summary.boundingBox();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
    await page.waitForTimeout(160);
    assert.notEqual(await summary.evaluate(node => getComputedStyle(node).backgroundColor), restingBackground, "hover highlights the whole task summary");
    assert.equal(await summary.evaluate(node => getComputedStyle(node).cursor), "pointer");
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
    assert.equal(await title.getAttribute("aria-expanded"), "true", "blank summary space opens the task once");
    await page.waitForFunction(() => document.querySelector('[data-task-id="correction"] .motion-feedback')?.style.height === "auto");
    await row.locator(".queue-request-body").click();
    assert.equal(await title.getAttribute("aria-expanded"), "true", "detail content does not toggle the summary");
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.copiedTaskText = text; } } }));
    await row.locator(".queue-copy-reference").click();
    assert.equal(await page.evaluate(() => window.copiedTaskText), "#T00003", "reference copy retains its own action");
    assert.equal(await title.getAttribute("aria-expanded"), "true", "copying a reference does not collapse the task");
    await row.getByRole("button", { name: "复制给 Agent", exact: true }).click();
    assert.match(await page.evaluate(() => window.copiedTaskText), /#T00003/, "detail action still works independently");
    assert.equal(await title.getAttribute("aria-expanded"), "true");
    await row.locator(".queue-task-time").click();
    assert.equal(await title.getAttribute("aria-expanded"), "false", "timestamp click collapses once");
    await row.locator(".motion-feedback").waitFor({ state: "detached" });
    await row.locator(".queue-task-meta > span").first().click();
    assert.equal(await title.getAttribute("aria-expanded"), "true", "metadata click opens once");
    await title.focus(); await page.keyboard.press("Space");
    assert.equal(await title.getAttribute("aria-expanded"), "false", "Space remains a native toggle");
    await row.locator(".motion-feedback").waitFor({ state: "detached" });
    const textBox = await title.boundingBox();
    await page.mouse.move(textBox.x + 2, textBox.y + textBox.height / 2);
    await page.mouse.down(); await page.mouse.move(textBox.x + Math.min(textBox.width - 2, 130), textBox.y + textBox.height / 2, { steps: 10 }); await page.mouse.up();
    assert.ok(await page.evaluate(() => window.getSelection().toString().length > 0), "title remains selectable");
    assert.equal(await title.getAttribute("aria-expanded"), "false", "selecting title text does not toggle the task");
    await title.focus(); await page.keyboard.press("Enter");
    assert.equal(await title.getAttribute("aria-expanded"), "true", "keyboard activation works with selected text");
    console.log("PASS whole-row hover and clicks, independent actions, native selection and keyboard activation");
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(resolve(output, `${baseline ? "before" : "after"}.json`), JSON.stringify({ errors, results }, null, 2));
  await browser?.close();
  await new Promise(done => server.close(done));
}
