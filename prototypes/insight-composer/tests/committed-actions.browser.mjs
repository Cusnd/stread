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
const page = await browser.newPage();
const errors = [], checks = [];
page.on("pageerror", error => errors.push(error.message));
page.on("request", request => { assert.ok(!new URL(request.url()).pathname.startsWith("/api/"), "fixture must not access workspace data"); });
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const current = () => page.evaluate(() => window.initialCommittedActions.read("argument"));
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/committed-actions.html`);
  await page.waitForFunction(() => document.querySelector("output")?.textContent === "initial:1:0");
  assert.deepEqual(await current(), { label: "initial", count: 0, handler: 1, suffix: "argument" });
  await page.getByRole("button", { name: "Increment", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("output")?.textContent === "initial:1:1");
  assert.equal((await current()).count, 1);
  check("retained callback reads current local state and forwards arguments/results");

  await page.evaluate(() => window.actionFixture.replace());
  await page.waitForFunction(() => document.querySelector("output")?.textContent === "replacement:2:1");
  assert.deepEqual(await current(), { label: "replacement", count: 1, handler: 2, suffix: "argument" });
  assert.equal(await page.evaluate(() => window.committedActions === window.initialCommittedActions && Object.keys(window.committedActions).every(key => window.committedActions[key] === window.initialCommittedActions[key])), true);
  await page.getByRole("button", { name: "Invoke retained handler" }).click();
  assert.deepEqual(await page.evaluate(() => window.committedActionCalls.at(-1)), { label: "replacement", count: 1, handler: 2 });
  check("same action object and callback identities call replacement handlers with current props");

  await page.evaluate(() => window.actionFixture.suspend());
  await page.waitForFunction(() => window.pendingActionRenderSeen);
  assert.deepEqual(await current(), { label: "replacement", count: 1, handler: 2, suffix: "argument" });
  await page.getByRole("button", { name: "Invoke retained handler" }).click();
  assert.deepEqual(await page.evaluate(() => window.committedActionCalls.at(-1)), { label: "replacement", count: 1, handler: 2 });
  check("suspended uncommitted render cannot replace live event handlers");

  await page.evaluate(() => window.actionFixture.release());
  await page.waitForFunction(() => document.querySelector("output")?.textContent === "pending:3:1");
  assert.deepEqual(await current(), { label: "pending", count: 1, handler: 3, suffix: "argument" });
  assert.equal(await page.evaluate(() => window.committedActions === window.initialCommittedActions), true);
  check("released transition updates handlers only after commit without changing identity");
  assert.deepEqual(errors, []);
  const output = fileURLToPath(new URL("../../../.audit/input-performance-2026-10-25/", import.meta.url));
  await mkdir(output, { recursive: true });
  await writeFile(output + "committed-actions-results.json", JSON.stringify({ checks, errors }, null, 2) + "\n");
} finally {
  await browser.close();
  await server.close();
}
