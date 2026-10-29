import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const frontend = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(frontend, "../../.audit/reader-toc-motion");
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_TEST_NODE_MODULES ? resolve(process.env.READER_TEST_NODE_MODULES, "playwright") : "playwright");
const vite = await createServer({ configFile: false, root: frontend, cacheDir: resolve(frontend, "node_modules/.vite-reader-toc-motion"), plugins: [react()], clearScreen: false, server: { host: "127.0.0.1", port: 0, open: false } });
await vite.listen();
const browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : { channel: "msedge" }) });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, reducedMotion: "no-preference" });
page.setDefaultTimeout(15000);
const result = { checks: [], transitions: [], pageErrors: [] };
page.on("pageerror", (error) => result.pageErrors.push(error.message));
const pass = (name) => { result.checks.push(name); console.log("PASS " + name); };
const mode = (value) => page.locator(`.reader-mode-option input[value="${value}"]`).evaluate((element) => element.click());
const jump = (id) => page.locator(`.paper-toc-link[href="#${id}"]`).evaluate((element) => element.click());

async function capture(name, action, expectedId, duration = 1600) {
  await page.evaluate((milliseconds) => {
    const scroller = document.querySelector(".reader-toc");
    const sample = () => {
      const indicator = scroller.querySelector(".reader-toc-indicator");
      const active = scroller.querySelector('[aria-current="location"]');
      const rows = [...scroller.querySelectorAll(".paper-toc-link")].map((item) => item.getBoundingClientRect());
      const box = indicator.getBoundingClientRect();
      const activeBox = active.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      return { x: box.x, y: box.y, bottom: box.bottom, height: box.height, transform: getComputedStyle(indicator).transform,
        active: active.hash.slice(1), activeTop: activeBox.top, activeBottom: activeBox.bottom,
        targetY: activeBox.top + parseFloat(getComputedStyle(indicator).top),
        firstRowTop: Math.min(...rows.map((row) => row.top)), lastRowBottom: Math.max(...rows.map((row) => row.bottom)),
        firstRowLeft: Math.min(...rows.map((row) => row.left)), lastRowRight: Math.max(...rows.map((row) => row.right)),
        scrollY, tocScroll: scroller.scrollTop, tocTop: viewport.top, tocBottom: viewport.bottom };
    };
    const before = sample();
    const frames = [];
    const started = performance.now();
    window.tocMotionProbe = new Promise((done) => {
      const frame = () => {
        const elapsed = performance.now() - started;
        frames.push({ ms: elapsed, ...sample() });
        if (elapsed < milliseconds) requestAnimationFrame(frame);
        else done({ before, frames });
      };
      requestAnimationFrame(frame);
    });
  }, duration);
  await action();
  const transition = { name, ...await page.evaluate(() => window.tocMotionProbe) };
  result.transitions.push(transition);
  // Normal local movement between rows is allowed. The full outline bounds,
  // including clipped rows, exclude document-scale excursions without assuming
  // a fixed sidebar height or requiring the indicator to snap to every frame.
  for (const frame of transition.frames) {
    const lower = Math.min(transition.before.firstRowTop, frame.firstRowTop) - 4;
    const upper = Math.max(transition.before.lastRowBottom, frame.lastRowBottom) + 4;
    assert.ok(frame.y >= lower && frame.bottom <= upper,
      `${name}: indicator escaped outline at ${frame.ms.toFixed(1)}ms: ${frame.y.toFixed(1)}..${frame.bottom.toFixed(1)}, rows ${lower.toFixed(1)}..${upper.toFixed(1)}`);
    assert.ok(frame.x >= frame.firstRowLeft - 3 && frame.x <= frame.lastRowRight, "indicator must stay inside the outline column");
  }
  const last = transition.frames.at(-1);
  if (expectedId) assert.equal(last.active, expectedId, `${name}: final current section`);
  assert.ok(Math.abs(last.y - last.targetY) < 1, `${name}: indicator must settle on active row (${last.y} vs ${last.targetY})`);
  pass(name);
  return transition;
}

try {
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/tests/fixtures/reader-opening.html?desktop&restore=S6.SS1`);
  await page.getByRole("button", { name: "打开验证文章" }).click();
  await page.waitForFunction(() => document.querySelector('.paper-toc-link[aria-current="location"]')?.hash === "#S6.SS1"
    && Math.abs(document.getElementById("S6.SS1").getBoundingClientRect().top - 102) < 2);
  await page.mouse.move(1000, 500);
  await page.waitForTimeout(500);
  for (const value of ["source", "translation", "bilingual"]) {
    const transition = await capture(`deep ${value} switch keeps indicator in outline coordinates`, () => mode(value), "S6.SS1");
    assert.ok(Math.abs(transition.before.scrollY - transition.frames.at(-1).scrollY) > 100, "exercise substantial article reflow");
  }
  await capture("rapid language reversals preserve the current section and indicator", async () => {
    for (const value of ["source", "translation", "source", "bilingual"]) { await mode(value); await page.waitForTimeout(45); }
  }, "S6.SS1");
  const longJump = await capture("smooth cross-article TOC jump keeps indicator inside the outline", () => jump("S3"), "S3");
  assert.ok(new Set(longJump.frames.map((frame) => frame.scrollY)).size > 3, "long navigation must render intermediate scrolling frames");
  const wheelDelta = await page.locator('[id="S3.SS1"]').evaluate((element) => element.getBoundingClientRect().top - 102 + 4);
  const wheel = await capture("page wheel crossing a heading keeps indicator local and tracks the section", () => page.mouse.wheel(0, wheelDelta), "S3.SS1");
  assert.ok(Math.abs(wheel.before.scrollY - wheel.frames.at(-1).scrollY) > 30, "wheel must move the article");
  await capture("rapid long jumps retarget the indicator to the final chapter", async () => {
    for (const id of ["S6.SS1", "S2", "S5", "S3.SS2"]) { await jump(id); await page.waitForTimeout(70); }
  }, "S3.SS2", 2000);

  await page.setViewportSize({ width: 1440, height: 600 });
  await page.waitForTimeout(400);
  await page.mouse.move(100, 350);
  const outline = await capture("outline wheel retains its own scroll without moving the article", () => page.mouse.wheel(0, 500));
  assert.equal(outline.frames.at(-1).active, outline.before.active);
  assert.equal(outline.frames.at(-1).scrollY, outline.before.scrollY);
  assert.ok(Math.abs(outline.frames.at(-1).tocScroll - outline.before.tocScroll) > 20);
  await page.mouse.move(1000, 400);
  const reveal = await capture("automatic reveal follows a distant active chapter within the short outline viewport", () => jump("S1"), "S1");
  const revealed = reveal.frames.at(-1);
  assert.ok(revealed.activeTop >= revealed.tocTop && revealed.activeBottom <= revealed.tocBottom, "active chapter must be revealed");
  assert.ok(Math.abs(revealed.tocScroll - reveal.before.tocScroll) > 10, "automatic reveal must exercise outline scrolling");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await capture("reduced motion still tracks chapter jumps without an offscreen indicator", () => jump("S3"), "S3");
  await capture("reduced motion language reflow keeps active indicator aligned", () => mode("source"), "S3");
  assert.equal(result.pageErrors.length, 0, result.pageErrors.join("\n"));
} finally {
  await writeFile(resolve(output, process.env.READER_MOTION_BASELINE ? "before.json" : "verification.json"), JSON.stringify(result, null, 2));
  await browser.close();
  await vite.close();
}
