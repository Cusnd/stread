import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.READER_TEST_NODE_MODULES ? `${process.env.READER_TEST_NODE_MODULES}/reader-tests.cjs` : import.meta.url);
const { chromium } = require("playwright");
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"], ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(8000);
const output = fileURLToPath(new URL("../../../.audit/reader-select/", import.meta.url));
const checks = [], errors = [], apiRequests = [], rightEdgeCases = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url()); });
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const status = () => page.getByRole("combobox", { name: "WEBB SPACE TELESCOPE的阅读状态" });
const isOpen = locator => locator.evaluate(element => element.matches(":open"));
try {
  await mkdir(output, { recursive: true });
  await page.goto(`${process.env.READER_TEST_URL || "http://127.0.0.1:5196"}/tests/fixtures/reader-select.html`);
  await status().waitFor();
  assert.equal(await status().locator(".reader-select-button").count(), 1);
  assert.equal(await status().evaluate(element => getComputedStyle(element).appearance), "base-select");
  await status().click();
  assert.equal(await isOpen(status()), true);
  await page.waitForTimeout(180);
  const colors = await status().evaluate(element => ({ picker: getComputedStyle(element, "::picker(select)").backgroundColor, text: getComputedStyle(element, "::picker(select)").color, checked: getComputedStyle(element.querySelector(":checked")).backgroundColor }));
  assert.deepEqual(colors, { picker: "rgb(255, 255, 255)", text: "rgb(37, 37, 37)", checked: "rgb(255, 255, 255)" });
  await page.screenshot({ path: `${output}/status-picker.png` });
  await status().getByRole("option", { name: "未读", exact: true }).click();
  assert.equal(await status().inputValue(), "unread");
  assert.equal(await status().locator("selectedcontent").textContent(), "未读");
  assert.deepEqual(await page.evaluate(() => window.selectFixture.writes), [{ id: "select-fixture", version: 1, status: "unread" }]);
  assert.equal(await status().evaluate(element => document.activeElement === element), true);
  check("standalone status picker uses neutral styling and preserves command identity, value and focus");

  await status().press("Space");
  assert.equal(await isOpen(status()), true);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.equal(await status().inputValue(), "done");
  assert.equal(await isOpen(status()), false);
  await status().press("Space");
  await page.keyboard.press("Escape");
  assert.equal(await isOpen(status()), false);
  assert.equal(await status().inputValue(), "done");
  check("keyboard opens, selects with End and Enter, and cancels with Escape");

  await page.getByRole("button", { name: "切换禁用" }).click();
  assert.equal(await status().isDisabled(), true);
  assert.equal(await status().evaluate(element => getComputedStyle(element).cursor), "default");
  await page.getByRole("button", { name: "切换禁用" }).click();
  check("pending state preserves native disabled behavior");

  const filter = page.getByRole("combobox", { name: "按文章筛选洞见" });
  await filter.click();
  await page.waitForTimeout(180);
  const bounds = await filter.locator("option").first().boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 1280);
  assert.equal(await filter.evaluate(element => getComputedStyle(element, "::picker(select)").overflowY), "auto");
  const pickerGeometry = await filter.evaluate(element => {
    const picker = getComputedStyle(element, "::picker(select)");
    const option = element.options[0], box = option.getBoundingClientRect();
    return { width: parseFloat(picker.width), border: parseFloat(picker.borderLeftWidth) + parseFloat(picker.borderRightWidth), paddingLeft: picker.paddingLeft, paddingRight: picker.paddingRight, optionWidth: box.width, radius: getComputedStyle(option).borderRadius };
  });
  assert.equal(pickerGeometry.paddingLeft, "0px", "picker adds a white inset before the highlight");
  assert.equal(pickerGeometry.paddingRight, "0px", "picker adds a white strip between highlight and scrollbar");
  assert.equal(pickerGeometry.radius, "0px", "option corners leave a white wedge beside the scrolling edge");
  assert.ok(Math.abs(pickerGeometry.width - pickerGeometry.border - pickerGeometry.optionWidth - 8) < 1, "picker must use the shared 8px native scrollbar, including its top-layer pseudo-element");
  await page.screenshot({ path: `${output}/long-options-picker.png` });
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.equal(await filter.inputValue(), "39");
  assert.equal(await filter.locator("selectedcontent").evaluate(element => getComputedStyle(element).textOverflow), "ellipsis");
  assert.equal(await filter.evaluate(element => getComputedStyle(element, "::picker-icon").flexShrink), "0");
  await filter.press("Tab");
  assert.equal(await page.getByRole("button", { name: "后续按钮" }).evaluate(element => document.activeElement === element), true);
  check("long option list has an 8px scrollbar without extra highlight insets, remains bounded and preserves normal Tab order");

  await page.getByRole("button", { name: "改变文章选项" }).click();
  assert.equal(await filter.locator("option").count(), 3);
  assert.equal(await filter.inputValue(), "0");
  assert.match(await filter.locator("selectedcontent").textContent(), /^Article 1:/);
  await page.getByRole("button", { name: "改变文章选项" }).click();
  assert.equal(await filter.locator("option").count(), 41);
  assert.equal(await filter.locator(".reader-select-button").count(), 1);
  assert.equal(await filter.evaluate(element => window.selectFixture.filterElement === element), true);
  await page.getByRole("button", { name: "切换文章筛选" }).click();
  assert.equal(await filter.count(), 0);
  assert.equal(await page.evaluate(() => window.selectFixture.filterElement), null);
  await page.getByRole("button", { name: "切换文章筛选" }).click();
  assert.equal(await filter.locator(".reader-select-button").count(), 1);
  assert.match(await filter.locator("selectedcontent").textContent(), /^Article 1:/);
  assert.equal(await filter.evaluate(element => window.selectFixture.filterElement === element), true);
  check("StrictMode, changing options and values, forwarded ref and remount preserve one synced native display slot");

  // Narrow triggers must not force their menu to the same narrow width. Put
  // the existing native article picker at the right viewport edge to exercise
  // the browser's anchor fallback while retaining real long option content.
  const originalFilterStyle = await filter.getAttribute("style");
  for (const [width, height] of [[1280, 900], [900, 600]]) for (const scale of [1, 1.25, 1.5]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(value => document.documentElement.style.setProperty("--ui-scale", String(value)), scale);
    await filter.evaluate(element => Object.assign(element.style, { position: "fixed", inset: "40px 8px auto auto", width: "76px", minWidth: "0", maxWidth: "none" }));
    await filter.click(); await page.waitForTimeout(180);
    const edge = await filter.evaluate(element => {
      const picker = getComputedStyle(element, "::picker(select)"), rect = element.getBoundingClientRect();
      const options = [...element.options].map(option => {
        const style = getComputedStyle(option), range = document.createRange(); range.selectNodeContents(option);
        return { box: option.getBoundingClientRect().toJSON(), text: range.getBoundingClientRect().toJSON(), lineHeight: parseFloat(style.lineHeight), scrollWidth: option.scrollWidth, clientWidth: option.clientWidth };
      });
      return { trigger: rect.toJSON(), pickerWidth: parseFloat(picker.width), options };
    });
    assert.ok(Math.abs(edge.pickerWidth - 160 * scale) < 1, `right edge ${width}/${scale}: menu lacks minimum readable width`);
    assert.ok(edge.pickerWidth > edge.trigger.width + 30, `right edge ${width}/${scale}: menu remains tied to compact trigger`);
    assert.ok(edge.options.every(option => option.box.x >= 0 && option.box.right <= width + 1 && option.scrollWidth <= option.clientWidth + 1), `right edge ${width}/${scale}: option overflows viewport or horizontal bounds`);
    assert.ok(edge.options[0].text.height < edge.options[0].lineHeight * 1.5, `right edge ${width}/${scale}: short option breaks into multiple lines`);
    assert.ok(edge.options[1].text.height > edge.options[1].lineHeight * 1.5, `right edge ${width}/${scale}: long article lost natural wrapping`);
    rightEdgeCases.push({ width, height, scale, ...edge });
    if (width === 900 && scale === 1.5) await page.screenshot({ path: `${output}/right-edge-120.png` });
    await page.keyboard.press("Escape");
    assert.equal(await isOpen(filter), false, `right edge ${width}/${scale}: Escape does not close picker`);
    assert.equal(await filter.inputValue(), "0", `right edge ${width}/${scale}: Escape changes selection`);
  }
  await filter.evaluate((element, value) => { if (value === null) element.removeAttribute("style"); else element.setAttribute("style", value); }, originalFilterStyle);
  await page.evaluate(() => document.documentElement.style.removeProperty("--ui-scale"));
  await page.setViewportSize({ width: 1280, height: 900 });
  check("compact picker keeps a readable minimum width at the right edge across three scales and two window sizes; long articles wrap and Escape preserves selection");

  await page.getByRole("button", { name: "编辑资料", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑资料" });
  const kind = dialog.getByRole("combobox", { name: "类型" });
  await kind.click();
  await page.waitForTimeout(180);
  await page.screenshot({ path: `${output}/dialog-picker.png` });
  await page.keyboard.press("Escape");
  assert.equal(await isOpen(kind), false);
  assert.equal(await dialog.isVisible(), true);
  await kind.click();
  await kind.getByRole("option", { name: "文章", exact: true }).click();
  assert.equal(await kind.inputValue(), "文章");
  assert.equal(await page.evaluate(() => window.selectFixture.saves), 0);
  await dialog.getByRole("button", { name: "保存修改" }).click();
  assert.equal(await page.evaluate(() => window.selectFixture.saves), 1);
  check("picker stays above modal; Escape only closes picker; selection does not submit form");

  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await kind.evaluate(element => getComputedStyle(element, "::picker(select)").transitionDuration), "0s");
  check("live reduced-motion preference removes picker transition");
  assert.deepEqual(errors, []);
  assert.deepEqual(apiRequests, []);
  check("no browser exceptions or workspace API requests");
  await writeFile(`${output}/verification.json`, JSON.stringify({ checks, colors, rightEdgeCases, errors, apiRequests, browser: await browser.version() }, null, 2));
} finally { await browser.close(); }
