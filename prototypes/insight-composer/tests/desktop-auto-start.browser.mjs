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
  import { DesktopAutoStart } from "./src/DesktopAutoStart.jsx";
  const root = createRoot(document.getElementById("root"));
  window.renderControl = (active, mounted = true) => root.render(mounted ? <DesktopAutoStart active={active} /> : null);
  const pending = [];
  window.calls = [];
  const defer = (method, value) => {
    calls.push({ method, value });
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  window.installBridge = () => { window.continuousReaderDesktop = { autoStart: { get: () => defer("get"), set: enabled => defer("set", enabled) } }; };
  window.settle = (index, enabled, error) => error ? pending[index].reject(new Error(error)) : pending[index].resolve({ enabled });
  renderControl(true);
`, resolveDir: frontend, loader: "jsx" }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", logLevel: "silent" });
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<!doctype html><html><body><div id="root"></div><script>' + bundle.outputFiles[0].text + '</script></body></html>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.READER_TEST_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const control = page.getByRole("switch", { name: "开机自启" });
  const count = expected => page.waitForFunction(value => calls.length === value, expected);
  const state = expected => page.waitForFunction(value => {
    const button = document.querySelector('[role="switch"]');
    return button && !button.disabled && button.getAttribute("aria-checked") === String(value);
  }, expected);
  assert.equal(await control.count(), 0, "browser builds expose no desktop setting");
  await page.evaluate(() => { installBridge(); renderControl(false); });
  await control.waitFor();
  assert.equal(await page.evaluate(() => calls.length), 0, "inactive page does not query the desktop");
  await page.evaluate(() => renderControl(true));
  await count(1);
  assert.equal(await control.isDisabled(), true, "initial read cannot be mistaken for an editable default");
  await page.evaluate(() => settle(0, true));
  await state(true);

  await control.click();
  await count(2);
  assert.equal(await control.isDisabled(), true);
  assert.equal(await control.getAttribute("aria-checked"), "true", "saving does not optimistically change system state");
  await control.evaluate(button => button.click());
  assert.deepEqual(await page.evaluate(() => calls[1]), { method: "set", value: false });
  assert.equal(await page.evaluate(() => calls.length), 2, "a pending write cannot be duplicated");
  await page.evaluate(() => settle(1, false));
  await state(false);

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await count(3);
  await page.evaluate(() => settle(2, true));
  await state(true);
  console.log("PASS desktop state, confirmed writes, pending lock and external focus refresh");

  await control.click();
  await count(4);
  await page.evaluate(() => settle(3, false, "系统未能保存设置"));
  await page.getByRole("alert").waitFor();
  assert.equal(await control.isDisabled(), true, "a failed save requires fresh system state");
  assert.match(await page.getByRole("alert").textContent(), /系统未能保存设置/);
  await page.getByRole("button", { name: "重试" }).click();
  await count(5);
  await page.evaluate(() => settle(4, true));
  await state(true);
  assert.equal(await page.getByRole("alert").count(), 0);
  console.log("PASS write errors remain visible and retry reloads confirmed system state");

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await count(6);
  await page.evaluate(() => renderControl(false));
  await page.evaluate(() => renderControl(true));
  await count(7);
  await page.evaluate(() => settle(6, true));
  await state(true);
  await page.evaluate(() => settle(5, false));
  await state(true);
  console.log("PASS a stale read cannot replace state from a reopened settings page");

  await control.click();
  await count(8);
  await page.evaluate(() => renderControl(false));
  await page.evaluate(() => renderControl(true));
  assert.equal(await page.evaluate(() => calls.length), 8, "reopening waits for the pending save");
  await page.evaluate(() => settle(7, false));
  await count(9);
  await page.evaluate(() => settle(8, false));
  await state(false);
  await control.focus();
  await page.keyboard.press("Space");
  await count(10);
  assert.deepEqual(await page.evaluate(() => calls[9]), { method: "set", value: true });
  await page.evaluate(() => settle(9, true));
  await state(true);
  console.log("PASS reopening during save refreshes afterward and keyboard activation works");

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await count(11);
  await page.evaluate(() => renderControl(false, false));
  await page.evaluate(() => settle(10, false));
  assert.equal(await control.count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS pending completion after unmount produces no browser errors");
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
