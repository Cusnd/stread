import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(frontend, "../../.audit/design-system-feedback");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_TEST_NODE_MODULES ? resolve(process.env.READER_TEST_NODE_MODULES, "playwright") : "playwright");
const bundle = await build({ stdin: { contents: `
  import React, { useState } from "react";
  import { createRoot } from "react-dom/client";
  import { ContinuousMotion } from "./src/Motion.jsx";
  import { InlineError, EmptyState, CopyFeedback, useClipboardFeedback } from "./src/Feedback.jsx";
  import { ActionError } from "./src/workspace/shared.jsx";
  import "./src/styles.css";
  import "./src/workspace/workspace.css";
  import "./src/workspace-shell.css";
  window.clipboardJobs = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText(text) {
    return new Promise((resolve, reject) => window.clipboardJobs.push({ text, resolve, reject }));
  } } });
  function Fixture() {
    const [message, setMessage] = useState("");
    const [draft, setDraft] = useState("Keep this draft");
    const clip = useClipboardFeedback();
    window.feedbackFixture = { setMessage, clear: clip.clear };
    return <ContinuousMotion><main className="workspace-ui" style={{ padding: 24, maxWidth: 650 }}>
      <label className="workspace-field">Draft<input aria-label="Draft" value={draft} onChange={e=>setDraft(e.target.value)} /></label>
      <button onClick={()=>setMessage("A recoverable error with a long explanation. ".repeat(5))}>Show error</button>
      <section id="workspace-error"><ActionError message={message} onDismiss={()=>setMessage("")} /></section>
      <section id="service-error"><InlineError className="workspace-service-error" message={message} /></section>
      <button id="copy-a" onClick={()=>clip.copy("A", {key:"A"})}>Copy A</button>
      <button id="copy-b" onClick={()=>clip.copy("B", {key:"B"})}>Copy B</button>
      <CopyFeedback message={clip.feedback?.message} /><output id="copy-result">{JSON.stringify(clip.feedback)}</output>
      <EmptyState action={<button>Retry search</button>}>No matching items</EmptyState>
    </main></ContinuousMotion>;
  }
  createRoot(document.getElementById("root")).render(<React.StrictMode><Fixture /></React.StrictMode>);
`, resolveDir: frontend, loader: "jsx" }, bundle: true, write: false, outdir: "feedback-fixture", platform: "browser", format: "iife", jsx: "automatic", logLevel: "silent" });
const javascript = bundle.outputFiles.find(f => f.path.endsWith(".js")).text;
const stylesheet = bundle.outputFiles.find(f => f.path.endsWith(".css")).text;
const server = createServer((request, response) => {
  const script = request.url === "/fixture.js", css = request.url === "/fixture.css";
  response.setHeader("Content-Type", script ? "text/javascript" : css ? "text/css" : "text/html; charset=utf-8");
  response.end(script ? javascript : css ? stylesheet : '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
await mkdir(output, { recursive: true });
const results = [], errors = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole("button", { name: "Show error" }).click();
  await page.waitForTimeout(650);
  const recipes = await page.locator(".ui-feedback-error").evaluateAll(nodes => nodes.map(node => {
    const s = getComputedStyle(node); return [s.color, s.backgroundColor, s.borderColor, s.borderRadius, s.fontSize];
  }));
  assert.deepEqual(recipes[0], recipes[1], "workspace and service errors use the same visual role");
  await page.getByLabel("Draft").fill("unsaved text remains");
  await page.getByRole("button", { name: "关闭错误提示" }).click();
  const closing = await page.locator("#workspace-error .motion-feedback").evaluate(node => ({ hidden: node.getAttribute("aria-hidden"), inert: node.inert, text: node.textContent }));
  assert.equal(closing.hidden, "true"); assert.equal(closing.inert, true);
  assert.match(closing.text, /recoverable error/, "exit retains the old error instead of flashing empty content");
  await page.getByRole("button", { name: "Show error" }).click();
  await page.waitForTimeout(650);
  assert.equal(await page.getByLabel("Draft").inputValue(), "unsaved text remains");
  assert.equal(await page.locator("#workspace-error .motion-feedback").getAttribute("aria-hidden"), null);
  results.push("Shared error style, exit content, close/reopen reversal, retained draft");

  await page.locator("#copy-a").click(); await page.locator("#copy-b").click();
  assert.equal(await page.locator("#copy-result").textContent(), "null", "pending clipboard writes cannot claim success");
  await page.evaluate(() => window.clipboardJobs[1].resolve());
  await page.waitForFunction(() => document.getElementById("copy-result").textContent.includes('"key":"B"'));
  await page.evaluate(() => window.clipboardJobs[0].reject(new Error("old request failed")));
  await page.waitForTimeout(50);
  assert.match(await page.locator("#copy-result").textContent(), /"key":"B","ok":true/, "late old failure cannot replace latest success");
  await page.locator("#copy-a").click();
  await page.evaluate(() => window.clipboardJobs[2].reject(new Error("blocked")));
  await page.waitForFunction(() => document.getElementById("copy-result").textContent.includes('"ok":false'));
  await page.waitForTimeout(2500);
  assert.match(await page.locator("#copy-result").textContent(), /"ok":false/, "failure does not silently expire");
  await page.locator("#copy-b").click();
  await page.evaluate(() => window.clipboardJobs[3].resolve());
  await page.waitForFunction(() => document.getElementById("copy-result").textContent === "null", { timeout: 4000 });
  results.push("Clipboard pending, out-of-order settlement, persistent failure and successful retry lifetime");

  await page.setViewportSize({ width: 320, height: 800 });
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "1.5"));
  await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "long error wraps at narrow width and 120% scale");
  await page.screenshot({ path: resolve(output, "narrow-error.png"), fullPage: true });
  await page.evaluate(() => window.feedbackFixture.setMessage(""));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => !document.querySelector("#workspace-error .motion-feedback"));
  assert.equal(await page.getByRole("button", { name: "Retry search" }).isEnabled(), true);
  results.push("Long error at 320px/120%, live reduced-motion exit, accessible empty-state recovery");
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, "report.json"), JSON.stringify({ results, errors }, null, 2));
  results.forEach(result => console.log("PASS " + result));
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
