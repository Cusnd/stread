import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Point READER_TEST_NODE_MODULES to a runtime providing Playwright when needed.
const require = createRequire(process.env.READER_TEST_NODE_MODULES ? `${process.env.READER_TEST_NODE_MODULES}/reader-tests.cjs` : import.meta.url);
const { chromium } = require("playwright");
const origin = process.env.READER_TEST_URL || "http://127.0.0.1:5186";
const output = fileURLToPath(new URL("../evidence/image-viewer/", import.meta.url));
const browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(6000);
const errors = [], requests = [], checks = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push({ method: request.method(), url: request.url() }); });
const button = (name) => page.getByRole("button", { name, exact: true });
const modal = page.locator(".reader-image-lightbox");
const picture = page.locator(".viewer-canvas > img");
const settled = () => page.waitForTimeout(220);
const ready = () => page.waitForFunction(() => document.querySelector('[aria-label="放大图片"]')?.disabled === false, null, { timeout: 6000 });
const transform = () => picture.evaluate((element) => element.style.transform);
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };
async function assertFits() {
  await page.waitForFunction(() => {
    const bounds = document.querySelector(".viewer-canvas > img")?.getBoundingClientRect();
    return bounds && bounds.width > 0 && bounds.x >= 71 && bounds.right <= innerWidth - 71 && bounds.y >= 63 && bounds.bottom <= innerHeight - 103;
  }, null, { timeout: 6000 });
  await settled();
  const bounds = await picture.boundingBox(), viewport = page.viewportSize();
  assert.ok(bounds.x >= 71 && bounds.x + bounds.width <= viewport.width - 71, JSON.stringify(bounds));
  assert.ok(bounds.y >= 63 && bounds.y + bounds.height <= viewport.height - 103, JSON.stringify(bounds));
}

