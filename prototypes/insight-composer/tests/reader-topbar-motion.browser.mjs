import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const frontend = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(frontend, "../../.audit/reader-topbar-motion");
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_TEST_NODE_MODULES ? resolve(process.env.READER_TEST_NODE_MODULES, "playwright") : "playwright");
const vite = await createServer({ configFile: false, root: frontend, cacheDir: resolve(frontend, "node_modules/.vite-reader-topbar-motion"), plugins: [react()], clearScreen: false, server: { host: "127.0.0.1", port: 0, open: false } });
await vite.listen();
const browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : { channel: "msedge" }) });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, reducedMotion: "no-preference" });
page.setDefaultTimeout(15000);
const result = { checks: [], transitions: [], pageErrors: [] };
page.on("pageerror", (error) => result.pageErrors.push(error.message));
const pass = (name) => { result.checks.push(name); console.log("PASS " + name); };

// Sample real intermediate frames: a settled screenshot misses scroll-induced
// layout projection on controls inside the fixed topbar.
async function switchModes(modes) {
  return page.evaluate(async (values) => {
    const button = document.querySelector(".reader-return");
    const article = document.querySelector(".article");
    const header = document.querySelector(".reader-topbar");
    const anchor = document.getElementById("S6.SS1");
    const sample = () => {
      const box = button.getBoundingClientRect();
      const indicator = document.querySelector('input:checked ~ .reader-mode-indicator');
      return { x: box.x, y: box.y, opacity: getComputedStyle(button).opacity, transform: getComputedStyle(button).transform,
        headerY: header.getBoundingClientRect().y, headerOpacity: getComputedStyle(header).opacity,
        indicatorY: indicator?.getBoundingClientRect().y, anchorY: anchor.getBoundingClientRect().y,
        scrollY, articleOpacity: getComputedStyle(article).opacity, sameButton: button === document.querySelector(".reader-return") };
    };
    const before = sample();
    const frames = [];
    const started = performance.now();
    let next = 0;
    await new Promise((done) => {
      const frame = () => {
        const elapsed = performance.now() - started;
        if (next < values.length && elapsed >= next * 45) {
          document.querySelector(`.reader-mode-option input[value="${values[next++]}"]`).click();
        }
        frames.push({ ms: elapsed, ...sample() });
        if (elapsed < values.length * 45 + 800) requestAnimationFrame(frame);
        else done();
      };
      frame();
    });
    return { modes: values, before, frames, finalMode: document.querySelector(".reader-mode-option input:checked").value };
  }, modes);
}

function assertStable(transition) {
  assert.equal(transition.finalMode, transition.modes.at(-1));
  for (const frame of transition.frames) {
    assert.equal(frame.sameButton, true, "return control must remain mounted");
    assert.ok(Math.abs(frame.x - transition.before.x) < 0.5, `return x moved at ${frame.ms}ms: ${frame.x}`);
    assert.ok(Math.abs(frame.y - transition.before.y) < 0.5, `return y moved at ${frame.ms}ms: ${frame.y}, expected ${transition.before.y}`);
    assert.equal(Number(frame.opacity), 1, "return control must not fade during language changes");
    assert.equal(frame.headerY, 0);
    assert.equal(Number(frame.headerOpacity), 1);
    assert.ok(Math.abs(frame.indicatorY - transition.before.indicatorY) < 0.5, "mode underline must remain at the topbar baseline");
  }
  assert.ok(Math.abs(transition.frames.at(-1).anchorY - transition.before.anchorY) < 2, "language switch must preserve reading anchor");
}

try {
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/tests/fixtures/reader-opening.html?desktop&restore=S3`);
  await page.getByRole("button", { name: "打开验证文章" }).click();
  await page.locator(".article").waitFor();
  await page.waitForFunction(() => Math.abs(document.getElementById("S3").getBoundingClientRect().top - 102) < 2);
  await page.locator('.paper-toc-link[href="#S6.SS1"]').click();
  await page.waitForFunction(() => Math.abs(document.getElementById("S6.SS1").getBoundingClientRect().top - 102) < 2
    && getComputedStyle(document.querySelector(".reader-return")).transform === "none");
  // Wait for the navigation spring's remaining subpixel movement to finish.
  await page.waitForTimeout(500);
  const originMode = "bilingual";
  for (const modes of [["source"], ["translation"], ["source", "translation", "bilingual", "source"]]) {
    const transition = await switchModes(modes);
    result.transitions.push(transition);
    assertStable(transition);
    assert.ok(Math.abs(transition.frames.at(-1).scrollY - transition.before.scrollY) > 100, "fixture must exercise document reflow and scroll restoration");
    assert.ok(transition.frames.some((frame) => Number(frame.articleOpacity) < 0.99), "article fade remains active");
    pass(`${modes.join(" → ")}: return control and topbar remain stationary through every frame; body fades and anchor survives`);
  }
  await page.screenshot({ path: resolve(output, "fixed-reader.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const reduced = await switchModes(["translation"]);
  result.transitions.push(reduced);
  assertStable(reduced);
  assert.ok(reduced.frames.every((frame) => Number(frame.articleOpacity) === 1));
  pass("reduced motion: stable topbar, no article fade, preserved reading anchor");
  await page.locator(".reader-return").click();
  await page.waitForFunction(() => !document.querySelector(".reader-return"));
  assert.equal(await page.locator(".reader-mode-option input:checked").inputValue(), originMode);
  assert.ok(Math.abs(await page.locator("#S3").evaluate((element) => element.getBoundingClientRect().top) - 102) < 2);
  pass("return still restores the preceding section and language, then removes the exhausted return control");
  assert.equal(result.pageErrors.length, 0, result.pageErrors.join("\n"));
} finally {
  await writeFile(resolve(output, process.env.READER_MOTION_BASELINE ? "before.json" : "verification.json"), JSON.stringify(result, null, 2));
  await browser.close();
  await vite.close();
}
