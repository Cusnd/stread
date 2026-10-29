import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "../node_modules/vite/dist/node/index.js";

const require = createRequire(process.env.READER_TEST_NODE_MODULES ? `${process.env.READER_TEST_NODE_MODULES}/reader-tests.cjs` : import.meta.url);
const { chromium } = require("playwright");
const output = fileURLToPath(new URL("../../../.audit/collection-plan-feedback/", import.meta.url));
const vite = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/dist/**"] } }, clearScreen: false });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
const errors = [], results = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) errors.push(`Unexpected API request: ${request.url()}`); });
const plan = page.locator('.workspace-detail-plan');
async function sample(name, { fail = false, reverse = false, reduced = false } = {}) {
  const frames = await page.evaluate(async ({ fail, reverse }) => {
    const button = document.querySelector('.workspace-detail-plan');
    const read = document.querySelector('.workspace-read-button');
    const labels = [...button.querySelectorAll('.workspace-plan-labels > span')];
    const initial = button.getAttribute('aria-pressed');
    window.planFeedback.failNext = fail;
    window.planFeedback.delay = 200;
    const startCount = window.planFeedback.commands.length;
    const capture = () => ({
      time: performance.now(), pressed: button.getAttribute('aria-pressed'), pending: button.getAttribute('aria-disabled'),
      labels: labels.map((node) => ({ opacity: +getComputedStyle(node).opacity, transform: getComputedStyle(node).transform })),
      readOpacity: +getComputedStyle(read).opacity, readColor: getComputedStyle(read).backgroundColor,
      readRect: JSON.stringify(read.getBoundingClientRect().toJSON()), sameRead: read === document.querySelector('.workspace-read-button'),
      samePlan: button === document.querySelector('.workspace-detail-plan'), planOpacity: +getComputedStyle(button).opacity,
    });
    const frames = [capture()];
    button.click();
    const start = performance.now();
    let triedDuplicate = false, reversed = false;
    do {
      await new Promise(requestAnimationFrame);
      if (!triedDuplicate && performance.now() - start > 70) {
        button.click(); read.click(); triedDuplicate = true;
      }
      if (reverse && !reversed && button.getAttribute('aria-pressed') !== initial) {
        window.planFeedback.delay = 0; button.click(); reversed = true;
      }
      frames.push(capture());
    } while (performance.now() - start < 850);
    return { initial, frames, commands: window.planFeedback.commands.length - startCount, reads: window.planFeedback.reads.length };
  }, { fail, reverse });
  results.push({ name, ...frames });
  assert.equal(frames.commands, reverse ? 2 : 1, `${name}: duplicate mutation`);
  assert.equal(frames.reads, 0, `${name}: pending read must be guarded`);
  assert.ok(frames.frames.every((frame) => frame.sameRead && frame.samePlan), `${name}: buttons remounted`);
  assert.ok(frames.frames.every((frame) => frame.readOpacity === 1 && frame.readColor === frames.frames[0].readColor && frame.readRect === frames.frames[0].readRect), `${name}: reading button flickered or moved`);
  assert.ok(frames.frames.every((frame) => frame.planOpacity === 1), `${name}: plan button flashed disabled`);
  assert.equal(frames.frames.at(-1).pressed, fail || reverse ? frames.initial : String(frames.initial !== 'true'));
  const intermediate = frames.frames.some((frame) => frame.labels.some((label) => label.opacity > 0.01 && label.opacity < 0.99));
  if (!fail && !reverse) assert.equal(intermediate, !reduced, `${name}: intermediate animation frames`);
  assert.ok(frames.frames.at(-1).labels.every((label) => label.opacity === 0 || label.opacity === 1), `${name}: labels did not settle`);
  console.log(`PASS ${name}`);
}
try {
  await mkdir(output, { recursive: true });
  for (const scale of [80, 100, 120]) {
    await page.goto(`${origin}/tests/fixtures/collection-plan-feedback.html?scale=${scale}`);
    await plan.waitFor(); await page.waitForTimeout(650);
    await sample(`${scale}: remove`);
    await sample(`${scale}: add`);
    await sample(`${scale}: reverse`, { reverse: true });
  }
  await sample('failed removal', { fail: true });
  assert.match(await page.getByRole('alert').textContent(), /Synthetic save failure/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await sample('reduced motion removal', { reduced: true });
  await plan.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.workspace-detail-plan').getAttribute('aria-pressed') === 'true');
  assert.equal(await plan.evaluate((node) => node === document.activeElement), true, 'keyboard focus retained');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => { window.planFeedback.delay = 0; document.querySelector('.workspace-detail-plan').click(); });
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-plan-labels > span')].some((node) => {
    const opacity = +getComputedStyle(node).opacity; return opacity > 0.01 && opacity < 0.99;
  }), null, { timeout: 2000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(50);
  assert.ok(await page.locator('.workspace-plan-labels > span').evaluateAll((nodes) => nodes.every((node) => [0, 1].includes(+getComputedStyle(node).opacity))), 'live reduced motion finishes label transition');
  results.push({ name: 'keyboard activation/focus and live reduced motion', passed: true });
  await page.screenshot({ path: `${output}/after.png` });
  assert.deepEqual(errors, []);
} finally {
  await writeFile(`${output}/verification.json`, JSON.stringify({ errors, results }, null, 2));
  await browser.close(); await vite.close();
}
