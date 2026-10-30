import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "../node_modules/vite/dist/node/index.js";

const require = createRequire(process.env.READER_TEST_NODE_MODULES ? `${process.env.READER_TEST_NODE_MODULES}/reader-tests.cjs` : import.meta.url);
const { chromium } = require("playwright");
const output = fileURLToPath(new URL("../../../.audit/collection-reading-status-motion/", import.meta.url));
const vite = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), cacheDir: fileURLToPath(new URL("../node_modules/.vite-collection-status-motion/", import.meta.url)), server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/dist/**"] } }, clearScreen: false });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const statuses = ["unread", "reading", "done"];
const readNames = { unread: "开始阅读", reading: "继续阅读", done: "重新阅读" };
const errors = [], results = [];
let browser, page, completed = false;
const visibleDetail = () => page.locator('.workspace-material-detail:visible');
const closeTo = (actual, expected, tolerance = .3) => Math.abs(actual - expected) <= tolerance;
const intermediate = (value, from, to) => value > Math.min(from, to) + .3 && value < Math.max(from, to) - .3;

async function openFixture(scale = 80, width = 1800) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`${origin}/tests/fixtures/collection-plan-feedback.html?scale=${scale}`);
  if (width < 600) {
    const navigation = page.locator('.workspace-navigation-dialog[open]');
    await navigation.waitFor();
    await navigation.getByRole("button", { name: "关闭面板", exact: true }).click();
    await navigation.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "打开资料详情", exact: true }).click();
  }
  await visibleDetail().locator('.workspace-reading-status-indicator').waitFor();
  await page.waitForFunction(() => {
    const material = [...document.querySelectorAll('.workspace-material-detail')].find(node => node.getClientRects().length && !node.closest('[inert]'));
    const indicator = material?.querySelector('.workspace-reading-status-indicator');
    const selected = material?.querySelector('.workspace-reading-status [aria-checked="true"]');
    const dialog = document.querySelector('.workspace-detail-dialog[open]');
    const dialogStyle = dialog && getComputedStyle(dialog);
    if (!indicator || !selected || (dialogStyle && (dialogStyle.opacity !== "1" || dialogStyle.transform !== "none"))) return false;
    const left = indicator.getBoundingClientRect(), right = selected.getBoundingClientRect();
    const labels = [...material.querySelectorAll('.workspace-read-labels > span')];
    return Math.abs(left.left + left.width / 2 - right.left - right.width / 2) < .3 && labels.length === 3 && labels.every(label => [0, 1].includes(+getComputedStyle(label).opacity));
  });
}

async function capture({ target, reverse = false, fail = false, probePending = false }) {
  return page.evaluate(async ({ target, reverse, fail, probePending }) => {
    const statuses = ["unread", "reading", "done"];
    const material = [...document.querySelectorAll('.workspace-material-detail')].find(node => node.getClientRects().length && !node.closest('[inert]'));
    const group = material.querySelector('.workspace-reading-status');
    const radios = [...group.querySelectorAll('[role="radio"]')];
    const indicator = group.querySelector('.workspace-reading-status-indicator');
    const read = material.querySelector('.workspace-read-button');
    const labels = [...read.querySelectorAll('.workspace-read-labels > span')];
    const initialStatus = window.planFeedback.getWorkspace().documents[0].status;
    const initialIndex = statuses.indexOf(initialStatus), targetIndex = statuses.indexOf(target);
    const count = window.planFeedback.commands.length, reads = window.planFeedback.reads.length;
    const rect = node => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const frame = () => {
      const groupRect = group.getBoundingClientRect(), indicatorRect = indicator.getBoundingClientRect();
      return {
        time: performance.now(), selected: statuses[radios.findIndex(node => node.getAttribute('aria-checked') === 'true')],
        committed: window.planFeedback.getWorkspace().documents[0].status, pending: group.getAttribute('aria-disabled') === 'true',
        indicator: { center: indicatorRect.left + indicatorRect.width / 2 - groupRect.left, width: indicatorRect.width },
        radioCenters: radios.map(node => { const box = node.getBoundingClientRect(); return box.left + box.width / 2 - groupRect.left; }),
        radioOpacity: radios.map(node => +getComputedStyle(node).opacity),
        labels: labels.map(node => {
          const style = getComputedStyle(node);
          return { state: node.dataset.readingState, opacity: +style.opacity, y: style.transform === 'none' ? 0 : new DOMMatrixReadOnly(style.transform).m42 };
        }),
        readRect: rect(read), readOpacity: +getComputedStyle(read).opacity, readColor: getComputedStyle(read).backgroundColor,
        sameIndicator: indicator === group.querySelector('.workspace-reading-status-indicator'),
        sameRead: read === material.querySelector('.workspace-read-button'),
        sameLabels: labels.every((node, index) => node === read.querySelectorAll('.workspace-read-labels > span')[index]),
        indicatorCount: group.querySelectorAll('.workspace-reading-status-indicator').length,
      };
    };
    const frames = [frame()];
    const startCenter = frames[0].indicator.center, targetCenter = frames[0].radioCenters[targetIndex];
    window.statusMotionCapture = { moving: false, liveReducedAt: null };
    window.planFeedback.failNext = fail;
    window.planFeedback.delay = probePending || fail ? 220 : reverse ? 0 : 60;
    radios[targetIndex].click();
    const start = performance.now();
    let reversal = null, probed = false;
    do {
      await new Promise(requestAnimationFrame);
      const next = frame();
      frames.push(next);
      const progress = (next.indicator.center - startCenter) / (targetCenter - startCenter);
      if (progress > .02 && progress < .98) window.statusMotionCapture.moving = true;
      if (probePending && !probed && next.pending && next.time - start > 60) {
        radios.forEach(node => node.click());
        material.querySelector('.workspace-detail-plan').click(); read.click(); probed = true;
      }
      if (reverse && !reversal && next.selected === target && !next.pending && progress > .4 && progress < .8) {
        reversal = { index: frames.length - 1, before: frame() };
        window.planFeedback.delay = 0;
        radios[initialIndex].click();
        reversal.afterClick = frame();
      }
    } while (performance.now() - start < 1000);
    return { initialStatus, target, frames, reversal, probed, liveReducedAt: window.statusMotionCapture.liveReducedAt,
      commandCount: window.planFeedback.commands.length - count, readCount: window.planFeedback.reads.length - reads,
      finalReadName: read.getAttribute('aria-label'), finalStatus: window.planFeedback.getWorkspace().documents[0].status };
  }, { target, reverse, fail, probePending });
}

async function sample(name, options) {
  const inProgress = capture(options);
  if (options.liveReduced) {
    await page.waitForFunction(() => window.statusMotionCapture?.moving, null, { timeout: 3000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => { window.statusMotionCapture.liveReducedAt = performance.now(); });
  }
  const evidence = await inProgress;
  results.push({ name, ...evidence });
  const frames = evidence.frames, first = frames[0], last = frames.at(-1);
  const finalStatus = options.reverse || options.fail ? evidence.initialStatus : options.target;
  const targetCenter = first.radioCenters[statuses.indexOf(options.target)];
  assert.equal(evidence.commandCount, options.reverse ? 2 : 1, `${name}: writes do not match explicit actions`);
  assert.equal(evidence.readCount, 0, `${name}: pending click opened Reader`);
  assert.equal(evidence.finalStatus, finalStatus);
  assert.equal(last.selected, finalStatus);
  assert.equal(evidence.finalReadName, readNames[finalStatus], `${name}: final accessible reading action`);
  assert.ok(frames.every(frame => frame.sameIndicator && frame.sameRead && frame.sameLabels && frame.indicatorCount === 1), `${name}: animated nodes remounted`);
  assert.ok(frames.every(frame => frame.readOpacity === 1 && frame.readColor === first.readColor), `${name}: reading button itself flashed`);
  assert.ok(frames.every(frame => Object.keys(first.readRect).every(key => closeTo(frame.readRect[key], first.readRect[key], .05))), `${name}: label animation moved or resized the reading button`);
  assert.ok(closeTo(last.indicator.center, last.radioCenters[statuses.indexOf(finalStatus)]), `${name}: indicator did not settle on selected status`);
  assert.ok(last.labels.every(label => label.opacity === (label.state === finalStatus ? 1 : 0)), `${name}: reading labels did not settle`);

  const statusMoves = frames.some(frame => intermediate(frame.indicator.center, first.indicator.center, targetCenter));
  const labelFades = frames.some(frame => frame.labels.some(label => label.opacity > .01 && label.opacity < .99));
  const radioFades = frames.some(frame => frame.radioOpacity.some(opacity => opacity > .57 && opacity < .98));
  if (options.fail) {
    assert.ok(frames.every(frame => closeTo(frame.indicator.center, first.indicator.center, .05)), `${name}: failed save moved the indicator`);
    assert.ok(frames.every(frame => frame.labels.every((label, index) => label.opacity === first.labels[index].opacity)), `${name}: failed save changed reading labels`);
    assert.equal(evidence.finalStatus, evidence.initialStatus);
  } else {
    assert.equal(statusMoves, !options.reduced, `${name}: indicator must have intermediate frames only with motion enabled`);
    assert.equal(labelFades, !options.reduced, `${name}: reading labels must fade only with motion enabled`);
    if (!options.liveReduced) assert.equal(radioFades, !options.reduced, `${name}: status text opacity transition`);
  }
  if (options.probePending) {
    assert.equal(evidence.probed, true, `${name}: pending guard was not exercised`);
    const pending = frames.filter(frame => frame.pending && frame.committed === evidence.initialStatus);
    assert.ok(pending.length >= 2, `${name}: no pending frames captured`);
    assert.ok(pending.every(frame => closeTo(frame.indicator.center, first.indicator.center, .05) && frame.labels.every((label, index) => label.opacity === first.labels[index].opacity)), `${name}: pending save animated before committing`);
  }
  if (options.reverse) {
    assert.ok(evidence.reversal, `${name}: never reversed mid-flight`);
    assert.ok(closeTo(evidence.reversal.before.indicator.center, evidence.reversal.afterClick.indicator.center, .05), `${name}: reverse click reset the visible position`);
    const after = frames.slice(evidence.reversal.index + 1);
    const committed = after.find(frame => frame.selected === evidence.initialStatus && !frame.pending);
    assert.ok(committed && intermediate(committed.indicator.center, first.indicator.center, targetCenter), `${name}: reversal snapped to an endpoint`);
    const travel = Math.abs(targetCenter - first.indicator.center);
    assert.ok(after.slice(1).every((frame, index) => frame.time - after[index].time > 80 || Math.abs(frame.indicator.center - after[index].indicator.center) < travel * .6), `${name}: reversed motion is discontinuous`);
  }
  if (options.liveReduced) {
    assert.ok(evidence.liveReducedAt, `${name}: reduced-motion preference was not changed`);
    const stopped = frames.filter(frame => frame.time >= evidence.liveReducedAt + 60);
    assert.ok(stopped.length && stopped.every(frame => closeTo(frame.indicator.center, last.indicator.center) && frame.labels.every(label => label.opacity === (label.state === finalStatus ? 1 : 0))), `${name}: live reduced motion left an animation running`);
  }
  console.log(`PASS ${name}`);
}

try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
  page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) errors.push(`Unexpected API request: ${request.url()}`); });
  for (const scale of [80, 100, 120]) {
    await openFixture(scale);
    for (const target of ["unread", "done", "reading"]) await sample(`${scale}: status and reading action animate to ${target}`, { target });
    await sample(`${scale}: mid-flight reversal preserves continuous indicator motion`, { target: "unread", reverse: true });
    await page.screenshot({ path: `${output}/desktop-${scale}.png` });
  }
  await openFixture(100);
  await sample("pending updates stay visually committed and reject duplicate actions", { target: "done", probePending: true });
  await sample("failed status update does not animate a new status or reading action", { target: "unread", fail: true });
  for (const width of [390, 320]) {
    await openFixture(120, width);
    await sample(`${width}px/120: narrow dialog animation keeps reading action geometry`, { target: "done" });
    await page.screenshot({ path: `${output}/dialog-${width}-120.png` });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openFixture(100);
  await sample("reduced motion at startup switches to final values without intermediate frames", { target: "unread", reduced: true });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openFixture(100);
  await sample("enabling reduced motion mid-animation finishes the current indicator and labels", { target: "done", liveReduced: true });
  assert.deepEqual(errors, []);
  completed = true;
} finally {
  await writeFile(`${output}/verification.json`, JSON.stringify({ passed: completed, errors, results }, null, 2));
  await browser?.close();
  await vite.close();
}
