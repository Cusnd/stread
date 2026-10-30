import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.READER_TEST_NODE_MODULES ? resolve(process.env.READER_TEST_NODE_MODULES, "playwright") : "playwright");
const output = resolve(frontend, "../../.audit/ui-controls");
const bundle = await build({ entryPoints: [resolve(frontend, "tests/fixtures/ui-controls.jsx")], bundle: true, write: false, outfile: resolve(output, "fixture.js"), format: "iife", platform: "browser", jsx: "automatic", logLevel: "silent" });
const files = new Map(bundle.outputFiles.map(file => [file.path.endsWith(".css") ? "/fixture.css" : "/fixture.js", file.text]));
let questionRows = [];
const questionRequests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost"), pathname = url.pathname;
  if (pathname.startsWith("/api/")) {
    response.setHeader("Content-Type", "application/json");
    if (pathname === "/api/flow/insights") questionRequests.push(Object.fromEntries(url.searchParams));
    response.end(JSON.stringify(pathname === "/api/sources" ? { sources: [{ id: "source-one", sourceId: "source-one", filename: "A long source filename / 测试文件.pdf" }], hasMore: false }
      : pathname === "/api/flow/insights" ? { items: questionRows, total: questionRows.length, hasMore: false } : { items: [] }));
    return;
  }
  response.setHeader("Content-Type", pathname.endsWith(".css") ? "text/css" : pathname.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8");
  response.end(files.get(pathname) || '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
let browser;
const checks = [], errors = [], queueGeometry = [], taskPickerGeometry = [], taskTypeLayout = [];
const check = message => { checks.push(message); console.log(`PASS ${message}`); };
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "检查更新", exact: true }).waitFor();
  const metrics = locator => locator.evaluate(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, minHeight: parseFloat(style.minHeight), fontSize: parseFloat(style.fontSize), radius: style.borderRadius,
      background: style.backgroundColor, color: style.color, borderColor: style.borderColor, outline: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor, shadow: style.boxShadow, opacity: style.opacity,
      borderBottomColor: style.borderBottomColor, borderLeftColor: style.borderLeftColor, borderRightColor: style.borderRightColor, borderTopColor: style.borderTopColor, borderWidth: style.borderWidth, paddingLeft: parseFloat(style.paddingLeft),
      clipped: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1 };
  });
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1, `${label}: expected ${expected}, got ${actual}`);
  const addTask = () => page.getByRole("button", { name: "添加任务", exact: true });
  const read = () => page.getByRole("button", { name: "继续阅读", exact: true });
  const tool = () => page.getByRole("button", { name: "普通工具", exact: true });
  const input = () => page.getByRole("textbox", { name: "普通输入", exact: true });
  const select = () => page.getByRole("combobox", { name: "普通选择", exact: true });
  const settleQueuePages = () => page.waitForFunction(() => [...document.querySelectorAll(".queue-task-form-scroll")].every(element => {
    const opacity = Number(getComputedStyle(element).opacity);
    return element.dataset.active === "true" ? opacity > .999 : opacity < .001;
  }));
  const openQueueDraft = async draft => {
    await page.evaluate(value => uiFixture.openQueue(value), draft);
    await page.waitForFunction(() => {
      const dialog = document.querySelector(".queue-task-dialog");
      return dialog?.open && getComputedStyle(dialog).opacity === "1" && getComputedStyle(dialog).transform === "none";
    });
    await settleQueuePages();
    return page.locator(".queue-task-dialog");
  };
  const closeQueueDraft = async dialog => {
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".queue-task-dialog")?.open);
  };
  const assertReachableFooter = async (dialog, height) => {
    const [bounds, footer] = await Promise.all([dialog.boundingBox(), dialog.locator(".queue-task-form-actions").boundingBox()]);
    assert.ok(footer.y >= bounds.y && footer.y + footer.height <= Math.min(height, bounds.y + bounds.height) + 1, "the decision footer stays inside the dialog and viewport");
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "composer has no horizontal overflow");
  };
  const assertPickerPlaceholderHidden = async control => {
    assert.equal(await control.evaluate(element => element.matches(":open")), true, "inspect the real open native picker");
    assert.deepEqual(await control.locator('option[value=""]').evaluate(element => ({ disabled: element.disabled, hidden: element.hidden,
      display: getComputedStyle(element).display, height: element.getBoundingClientRect().height })),
    { disabled: true, hidden: true, display: "none", height: 0 }, "empty guidance occupies no row even when custom option styles are active");
  };
  const settleNativePicker = async control => {
    const element = await control.elementHandle();
    try { await page.waitForFunction(node => node.matches(":open") && Number(getComputedStyle(node, "::picker(select)").opacity) > .999, element); }
    finally { await element.dispose(); }
  };
  const settleFieldBorder = async (control, color) => {
    const element = await control.elementHandle();
    try { await page.waitForFunction(({ node, color }) => getComputedStyle(node).borderColor === color, { node: element, color }); }
    finally { await element.dispose(); }
  };
  const inspectTaskTypeLayout = async (dialog, name, percent) => {
    const sample = await dialog.evaluate(element => {
      const box = node => node.getBoundingClientRect().toJSON();
      const heading = element.querySelector(".workspace-dialog-heading");
      const row = element.querySelector(".queue-task-type-row");
      const control = row.querySelector("select");
      const content = control.querySelector("selectedcontent");
      const style = getComputedStyle(control), icon = getComputedStyle(control, "::picker-icon");
      const range = document.createRange(); range.selectNodeContents(content);
      const rect = control.getBoundingClientRect(), text = range.getBoundingClientRect();
      const borderRight = parseFloat(style.borderRightWidth), paddingRight = parseFloat(style.paddingRight), marginRight = parseFloat(icon.marginRight);
      const iconWidth = parseFloat(icon.width) + (icon.boxSizing === "border-box" ? 0 : parseFloat(icon.borderLeftWidth) + parseFloat(icon.borderRightWidth));
      const iconLeft = rect.right - borderRight - paddingRight - marginRight - iconWidth;
      return { heading: box(heading), row: box(row), control: box(control), text: text.toJSON(), label: content.textContent,
        headingSelects: heading.querySelectorAll("select").length,
        headingText: heading.querySelector("h2").textContent,
        firstContext: box(element.querySelector('.queue-task-form-scroll[data-active="true"] .queue-task-context')),
        pages: box(element.querySelector(".queue-task-pages")),
        gap: parseFloat(style.columnGap), iconLeft, textToIcon: iconLeft - text.right,
        viewport: { width: innerWidth, height: innerHeight } };
    });
    assert.equal(sample.headingSelects, 0, `${name}: the title row has no type selector`);
    assert.equal(sample.headingText, "添加任务");
    assert.ok(sample.row.top >= sample.heading.bottom - 1, `${name}: task type is below the title row`);
    assert.ok(sample.control.bottom <= sample.pages.top + 1 && sample.control.bottom <= sample.firstContext.top + 1, `${name}: task type precedes the changing context fields`);
    near(sample.control.width, 200 * percent / 80, `${name}: task type has a readable field width`);
    near(sample.control.height, 34 * percent / 80, `${name}: task type shares the compact context field height`);
    near(sample.gap, 12 * percent / 80, `${name}: arrow has the shared minimum gap`);
    assert.ok(sample.textToIcon >= 12 * percent / 80 - 1, `${name}: ${sample.label} has real text-to-arrow clearance (${sample.textToIcon}px)`);
    assert.ok(sample.text.left >= sample.control.left && sample.text.right < sample.iconLeft, `${name}: the full selected label precedes the arrow`);
    assert.ok(sample.control.top >= 0 && sample.control.bottom <= sample.viewport.height, `${name}: type control stays within the viewport`);
    taskTypeLayout.push({ name, percent, ...sample });
    return sample;
  };
  const inspectTaskPicker = async (dialog, name) => {
    const control = dialog.getByRole("combobox", { name: "任务类型", exact: true });
    const beforeValue = await control.inputValue();
    const beforeDraft = await page.evaluate(() => uiFixture.getDraft());
    await control.click();
    await settleNativePicker(control);
    const sample = await control.evaluate(element => {
      const picker = getComputedStyle(element, "::picker(select)"), trigger = element.getBoundingClientRect();
      const options = [...element.options].filter(option => !option.hidden).map(option => {
        const style = getComputedStyle(option), checkmark = getComputedStyle(option, "::checkmark"), box = option.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(option);
        const text = range.getBoundingClientRect();
        const lines = new Set([...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => Math.round(rect.top * 100) / 100));
        return { label: option.textContent, selected: option.selected, box: box.toJSON(), text: text.toJSON(), lines: lines.size,
          paddingRight: parseFloat(style.paddingRight), gap: parseFloat(style.columnGap),
          checkmarkWidth: parseFloat(checkmark.width) || parseFloat(checkmark.fontSize) };
      });
      const border = parseFloat(picker.borderWidth) || 0;
      return { trigger: trigger.toJSON(), width: parseFloat(picker.width), viewport: { width: innerWidth, height: innerHeight }, options,
        bounds: { left: Math.min(...options.map(option => option.box.left)) - (parseFloat(picker.paddingLeft) || 0) - border,
          right: Math.max(...options.map(option => option.box.right)) + (parseFloat(picker.paddingRight) || 0) + border,
          top: Math.min(...options.map(option => option.box.top)) - (parseFloat(picker.paddingTop) || 0) - border,
          bottom: Math.max(...options.map(option => option.box.bottom)) + (parseFloat(picker.paddingBottom) || 0) + border } };
    });
    assert.deepEqual(sample.options.map(option => option.label), ["源文件转换", "内容纠错", "译文修改", "问答", "通用任务"]);
    near(sample.width, sample.trigger.width, `${name}: the readable task field and native picker align`);
    for (const option of sample.options) {
      assert.equal(option.lines, 1, `${name}: ${option.label} stays on one line`);
      assert.ok(option.text.left >= option.box.left && option.text.right <= option.box.right + 1, `${name}: label stays within its row`);
      if (option.selected) assert.ok(option.text.right + option.gap <= option.box.right - option.paddingRight - option.checkmarkWidth + 1, `${name}: selected checkmark has reserved space after the whole label`);
    }
    assert.ok(sample.bounds.left >= -1 && sample.bounds.right <= sample.viewport.width + 1 && sample.bounds.top >= -1 && sample.bounds.bottom <= sample.viewport.height + 1, `${name}: native task picker fits inside the viewport`);
    await page.screenshot({ path: resolve(output, `queue-type-picker-${name}.png`) });
    taskPickerGeometry.push({ name, ...sample });
    await page.keyboard.press("Escape");
    assert.equal(await control.evaluate(element => element.matches(":open")), false);
    assert.equal(await control.inputValue(), beforeValue, "Escape does not change the selected task type");
    assert.deepEqual(await page.evaluate(() => uiFixture.getDraft()), beforeDraft, "Escape leaves the complete draft intact");
    assert.equal(await dialog.isVisible(), true, "Escape closes the task picker before its composer");
  };

  for (const percent of [80, 100, 120]) {
    const scale = percent / 80;
    await page.evaluate(value => uiFixture.scale(value), percent);
    await page.waitForFunction(value => getComputedStyle(document.documentElement).getPropertyValue("--ui-scale") === String(value), scale);
    const [entry, reading, ordinaryTool, compact, field, nativeSelect, longAction] = await Promise.all([
      metrics(addTask()), metrics(read()), metrics(tool()), metrics(page.getByRole("button", { name: "紧凑工具" })), metrics(input()), metrics(select()), metrics(page.locator('[data-role-sample="long"]')),
    ]);
    for (const [name, action] of [["header entry", entry], ["secondary", await metrics(page.locator('[data-role-sample="secondary"]'))], ["update check", await metrics(page.getByRole("button", { name: "检查更新", exact: true }))]]) {
      assert.equal(action.background, "rgb(241, 241, 241)", `${name} uses the shared light-gray surface`);
      assert.equal(action.borderColor, "rgba(0, 0, 0, 0)", `${name} has no painted border`);
      assert.equal(action.shadow, "none", `${name} does not recreate a border using shadow`);
    }
    assert.equal(reading.background, "rgb(37, 37, 37)", "reading remains an emphasized action");
    near(ordinaryTool.height, 30 * scale, "ordinary tool hit area");
    near(ordinaryTool.width, 30 * scale, "ordinary tool width");
    near(compact.height, 28 * scale, "explicit compact hit area");
    near(field.height, 38 * scale, "text field scale");
    near(nativeSelect.height, field.height, "native select and input density");
    for (const fieldStyle of [field, nativeSelect]) {
      assert.equal(fieldStyle.background, "rgb(255, 255, 255)", "fields use a white editable surface");
      near(parseFloat(fieldStyle.radius), 6 * scale, "field radius follows UI scale");
      near(fieldStyle.paddingLeft, 10 * scale, "field text has deliberate inset");
      assert.equal(fieldStyle.borderWidth, "1px", "field boundary has stable geometry");
      for (const side of ["borderBottomColor", "borderLeftColor", "borderRightColor", "borderTopColor"]) assert.equal(fieldStyle[side], "rgb(217, 223, 228)", "the complete field boundary is visible before interaction");
    }
    near(reading.minHeight, 36 * scale, "read action scale");
    assert.equal(longAction.clipped, false, "long actions remain readable");
    assert.ok((await page.locator('[data-unscaled-checkbox]').boundingBox()).height < field.height - 10, "field recipe excludes native checkbox geometry");
    const updateButton = await metrics(page.getByRole("button", { name: "检查更新", exact: true }));
    near(updateButton.minHeight, 34 * scale, "desktop update entry scale");
    near(updateButton.fontSize, 12 * scale, "desktop update text scale");
    await page.screenshot({ path: resolve(output, `roles-${percent}.png`), fullPage: true });
    check(`${percent}% roles preserve emphasis, hit areas, readable long labels and shared field scale`);
  }

  for (const percent of [80, 100, 120]) {
    await page.evaluate(value => uiFixture.scale(value), percent);
    await addTask().click();
    const dialog = page.getByRole("dialog", { name: /添加任务/ });
    await dialog.waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.queue-task-dialog')).opacity === "1");
    const writing = dialog.getByRole("textbox", { name: "任务要求", exact: true });
    const defaultWriting = await metrics(writing);
    assert.equal(defaultWriting.borderColor, "rgb(217, 223, 228)", "the writing area is identifiable before hover or focus");
    assert.equal(defaultWriting.background, "rgb(255, 255, 255)");
    await writing.hover();
    await settleFieldBorder(writing, "rgb(189, 199, 207)");
    const hoveredWriting = await metrics(writing);
    assert.equal(hoveredWriting.borderColor, "rgb(189, 199, 207)", "hover clarifies the existing field boundary");
    near(hoveredWriting.height, defaultWriting.height, "hover does not change field geometry");
    await writing.fill("在这里写下需要修正的内容，保留原文和上下文。\n浅色边界标识书写区，交互不改变草稿。");
    await writing.click();
    await settleFieldBorder(writing, "rgb(140, 157, 170)");
    const focused = await metrics(writing);
    assert.equal(focused.background, "rgb(255, 255, 255)");
    assert.equal(focused.outline, "none", "focus does not add a second hard outline");
    assert.equal(focused.borderColor, "rgb(140, 157, 170)", "editing focus remains distinct even while hovered");
    assert.notEqual(focused.shadow, "none", "focus has a soft visible halo");
    near(focused.paddingLeft, 10 * percent / 80, "prose uses the shared field inset");
    near(parseFloat(focused.radius), 6 * percent / 80, "writing area shares field rounding");
    near(focused.height, defaultWriting.height, "focus does not change writing geometry");
    await writing.press("Control+A");
    assert.equal(await writing.evaluate(element => element.selectionEnd - element.selectionStart), (await writing.inputValue()).length, "native text selection is retained");
    await writing.press("Tab");
    await dialog.locator('.workspace-field > span').filter({ hasText: "任务要求" }).click();
    await settleFieldBorder(writing, "rgb(217, 223, 228)");
    assert.equal((await metrics(writing)).borderColor, "rgb(217, 223, 228)", "the field stays visibly bounded after focus leaves");
    assert.equal(await dialog.locator(".queue-task-context").evaluate(element => getComputedStyle(element).borderBottomWidth), "0px", "context grouping does not duplicate the fields' own boundaries");
    assert.match(await writing.inputValue(), /交互不改变草稿/);
    await page.screenshot({ path: resolve(output, `queue-writing-${percent}.png`) });
    if (percent === 120) {
      await page.setViewportSize({ width: 900, height: 600 });
      await dialog.getByRole("combobox", { name: "任务类型" }).selectOption("conversion");
      const sourceGroup = dialog.locator(".queue-source-control");
      await sourceGroup.waitFor();
      assert.equal((await metrics(sourceGroup)).background, "rgba(0, 0, 0, 0)", "source tools do not recreate a gray card");
      await settleQueuePages();
      const shortTypeBefore = await inspectTaskTypeLayout(dialog, "short-120-before-scroll", percent);
      await inspectTaskPicker(dialog, "short-120");
      const sourceChoice = dialog.getByRole("combobox", { name: "选择已保存的源文件" });
      await sourceChoice.click();
      await assertPickerPlaceholderHidden(sourceChoice);
      await page.keyboard.press("Escape");
      await sourceChoice.selectOption("source-one");
      const scroll = dialog.locator('.queue-task-form-scroll[data-active="true"]');
      await page.waitForFunction(() => [...document.querySelectorAll('.queue-task-form-scroll')].every(element => element.dataset.active === "true" ? Number(getComputedStyle(element).opacity) > .999 : Number(getComputedStyle(element).opacity) < .001));
      assert.equal(await scroll.evaluate(element => element.scrollHeight > element.clientHeight), true, "short window uses the form's independent scroll");
      const footer = await dialog.locator('.queue-task-form-actions').boundingBox();
      assert.ok(footer.y >= 0 && footer.y + footer.height <= 600, "submit remains within the short viewport");
      await page.screenshot({ path: resolve(output, "queue-source-short-120.png") });
      const shortWriting = dialog.locator('.queue-task-form-scroll[data-active="true"] .queue-task-requirements textarea');
      await shortWriting.scrollIntoViewIfNeeded();
      await shortWriting.fill(Array.from({ length: 16 }, (_, index) => `第 ${index + 1} 行：保留可编辑文本与独立滚动。`).join("\n"));
      await shortWriting.evaluate(element => { element.scrollTop = element.scrollHeight; });
      assert.ok(await shortWriting.evaluate(element => element.scrollTop > 0), "long prose scrolls inside its native textarea");
      assert.equal((await metrics(shortWriting)).background, "rgb(255, 255, 255)");
      const shortTypeAfter = await dialog.getByRole("combobox", { name: "任务类型", exact: true }).boundingBox();
      near(shortTypeAfter.y, shortTypeBefore.control.y, "short-window type field remains fixed while the form scrolls");
      near(shortTypeAfter.height, shortTypeBefore.control.height, "short-window type field keeps its hit area");
      await inspectTaskPicker(dialog, "short-120-after-scroll");
      await page.screenshot({ path: resolve(output, "queue-writing-short-120.png") });
      await page.setViewportSize({ width: 1440, height: 1000 });
      check("900×600 at 120% keeps a readable task picker, bounded source fields, native writing scroll and the submit footer usable");
    }
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    check(`${percent}% Queue fields have visible default, hover and focus boundaries while preserving native selection and the draft`);
  }

  await page.evaluate(() => uiFixture.scale(80));
  await addTask().click();
  const queue = page.getByRole("dialog", { name: /添加任务/ });
  await queue.waitFor();
  const body = queue.getByRole("textbox", { name: "任务要求", exact: true });
  await body.fill("保留这段原生输入，检查键盘与保存中的状态。");
  await queue.locator('.workspace-field > span').filter({ hasText: "任务要求" }).click();
  assert.equal(await body.evaluate(element => document.activeElement === element), false, "field title does not refocus its input");
  await body.click();
  const focusedField = await metrics(body);
  assert.notEqual(focusedField.outlineColor, "rgb(48, 48, 48)", "pointer input does not receive the old charcoal border");
  await body.press("Tab");
  const cancel = queue.getByRole("button", { name: "取消", exact: true });
  assert.equal(await cancel.evaluate(element => document.activeElement === element), true);
  assert.equal((await metrics(cancel)).outlineWidth, "1px", "keyboard focus uses the common thin ring");
  await cancel.press("Tab");
  const submit = queue.getByRole("button", { name: "加入队列", exact: true });
  assert.equal(await submit.evaluate(element => document.activeElement === element), true);
  await submit.press("Enter");
  await page.waitForFunction(() => uiFixture.queueWrites.length === 1);
  const saving = queue.getByRole("button", { name: "正在保存…", exact: true });
  assert.equal(await saving.isDisabled(), true);
  await saving.evaluate(element => element.click());
  assert.equal(await page.evaluate(() => uiFixture.queueWrites.length), 1, "disabled submit cannot duplicate the write");
  assert.equal(await body.inputValue(), "保留这段原生输入，检查键盘与保存中的状态。");
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.queue-task-form-actions [data-ui-button="submit"]')).opacity === "0.5");
  await page.evaluate(() => uiFixture.busy(false));
  await queue.getByRole("combobox", { name: "任务类型" }).selectOption("conversion");
  const source = queue.getByRole("combobox", { name: "选择已保存的源文件" });
  await source.selectOption("source-one");
  await queue.getByRole("button", { name: "上传新文件", exact: true }).click();
  assert.equal(await page.evaluate(() => uiFixture.uploads.length), 1);
  assert.equal(await queue.getByRole("button", { name: "上传新文件", exact: true }).locator("svg").count(), 0);
  const queueSelect = queue.getByRole("combobox", { name: "原文语言", exact: true });
  await queueSelect.click();
  assert.equal(await queueSelect.evaluate(element => element.matches(":open")), true);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.equal(await queueSelect.inputValue(), "de");
  await queueSelect.press("Space");
  await page.keyboard.press("Escape");
  assert.equal(await queueSelect.evaluate(element => element.matches(":open")), false);
  assert.equal(await queue.isVisible(), true, "first Escape closes only the native picker");
  await page.screenshot({ path: resolve(output, "queue-fields.png") });
  await page.keyboard.press("Escape");
  await queue.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.dataset.focusKey === "queue-add-task");
  assert.equal(await addTask().evaluate(element => document.activeElement === element), true);
  check("Queue preserves field click range, native picker keyboard behavior, input and single-submit busy guard");

  // Every page uses the same compact composer. Check the transition itself,
  // since settled screenshots cannot reveal a height jump or live hidden field.
  for (const percent of [80, 100, 120]) {
    await page.evaluate(value => uiFixture.scale(value), percent);
    const composer = await openQueueDraft({ type: "correction", documentId: "ui-material", body: "Keep this draft through every task type." });
    const original = await composer.boundingBox();
    near(original.width, 560 * percent / 80, "composer width follows its own role");
    near(original.height, 420 * percent / 80, "composer has the compact height rather than Settings panel height");
    assert.equal(await composer.getAttribute("data-modal-size"), "composer");
    assert.equal(await composer.locator('[data-focus-key="queue-task-surface"]').evaluate(element => element === document.activeElement), true, "new task opens neutrally without beginning to edit");
    const initialContext = composer.getByRole("combobox", { name: "关联文章", exact: true });
    assert.equal((await metrics(initialContext)).borderColor, "rgb(217, 223, 228)", "context values retain a visible editable boundary");
    const originalTypeRow = await inspectTaskTypeLayout(composer, `${percent}-initial`, percent);
    for (const type of ["conversion", "translation", "question", "instruction", "correction"]) {
      await page.evaluate(() => {
        window.queueTypeFrames = [];
        window.queueTypeFramesDone = false;
        const start = performance.now();
        const record = () => {
          const dialog = document.querySelector(".queue-task-dialog"), rect = dialog.getBoundingClientRect();
          const footer = dialog.querySelector(".queue-task-form-actions").getBoundingClientRect();
          window.queueTypeFrames.push({ time: performance.now() - start, width: rect.width, height: rect.height, x: rect.x, y: rect.y, footerY: footer.y,
            pages: [...dialog.querySelectorAll(".queue-task-form-scroll")].map(element => ({ active: element.dataset.active === "true", opacity: Number(getComputedStyle(element).opacity), disabled: element.disabled, inert: element.inert })) });
          if (performance.now() - start < 450) requestAnimationFrame(record);
          else window.queueTypeFramesDone = true;
        };
        record();
      });
      await composer.getByRole("combobox", { name: "任务类型", exact: true }).selectOption(type);
      await page.waitForFunction(() => window.queueTypeFramesDone);
      await settleQueuePages();
      const frames = await page.evaluate(() => window.queueTypeFrames);
      assert.ok(frames.some(frame => frame.pages.some(panel => panel.opacity > .05 && panel.opacity < .95)), `${type}: observe a real intermediate page transition`);
      for (const frame of frames) {
        near(frame.width, original.width, `${type}: width remains fixed during transition`);
        near(frame.height, original.height, `${type}: height remains fixed during transition`);
        near(frame.x, original.x, `${type}: horizontal position remains fixed`);
        near(frame.y, original.y, `${type}: vertical position remains fixed`);
        assert.equal(frame.pages.filter(panel => panel.active).length, 1);
        assert.ok(frame.pages.every(panel => panel.active ? !panel.disabled && !panel.inert : panel.disabled && panel.inert), `${type}: hidden native fields cannot validate or receive input`);
      }
      const current = composer.locator('.queue-task-form-scroll[data-active="true"]');
      assert.equal(await current.locator("textarea").inputValue(), "Keep this draft through every task type.");
      assert.equal(await current.locator("textarea").getAttribute("aria-labelledby").then(Boolean), true);
      const typeLayout = await inspectTaskTypeLayout(composer, `${percent}-${type}`, percent);
      near(typeLayout.control.y, originalTypeRow.control.y, `${type}: task type remains fixed above changing pages`);
      await assertReachableFooter(composer, 1000);
      queueGeometry.push({ percent, type, original, frames });
    }
    await composer.getByRole("combobox", { name: "关联文章", exact: true }).selectOption("ui-material");
    assert.equal(await composer.locator("form").evaluate(element => element.checkValidity()), true, "visited source and question required fields cannot block the active correction form");
    const footerButtons = await composer.locator(".queue-task-form-actions button").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
    assert.ok(footerButtons[1] - footerButtons[0] > original.width / 2, "cancel and submit remain at opposite ends of the footer");
    await page.screenshot({ path: resolve(output, `queue-composer-${percent}.png`) });
    check(`${percent}% all five task types preserve the compact frame through animation, disable hidden fields and retain the draft`);
    await composer.getByRole("combobox", { name: "任务类型", exact: true }).selectOption("conversion");
    await settleQueuePages();
    await inspectTaskPicker(composer, String(percent));
    const typeControl = composer.getByRole("combobox", { name: "任务类型", exact: true });
    const savesBeforeTypeSelection = await page.evaluate(() => uiFixture.queueWrites.length);
    await typeControl.focus();
    await typeControl.press("Space");
    await settleNativePicker(typeControl);
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await settleQueuePages();
    assert.equal(await typeControl.inputValue(), "instruction", "keyboard selection changes the task type from its separate row");
    assert.equal(await page.evaluate(() => uiFixture.queueWrites.length), savesBeforeTypeSelection, "Enter in the native type picker does not submit its containing form");
    assert.equal(await composer.getByRole("textbox", { name: "任务要求", exact: true }).inputValue(), "Keep this draft through every task type.");
    await inspectTaskTypeLayout(composer, `${percent}-keyboard-instruction`, percent);
    await inspectTaskPicker(composer, `${percent}-keyboard-instruction`);
    await page.keyboard.press("Escape");
    await composer.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.dataset.focusKey === "queue-add-task");
    assert.equal(await page.evaluate(() => uiFixture.queueWrites.length), savesBeforeTypeSelection, "closing the picker and composer performs no save");
    check(`${percent}% separate task type row stays below the title, gives every label arrow clearance and preserves keyboard selection, Escape and the draft`);
  }

  await page.evaluate(() => uiFixture.scale(80));
  questionRows = [];
  const questionDialog = await openQueueDraft({ type: "question", documentId: "", insightId: "", body: "Preserve the supplementary request." });
  const articleChoice = questionDialog.getByRole("combobox", { name: "关联文章", exact: true });
  const questionChoice = questionDialog.getByRole("combobox", { name: "问题", exact: true });
  assert.equal(await questionChoice.isDisabled(), true, "choose an article before loading questions");
  for (const control of [articleChoice, questionChoice]) {
    assert.deepEqual(await control.locator('option[value=""]').evaluate(element => ({ disabled: element.disabled, hidden: element.hidden })), { disabled: true, hidden: true }, "empty guidance is not a selectable native picker entry");
  }
  await articleChoice.click();
  await assertPickerPlaceholderHidden(articleChoice);
  await page.keyboard.press("Escape");
  await articleChoice.selectOption("ui-material");
  await questionDialog.getByText("这篇文章还没有未回答的问题。", { exact: true }).waitFor();
  assert.equal(await questionChoice.evaluate(element => element.validity.valueMissing), true);
  const writesBeforeEmpty = await page.evaluate(() => uiFixture.queueWrites.length);
  await questionDialog.getByRole("button", { name: "加入队列", exact: true }).click();
  assert.equal(await page.evaluate(() => uiFixture.queueWrites.length), writesBeforeEmpty, "empty question choice cannot submit a nonexistent question");
  assert.equal(await questionDialog.getByRole("textbox", { name: "补充要求", exact: true }).inputValue(), "Preserve the supplementary request.");
  await assertReachableFooter(questionDialog, 1000);
  check("question tasks distinguish empty results from a selectable placeholder and keep supplementary input without submitting");

  const longQuestion = "如何核对源文中所有公式的假设、推导边界与引用关系？ ".repeat(9);
  questionRows = [{ id: "question-long", reference: "#Q00042", documentId: "ui-material", type: "question", title: longQuestion, version: 7 }];
  const readsBeforeRefresh = questionRequests.length;
  await questionDialog.getByRole("button", { name: "刷新问题列表", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.queue-task-form-scroll[data-active="true"] option[value="question-long"]'));
  assert.ok(questionRequests.length > readsBeforeRefresh);
  assert.equal(questionRequests.at(-1).documentId, "ui-material");
  await questionChoice.selectOption("question-long");
  assert.equal((await page.evaluate(() => uiFixture.getDraft())).expectedInsightVersion, 7);
  await questionChoice.click();
  assert.equal(await questionChoice.evaluate(element => element.matches(":open")), true);
  await settleNativePicker(questionChoice);
  await assertPickerPlaceholderHidden(questionChoice);
  const option = questionChoice.locator('option[value="question-long"]');
  const optionBounds = await option.boundingBox();
  assert.ok(optionBounds.height > 40, "long native question options wrap to multiple lines");
  assert.ok(await option.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "long question content does not overflow the picker horizontally");
  await page.screenshot({ path: resolve(output, "queue-question-long-picker.png") });
  await page.keyboard.press("Escape");
  assert.equal(await questionDialog.isVisible(), true);
  await assertReachableFooter(questionDialog, 1000);
  questionRows = [{ ...questionRows[0], version: 8, title: "Updated question after source review" }];
  await questionDialog.getByRole("button", { name: "刷新问题列表", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.queue-task-form-scroll[data-active="true"] option[value="question-long"]')?.textContent.includes("Updated question"));
  const refreshedDraft = await page.evaluate(() => uiFixture.getDraft());
  assert.equal(refreshedDraft.insightId, "");
  assert.equal(refreshedDraft.expectedInsightVersion, undefined, "refresh invalidates the earlier question version");
  assert.equal(refreshedDraft.body, "Preserve the supplementary request.");
  await questionChoice.selectOption("question-long");
  assert.equal((await page.evaluate(() => uiFixture.getDraft())).expectedInsightVersion, 8);
  await questionDialog.getByRole("textbox", { name: "补充要求", exact: true }).fill("");
  assert.equal(await questionDialog.locator("form").evaluate(element => element.checkValidity()), true, "a selected question does not require redundant supplementary prose");
  await questionDialog.getByRole("button", { name: "加入队列", exact: true }).click();
  assert.equal((await page.evaluate(() => uiFixture.queueCommands.at(-1))).task.expectedInsightVersion, 8);
  await page.evaluate(() => uiFixture.busy(false));
  await closeQueueDraft(questionDialog);
  check("question refresh loads and wraps long native options, retains prose and submits only the newly selected version");

  await page.setViewportSize({ width: 900, height: 600 });
  await page.evaluate(() => uiFixture.scale(120));
  questionRows = [{ id: "question-long", reference: "#Q00042", documentId: "ui-material", type: "question", title: longQuestion, version: 9 }];
  const shortQuestion = await openQueueDraft({ type: "question", documentId: "ui-material", insightId: "", body: "Preserve the question draft in a short window." });
  const shortQuestionChoice = shortQuestion.getByRole("combobox", { name: "问题", exact: true });
  await page.waitForFunction(() => document.querySelector('.queue-task-form-scroll[data-active="true"] option[value="question-long"]'));
  await shortQuestionChoice.selectOption("question-long");
  const questionWriting = shortQuestion.getByRole("textbox", { name: "补充要求", exact: true });
  await questionWriting.scrollIntoViewIfNeeded();
  await questionWriting.fill(Array.from({ length: 16 }, (_, index) => `第 ${index + 1} 行：保留问题的来源与补充要求。`).join("\n"));
  await questionWriting.evaluate(element => { element.scrollTop = element.scrollHeight; });
  assert.ok(await questionWriting.evaluate(element => element.scrollTop > 0), "question prose keeps its native scroll at the minimum desktop window");
  assert.equal(await shortQuestion.locator("form").evaluate(element => element.checkValidity()), true);
  await assertReachableFooter(shortQuestion, 600);
  await page.screenshot({ path: resolve(output, "queue-question-short-120.png") });
  await shortQuestion.getByRole("button", { name: "刷新问题列表", exact: true }).scrollIntoViewIfNeeded();
  await shortQuestion.getByRole("button", { name: "刷新问题列表", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.queue-task-form-scroll[data-active="true"] select[aria-labelledby]:disabled'));
  assert.match(await questionWriting.inputValue(), /第 16 行/);
  assert.equal((await page.evaluate(() => uiFixture.getDraft())).insightId, "");
  await assertReachableFooter(shortQuestion, 600);
  await closeQueueDraft(shortQuestion);
  check("900×600 at 120% keeps question selection, refresh, long prose and the decision footer reachable");

  const editBody = Array.from({ length: 18 }, (_, index) => `Line ${index + 1}: retain this draft through conflict recovery.`).join("\n");
  const editDialog = await openQueueDraft({ type: "correction", taskId: "edit-task", reference: "#T00077", expectedVersion: 3, documentId: "ui-material", body: editBody, conflict: true });
  await page.evaluate(() => uiFixture.queueError("The saved task changed. Keep the full current draft and choose how to continue. ".repeat(4)));
  const editWriting = editDialog.getByRole("textbox", { name: "任务要求", exact: true });
  assert.equal(await editWriting.evaluate(element => element === document.activeElement), true, "editing returns focus directly to the requirements");
  assert.equal(await editDialog.getByRole("combobox", { name: "任务类型", exact: true }).isDisabled(), true);
  assert.equal(await editDialog.getByRole("combobox", { name: "关联文章", exact: true }).isDisabled(), true);
  assert.equal(await editDialog.getByRole("button", { name: "保存修改", exact: true }).isDisabled(), true, "conflict prevents a blind overwrite");
  const recovery = editDialog.getByRole("button", { name: "读取最新版本并保留输入", exact: true });
  await recovery.scrollIntoViewIfNeeded();
  await assertReachableFooter(editDialog, 600);
  await page.screenshot({ path: resolve(output, "queue-edit-conflict-short.png") });
  await recovery.click();
  assert.deepEqual(await page.evaluate(() => uiFixture.reloads), ["edit-task"]);
  assert.equal(await editWriting.inputValue(), editBody);
  assert.equal(await editDialog.getByRole("button", { name: "保存修改", exact: true }).isEnabled(), true);
  await editWriting.scrollIntoViewIfNeeded();
  await editWriting.fill(editBody + "\nUpdated after reviewing the latest version.");
  await editDialog.getByRole("button", { name: "保存修改", exact: true }).click();
  const recoveredCommand = await page.evaluate(() => uiFixture.queueCommands.at(-1));
  assert.equal(recoveredCommand.expectedVersion, 4);
  assert.match(recoveredCommand.patch.body, /Updated after reviewing/);
  await page.evaluate(() => uiFixture.busy(false));
  await closeQueueDraft(editDialog);
  check("short-window edit conflicts keep identity locked, expose recovery and footer, and preserve prose for the newer version");

  const pendingCommand = { kind: "queue.update", taskId: "pending-task", expectedVersion: 5, requestId: "original-unconfirmed-request", patch: { body: "Keep the original unconfirmed operation." } };
  const pendingDialog = await openQueueDraft({ type: "question", taskId: "pending-task", reference: "#T00078", expectedVersion: 5, documentId: "ui-material", body: pendingCommand.patch.body, pendingCommand });
  assert.equal(await pendingDialog.getByRole("combobox", { name: "问题", exact: true }).count(), 0, "editing does not change the task's original question identity");
  assert.equal(await pendingDialog.getByRole("textbox", { name: "任务要求", exact: true }).isDisabled(), true);
  await pendingDialog.getByText("上次保存结果尚未确认。继续确认会重试同一项操作。", { exact: true }).scrollIntoViewIfNeeded();
  await assertReachableFooter(pendingDialog, 600);
  const confirmSave = pendingDialog.getByRole("button", { name: "继续确认保存", exact: true });
  assert.equal(await confirmSave.isEnabled(), true);
  await confirmSave.click();
  assert.deepEqual(await page.evaluate(() => uiFixture.queueCommands.at(-1)), pendingCommand, "confirmation retries the original request rather than inventing another write");
  await page.evaluate(() => uiFixture.busy(false));
  await closeQueueDraft(pendingDialog);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => uiFixture.scale(80));
  check("pending-save edits retain locked fields, reachable confirmation and the exact original command identity");

  await page.evaluate(() => uiFixture.busy(true));
  await read().evaluate(element => element.click());
  assert.equal(await page.evaluate(() => uiFixture.reads.length), 0, "aria-disabled read preserves its business guard");
  await page.evaluate(() => uiFixture.busy(false));
  await page.getByRole("radio", { name: "在读", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "重新阅读", exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => uiFixture.statuses), ["done"]);
  await page.getByRole("button", { name: "加入阅读计划", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "已加入阅读计划", exact: true }).getAttribute("aria-pressed"), "true");
  check("Collection roles retain explicit status changes, plan toggle and aria-disabled behavior");

  const updateRegion = page.getByRole("region", { name: "程序更新", exact: true });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await page.getByRole("button", { name: "正在检查…", exact: true }).waitFor();
  await page.getByRole("button", { name: "正在检查…", exact: true }).evaluate(element => element.click());
  assert.deepEqual(await page.evaluate(() => uiFixture.updateCalls), ["check"]);
  await page.evaluate(() => uiFixture.settleUpdate({ state: "available", availableVersion: "2026.10.30-with-a-deliberately-long-version-label", bytes: 4194304, releaseUrl: "https://example.invalid/release" }));
  const download = page.getByRole("button", { name: /^下载更新/ });
  await download.waitFor();
  assert.equal(await download.getAttribute("data-ui-button"), "submit");
  await download.click();
  await page.evaluate(() => uiFixture.setUpdate({ state: "downloading", receivedBytes: 2, bytes: 4 }));
  await updateRegion.getByRole("progressbar").waitFor();
  assert.equal(await updateRegion.getByRole("progressbar").getAttribute("value"), "2");
  await page.evaluate(() => uiFixture.settleUpdate({ state: "downloaded", availableVersion: "2026.10.30-fixture" }));
  const restart = page.getByRole("button", { name: "重启并更新", exact: true });
  await restart.waitFor();
  await restart.click();
  await page.getByText("正在保存并重启…", { exact: true }).waitFor();
  await page.evaluate(() => uiFixture.settleUpdate(null, "合成错误：连接中断，操作未完成。"));
  await updateRegion.getByRole("alert").waitFor();
  assert.match(await updateRegion.getByRole("alert").textContent(), /连接中断/);
  await page.evaluate(() => uiFixture.setUpdate({ state: "full-update-required", availableVersion: "2026.10.30", releaseUrl: "https://example.invalid/release" }));
  const installer = page.getByRole("button", { name: "下载安装包", exact: true });
  await installer.waitFor();
  assert.equal(await installer.getAttribute("data-ui-button"), "entry");
  await installer.click();
  await page.evaluate(() => uiFixture.settleUpdate({ state: "idle", checkedAt: "fixture" }));
  await page.getByText("已是最新版本", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => uiFixture.updateCalls), ["check", "download", "restart", "openRelease"]);
  check("Desktop Updates exercises check, available, downloading, downloaded, restart failure, full installer and idle states through a mocked bridge");

  await page.evaluate(() => uiFixture.scale(80));
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings.waitFor();
  const settleSettingsPages = () => page.waitForFunction(() => [...document.querySelectorAll(".settings-page")].every(element => {
    const opacity = Number(getComputedStyle(element).opacity);
    return element.dataset.active === "true" ? opacity > .999 : opacity < .001;
  }));
  const settingsClose = settings.getByRole("button", { name: "关闭设置", exact: true });
  const settingsDone = settings.getByRole("button", { name: "完成", exact: true });
  const doneStyle = await metrics(settingsDone);
  assert.equal(doneStyle.background, "rgb(241, 241, 241)");
  assert.equal(doneStyle.borderColor, "rgba(0, 0, 0, 0)");
  assert.equal(doneStyle.shadow, "none");
  await settingsDone.hover();
  await page.waitForTimeout(180);
  const doneHover = await metrics(settingsDone);
  assert.equal(doneHover.background, "rgb(232, 232, 232)");
  assert.equal(doneHover.borderColor, "rgba(0, 0, 0, 0)");
  await settingsClose.focus();
  await page.keyboard.press("Tab");
  const settingsRadio = settings.getByRole("radio", { name: "侧栏", exact: true });
  await settingsRadio.focus();
  const settingsProxy = settingsRadio.locator("+ span");
  assert.equal((await metrics(settingsProxy)).outlineColor, "rgb(115, 123, 131)");
  assert.equal((await metrics(settingsProxy)).background, "rgb(222, 222, 222)");
  await page.emulateMedia({ forcedColors: "active" });
  assert.equal((await metrics(settingsProxy)).outlineWidth, "2px");
  assert.equal((await metrics(settingsProxy)).shadow, "none");
  await page.emulateMedia({ forcedColors: "none" });
  await settings.getByRole("tab", { name: "高亮", exact: true }).click();
  await settleSettingsPages();
  for (const card of await settings.locator(".palette-preset").all()) {
    const cardStyle = await metrics(card);
    assert.equal(cardStyle.borderColor, "rgba(0, 0, 0, 0)");
    assert.equal(cardStyle.background, await card.locator("input").isChecked() ? "rgb(222, 222, 222)" : "rgb(241, 241, 241)");
  }
  await page.screenshot({ path: resolve(output, "settings-palette-borderless.png") });
  await page.keyboard.press("Tab");
  for (const selector of [".palette-preset", ".palette-color"]) {
    const proxy = settings.locator(selector).first();
    await proxy.locator("input").focus();
    assert.equal((await metrics(proxy)).outlineColor, "rgb(115, 123, 131)");
    await page.emulateMedia({ forcedColors: "active" });
    assert.equal((await metrics(proxy)).outlineWidth, "2px");
    assert.equal((await metrics(proxy)).shadow, "none");
    await page.emulateMedia({ forcedColors: "none" });
  }
  check("Settings radio and palette focus proxies share visible gray keyboard focus and system forced colors");
  await settings.getByRole("tab", { name: "界面", exact: true }).click();
  await settleSettingsPages();
  await settings.locator(".icon-style-sample").first().waitFor();
  for (const option of await settings.locator(".icon-style-option").all()) {
    const cardStyle = await metrics(option.locator(".icon-style-sample"));
    assert.equal(cardStyle.borderColor, "rgba(0, 0, 0, 0)");
    assert.equal(cardStyle.background, await option.locator("input").isChecked() ? "rgb(222, 222, 222)" : "rgb(241, 241, 241)");
    assert.equal(cardStyle.shadow, "none");
  }
  const modeStyle = await metrics(settings.locator(".interface-mode-option input:checked + span"));
  assert.equal(modeStyle.background, "rgb(222, 222, 222)");
  assert.equal(modeStyle.shadow, "none");
  await page.screenshot({ path: resolve(output, "settings-interface-borderless.png") });
  await settings.getByRole("tab", { name: "快捷键", exact: true }).click();
  await settleSettingsPages();
  const recorderStyle = await metrics(settings.locator(".shortcut-recorder").first());
  assert.equal(recorderStyle.background, "rgb(241, 241, 241)");
  assert.equal(recorderStyle.borderColor, "rgba(0, 0, 0, 0)");
  check("Settings icon, palette, interface and shortcut choices use borderless gray surfaces with distinct selected states");
  const before = await metrics(settingsClose);
  await page.evaluate(() => uiFixture.scale(120));
  await page.waitForTimeout(50);
  const after = await metrics(settingsClose);
  near(after.height, before.height, "open settings controls keep frozen scale");
  await settings.getByRole("tab", { name: "更新", exact: true }).click();
  const settingsCheck = settings.getByRole("button", { name: "检查更新", exact: true });
  await settingsCheck.waitFor();
  near((await metrics(settingsCheck)).fontSize, 12, "open settings update controls share frozen scale");
  await settingsClose.click();
  await settings.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await settings.waitFor();
  near((await metrics(settingsClose)).height, 45, "reopened settings adopts new scale");
  await settingsClose.click();
  await settings.waitFor({ state: "hidden" });
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  check("Settings uses an independent frozen token scope and adopts a new scale only on reopen");

  for (const selector of ['[data-role-sample="legacy-glossary"]', '[data-role-sample="legacy-reference"]', '[data-role-sample="legacy-editor"]', '[data-role-sample="legacy-save"]', '[data-role-sample="legacy-glossary-add"]', '[data-role-sample="legacy-reference-open"]', '[data-role-sample="legacy-gallery"]']) {
    const sample = page.locator(selector);
    const normal = await metrics(sample);
    assert.equal(normal.background, "rgb(241, 241, 241)", `${selector} follows the light action surface`);
    assert.equal(normal.borderColor, "rgba(0, 0, 0, 0)", `${selector} has no legacy border`);
    assert.equal(normal.shadow, "none", `${selector} has no inset border`);
    await sample.hover();
    await page.waitForTimeout(180);
    const hovered = await metrics(sample);
    assert.equal(hovered.borderColor, "rgba(0, 0, 0, 0)", `${selector} does not restore a border on hover`);
  }
  const readerSelected = await metrics(page.locator('[data-role-sample="reader-selected"]'));
  assert.equal(readerSelected.background, "rgb(240, 240, 240)");
  assert.equal(readerSelected.shadow, "none");
  near(readerSelected.height, 45, "Reader tool uses the shared 30px scale role");
  check("light actions and selected Reader tools have no white surface or dark border, including hover and legacy consumers");

  await page.setViewportSize({ width: 640, height: 800 });
  await page.evaluate(() => uiFixture.scale(120));
  await page.getByRole("button", { name: "检查更新", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "large-scale content does not escape narrow viewport");
  assert.equal((await metrics(page.locator('[data-role-sample="long"]'))).clipped, false);
  await page.emulateMedia({ forcedColors: "active" });
  await tool().focus();
  await page.keyboard.press("Tab");
  const compactTool = page.getByRole("button", { name: "紧凑工具" });
  const forced = await metrics(compactTool);
  assert.equal(await compactTool.evaluate(element => element === document.activeElement), true, "keyboard focus reaches the compact tool");
  assert.equal(forced.outlineWidth, "2px", JSON.stringify(forced));
  assert.equal(forced.shadow, "none");
  assert.notEqual(forced.outlineColor, "rgba(0, 0, 0, 0)");
  await select().focus();
  await select().press("Space");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.equal(await select().inputValue(), "last");
  await page.screenshot({ path: resolve(output, "forced-colors-120.png"), fullPage: true });
  check("narrow 120% layout and forced colors preserve readable actions, visible keyboard focus and native selection");
  assert.deepEqual(errors, [], "no browser runtime errors");
  await writeFile(resolve(output, "queue-composer-geometry.json"), JSON.stringify(queueGeometry, null, 2));
  await writeFile(resolve(output, "queue-task-picker-geometry.json"), JSON.stringify(taskPickerGeometry, null, 2));
  await writeFile(resolve(output, "queue-task-type-layout.json"), JSON.stringify(taskTypeLayout, null, 2));
  await writeFile(resolve(output, "results.json"), JSON.stringify({ checks, errors, evidence: "Headless browser; synthetic records and mocked desktop bridge; no installed-profile or provider validation." }, null, 2));
} finally { await browser?.close(); await new Promise(done => server.close(done)); }
