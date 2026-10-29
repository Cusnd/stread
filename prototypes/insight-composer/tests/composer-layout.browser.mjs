import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const require = createRequire(process.env.READER_TEST_NODE_MODULES ? `${process.env.READER_TEST_NODE_MODULES}/reader-tests.cjs` : import.meta.url);
const { chromium } = require("playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, open: false, proxy: {} }, clearScreen: false });
await server.listen();
const browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [], checks = [];
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => { assert.ok(!new URL(request.url()).pathname.startsWith("/api/"), "fixture must never access workspace API"); });
const field = page.getByRole("textbox", { name: "洞见内容", exact: true });
const settle = () => page.waitForTimeout(420);
const geometry = () => page.locator(".composer").evaluate(surface => {
  const input = surface.querySelector("textarea"), rect = input.getBoundingClientRect();
  return { mode: surface.dataset.layout, lines: Number(surface.dataset.visibleLines), height: rect.height, width: rect.width, value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input, scrollTop: input.scrollTop, scrollHeight: input.scrollHeight, clientHeight: input.clientHeight, overflow: getComputedStyle(input).overflowY, anchor: surface.dataset.anchor, inert: surface.inert };
});
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/composer-layout-fixture.html`);
  await field.waitFor();
  await settle();
  await field.fill("first line"); await settle();
  await field.evaluate(input => { window.originalComposerTextarea = input; });
  assert.equal((await geometry()).mode, "compact");
  check("one visual line remains compact");

  for (const lines of [2, 5, 10]) {
    await field.fill(Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n")); await settle();
    const result = await geometry();
    assert.equal(result.mode, "expanded");
    assert.equal(result.lines, Math.min(lines, 5));
    assert.ok(Math.abs(result.height - Math.min(lines, 5) * 22) < 1, JSON.stringify(result));
    assert.equal(result.overflow, lines > 5 ? "auto" : "hidden");
    assert.equal(await field.evaluate(input => input === window.originalComposerTextarea), true);
    check(`${lines} lines preserve textarea identity and five-line height cap`);
  }
  assert.ok((await geometry()).scrollTop > 0, "long paste keeps final caret visible");
  check("long paste scrolls to the end caret after geometry settles");
  await field.fill("short"); await settle();
  assert.equal((await geometry()).mode, "expanded");
  await field.fill(""); await settle();
  assert.equal((await geometry()).mode, "compact");
  check("expanded layout latches until cleared");

  await field.fill("1".repeat(1200)); await settle();
  const unbroken = await geometry();
  assert.equal(unbroken.lines, 5);
  assert.ok(unbroken.scrollHeight > unbroken.clientHeight);
  assert.ok(unbroken.scrollTop >= unbroken.scrollHeight - unbroken.clientHeight - 2, JSON.stringify(unbroken));
  check("long unbroken text wraps and the final caret stays visible");
  await field.press("Home");
  await field.press("ArrowLeft");
  const selected = await geometry();
  await page.evaluate(() => window.composerFixture.setWidth(520)); await settle();
  const resized = await geometry();
  assert.equal(resized.start, selected.start);
  assert.equal(resized.end, selected.end);
  assert.equal(resized.focused, true);
  assert.equal(resized.anchor, selected.anchor);
  check("resize preserves focus, selection and anchor side");

  await field.fill(""); await settle();
  await field.dispatchEvent("compositionstart", { data: "中" });
  await field.fill("中文输入法组合".repeat(40)); await settle();
  assert.equal((await geometry()).mode, "compact");
  await field.dispatchEvent("compositionend", { data: "中文输入法组合".repeat(40) }); await settle();
  assert.equal((await geometry()).mode, "expanded");
  assert.equal((await geometry()).value, "中文输入法组合".repeat(40));
  check("IME composition keeps geometry stable and measures on completion");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await field.fill(""); await settle();
  await field.fill(Array.from({ length: 10 }, (_, i) => `reduced ${i}`).join("\n")); await settle();
  const reduced = await geometry();
  assert.equal(reduced.lines, 5);
  assert.ok(reduced.scrollTop >= reduced.scrollHeight - reduced.clientHeight - 2);
  check("live reduced motion preserves five-line cap and end caret");
  await page.evaluate(() => window.composerFixture.setTitleExpanded(true)); await settle();
  await page.getByRole("textbox", { name: "洞见标题（可选）" }).fill("Independent title");
  await page.getByRole("textbox", { name: "洞见标题（可选）" }).press("Enter");
  assert.equal((await geometry()).focused, true);
  assert.equal(await page.evaluate(() => window.composerFixture.read().title), "Independent title");
  check("title retains its value and Enter returns focus to same textarea");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => { window.composerFixture.setTitleExpanded(false); window.composerFixture.setWidth(640); });
  await field.fill("x"); await settle();
  await page.evaluate(() => {
    window.composerReads = { rect: 0, style: 0, observers: 0 };
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (...args) { if (this.classList.contains("composer-measure")) window.composerReads.rect++; return rect.apply(this, args); };
    const style = window.getComputedStyle;
    window.getComputedStyle = function (element, ...args) { if (element.classList.contains("composer")) window.composerReads.style++; return style.call(this, element, ...args); };
    const Observer = window.ResizeObserver;
    window.ResizeObserver = class extends Observer { constructor(...args) { window.composerReads.observers++; super(...args); } };
  });
  await field.pressSequentially("abcdefghijklmnopqrst", { delay: 10 }); await settle();
  const reads = await page.evaluate(() => window.composerReads);
  assert.deepEqual(reads, { rect: 0, style: 0, observers: 0 });
  check("same-line continuous typing performs no mirror geometry reads, surface style reads or observer recreation");
  await page.evaluate(() => window.composerFixture.setClosing(true));
  await page.waitForFunction(() => document.querySelector(".composer").inert);
  check("closing surface is immediately inert");
  assert.deepEqual(errors, []);
  const output = fileURLToPath(new URL("../../../.audit/input-performance-2026-10-25/composer-layout-results.json", import.meta.url));
  await mkdir(fileURLToPath(new URL("../../../.audit/input-performance-2026-10-25/", import.meta.url)), { recursive: true });
  await writeFile(output, JSON.stringify({ checks, reads, errors }, null, 2));
} finally {
  await browser.close();
  await server.close();
}
