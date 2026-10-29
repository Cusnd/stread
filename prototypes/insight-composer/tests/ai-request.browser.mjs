import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.READER_TEST_NODE_MODULES ? `${process.env.READER_TEST_NODE_MODULES}/reader-tests.cjs` : import.meta.url);
const { chromium } = require("playwright");
const origin = process.env.READER_TEST_URL || "http://127.0.0.1:5191";
const output = process.env.READER_TEST_OUTPUT || fileURLToPath(new URL("../../../.audit/ai-request-scope/", import.meta.url));
const browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(8000);
const errors = [], apiRequests = [], checks = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push({ method: request.method(), url: request.url() }); });
const input = () => page.getByRole("textbox", { name: "请求内容", exact: true });
const composer = () => page.getByRole("dialog", { name: "AI 请求", exact: true });
const paragraph = (id = "intro", variant = "source") => page.locator(`.article [data-block-id="${id}"][data-variant="${variant}"]`).first();
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };
async function reset(query = "") {
  await page.goto(`${origin}/tests/fixtures/ai-request.html${query}`);
  await paragraph().waitFor();
  await page.emulateMedia({ reducedMotion: "reduce" });
}
async function select(locator, quote) {
  await locator.scrollIntoViewIfNeeded();
  await page.locator(".article").focus();
  return locator.evaluate((element, quote) => {
    const text = element.textContent;
    const start = text.indexOf(quote);
    if (start < 0) throw new Error(`Missing selection: ${quote}`);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    const point = (offset) => {
      for (const node of nodes) { if (offset <= node.textContent.length) return [node, offset]; offset -= node.textContent.length; }
      throw new Error("Text offset outside fixture");
    };
    const range = document.createRange(); range.setStart(...point(start)); range.setEnd(...point(start + quote.length));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const bounds = range.getClientRects()[0];
    return { start, end: start + quote.length, x: bounds.left + Math.min(bounds.width / 2, 20), y: bounds.top + bounds.height / 2 };
  }, quote);
}
async function requestFromSelection(locator, quote) {
  const range = await select(locator, quote);
  await page.mouse.click(range.x, range.y, { button: "right" });
  if (quote === "beta gamma") {
    await page.getByRole("menuitem", { name: "AI 请求", exact: true }).waitFor();
    await page.screenshot({ path: `${output}/context-menu.png` });
  }
  await page.getByRole("menuitem", { name: "AI 请求", exact: true }).click();
  await input().waitFor();
  return range;
}
async function requestFromTarget(locator) {
  await locator.scrollIntoViewIfNeeded();
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await locator.click({ button: "right" });
  await page.getByRole("menuitem", { name: "AI 请求", exact: true }).click();
  await input().waitFor();
}
async function save(body = "请下载相关论文并解释它与本文的关系。") {
  await input().fill(body);
  await page.getByRole("button", { name: "保存 AI 请求", exact: true }).click();
  await page.locator(".composer").waitFor({ state: "detached" });
  return page.evaluate(() => window.aiRequestFixture.writes.at(-1).input);
}
async function openByR() {
  await page.locator(".article").focus();
  await page.keyboard.press("r");
  await input().waitFor();
}
async function assertWholeArticle() {
  assert.equal(await page.locator(".request-context-source").textContent(), "整篇文章");
  assert.equal(await page.locator(".article").getAttribute("data-selecting-request"), "false");
  assert.equal(await page.locator(".article .draft-highlight").count(), 0);
  assert.equal(await page.getByRole("button", { name: "选择请求范围", exact: true }).getAttribute("aria-pressed"), "false");
  const bounds = await composer().boundingBox(), viewport = page.viewportSize();
  const headerBottom = await page.locator(".topbar").evaluate((element) => element.getBoundingClientRect().bottom);
  assert.ok(bounds.y >= headerBottom, `Whole-article composer must open below chrome: ${JSON.stringify(bounds)}`);
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) <= 1, `Whole-article composer must be centered: ${JSON.stringify(bounds)}`);
}
function sourceIs(actual, expected) { for (const [key, value] of Object.entries(expected)) assert.equal(actual.source?.[key], value, `${key}: ${JSON.stringify(actual)}`); }

