import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const frontend = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(frontend, "../../.audit/conversion-feedback/navigation");
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_TEST_NODE_MODULES ? resolve(process.env.READER_TEST_NODE_MODULES, "playwright") : "playwright");
const vite = await createServer({ configFile: false, root: frontend, plugins: [react()], clearScreen: false, server: { host: "127.0.0.1", port: 0, open: false } });
await vite.listen();
const browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : { channel: "msedge" }) });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const result = { checks: [], pageErrors: [] };
page.on("pageerror", (error) => result.pageErrors.push(error.message));
const pass = (name) => { result.checks.push(name); console.log("PASS " + name); };
const settle = () => page.waitForFunction(() => !document.querySelector('.reader-app[data-layout-moving="true"]'));
const show = async (index) => { await page.evaluate((value) => window.navigationFixture.show(value), index); await settle(); };
try {
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/tests/fixtures/reader-navigation.html`);
  await page.locator(".reader-app").waitFor();
  assert.equal(await page.locator("#reader-toc").count(), 0);
  assert.equal(await page.locator(".toc-toggle").count(), 0);
  assert.equal(await page.locator(".reader-main").evaluate((element) => getComputedStyle(element).marginLeft), "0px");
  assert.equal(await page.evaluate(() => window.navigationFixture.view().tocMode), "pinned");
  pass("no headings or auxiliary navigation: no empty sidebar, trigger or reserved width; pinned preference retained");
  await page.screenshot({ path: resolve(output, "empty.png") });

  await show(1);
  await page.getByRole("navigation", { name: "阅读导航", exact: true }).waitFor();
  assert.equal(await page.locator(".paper-toc-link").count(), 4);
  assert.equal(await page.locator(".paper-heading").count(), 0);
  assert.ok(await page.locator(".reader-main").evaluate((element) => parseFloat(getComputedStyle(element).marginLeft)) > 200);
  assert.equal(await page.locator(".toc-toggle").getAttribute("aria-pressed"), "true");
  pass("auxiliary navigation appears and restores pinned width without inserting source headings");

  for (const id of ["equation", "html", "para-24", "para-0"]) {
    await page.locator(`.paper-toc-link[href="#${id}"]`).click();
    await page.waitForFunction((target) => document.querySelector('.paper-toc-link[aria-current="location"]')?.getAttribute("href") === `#${target}`, id);
    const top = await page.locator(`#${id}`).evaluate((element) => element.getBoundingClientRect().top);
    assert.ok(top > 50 && top < 160, `${id}: target top ${top}`);
  }
  pass("paragraph, equation and authored HTML anchors navigate exactly and update the active entry");
  await page.locator('.reader-mode-option').filter({ has: page.locator('input[value="translation"]') }).click();
  await page.waitForFunction(() => document.querySelector('.paper-toc-link[href="#equation"] .toc-label')?.textContent === "误差导数");
  assert.equal(await page.locator(".paper-heading").count(), 0);
  pass("auxiliary labels follow language selection independently of source content");
  await page.screenshot({ path: resolve(output, "auxiliary.png") });

  await show(3);
  assert.equal(await page.locator(".paper-source-details").evaluate((element) => element.open), false);
  await page.locator('.paper-toc-link[href="#author-note"]').click();
  await page.waitForFunction(() => document.querySelector(".paper-source-details")?.open);
  const frontmatter = await page.locator("#author-note").evaluate((element) => ({ top: element.getBoundingClientRect().top, visible: element.checkVisibility() }));
  assert.equal(frontmatter.visible, true);
  assert.ok(frontmatter.top > 50 && frontmatter.top < 160);
  pass("navigation to closed front matter opens its disclosure and reaches the existing source block");
  await show(1);

  await page.locator(".toc-toggle").click();
  await page.mouse.move(1000, 500);
  await page.waitForFunction(() => document.querySelector("#reader-toc")?.inert);
  assert.equal(await page.evaluate(() => window.navigationFixture.view().tocMode), "collapsed");
  await page.locator(".toc-toggle").hover();
  await page.waitForFunction(() => document.querySelector("#reader-toc")?.dataset.state === "open");
  await page.locator('.paper-toc-link[href="#equation"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("#reader-toc")?.inert);
  assert.equal(await page.locator(".article").evaluate((element) => document.activeElement === element), true);
  pass("collapsed auxiliary navigation keeps hover preview and keyboard jump with focus return");

  await show(0);
  await page.waitForFunction(() => !document.querySelector("#reader-toc"));
  await show(1);
  assert.equal(await page.locator("#reader-toc").getAttribute("data-state"), "closed");
  assert.equal(await page.evaluate(() => window.navigationFixture.view().tocMode), "collapsed");
  await page.locator(".toc-toggle").click();
  await show(0);
  await page.waitForFunction(() => !document.querySelector("#reader-toc"));
  await show(2);
  await page.getByRole("navigation", { name: "文章目录", exact: true }).waitFor();
  assert.equal(await page.locator(".paper-toc-link").count(), 1);
  assert.equal(await page.locator(".toc-title").innerText(), "目录");
  assert.equal(await page.locator(".toc-toggle").getAttribute("aria-pressed"), "true");
  pass("empty article preserves collapsed or pinned choice; source headings take precedence when returning");

  await page.setViewportSize({ width: 1000, height: 850 });
  await page.evaluate(() => window.navigationFixture.scale(120));
  await show(1);
  await page.waitForFunction(() => document.querySelectorAll(".paper-toc-link").length === 4);
  await settle();
  const geometry = await page.locator("#reader-toc").evaluate((element) => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width }));
  assert.equal(geometry.left, 0);
  assert.ok(geometry.width > 300 && geometry.right < 1000);
  assert.equal(result.pageErrors.length, 0, result.pageErrors.join("\n"));
  pass("desktop resize and 120% interface scale retain navigation geometry without browser errors");
  await page.screenshot({ path: resolve(output, "desktop-1000-scale120.png") });

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => window.navigationFixture.show(0));
  await page.waitForFunction(() => !document.querySelector("#reader-toc") || document.querySelector("#reader-toc").inert);
  await page.evaluate(() => window.navigationFixture.show(1));
  await page.waitForFunction(() => document.querySelector("#reader-toc")?.dataset.state === "open" && !document.querySelector("#reader-toc").inert);
  await settle();
  await page.evaluate(() => window.navigationFixture.show(0));
  await page.waitForFunction(() => !document.querySelector("#reader-toc"));
  await settle();
  assert.equal(await page.locator(".reader-main").evaluate((element) => getComputedStyle(element).marginLeft), "0px");
  assert.equal(await page.evaluate(() => window.navigationFixture.view().tocMode), "pinned");
  pass("normal motion makes a removed navigation inert, survives rapid restoration and releases its column after exit");
} finally {
  await writeFile(resolve(output, "verification.json"), JSON.stringify(result, null, 2));
  await browser.close();
  await vite.close();
}
