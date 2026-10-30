import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_TEST_NODE_MODULES ? resolve(process.env.READER_TEST_NODE_MODULES, "playwright") : "playwright");
const bundle = await build({ stdin: { contents: `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { ImageLightbox } from "./src/ImageLightbox.jsx";
  const root = createRoot(document.getElementById("root"));
  const src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="white"/></svg>');
  window.calls = [];
  window.continuousReaderDesktop = { setTitlebarDark: dark => calls.push(dark) };
  window.closeFixture = () => root.render(null);
  window.openFixture = () => root.render(<ImageLightbox image={{ index: 0, slides: [{ src, alt: "Synthetic figure" }, { src, alt: "Second figure" }] }} onClose={closeFixture} />);
`, resolveDir: frontend, loader: "jsx" }, bundle: true, write: false, outfile: "fixture.js", format: "iife", platform: "browser", jsx: "automatic", logLevel: "silent" });
const script = bundle.outputFiles.find(file => file.path.endsWith(".js")).text;
const styles = bundle.outputFiles.find(file => file.path.endsWith(".css")).text;
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<!doctype html><html><head><style>' + styles + '</style></head><body><div id="root"></div><script>' + script + '</script></body></html>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ reducedMotion: "no-preference" });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const modal = page.locator(".reader-image-lightbox");
  const open = async () => {
    await page.evaluate(() => openFixture());
    await page.waitForFunction(() => document.querySelector('[aria-label="放大图片"]')?.disabled === false);
  };
  await open();
  assert.deepEqual(await page.evaluate(() => calls), [true]);
  assert.equal(await modal.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(25, 26, 28)");
  const closing = await page.evaluate(() => {
    document.querySelector('[aria-label="关闭大图"]').click();
    const element = document.querySelector(".reader-image-lightbox");
    return { calls: [...calls], closing: element?.dataset.closing, duration: element && getComputedStyle(element).transitionDuration };
  });
  assert.deepEqual(closing.calls, [true], "native symbols stay light while the dark surface fades out");
  assert.equal(closing.closing, "true");
  assert.notEqual(closing.duration, "0s");
  await modal.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => calls), [true, false]);
  console.log("PASS image preview requests light symbols until its exit completes");

  await open();
  assert.deepEqual(await page.evaluate(() => calls), [true, false, true]);
  await page.evaluate(() => closeFixture());
  await modal.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => calls), [true, false, true, false]);
  console.log("PASS reopening and direct unmount restore native symbol contrast");

  await page.evaluate(() => { delete window.continuousReaderDesktop; });
  await open();
  await page.getByRole("button", { name: "关闭大图", exact: true }).click();
  await modal.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => calls), [true, false, true, false]);
  assert.deepEqual(errors, []);
  console.log("PASS ordinary browser preview works without a native bridge");
} finally {
  await browser?.close();
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}
