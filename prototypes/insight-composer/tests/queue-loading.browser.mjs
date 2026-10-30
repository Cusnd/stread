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
  import React, { useState } from "react";
  import { createRoot } from "react-dom/client";
  import { QueuePage } from "./src/workspace/QueuePage.jsx";
  import { ContinuousMotion } from "./src/Motion.jsx";
  import { NavigationLoadingLine } from "./src/NavigationLoadingLine.jsx";
  import { getSnapshot, subscribe } from "./src/navigation-loading.js";
  import "./src/styles.css";
  window.loadingEvents = [];
  window.loadingSnapshot = getSnapshot;
  subscribe(() => window.loadingEvents.push(getSnapshot()));
  function Fixture() {
    const [mounted, setMounted] = useState(true);
    const [view, setView] = useState({ type: "conversion", status: "pending", navigationExpanded: true });
    window.unmountQueue = () => setMounted(false);
    return <ContinuousMotion><header style={{ position: "relative", height: 56 }}>Queue<NavigationLoadingLine /></header>{mounted && <QueuePage workspace={{ revision: 1, documents: [] }} view={view} setView={setView} command={async () => { throw new Error("Read-only fixture"); }} openDocument={async () => {}} />}</ContinuousMotion>;
  }
  createRoot(document.getElementById("root")).render(<React.StrictMode><Fixture /></React.StrictMode>);
`, resolveDir: frontend, loader: "jsx" }, bundle: true, write: false, outdir: "queue-loading-fixture", format: "iife", platform: "browser", jsx: "automatic", logLevel: "silent" });
const javascript = bundle.outputFiles.find(file => file.path.endsWith(".js")).text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css")).text;
const server = createServer((request, response) => {
  const script = request.url === "/fixture.js", css = request.url === "/fixture.css";
  response.setHeader("Content-Type", script ? "text/javascript" : css ? "text/css" : "text/html; charset=utf-8");
  response.end(script ? javascript : css ? stylesheet : '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const tasks = [
  { id: "conversion", reference: "#T00001", type: "conversion", title: "Convert fixture" },
  { id: "correction", reference: "#T00002", type: "correction", title: "Correct fixture" },
].map(task => ({ ...task, status: "pending", version: 1, body: "A complete task available in the list.", createdAt: "2026-10-29T09:33:00Z" }));
const requests = [], errors = [];
let revision = 1, delayMs = 650, failType = null, browser;
async function waitUntil(condition, message) {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
  assert.ok(condition(), message);
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  page.setDefaultTimeout(5000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(request.method(), "GET", "fixture must not write");
    const item = { path: url.pathname, type: url.searchParams.get("type"), done: false };
    requests.push(item);
    await new Promise(done => setTimeout(done, delayMs));
    try {
      if (url.pathname === "/api/queue") {
        if (item.type === failType) await route.fulfill({ status: 500, json: { error: "Fixture list failed" } });
        else {
          const visible = tasks.filter(task => item.type === "all" || task.type === item.type);
          await route.fulfill({ json: { tasks: visible, total: visible.length, revision, counts: { pending: visible.length }, allCounts: { pending: 2 }, typeCounts: { all: 2, conversion: 1, correction: 1 } } });
        }
      } else if (url.pathname.startsWith("/api/queue/")) {
        await route.fulfill({ json: { task: tasks.find(task => task.id === url.pathname.split("/").at(-1)) } });
      } else { errors.push(`Unexpected API: ${url.pathname}`); await route.abort(); }
    } finally { item.done = true; }
  });
  const activeLine = () => page.locator("header .navigation-loading-line[data-phase='active']").waitFor();
  const idle = async () => {
    await page.waitForFunction(() => window.loadingSnapshot().pendingCount === 0 && !window.loadingSnapshot().visible);
    assert.equal(await page.locator(".navigation-loading-line").count(), 0, "shared line releases after work finishes");
  };
  const noLoadingPlaceholder = async () => {
    assert.equal(await page.locator(".queue-empty").count(), 0, "pending reads do not render a premature empty state");
    assert.equal(await page.getByText("正在读取队列…", { exact: true }).count(), 0, "Queue does not use a separate text loader");
  };

  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await activeLine(); await noLoadingPlaceholder();
  await page.locator('[data-task-id="conversion"]').waitFor(); await idle();
  console.log("PASS initial Queue read uses the shared header line and waits before empty-state rendering");

  await page.locator('[data-focus-key="queue-type-question"]').click();
  await activeLine(); await noLoadingPlaceholder();
  await page.getByText("队列中还没有任务", { exact: true }).waitFor(); await idle();
  console.log("PASS an empty category shows loading first and its empty state only after the read completes");

  await page.locator('[data-focus-key="queue-type-correction"]').click();
  await activeLine(); await noLoadingPlaceholder();
  await page.locator('[data-task-id="correction"]').waitFor(); await idle();
  await page.locator('[data-task-id="correction"] .queue-task-title').click();
  await activeLine();
  assert.equal(await page.locator('[data-task-id="correction"] .queue-task-title').getAttribute("aria-expanded"), "true", "title expands while its detail read is tracked");
  await idle();
  console.log("PASS category navigation and title detail reads share the header line");

  await page.evaluate(() => { window.loadingEvents = []; });
  const firstBackground = requests.length;
  revision += 1;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waitUntil(() => requests.slice(firstBackground).some(request => request.path === "/api/queue" && request.done), "background list refresh completes");
  await waitUntil(() => requests.slice(firstBackground).some(request => request.path === "/api/queue/correction" && request.done), "changed list refreshes selected detail");
  assert.deepEqual(await page.evaluate(() => window.loadingEvents.filter(event => event.busy || event.visible)), [], "background list and detail refreshes do not flash the header line");
  assert.equal(await page.locator('[data-task-id="correction"] .queue-task-title').getAttribute("aria-expanded"), "true");
  console.log("PASS background list and selected-detail refreshes stay quiet");

  failType = "translation";
  await page.locator('[data-focus-key="queue-type-translation"]').click();
  await activeLine(); await noLoadingPlaceholder();
  await page.getByText("Fixture list failed", { exact: true }).waitFor(); await idle();
  await page.getByRole("button", { name: "重新读取", exact: true }).waitFor();
  failType = null;
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await activeLine();
  await page.getByText("队列中还没有任务", { exact: true }).waitFor(); await idle();
  console.log("PASS failed reads release the line and retry tracks new foreground work");

  delayMs = 1000;
  await page.locator('[data-focus-key="queue-type-conversion"]').click(); await activeLine();
  await page.locator('[data-focus-key="queue-type-correction"]').click();
  await activeLine(); await noLoadingPlaceholder();
  await page.locator('[data-task-id="correction"]').waitFor(); await idle();
  assert.equal(await page.locator('[data-task-id="conversion"][data-motion-present="true"]').count(), 0, "cancelled response does not replace the current category");
  await page.locator('[data-task-id="correction"] .queue-task-title').click(); await activeLine();
  await page.evaluate(() => window.unmountQueue());
  await idle();
  await waitUntil(() => requests.every(request => request.done), "cancelled fixture requests finish cleanly");
  assert.deepEqual(errors, []);
  console.log("PASS rapid navigation and unmount cancel tracked reads without stale content or stuck loading");
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