try {
  await mkdir(output, { recursive: true });
  await reset(); await openByR(); await assertWholeArticle();
  assert.equal(await input().getAttribute("placeholder"), "希望 AI 做什么？");
  await page.screenshot({ path: `${output}/whole-article-request.png` });
  const whole = await save(); assert.equal(whole.source, undefined); assert.equal(whole.category, "instruction"); assert.equal(whole.revision, 3);
  check("R opens a general AI request for the whole article without source selection or highlighting");

  await reset(); await select(paragraph(), "beta gamma"); await page.keyboard.press("r"); await input().waitFor(); await assertWholeArticle();
  assert.equal(await page.evaluate(() => getSelection().toString()), "");
  assert.equal((await save("分析整篇文章的研究思路。")).source, undefined);
  check("R ignores an existing native text selection and saves a document-wide payload");

  await reset(); const range = await requestFromSelection(paragraph(), "beta gamma");
  assert.equal(await page.locator(".request-context-source").textContent(), "原文 · beta gamma");
  await page.screenshot({ path: `${output}/selected-text-request.png` });
  const selected = await save();
  sourceIs(selected, { blockId: "intro", variant: "source", field: "text", start: range.start, end: range.end, quote: "beta gamma" });
  check("Selection context action preserves exact original-language field and offsets");
  await openByR(); await assertWholeArticle(); assert.equal((await save("新请求以全文为范围。")).source, undefined);
  check("Opening R after saving a sourced request resets placement and scope for the whole article");

  await reset(); const translatedRange = await requestFromSelection(paragraph("intro", "zh-CN"), "研究思路");
  const translated = await save(); sourceIs(translated, { blockId: "intro", variant: "zh-CN", field: "text", start: translatedRange.start, end: translatedRange.end, quote: "研究思路" });
  check("Translated selection requests retain translation identity and exact offsets");

  await reset(); await requestFromTarget(paragraph("second"));
  const paragraphRequest = await save(); sourceIs(paragraphRequest, { blockId: "second", variant: "source", field: "text", start: 0, quote: "Another paragraph for independent request targeting." });
  check("Unselected paragraph context action anchors the actual paragraph");

  await reset(); const listRange = await requestFromSelection(paragraph("items"), "stable list");
  const list = await save(); sourceIs(list, { blockId: "items", itemId: "item-one", field: "text", start: listRange.start, end: listRange.end, quote: "stable list" });
  check("List selection requests preserve list-item identity");

  const cell = () => page.locator('[data-block-id="table-one"][data-field="rows"][data-row="0"][data-column="0"][data-variant="source"]');
  await reset(); await requestFromTarget(cell());
  const table = await save(); sourceIs(table, { blockId: "table-one", field: "rows", row: 0, column: 0, variant: "source", quote: "Stable cell alpha" });
  check("Table object context requests retain exact row and column");
  await reset(); const cellRange = await requestFromSelection(cell(), "cell alpha");
  const tableSelection = await save(); sourceIs(tableSelection, { blockId: "table-one", field: "rows", row: 0, column: 0, start: cellRange.start, end: cellRange.end, quote: "cell alpha" });
  check("Table text selection takes priority over the surrounding object menu");

  await reset(); const keyboardRange = await select(paragraph(), "gamma delta"); await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "AI 请求", exact: true }).click();
  const keyboardRequest = await save(); sourceIs(keyboardRequest, { blockId: "intro", field: "text", start: keyboardRange.start, end: keyboardRange.end, quote: "gamma delta" });
  check("Keyboard context menu creates a request from the captured selection");

  await reset(); await requestFromTarget(page.locator('#figure-one img'));
  const image = await save(); sourceIs(image, { blockId: "figure-one", field: "caption", quote: "Architecture figure caption" });
  check("Image context requests use its real caption source");

  await reset(); const bareImage = page.locator('#figure-no-caption img');
  await bareImage.evaluate(async (image) => { image.loading = "eager"; await image.decode(); });
  await bareImage.scrollIntoViewIfNeeded(); await page.waitForTimeout(100);
  const bareBounds = await bareImage.boundingBox();
  await page.mouse.click(bareBounds.x + 30, Math.max(80, bareBounds.y + 30), { button: "right" });
  await page.getByRole("menuitem", { name: "打开大图", exact: true }).waitFor();
  assert.equal(await page.getByRole("menuitem", { name: "打开大图", exact: true }).count(), 1);
  assert.equal(await page.getByRole("menuitem", { name: "AI 请求", exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.aiRequestFixture.writes), []);
  check("Images without a visible indexed source keep their object menu without inventing a request anchor");

  await reset(); await openByR(); await page.getByRole("button", { name: "选择请求范围", exact: true }).click();
  assert.equal(await page.locator(".article").getAttribute("data-selecting-request"), "true");
  await paragraph("second").click();
  assert.equal(await page.locator(".article").getAttribute("data-selecting-request"), "false");
  assert.match(await page.locator(".request-context-source").textContent(), /Another paragraph/);
  await page.getByRole("button", { name: "清除请求范围，改为整篇文章", exact: true }).click(); await assertWholeArticle();
  assert.equal((await save("整篇文章范围已恢复。")).source, undefined);
  check("Explicit scope selection can attach content and clearing it restores whole-article writes");

  await reset(); await openByR(); await page.getByRole("button", { name: "选择请求范围", exact: true }).click();
  const manualRange = await select(paragraph("second"), "independent request");
  await page.waitForFunction(() => document.querySelector(".request-context-source")?.textContent === "原文 · independent request");
  const manual = await save(); sourceIs(manual, { blockId: "second", field: "text", start: manualRange.start, end: manualRange.end, quote: "independent request" });
  check("Explicit range selection attaches a newly selected exact excerpt");

  await reset(); await requestFromSelection(paragraph(), "beta gamma"); await input().fill("保留草稿正文");
  await paragraph("second").click({ button: "right" });
  assert.equal(await page.getByRole("menuitem", { name: "AI 请求", exact: true }).count(), 0);
  await page.getByRole("menuitem", { name: "继续当前草稿", exact: true }).click();
  assert.equal(await input().inputValue(), "保留草稿正文");
  assert.equal(await page.locator(".request-context-source").textContent(), "原文 · beta gamma");
  await page.locator(".article").focus(); await page.keyboard.press("r");
  assert.equal(await input().inputValue(), "保留草稿正文");
  const resumed = await save("保留草稿正文"); sourceIs(resumed, { blockId: "intro", quote: "beta gamma" });
  check("Context continuation and R preserve an existing draft body and selected source");

  await reset(); await page.emulateMedia({ reducedMotion: "no-preference" }); await openByR(); await input().fill("退出过程中继续编辑");
  await page.waitForTimeout(250);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".composer").getAttribute("data-closing"), "true");
  await page.locator(".article").focus(); await page.keyboard.press("r");
  await page.waitForTimeout(300);
  assert.equal(await input().inputValue(), "退出过程中继续编辑");
  assert.equal(await page.locator(".composer").getAttribute("data-closing"), null);
  check("R reverses an unfinished composer exit without stale callbacks discarding the draft");

  await reset(); await page.getByRole("textbox", { name: "快捷键隔离输入", exact: true }).fill("");
  await page.keyboard.type("r"); assert.equal(await composer().count(), 0);
  assert.equal(await page.getByRole("textbox", { name: "快捷键隔离输入", exact: true }).inputValue(), "r");
  await openByR(); await input().fill(""); await page.keyboard.type("r"); assert.equal(await input().inputValue(), "r");
  check("Typing R in ordinary inputs or the composer never invokes the Reader shortcut");

  await reset("?readonly"); await page.locator(".article").focus(); await page.keyboard.press("r");
  assert.equal(await composer().count(), 0);
  await paragraph().click({ button: "right" });
  assert.equal(await page.getByRole("menuitem", { name: "AI 请求", exact: true }).isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.aiRequestFixture.writes), []);
  check("Read-only readers reject R and disable request context actions");

  assert.deepEqual(errors, []); assert.deepEqual(apiRequests, []);
  check("All checks use isolated memory and issue no workspace API requests or browser exceptions");
  await writeFile(`${output}/browser-checks.json`, JSON.stringify({ checks, errors, apiRequests, viewport: [1440, 960] }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  await writeFile(`${output}/failure.json`, JSON.stringify({ checks, errors, apiRequests, message: String(error) }, null, 2));
  console.error({ errors, checks }); throw error;
} finally { await browser.close(); }
