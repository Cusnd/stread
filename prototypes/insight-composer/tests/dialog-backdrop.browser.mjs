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
  import { ReadingSettings } from "./src/ReadingSettings.jsx";
  import { QueueTaskDialog } from "./src/workspace/QueueTaskDialog.jsx";
  import { ReaderRuntimeProvider } from "./src/ReaderRuntime.jsx";
  import { createPreviewReaderRuntime } from "./src/reader-runtime.js";
  import { ReaderInterfaceScale } from "./src/InterfaceScale.jsx";
  import { ContinuousMotion } from "./src/Motion.jsx";
  import "./src/styles.css";
  import "./src/workspace-shell.css";
  import "./src/workspace/workspace.css";
  import "./src/workspace/queue.css";
  const root = createRoot(document.getElementById("root"));
  const question = { id: "fixture-question", reference: "#Q00001", type: "question", body: "Synthetic question", title: "Question" };
  const note = { id: "fixture-note", reference: "#N00001", type: "note", body: "Synthetic note" };
  function Fixture({ kind, initiallyOpen }) {
    const [open, setOpen] = useState(initiallyOpen);
    const [nested, setNested] = useState(false);
    const [runtime] = useState(() => { const value = createPreviewReaderRuntime("modal-policy-fixture"); value.mode = "fixture"; return value; });
    const [draft, setDraft] = useState({ type: "correction", documentId: "fixture-document", body: "Preserve the draft" });
    const [fontSize, setFontSize] = useState(20);
    window.setFixtureOpen = setOpen;
    window.setNestedOpen = setNested;
    window.setFixtureScale = percent => runtime.uiScale.update(percent);
    const onClose = () => setOpen(false);
    const props = { open, onClose };
    const fields = <form className="workspace-form workspace-edit-form">{Array.from({ length: 12 }, (_, index) => <label key={index} className="workspace-field"><span>{"Field " + index}</span><input aria-label={"Field " + index} defaultValue={"Draft " + index} /></label>)}<footer className="workspace-dialog-actions"><button type="button" className="ui-button" data-ui-button="text" onClick={onClose}>Cancel form</button><button type="button" className="ui-button" data-ui-button="submit">Save form</button></footer></form>;
    return <ReaderRuntimeProvider value={runtime}><ContinuousMotion><ReaderInterfaceScale />{kind === "service" ? <ServiceDialog {...props} title="Service dialog">{fields}</ServiceDialog>
      : kind === "workspace" ? <WorkspaceDialog {...props} title="Workspace dialog"><input aria-label="Title" /></WorkspaceDialog>
      : kind === "form" ? <WorkspaceDialog {...props} title="Workspace form">{fields}</WorkspaceDialog>
      : kind === "queue" ? <QueueTaskDialog draft={open ? draft : null} workspace={{ documents: [{ id: "fixture-document", title: "Fixture document" }] }} onChange={patch => setDraft(value => ({ ...value, ...patch }))} onSave={() => {}} onClose={onClose} />
      : kind === "settings" ? <ReadingSettings {...props} fontSize={fontSize} onFontSizeChange={setFontSize} readingWidthPercent={80} onReadingWidthChange={() => {}} showMargins={false} onMarginsChange={() => {}} openMode="sidebar" onOpenModeChange={() => {}} />
      : kind === "navigation" ? <WorkspaceDialog {...props} title="Navigation" size="navigation" className="workspace-navigation-dialog"><nav><button type="button">Current section</button></nav></WorkspaceDialog>
      : kind === "nested" ? <><WorkspaceDialog {...props} title="Outer dialog"><button id="nested-trigger" onClick={() => setNested(true)}>Open nested</button></WorkspaceDialog><ServiceDialog open={nested} onClose={() => setNested(false)} title="Inner dialog"><input aria-label="Nested input" /></ServiceDialog></>
      : kind === "question" ? <QuestionDetail {...props} question={question} readOnly />
      : <MarginGroupDetail {...props} groupId="fixture-group" notes={[note]} readOnly />}</ContinuousMotion></ReaderRuntimeProvider>;
  }
  let key = 0;
  window.mountFixture = (kind, initiallyOpen = false) => root.render(<React.StrictMode><Fixture key={++key} kind={kind} initiallyOpen={initiallyOpen} /></React.StrictMode>);
  window.unmountFixture = () => root.render(null);
  window.recordDialog = (duration = 650) => {
    const frames = [], start = performance.now();
    window.dialogFrames = new Promise(resolve => {
      function record() {
        const dialog = document.querySelector("dialog[open]");
        const surface = dialog?.querySelector(":scope > .ui-modal-surface") || dialog;
        const style = surface && getComputedStyle(surface);
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
      const surface = dialog?.querySelector(":scope > .ui-modal-surface") || dialog;
      return surface && getComputedStyle(surface).opacity === "1" && getComputedStyle(surface).transform === "none";
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
    // Allow subpixel rounding at the final sample, not a separate backdrop clock.
    assert.ok(maxBlur <= 0.25, `${label}: blur persists after surface fades (${maxBlur}px)`);
    assert.ok(maxAlpha <= initial.alpha * 0.13 + 0.004, `${label}: tint persists after surface fades (${maxAlpha})`);
    assert.equal(frames.at(-1).open, false, `${label}: native modal eventually closes`);
    console.log(`PASS ${label}: residual blur=${maxBlur.toFixed(3)}px, tint=${maxAlpha.toFixed(3)}`);
  };
  const closeLabels = { service: "关闭", workspace: "关闭面板", form: "关闭面板", queue: "关闭面板", settings: "关闭设置", navigation: "关闭面板", question: "关闭问题详情", margin: "关闭段落批注" };
  for (const kind of Object.keys(closeLabels)) {
    await page.evaluate(kind => mountFixture(kind), kind);
    await page.waitForFunction(() => typeof setFixtureOpen === "function");
    await page.locator("#trigger").focus();
    await page.evaluate(() => { recordDialog(); setFixtureOpen(true); });
    const opening = await page.evaluate(() => dialogFrames);
    await settled();
    assert.ok(opening.some(frame => frame.open && frame.opacity > 0 && frame.opacity < 1), `${kind}: opening fade occurs`);
    assert.ok(opening.at(-1).alpha > 0.1, `${kind}: backdrop visible when open`);
    assert.equal(opening.at(-1).blur, 2, `${kind}: ordinary modal uses shared blur`);
    assert.ok(Math.abs(opening.at(-1).alpha - 56 / 255) < 0.005, `${kind}: ordinary modal uses shared tint`);
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
    await page.mouse.click(kind === "navigation" ? 1275 : 5, 5);
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

  // The same lifecycle applies when a modal starts another modal. Check both
  // normal closing order and a disappearing invoking layer, using real clicks.
  const nestedSamples = [];
  const recordNested = () => page.evaluate(() => {
    const started = performance.now(), frames = [];
    window.nestedBackdropFrames = new Promise(resolve => {
      function record() {
        const layers = [...document.querySelectorAll("dialog:modal")].map(dialog => {
          const style = getComputedStyle(dialog, "::backdrop");
          const rgba = style.backgroundColor.match(/[\d.]+/g)?.map(Number) || [];
          return { alpha: rgba.length === 4 ? rgba[3] : rgba.length === 3 ? 1 : 0,
            blur: Number(style.backdropFilter.match(/blur\(([\d.]+)px\)/)?.[1] || 0) };
        });
        frames.push({ time: performance.now() - started, layers,
          alpha: 1 - layers.reduce((remaining, layer) => remaining * (1 - layer.alpha), 1),
          blur: Math.sqrt(layers.reduce((sum, layer) => sum + layer.blur ** 2, 0)) });
        if (performance.now() - started < 650) requestAnimationFrame(record);
        else resolve(frames);
      }
      record();
    });
  });
  const checkNested = async phase => {
    const frames = await page.evaluate(() => nestedBackdropFrames);
    nestedSamples.push({ phase, frames });
    await writeFile(resolve(output, "nested-frames.json"), JSON.stringify(nestedSamples, null, 2));
    assert.ok(frames.some(frame => frame.layers.length === 2), `${phase}: sampled overlapping modal lifetimes`);
    for (const frame of frames) {
      assert.equal(frame.layers.filter(layer => layer.alpha > 0.005).length, 1, `${phase}: one native backdrop owns the scene`);
      assert.ok(Math.abs(frame.alpha - 56 / 255) <= 0.005, `${phase}: nested transition must not double tint or flash transparent at ${frame.time}ms`);
      assert.ok(Math.abs(frame.blur - 2) <= 0.02, `${phase}: nested transition must not double blur or flash clear at ${frame.time}ms`);
    }
  };
  await page.evaluate(() => mountFixture("nested"));
  await page.waitForFunction(() => document.querySelector('.workspace-dialog[aria-labelledby]'));
  await open();
  await recordNested();
  await page.getByRole("button", { name: "Open nested", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("dialog:modal").length === 2);
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.workspace-service-dialog')).opacity) === 1);
  await page.waitForTimeout(180);
  assert.equal(await page.locator('.workspace-dialog').evaluate(dialog => parseFloat(getComputedStyle(dialog, "::backdrop").backgroundColor.match(/[\d.]+/g).at(-1))), 0, "covered modal does not stack another dark backdrop");
  await checkNested("nested open");
  await recordNested();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll("dialog:modal").length === 1);
  assert.equal((await rootStyle()).overflow, "hidden", "closing nested layer retains the outer scroll lock");
  assert.equal(await page.evaluate(() => document.activeElement.id), "nested-trigger", "child returns focus to its invoking control");
  await checkNested("nested close");
  await page.getByRole("button", { name: "Open nested", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("dialog:modal").length === 2);
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.workspace-service-dialog')).opacity) === 1);
  await page.getByRole("textbox", { name: "Nested input", exact: true }).focus();
  await recordNested();
  await page.evaluate(() => setFixtureOpen(false));
  await page.waitForFunction(() => !document.querySelector('.workspace-dialog').open);
  assert.equal(await page.getByRole("textbox", { name: "Nested input", exact: true }).evaluate(node => document.activeElement === node), true, "closing a lower layer does not steal focus");
  assert.equal((await rootStyle()).overflow, "hidden", "closing a lower layer retains the child lock");
  await checkNested("lower layer closes first");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await restored("out-of-order nested close");
  console.log("PASS nested dialogs: one backdrop through every frame of opening, closing and out-of-order closure; independent locks and focus return");

  const geometry = [];
  for (const percent of [80, 100, 120]) {
    for (const height of [900, 420]) {
      await page.setViewportSize({ width: 1280, height });
      for (const kind of ["service", "form", "queue", "settings"]) {
        await page.evaluate(kind => mountFixture(kind), kind);
        await page.waitForFunction(() => !document.querySelector("dialog[open]"));
        await page.evaluate(percent => setFixtureScale(percent), percent);
        await open();
        const bounds = await page.evaluate(() => {
          const dialog = document.querySelector("dialog:modal");
          const surface = dialog.querySelector(":scope > .ui-modal-surface") || dialog;
          const rect = surface.getBoundingClientRect();
          const heading = surface.querySelector("header").getBoundingClientRect();
          const primary = surface.querySelector('[data-ui-button="submit"], .settings-footer button')?.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom,
            headingTop: heading.top, headingBottom: heading.bottom, primaryTop: primary?.top, primaryBottom: primary?.bottom,
            horizontalOverflow: surface.scrollWidth - surface.clientWidth, viewportWidth: innerWidth, viewportHeight: innerHeight };
        });
        geometry.push({ kind, percent, height, bounds });
        assert.ok(bounds.x >= -1 && bounds.right <= bounds.viewportWidth + 1 && bounds.y >= -1 && bounds.bottom <= height + 1, `${kind} ${percent}% ${height}px: surface fits the window`);
        assert.ok(bounds.headingTop >= bounds.y - 1 && bounds.headingBottom <= bounds.bottom + 1, `${kind} ${percent}% ${height}px: heading remains reachable`);
        assert.ok(bounds.primaryTop >= bounds.y && bounds.primaryBottom <= bounds.bottom + 1, `${kind} ${percent}% ${height}px: primary action remains visible`);
        assert.ok(bounds.horizontalOverflow <= 1, `${kind} ${percent}% ${height}px: no horizontal overflow`);
        await page.getByRole("button", { name: closeLabels[kind], exact: true }).click();
        await restored(`${kind} ${percent}% ${height}px`);
      }
    }
  }
  await writeFile(resolve(output, "geometry.json"), JSON.stringify(geometry, null, 2));
  console.log("PASS modal geometry: service/simple form/Queue/Settings at 80%, 100%, 120% and 900px/420px heights");
  assert.deepEqual(errors, [], "no browser runtime errors");
} finally {
  await browser?.close();
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}
