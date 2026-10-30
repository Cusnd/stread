import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const frontend = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(frontend, "../../.audit/reader-overlay-motion");
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_TEST_NODE_MODULES ? resolve(process.env.READER_TEST_NODE_MODULES, "playwright") : "playwright");
const vite = await createServer({ configFile: false, root: frontend, cacheDir: resolve(frontend, "node_modules/.vite-reader-overlay-motion"), plugins: [react()], clearScreen: false, server: { host: "127.0.0.1", port: 0, open: false } });
await vite.listen();
let browser;
const evidence = { checks: [], samples: [], pageErrors: [] };
const check = name => { evidence.checks.push(name); console.log("PASS " + name); };

try {
  browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "no-preference" });
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => evidence.pageErrors.push(error.message));
  // This existing fixture mounts the real Reader, App overlays, settings and CSS
  // with an in-memory runtime. It has no workspace API or personal profile.
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/tests/fixtures/reader-opening.html?unpinned`);
  await page.getByRole("button", { name: "打开验证文章" }).click();
  await page.locator(".article").waitFor();
  await page.waitForTimeout(500);

  const surfaces = [
    { name: "insights", overlay: ".insights-overlay", panel: ".insights-modal", close: '.insights-modal [aria-label="关闭洞见"]', trigger: ".insight-tool", alpha: 48 / 255, key: "I", shiftKey: true },
    { name: "settings", overlay: ".settings-overlay", panel: ".settings", close: "[data-settings-close]", trigger: ".settings-tool", alpha: 56 / 255, blur: 2, key: ",", ctrlKey: true },
  ];
  const settleOpen = surface => page.waitForFunction(({ overlay, panel }) => {
    const backdrop = document.querySelector(overlay), content = document.querySelector(panel);
    return backdrop && !backdrop.inert && content && Number(getComputedStyle(content).opacity) === 1;
  }, surface);
  const settleClosed = surface => page.waitForFunction(({ overlay }) => {
    const backdrop = document.querySelector(overlay);
    return !backdrop || getComputedStyle(backdrop).visibility === "hidden";
  }, surface);
  const open = async surface => {
    await page.locator(surface.trigger).focus();
    await page.keyboard.press(surface.name === "insights" ? "Shift+I" : "Control+,");
    await settleOpen(surface);
    await page.waitForTimeout(350);
  };
  const startSample = (surface, reverse = false, opening = false) => page.evaluate(({ surface, reverse, opening }) => {
    const originalPanel = document.querySelector(surface.panel);
    window.overlayMotionFrames = [];
    window.overlayMotionDone = false;
    const started = performance.now();
    let reopened = false;
    const record = () => {
      const elapsed = performance.now() - started;
      if (reverse && !reopened && elapsed >= 60) {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: surface.key, shiftKey: Boolean(surface.shiftKey), ctrlKey: Boolean(surface.ctrlKey), bubbles: true }));
        reopened = true;
      }
      const overlay = document.querySelector(surface.overlay), panel = document.querySelector(surface.panel);
      const style = overlay && getComputedStyle(overlay);
      const color = style?.backgroundColor.match(/[\d.]+/g)?.map(Number) || [];
      const alpha = color.length === 4 ? color[3] : color.length === 3 ? 1 : 0;
      window.overlayMotionFrames.push({ elapsed, opacity: panel ? Number(getComputedStyle(panel).opacity) : 0, tint: alpha / surface.alpha,
        blur: Number(style?.backdropFilter.match(/blur\(([\d.]+)px\)/)?.[1] || 0),
        visible: Boolean(overlay && style.visibility !== "hidden"), inert: overlay?.inert ?? true, samePanel: panel === originalPanel,
        overflow: document.documentElement.style.overflow, reopened });
      // Read after Motion's frame writes; otherwise JS-driven backdropFilter
      // can still contain the prior frame while compositor opacity has advanced.
      if (elapsed < 650) requestAnimationFrame(() => setTimeout(record, 0));
      else window.overlayMotionDone = true;
    };
    if (opening) document.body.dispatchEvent(new KeyboardEvent("keydown", { key: surface.key, shiftKey: Boolean(surface.shiftKey), ctrlKey: Boolean(surface.ctrlKey), bubbles: true }));
    else document.querySelector(surface.close).click();
    requestAnimationFrame(() => setTimeout(record, 0));
  }, { surface, reverse, opening });
  const finishSample = async name => {
    await page.waitForFunction(() => window.overlayMotionDone);
    const frames = await page.evaluate(() => window.overlayMotionFrames);
    evidence.samples.push({ name, frames });
    return frames;
  };

  for (const surface of surfaces) {
    if (surface.blur) {
      await page.locator(surface.trigger).focus();
      await startSample(surface, false, true);
      const opening = await finishSample(`${surface.name}: open with blur`);
      assert.ok(opening.some(frame => frame.blur > 0.2 && frame.blur < 1.8), `${surface.name}: opening blur must interpolate`);
      for (const frame of opening.filter(frame => frame.visible)) {
        assert.ok(Math.abs(frame.opacity - frame.blur / surface.blur) <= 0.16, `${surface.name}: opening blur and panel diverged at ${frame.elapsed.toFixed(1)}ms`);
      }
      assert.equal(opening.at(-1).blur, surface.blur, `${surface.name}: fully open backdrop must be blurred`);
      await settleOpen(surface);
      await page.screenshot({ path: resolve(output, "settings-open.png") });
      check(`${surface.name}: opening blur interpolates with the panel and settles at 2px`);
    } else await open(surface);
    await startSample(surface);
    const frames = await finishSample(`${surface.name}: close`);
    assert.ok(frames.some(frame => frame.opacity > 0.1 && frame.opacity < 0.9), `${surface.name}: observe an intermediate panel fade`);
    assert.ok(frames.some(frame => frame.tint > 0.1 && frame.tint < 0.9), `${surface.name}: observe an intermediate backdrop fade`);
    for (const frame of frames.filter(frame => frame.visible)) {
      assert.ok(Math.abs(frame.opacity - frame.tint) <= 0.16, `${surface.name}: panel and backdrop diverged at ${frame.elapsed.toFixed(1)}ms (opacity ${frame.opacity}, tint ${frame.tint})`);
      assert.ok(frame.opacity > 0.01 || frame.tint <= 0.05, `${surface.name}: backdrop remains after the panel disappeared`);
      if (surface.blur) {
        assert.ok(Math.abs(frame.opacity - frame.blur / surface.blur) <= 0.16, `${surface.name}: closing blur and panel diverged at ${frame.elapsed.toFixed(1)}ms`);
        assert.ok(frame.opacity > 0.01 || frame.blur <= 0.1, `${surface.name}: blur remains after the panel disappeared`);
      }
      assert.equal(frame.inert, true, `${surface.name}: closing overlay accepts interaction`);
    }
    await settleClosed(surface);
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "", `${surface.name}: scroll lock released`);
    assert.equal(await page.locator(surface.trigger).evaluate(node => document.activeElement === node), true, `${surface.name}: invoking control regains focus`);
    check(`${surface.name}: panel and tint fade together; closing controls are inert; focus and scrolling return`);

    await open(surface);
    await startSample(surface, true);
    const reversed = await finishSample(`${surface.name}: reverse close`);
    assert.ok(reversed.every(frame => frame.samePanel), `${surface.name}: rapid reopening replaced the live panel`);
    assert.ok(reversed.every(frame => frame.overflow === "hidden"), `${surface.name}: reversed exit released the scroll lock`);
    assert.equal(reversed.at(-1).opacity, 1);
    assert.ok(Math.abs(reversed.at(-1).tint - 1) <= 0.01);
    assert.equal(reversed.at(-1).inert, false);
    if (surface.blur) assert.equal(reversed.at(-1).blur, surface.blur, `${surface.name}: reversing exit restores the full blur`);
    check(`${surface.name}: reopening during exit preserves the panel and modal scroll lock`);

    await startSample(surface);
    await page.waitForFunction(() => window.overlayMotionFrames.some(frame => frame.opacity > 0.05 && frame.opacity < 0.95));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));
    const reduced = await page.evaluate(({ overlay, panel }) => {
      const backdrop = document.querySelector(overlay), content = document.querySelector(panel);
      return { visible: Boolean(backdrop && getComputedStyle(backdrop).visibility !== "hidden"), opacity: content ? Number(getComputedStyle(content).opacity) : 0,
        blur: Number((backdrop && getComputedStyle(backdrop).backdropFilter.match(/blur\(([\d.]+)px\)/)?.[1]) || 0), overflow: document.documentElement.style.overflow };
    }, surface);
    assert.deepEqual(reduced, { visible: false, opacity: 0, blur: 0, overflow: "" }, `${surface.name}: live reduced motion must finish the current exit`);
    await finishSample(`${surface.name}: reduced motion during exit`);
    check(`${surface.name}: enabling reduced motion during exit immediately releases the overlay`);
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
  assert.deepEqual(evidence.pageErrors, []);
} finally {
  await writeFile(resolve(output, "results.json"), JSON.stringify(evidence, null, 2));
  await browser?.close();
  await vite.close();
}
