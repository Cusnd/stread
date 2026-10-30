import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "../node_modules/vite/dist/node/index.js";

const require = createRequire(process.env.READER_TEST_NODE_MODULES ? `${process.env.READER_TEST_NODE_MODULES}/reader-tests.cjs` : import.meta.url);
const { chromium } = require("playwright");
const output = fileURLToPath(new URL("../../../.audit/collection-reading-status/", import.meta.url));
const vite = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), cacheDir: `${output}/vite-cache`, server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/dist/**"] } }, clearScreen: false });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const errors = [], results = [];
const labels = { unread: "未读", reading: "在读", done: "已读" };
let browser, page;
const group = () => page.locator('.workspace-reading-status:visible');
const radio = status => group().getByRole("radio", { name: labels[status], exact: true });
const detail = () => page.locator('.workspace-material-detail:visible');
const snapshot = () => page.evaluate(() => ({ workspace: window.planFeedback.getWorkspace(), commands: window.planFeedback.commands, reads: window.planFeedback.reads }));
const pass = (name, evidence = {}) => { results.push({ name, ...evidence }); console.log(`PASS ${name}`); };

async function settled(status) {
  await page.waitForFunction(expected => {
    const group = [...document.querySelectorAll('.workspace-reading-status')].find(node => node.getClientRects().length && !node.closest('[inert]'));
    return window.planFeedback.getWorkspace().documents[0].status === expected && group && !group.querySelector('[aria-disabled="true"]');
  }, status);
  assert.equal(await radio(status).getAttribute("aria-checked"), "true");
  assert.equal(await group().locator('[aria-checked="true"]').count(), 1);
  assert.equal(await radio(status).getAttribute("tabindex"), "0");
  assert.equal(await group().locator('[tabindex="0"]').count(), 1);
}

async function openFixture(scale = 80, width = 1800) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`${origin}/tests/fixtures/collection-plan-feedback.html?scale=${scale}`);
  if (width < 600) {
    const navigation = page.locator('.workspace-navigation-dialog[open]');
    await navigation.waitFor();
    await navigation.getByRole("button", { name: "关闭面板", exact: true }).click();
    await navigation.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "打开资料详情", exact: true }).click();
    await page.locator('.workspace-detail-dialog[open]').waitFor();
  }
  await group().waitFor();
  await settled("reading");
  await page.waitForFunction(() => {
    const dialog = document.querySelector('.workspace-detail-dialog[open]');
    return !dialog || getComputedStyle(dialog).opacity === "1";
  });
  assert.equal(await group().getAttribute("role"), "radiogroup");
  assert.match(await group().getAttribute("aria-label"), /的阅读状态$/);
  assert.deepEqual(await group().getByRole("radio").allTextContents(), ["未读", "在读", "已读"]);
  assert.equal(await group().locator("select, svg, img").count(), 0, "status is text controls without a native picker or arrow icon");
}

async function geometry(name) {
  const state = await detail().evaluate(material => {
    const rect = node => { const box = node.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
    const context = material.querySelector('.workspace-reading-context');
    const group = context.querySelector('.workspace-reading-status');
    const plan = context.querySelector('.workspace-detail-plan');
    const read = material.querySelector('.workspace-read-button');
    const texts = [...group.querySelectorAll('[role="radio"]')].map(button => {
      const tops = [];
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        for (const box of range.getClientRects()) tops.push(Math.round(box.top));
      }
      return { label: button.textContent.trim(), lines: new Set(tops).size, rect: rect(button), clientWidth: button.clientWidth, scrollWidth: button.scrollWidth };
    });
    return { context: rect(context), group: rect(group), plan: rect(plan), read: rect(read), contextClient: context.clientWidth, contextScroll: context.scrollWidth, materialClient: material.clientWidth, materialScroll: material.scrollWidth, texts };
  });
  assert.ok(state.contextScroll <= state.contextClient + 1, `${name}: reading controls overflow their row`);
  assert.ok(state.materialScroll <= state.materialClient + 1, `${name}: detail content overflows horizontally`);
  assert.ok(state.group.left >= state.context.left - 1 && state.group.right <= state.context.right + 1, `${name}: status group leaves its row`);
  assert.ok(state.plan.left >= state.context.left - 1 && state.plan.right <= state.context.right + 1, `${name}: plan action leaves its row`);
  const overlapX = Math.min(state.group.right, state.plan.right) - Math.max(state.group.left, state.plan.left);
  const overlapY = Math.min(state.group.bottom, state.plan.bottom) - Math.max(state.group.top, state.plan.top);
  assert.ok(overlapX <= 1 || overlapY <= 1, `${name}: plan action overlaps status group`);
  assert.ok(state.read.top >= state.context.bottom - 1, `${name}: reading button overlaps its controls`);
  for (const text of state.texts) {
    assert.equal(text.lines, 1, `${name}: ${text.label} wraps vertically`);
    assert.ok(text.scrollWidth <= text.clientWidth + 1, `${name}: ${text.label} overflows its button`);
  }
  return state;
}

async function choose(status, key) {
  const before = await snapshot();
  if (key) await page.keyboard.press(key);
  else await radio(status).click();
  await settled(status);
  const after = await snapshot();
  assert.equal(after.commands.length, before.commands.length + 1);
  assert.deepEqual(after.commands.at(-1), { kind: "document.update", documentId: "plan-feedback", expectedVersion: before.workspace.documents[0].version, patch: { status } });
  assert.equal(after.workspace.documents[0].version, before.workspace.documents[0].version + 1);
  assert.equal(after.workspace.revision, before.workspace.revision + 1);
  assert.deepEqual(after.workspace.planIds, before.workspace.planIds);
  assert.equal(after.workspace.planVersion, before.workspace.planVersion);
  assert.equal(await radio(status).evaluate(node => node === document.activeElement), true, "selected radio retains keyboard/pointer focus through pending");
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
    await geometry(`${scale}: initial`);
    for (const status of ["unread", "done", "reading"]) await choose(status);
    const before = await snapshot();
    await radio("reading").click();
    assert.deepEqual(await snapshot(), before, "clicking the current status must not issue another write");
    pass(`${scale}: all three statuses preserve identity, version guards and single-line controls`, { geometry: await geometry(`${scale}: final`) });
    await page.screenshot({ path: `${output}/desktop-${scale}.png` });
  }

  await openFixture(100);
  await page.evaluate(() => { window.planFeedback.delay = 600; });
  await radio("unread").click();
  await page.waitForFunction(() => document.querySelector('.workspace-reading-status [aria-disabled="true"]'));
  assert.deepEqual(await group().getByRole("radio").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-disabled"))), ["true", "true", "true"]);
  await detail().evaluate(material => {
    material.querySelectorAll('.workspace-reading-status [role="radio"]').forEach(node => { node.click(); node.click(); });
    material.querySelector('.workspace-detail-plan').click();
    material.querySelector('.workspace-read-button').click();
  });
  await page.keyboard.press("ArrowRight");
  const pending = await snapshot();
  assert.equal(pending.commands.length, 1, "pending status/plan activations must not duplicate writes");
  assert.equal(pending.reads.length, 0, "pending status update must block reading");
  assert.equal(pending.workspace.documents[0].status, "reading", "status stays on its committed value until success");
  await settled("unread");
  assert.equal((await snapshot()).commands.length, 1);
  pass("pending update blocks repeated status, keyboard, plan and reading actions");

  const beforeFailure = await snapshot();
  await page.evaluate(() => { window.planFeedback.delay = 80; window.planFeedback.failNext = true; });
  await radio("done").click();
  await page.getByRole("alert").filter({ hasText: "Synthetic save failure" }).first().waitFor();
  await settled("unread");
  const failed = await snapshot();
  assert.equal(failed.commands.length, beforeFailure.commands.length + 1);
  assert.deepEqual(failed.workspace, beforeFailure.workspace, "failed status update must retain the original status and versions");
  assert.equal(await radio("done").evaluate(node => node === document.activeElement), true);
  pass("failed status update retains the committed value, versions and focus");

  await openFixture(80);
  await radio("reading").focus();
  for (const [key, status] of [["ArrowRight", "done"], ["Home", "unread"], ["ArrowLeft", "done"], ["ArrowDown", "unread"], ["ArrowUp", "done"], ["ArrowRight", "unread"], ["End", "done"]]) await choose(status, key);
  const current = await snapshot();
  await page.keyboard.press("End"); await page.keyboard.press("Enter");
  assert.deepEqual(await snapshot(), current, "reselecting the current radio with keyboard must not write");
  await radio("reading").focus(); await choose("reading", "Space");
  await radio("unread").focus(); await choose("unread", "Enter");
  pass("Arrow/Home/End and Space/Enter select exactly once and retain focus");

  for (const width of [390, 320]) {
    for (const scale of [80, 100, 120]) {
      await openFixture(scale, width);
      const before = await geometry(`${width}/${scale}: initial`);
      for (const status of ["done", "unread", "reading"]) await choose(status);
      const after = await geometry(`${width}/${scale}: final`);
      pass(`${width}px/${scale}: details dialog keeps all status text single-line without overlap`, { before, after });
      await page.screenshot({ path: `${output}/dialog-${width}-${scale}.png` });
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(`${output}/verification.json`, JSON.stringify({ errors, results }, null, 2));
  await browser?.close();
  await vite.close();
}
