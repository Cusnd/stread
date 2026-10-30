import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_TEST_NODE_MODULES ? resolve(process.env.READER_TEST_NODE_MODULES, "playwright") : "playwright");
const baseline = process.env.READER_TEST_BASELINE === "1";
const output = resolve(frontend, "../../.audit/dialog-backdrop");
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: `
  import React, { useState } from "react";
  import { createRoot } from "react-dom/client";
  import { WorkspaceDialog as ServiceDialog } from "./src/WorkspaceDialog.jsx";
  import { WorkspaceDialog } from "./src/workspace/shared.jsx";
  import { QuestionDetail } from "./src/QuestionDetail.jsx";
  import { MarginGroupDetail } from "./src/MarginGroupDetail.jsx";
  import { ContinuousMotion } from "./src/Motion.jsx";
  import "./src/styles.css";
  import "./src/workspace-shell.css";
  import "./src/workspace/workspace.css";
  const root = createRoot(document.getElementById("root"));
  const question = { id: "fixture-question", reference: "#Q00001", type: "question", body: "Synthetic question", title: "Question" };
  const note = { id: "fixture-note", reference: "#N00001", type: "note", body: "Synthetic note" };
  function Fixture({ kind, initiallyOpen }) {
    const [open, setOpen] = useState(initiallyOpen);
    window.setFixtureOpen = setOpen;
    const onClose = () => setOpen(false);
    const props = { open, onClose };
    return <ContinuousMotion>{kind === "service" ? <ServiceDialog {...props} title="Service dialog"><input aria-label="Title" /></ServiceDialog>
      : kind === "workspace" ? <WorkspaceDialog {...props} title="Workspace dialog"><input aria-label="Title" /></WorkspaceDialog>
      : kind === "question" ? <QuestionDetail {...props} question={question} readOnly />
      : <MarginGroupDetail {...props} groupId="fixture-group" notes={[note]} readOnly />}</ContinuousMotion>;
  }
  let key = 0;
  window.mountFixture = (kind, initiallyOpen = false) => root.render(<React.StrictMode><Fixture key={++key} kind={kind} initiallyOpen={initiallyOpen} /></React.StrictMode>);
  window.unmountFixture = () => root.render(null);
  window.recordDialog = (duration = 650) => {
    const frames = [], start = performance.now();
    window.dialogFrames = new Promise(resolve => {
      function record() {
        const dialog = document.querySelector("dialog[open]");
        const style = dialog && getComputedStyle(dialog);
        const backdrop = dialog && getComputedStyle(dialog, "::backdrop");
        const rgba = backdrop?.backgroundColor.match(/[\\d.]+/g)?.map(Number) || [];
        frames.push({ time: performance.now() - start, open: Boolean(dialog), opacity: Number(style?.opacity || 0),
          alpha: rgba.length === 4 ? rgba[3] : rgba.length === 3 ? 1 : 0,
          blur: Number(backdrop?.backdropFilter.match(/blur\\(([\\d.]+)px\\)/)?.[1] || 0),
          inert: Boolean(dialog?.inert), state: dialog?.dataset.state,
          overflow: document.documentElement.style.overflow, focus: document.activeElement.id });
        if (performance.now() - start < duration) requestAnimationFrame(record);
        else resolve(frames);
      }
      record();
    });
  };
`, resolveDir: frontend, loader: "jsx" }, bundle: true, write: false, outdir: "dialog-backdrop-fixture", format: "iife", platform: "browser", jsx: "automatic", loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" }, logLevel: "silent",
  // Optional reproduction against the committed service backdrop, without
  // changing the working tree or the real application's profile.
  plugins: baseline ? [{ name: "committed-service-backdrop", setup(builder) {
    builder.onLoad({ filter: /workspace-shell\.css$/ }, () => ({ loader: "css", contents: execFileSync("git", ["show", "HEAD:prototypes/insight-composer/src/workspace-shell.css"], { cwd: frontend, encoding: "utf8" }) }));
  } }] : [],
});
const javascript = bundle.outputFiles.find(file => file.path.endsWith(".js")).text;
const stylesheet = bundle.outputFiles.find(file => file.path.endsWith(".css")).text;
const server = createServer((request, response) => {
  const script = request.url === "/fixture.js", css = request.url === "/fixture.css";
  response.setHeader("Content-Type", script ? "text/javascript" : css ? "text/css" : "text/html; charset=utf-8");
  response.end(script ? javascript : css ? stylesheet : '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/fixture.css"><style>body{min-height:2000px}#trigger{margin:20px}</style></head><body><button id="trigger">Open</button><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ reducedMotion: "no-preference", viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const rootStyle = () => page.evaluate(() => ({ overflow: document.documentElement.style.overflow, gutter: document.documentElement.style.scrollbarGutter, padding: document.documentElement.style.paddingRight }));
  const original = await rootStyle();
  const settled = async () => {
    await page.waitForFunction(() => {
      const dialog = document.querySelector("dialog[open]");
      return dialog && getComputedStyle(dialog).opacity === "1" && getComputedStyle(dialog).transform === "none";
    });
    assert.equal((await rootStyle()).overflow, "hidden");
  };
  const open = async () => {
    await page.locator("#trigger").focus();
    await page.evaluate(() => setFixtureOpen(true));
    await settled();
  };
  const restored = async label => {
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    assert.deepEqual(await rootStyle(), original, `${label}: scroll lock released`);
    assert.equal(await page.evaluate(() => document.activeElement.id), "trigger", `${label}: invoking control regains focus`);
  };
  const measurements = [];
  const checkClose = async (frames, label) => {
    assert.ok(frames.some(frame => frame.open && frame.inert), `${label}: closing content is inert`);
    assert.ok(frames.some(frame => frame.open && frame.opacity > 0.05 && frame.opacity < 0.95), `${label}: visible fade occurred`);
    const initial = frames.find(frame => frame.open);
    const faded = frames.filter(frame => frame.open && frame.opacity <= 0.01);
    assert.ok(faded.length, `${label}: observed invisible retained native dialog`);
    const maxBlur = Math.max(0, ...faded.map(frame => frame.blur));
    const maxAlpha = Math.max(0, ...faded.map(frame => frame.alpha));
    measurements.push({ label, maxBlur, maxAlpha, frames });
    await writeFile(resolve(output, baseline ? "baseline-frames.json" : "frames.json"), JSON.stringify(measurements, null, 2));
    // One 60 Hz frame of phase difference is allowed between CSS and Motion.
    assert.ok(maxBlur <= 0.25, `${label}: blur persists after surface fades (${maxBlur}px)`);
    assert.ok(maxAlpha <= initial.alpha * 0.13 + 0.004, `${label}: tint persists after surface fades (${maxAlpha})`);
    assert.equal(frames.at(-1).open, false, `${label}: native modal eventually closes`);
    console.log(`PASS ${label}: residual blur=${maxBlur.toFixed(3)}px, tint=${maxAlpha.toFixed(3)}`);
  };
  const closeLabels = { service: "关闭", workspace: "关闭面板", question: "关闭问题详情", margin: "关闭段落批注" };
  for (const kind of Object.keys(closeLabels)) {
    await page.evaluate(kind => mountFixture(kind), kind);
    await page.waitForFunction(() => typeof setFixtureOpen === "function");
    await page.locator("#trigger").focus();
    await page.evaluate(() => { recordDialog(); setFixtureOpen(true); });
    const opening = await page.evaluate(() => dialogFrames);
    await settled();
    assert.ok(opening.some(frame => frame.open && frame.opacity > 0 && frame.opacity < 1), `${kind}: opening fade occurs`);
    assert.ok(opening.at(-1).alpha > 0.1, `${kind}: backdrop visible when open`);
    if (kind === "service") assert.equal(opening.at(-1).blur, 2);
    if (kind === "service") await page.screenshot({ path: resolve(output, baseline ? "baseline-open.png" : "open.png") });

    await page.evaluate(() => recordDialog());
    await page.getByRole("button", { name: closeLabels[kind], exact: true }).click();
    if (kind === "service") {
      await page.waitForTimeout(55);
      await page.screenshot({ path: resolve(output, baseline ? "baseline-closing.png" : "closing.png") });
    }
    await checkClose(await page.evaluate(() => dialogFrames), `${kind} close button`);
    await restored(kind);
    if (kind === "service") await page.screenshot({ path: resolve(output, "closed.png") });

    await open();
    await page.evaluate(() => recordDialog());
    await page.keyboard.press("Escape");
    await checkClose(await page.evaluate(() => dialogFrames), `${kind} Escape`);
    await restored(kind);

    await open();
    await page.evaluate(() => recordDialog());
    await page.mouse.click(5, 5);
    await checkClose(await page.evaluate(() => dialogFrames), `${kind} backdrop click`);
    await restored(kind);

    await open();
    await page.evaluate(async () => {
      setFixtureOpen(false);
      await new Promise(resolve => setTimeout(resolve, 65));
      setFixtureOpen(true);
    });
    await settled();
    await page.waitForTimeout(250);
    assert.equal(await page.locator("dialog[open]").count(), 1, `${kind}: stale close cannot dismiss reopened dialog`);
    assert.equal(await page.locator("dialog[open]").evaluate(dialog => dialog.inert), false);
    await page.evaluate(() => setFixtureOpen(false));
    await restored(`${kind} reversed`);

    await open();
    await page.evaluate(() => setFixtureOpen(false));
    await page.waitForTimeout(40);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await restored(`${kind} live reduced motion`);
    await open();
    const reducedStyle = await page.locator("dialog[open]").evaluate(dialog => getComputedStyle(dialog, "::backdrop").transitionDuration);
    assert.ok(reducedStyle.split(",").every(value => parseFloat(value) === 0), `${kind}: reduced motion also disables backdrop transitions`);
    await page.evaluate(() => setFixtureOpen(false));
    await restored(`${kind} reduced motion`);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    await open();
    await page.evaluate(() => unmountFixture());
    await page.locator("dialog").waitFor({ state: "detached" });
    assert.deepEqual(await rootStyle(), original, `${kind}: unmount releases scroll lock`);
    assert.equal(await page.evaluate(() => document.activeElement.id), "trigger", `${kind}: unmount restores focus`);
    console.log(`PASS ${kind}: reversal, live reduced motion, focus, scrolling, StrictMode unmount`);
  }
  assert.deepEqual(errors, [], "no browser runtime errors");
} finally {
  await browser?.close();
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}