try {
  await mkdir(output, { recursive: true });
  await page.goto(`${origin}/evidence/image-viewer/fixture.html`);
  const trigger = page.locator('.article img[src$="figure-4.png"]');
  await trigger.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => ({ scroll: scrollY, srcs: [...document.querySelectorAll(".article img")].map((image) => image.src), overflow: document.documentElement.style.overflow, gutter: document.documentElement.style.scrollbarGutter, padding: document.body.style.paddingRight }));
  await trigger.click(); await ready();
  assert.equal(await modal.count(), 1);
  assert.equal(await page.locator(".reader-image-counter").textContent(), "4/5");
  await button("向右旋转 90° (R)").click();
  assert.match(await transform(), /rotate\(90deg\)/);
  await assertFits();
  await page.screenshot({ path: `${output}/attention-rotated.png` });
  check("Attention figure 4 rotates upright and fits clear of toolbar");

  await button("水平翻转").click(); await button("垂直翻转").click();
  assert.match(await transform(), /scaleX\(-1\).*scaleY\(-1\)/);
  assert.equal(await button("水平翻转").getAttribute("aria-pressed"), "true");
  assert.equal(await button("垂直翻转").getAttribute("aria-pressed"), "true");
  await button("水平翻转").click(); await button("垂直翻转").click();
  assert.match(await transform(), /rotate\(90deg\)/);
  check("Both mirror axes toggle independently without clearing rotation");

  await button("原始大小").click(); await settled();
  assert.equal(await page.locator(".reader-image-ratio").textContent(), "100%");
  const original = await picture.boundingBox();
  await page.mouse.move(720, 460); await page.mouse.down(); await page.mouse.move(800, 510, { steps: 8 }); await page.mouse.up();
  const moved = await picture.boundingBox();
  assert.ok(Math.abs(moved.x - original.x) > 60 && Math.abs(moved.y - original.y) > 30);
  await page.mouse.wheel(0, -160); await settled();
  assert.notEqual(await page.locator(".reader-image-ratio").textContent(), "100%");
  await button("适应窗口 (0)").click(); await assertFits();
  assert.match(await transform(), /rotate\(90deg\)/);
  await page.mouse.dblclick(720, 460); await settled();
  assert.equal(await page.locator(".reader-image-ratio").textContent(), "100%");
  await page.mouse.dblclick(720, 460); await assertFits();
  check("Pixel zoom, pointer drag, wheel zoom, double-click and fit preserve orientation");

  await page.setViewportSize({ width: 1000, height: 720 }); await assertFits();
  assert.match(await transform(), /rotate\(90deg\)/);
  await page.evaluate(() => { document.documentElement.dataset.desktopTitlebar = "windows"; document.documentElement.style.setProperty("--desktop-controls-width", "138px"); });
  const closeBox = await button("关闭大图").boundingBox();
  assert.ok(closeBox.x + closeBox.width <= 1000 - 138);
  check("Resized desktop keeps rotated image fitted and close clear of native controls");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => document.querySelector(".reader-image-lightbox")?.dataset.reducedMotion === "true");
  assert.equal(await modal.getAttribute("data-reduced-motion"), "true");
  assert.match(await transform(), /rotate\(90deg\)/);
  await page.keyboard.press("Shift+R");
  assert.doesNotMatch(await transform(), /rotate\(90deg\)/);
  await button("水平翻转").click(); await button("重置图片").click();
  assert.equal(await transform(), "none");
  assert.equal(await button("水平翻转").getAttribute("aria-pressed"), "false");
  check("Live reduced-motion changes retain viewer state; shortcuts and reset work");

  await button("重置图片").focus(); await page.keyboard.press("Tab");
  assert.equal(await button("关闭大图").evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await button("重置图片").evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press("Escape"); await modal.waitFor({ state: "detached" });
  assert.equal(await trigger.evaluate((element) => (element.closest("a") || element) === document.activeElement), true);
  assert.equal(await page.locator("#root").evaluate((element) => element.inert), false);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => { delete document.documentElement.dataset.desktopTitlebar; });
  const after = await page.evaluate(() => ({ srcs: [...document.querySelectorAll(".article img")].map((image) => image.src), overflow: document.documentElement.style.overflow, gutter: document.documentElement.style.scrollbarGutter, padding: document.body.style.paddingRight }));
  assert.deepEqual(after, { srcs: before.srcs, overflow: before.overflow, gutter: before.gutter, padding: before.padding });
  check("Tab wraps and Escape restores trigger, background access and scroll styles");

  // An unresized opening verifies the exact reading position independently.
  await trigger.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => scrollY);
  await trigger.click(); await ready();
  assert.equal(await transform(), "none");
  await button("向右旋转 90° (R)").click();
  await button("关闭大图").click(); await modal.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => scrollY), scroll);
  check("Close/reopen resets temporary transforms and preserves exact reading scroll");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${origin}/evidence/image-lightbox/fixture.html`);
  const linked = page.locator(".article a img").first();
  await linked.click(); await ready();
  assert.equal(await page.locator(".reader-image-counter").textContent(), "2/3");
  assert.ok(page.url().includes("fixture.html"));
  await button("下一张图片").click();
  await page.locator(".reader-image-error").waitFor();
  assert.equal(await button("下一张图片").isDisabled(), true);
  assert.equal(await button("放大图片").isDisabled(), true);
  await page.keyboard.press("Escape");
  assert.equal(await modal.count(), 1);
  await page.keyboard.press("Control+."); await modal.waitFor({ state: "detached" });
  assert.equal(await linked.evaluate((element) => element.closest("a") === document.activeElement), true);
  check("Linked/bilingual images deduplicate; errors retain custom close and boundary focus");

  await page.locator(".article img").first().focus(); await page.keyboard.press("Enter"); await ready();
  await button("关闭大图").click();
  assert.equal(await modal.getAttribute("data-closing"), "true");
  assert.equal(await modal.evaluate((element) => element.inert), true);
  await modal.waitFor({ state: "detached" });
  await page.locator(".article img").first().focus(); await page.keyboard.press("Space"); await ready();
  await page.mouse.click(100, 200); await modal.waitFor({ state: "detached" });
  check("Enter/Space opening, inert exit transition and backdrop close work in StrictMode");
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  check("No page exceptions or workspace API requests in either isolated fixture");
  await writeFile(`${output}/browser-checks.json`, JSON.stringify({ checks, errors, requests, viewport: [1440, 960], resizedViewport: [1000, 720] }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  console.error({ errors, checks });
  throw error;
} finally { await browser.close(); }
