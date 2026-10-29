import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const require = createRequire(process.env.READER_TEST_NODE_MODULES ? `${process.env.READER_TEST_NODE_MODULES}/reader-tests.cjs` : import.meta.url);
const { chromium } = require("playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, open: false, proxy: {} }, clearScreen: false });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/authoring-fields-fixture.html`);
  await page.locator("#table-paired").waitFor();
  const caption = id => page.locator(`#${id} figcaption`);
  const captionVariants = id => caption(id).locator("[data-field=caption]").evaluateAll(nodes => nodes.map(node => node.dataset.variant));
  for (const id of ["figure-translated", "table-translated"]) assert.equal(await caption(id).count(), 0, "source mode has no invented caption");
  for (const id of ["figure-paired", "table-paired"]) assert.deepEqual(await captionVariants(id), ["source"]);
  assert.equal(await page.locator(".paper-header .katex").count(), 1, "original article title renders its formula");
  assert.equal(await page.locator(".toc-label .katex").count(), 1, "original heading-derived TOC renders its formula");
  assert.equal(await page.locator(".paper-toc-link a").count(), 0, "link labels never create nested navigation anchors");
  assert.equal(await page.locator(".paper-toc-link").getAttribute("href"), "#heading-math");
  await page.locator(".paper-toc-link").click();
  assert.equal(new URL(page.url()).hash, "#heading-math");

  for (const mode of ["translation", "bilingual"]) {
    await page.evaluate(value => window.authoringFields.setMode(value), mode);
    await caption("table-translated").waitFor();
    for (const id of ["figure-translated", "table-translated"]) {
      assert.deepEqual(await captionVariants(id), ["zh-CN"], "a translated-only caption has no empty source placeholder");
      assert.equal(await caption(id).locator(".katex").count(), 1, "stored inline math renders in the caption");
      const paragraph = caption(id).locator("[data-field=caption]");
      assert.equal(await paragraph.getAttribute("data-block-id"), id);
      assert.equal(await paragraph.getAttribute("data-source-length"), String("译文图注 $x_i^2$".length));
      assert.ok((await paragraph.textContent()).startsWith(id.startsWith("figure") ? "译文图注" : "译文表注"));
    }
    for (const id of ["figure-paired", "table-paired"]) assert.deepEqual(await captionVariants(id), mode === "translation" ? ["zh-CN"] : ["source", "zh-CN"]);
    assert.equal(await page.locator(".paper-header .katex").count(), mode === "translation" ? 1 : 2, "translated and bilingual titles render formulas");
    assert.equal(await page.locator(".toc-label .katex").count(), 1);
    assert.ok((await page.locator(".toc-label").textContent()).includes("的证明与表格"));
    assert.equal(await page.locator(".paper-toc-link a").count(), 0);
  }
  await page.evaluate(() => window.authoringFields.setTranslationFirst(true));
  await page.waitForFunction(() => document.querySelector("#table-paired figcaption [data-field=caption]")?.dataset.variant === "zh-CN");
  for (const id of ["figure-paired", "table-paired"]) assert.deepEqual(await captionVariants(id), ["zh-CN", "source"]);
  await page.evaluate(() => window.authoringFields.setTargetLanguage("fr"));
  await page.waitForFunction(() => document.querySelector("#table-translated figcaption") === null);
  for (const id of ["figure-translated", "table-translated"]) assert.equal(await caption(id).count(), 0, "absent target-language captions do not leak another translation");
  for (const id of ["figure-paired", "table-paired"]) assert.deepEqual(await captionVariants(id), ["source"]);
  await page.evaluate(() => window.authoringFields.setAuxiliary(true));
  await page.waitForFunction(() => document.querySelector(".toc-label")?.textContent === "Plain auxiliary label");
  assert.equal(await page.locator(".toc-label .katex").count(), 0);
  assert.equal(await page.locator(".paper-toc-link").getAttribute("href"), "#table-paired");
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, [], "the fixture does not access the user's workspace");
  console.log("PASS title/heading formulas, plain auxiliary navigation, non-nested TOC links and optional figure/table captions across language modes");
} finally {
  await browser?.close();
  await server.close();
}
