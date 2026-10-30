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
  import { WorkspaceDialog } from "./src/WorkspaceDialog.jsx";
  const root = createRoot(document.getElementById("root"));
  window.fixtureKey = 0;
  window.renderDialog = open => root.render(<React.StrictMode><WorkspaceDialog key={fixtureKey} open={open} title="Test import" onClose={() => renderDialog(false)}><input aria-label="Title" /></WorkspaceDialog></React.StrictMode>);
  window.unmountFixture = () => root.render(null);
`, resolveDir: frontend, loader: "jsx" }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", logLevel: "silent" });
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<!doctype html><html><head><style>html{scrollbar-gutter:stable}body{margin:0;min-height:2000px}dialog::backdrop{background:#24242428}</style></head><body><button id="trigger">Open</button><div id="root"></div><script>' + bundle.outputFiles[0].text + '</script></body></html>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const original = await page.evaluate(() => ({ overflow: document.documentElement.style.overflow, gutter: document.documentElement.style.scrollbarGutter, padding: document.documentElement.style.paddingRight }));
  const rootState = () => page.evaluate(() => ({ open: document.querySelector("dialog")?.open, overflow: document.documentElement.style.overflow, gutter: getComputedStyle(document.documentElement).scrollbarGutter }));
  const open = async () => {
    await page.evaluate(() => renderDialog(true));
    await page.waitForFunction(() => document.querySelector("dialog")?.open && getComputedStyle(document.querySelector("dialog")).opacity === "1");
    assert.deepEqual(await rootState(), { open: true, overflow: "hidden", gutter: "auto" });
  };
  const close = async () => {
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("dialog")?.open);
    assert.deepEqual(await page.evaluate(() => ({ overflow: document.documentElement.style.overflow, gutter: document.documentElement.style.scrollbarGutter, padding: document.documentElement.style.paddingRight })), original);
    assert.equal(await page.evaluate(() => document.activeElement.id), "trigger");
  };
  await page.locator("#trigger").focus();
  await open();
  await close();
  await open();
  await close();
  console.log("PASS initially open StrictMode dialog locks on first mount and repeated reopen");

  await page.evaluate(() => { fixtureKey++; renderDialog(false); });
  await page.waitForFunction(() => document.querySelector("dialog")?.dataset.state === "closed");
  await open();
  await close();
  console.log("PASS initially closed StrictMode dialog locks after opening");

  await open();
  await page.evaluate(() => unmountFixture());
  await page.locator("dialog").waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => ({ overflow: document.documentElement.style.overflow, gutter: document.documentElement.style.scrollbarGutter, padding: document.documentElement.style.paddingRight })), original);
  assert.deepEqual(errors, []);
  console.log("PASS unmount restores root scroll styles");
} finally {
  await browser?.close();
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}
