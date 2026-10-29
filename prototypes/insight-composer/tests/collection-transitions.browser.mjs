import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.READER_TEST_NODE_MODULES ? `${process.env.READER_TEST_NODE_MODULES}/reader-tests.cjs` : import.meta.url);
const { chromium } = require("playwright");
const origin = process.env.READER_TEST_URL || "http://127.0.0.1:5196";
const output = fileURLToPath(new URL("../../../.audit/collection-transitions/", import.meta.url));
const baseline = process.env.READER_TEST_BASELINE === "1";
const browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [], results = [];
page.on("pageerror", (error) => errors.push(error.stack));
page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) errors.push(`Unexpected API request: ${request.url()}`); });
async function sample(key, name, options = {}) {
  const frames = await page.evaluate(async ({ key, reverse }) => {
    const scroll = document.querySelector(".workspace-list-scroll");
    const footer = document.querySelector(".workspace-list-footer");
    const frame = () => ({
      width: scroll.clientWidth, height: scroll.clientHeight, scrollWidth: scroll.scrollWidth, scrollHeight: scroll.scrollHeight,
      top: scroll.scrollTop, footerY: footer.getBoundingClientRect().y, footerSame: footer === document.querySelector(".workspace-list-footer"),
      footerOpacity: getComputedStyle(footer).opacity, empty: document.querySelector(".workspace-empty-catalog")?.getBoundingClientRect().height || 0,
      exiting: [...document.querySelectorAll('.workspace-document-list [data-motion-present="false"]')].map((node) => ({ inert: node.inert, position: getComputedStyle(node).position, width: node.getBoundingClientRect().width })),
    });
    const frames = [frame()];
    document.querySelector(`[data-focus-key="${key}"]`).click();
    const start = performance.now();
    let reversed = false;
    do {
      await new Promise(requestAnimationFrame);
      if (reverse && !reversed && performance.now() - start > 70) { document.querySelector(`[data-focus-key="${reverse}"]`).click(); reversed = true; }
      frames.push(frame());
    } while (performance.now() - start < 850);
    return frames;
  }, { key, reverse: options.reverse });
  results.push({ name, frames });
  const transientY = frames.slice(1).some((frame) => frame.scrollHeight > frame.height + 1);
  console.log(`${name}: horizontal=${Math.max(...frames.map((frame) => frame.scrollWidth - frame.width))}, vertical=${transientY}, footerTravel=${Math.round(Math.max(...frames.map((frame) => frame.footerY)) - Math.min(...frames.map((frame) => frame.footerY)))}`);
  if (baseline) return;
  assert.ok(frames.every((frame) => frame.scrollWidth <= frame.width + 1), `${name}: horizontal overflow`);
  if (!options.long) assert.equal(transientY, false, `${name}: transient vertical overflow`);
  assert.ok(frames.every((frame) => frame.footerSame && frame.footerOpacity === "1"), `${name}: footer remounted or faded`);
  assert.ok(frames.every((frame) => frame.exiting.every((row) => row.inert)), `${name}: exiting rows interactive`);
  assert.equal(frames.at(-1).exiting.length, 0, `${name}: stale exiting rows`);
  assert.ok(frames.at(-1).scrollHeight <= frames.at(-1).height + 1, `${name}: scrollbar remains after short result settles`);
  if (options.monotonic) {
    const positions = frames.map((frame) => frame.footerY), direction = Math.sign(positions.at(-1) - positions[0]);
    assert.ok(positions.slice(1).every((position, index) => direction * (position - positions[index]) >= -1), `${name}: footer reverses during empty state exit`);
  }
}
async function settleClick(key) { await page.locator(`[data-focus-key="${key}"]`).click(); await page.waitForTimeout(850); }
try {
  await mkdir(output, { recursive: true });
  for (const scale of baseline ? [80] : [80, 100, 120]) {
    await page.goto(`${origin}/tests/fixtures/collection-transitions.html?scale=${scale}`);
    await page.locator('[data-focus-key="collection-status-unread"]').waitFor();
    await page.waitForTimeout(900);
    await sample("collection-status-unread", `${scale}: reading to unread`);
    await settleClick("collection-status-done");
    await sample("collection-status-unread", `${scale}: empty done to unread`, { monotonic: true });
    await settleClick("collection-status-all");
    await settleClick("category-plan");
    await sample("category-uncategorized", `${scale}: plan to uncategorized`);
    await sample("category-plan", `${scale}: rapid category reversal`, { reverse: "category-uncategorized" });
    await page.screenshot({ path: `${output}/collection-${scale}-${baseline ? "before" : "after"}.png` });
  }
  if (!baseline) {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await sample("category-plan", "reduced motion category");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(`${origin}/tests/fixtures/collection-transitions.html?count=60`);
    await page.locator('[data-focus-key="collection-status-unread"]').waitFor();
    await page.waitForTimeout(900);
    const scroll = page.locator(".workspace-list-scroll");
    await scroll.hover(); await page.mouse.wheel(0, 600); await page.waitForTimeout(200);
    assert.ok(await scroll.evaluate((node) => node.scrollTop > 0), "long list wheel scrolling");
    await page.locator('[data-material-id="fixture-12"]').focus(); await page.keyboard.press("End");
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.materialId), "fixture-59", "long list keyboard navigation");
    await sample("collection-status-unread", "long scrolled list to unread", { long: true });
    assert.equal(await scroll.evaluate((node) => node.scrollTop), 0, "filter resets scroll");
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(`${output}/${baseline ? "before" : "after"}.json`, JSON.stringify({ errors, results }, null, 2));
  await browser.close();
}
