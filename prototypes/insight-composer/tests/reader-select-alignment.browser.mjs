import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.READER_TEST_NODE_MODULES ? `${process.env.READER_TEST_NODE_MODULES}/reader-tests.cjs` : import.meta.url);
const { chromium } = require("playwright");
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"], ...(process.env.READER_TEST_BROWSER ? { executablePath: process.env.READER_TEST_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(6000);
const origin = process.env.READER_TEST_URL || "http://127.0.0.1:5196";
const output = fileURLToPath(new URL("../../../.audit/reader-select/alignment/", import.meta.url));
const errors = [], requests = [], results = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url()); });
const close = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(160); };
async function measure(select) {
  return select.evaluate(element => {
    const style = getComputedStyle(element), picker = getComputedStyle(element, "::picker(select)");
    const rect = node => node.getBoundingClientRect().toJSON();
    const text = node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().toJSON(); };
    const options = [...element.options].map(option => ({ box: rect(option), text: text(option), outline: getComputedStyle(option).outlineStyle, shadow: getComputedStyle(option).boxShadow, background: getComputedStyle(option).backgroundColor, focused: option.matches(":focus-visible") }));
    return { box: rect(element), text: text(element.querySelector("selectedcontent")), border: style.borderColor, borderWidth: style.borderWidth, outline: style.outlineStyle, shadow: style.boxShadow, focusVisible: element.matches(":focus-visible"), picker: { width: Number.parseFloat(picker.width), padding: Number.parseFloat(picker.paddingLeft), border: Number.parseFloat(picker.borderLeftWidth), outline: picker.outlineStyle }, options };
  });
}
try {
  await mkdir(output, { recursive: true });
  for (const scale of [80, 100, 120]) for (const [context, count] of Object.entries({ details: 0, edit: 2, category: 1, flow: 2, settings: 3, import: 1, revision: 1, reference: 1 })) {
    await page.goto(`${origin}/tests/fixtures/reader-select-contexts.html?context=${context}&scale=${scale}`);
    const selects = page.getByRole("combobox");
    if (context === "details") {
      // MaterialDetails intentionally presents all three statuses as a radio
      // group. Native picker geometry remains covered by the other contexts.
      const group = page.getByRole("radiogroup", { name: /的阅读状态$/ });
      await group.waitFor(); await page.waitForTimeout(420);
      assert.equal(await selects.count(), 0, "details must not retain a reading-status dropdown");
      const radios = group.getByRole("radio");
      assert.equal(await radios.count(), 3, "details reading-state coverage");
      assert.deepEqual(await radios.allTextContents(), ["未读", "在读", "已读"]);
      assert.equal(await group.getByRole("radio", { checked: true }).count(), 1, "details has exactly one checked state");
      const states = await radios.evaluateAll(elements => elements.map(element => ({ label: element.textContent, checked: element.getAttribute("aria-checked"), tabIndex: element.tabIndex, box: element.getBoundingClientRect().toJSON() })));
      assert.equal(states.filter(state => state.tabIndex === 0).length, 1, "details has one Tab entry point");
      const name = `details/radiogroup/${scale}`;
      results.push({ name, comboboxCount: 0, states });
      console.log(`PASS ${name}: no dropdown, three radio states and one Tab entry point`);
      continue;
    }
    await selects.first().waitFor(); await page.waitForTimeout(420);
    assert.equal(await selects.count(), count, `${context} control coverage`);
    for (let index = 0; index < count; index++) {
      const select = selects.nth(index), name = `${context}/${index}/${scale}`;
      await select.scrollIntoViewIfNeeded();
      await select.click(); await page.waitForTimeout(180);
      const pointer = await measure(select);
      const left = pointer.options[0].box.x - pointer.picker.padding - pointer.picker.border;
      assert.ok(Math.abs(pointer.picker.width - pointer.box.width) < 1, `${name}: picker width ${pointer.picker.width}, control ${pointer.box.width}`);
      assert.ok(Math.abs(left - pointer.box.x) < 1, `${name}: left edges do not align`);
      assert.ok(pointer.options.every(option => Math.abs(option.text.x - pointer.text.x) < 1), `${name}: text axes do not align`);
      assert.equal(pointer.border, "rgb(229, 229, 229)", `${name}: pointer-open border is emphasized`);
      assert.equal(pointer.outline, "none", `${name}: trigger has outer focus box`);
      assert.equal(pointer.picker.outline, "none", `${name}: picker outline`);
      assert.ok(pointer.options.every(option => option.outline === "none" && option.shadow === "none"), `${name}: framed option`);
      if (index === 0 && scale === 100) {
        const top = Math.min(pointer.box.y, pointer.options[0].box.y) - 12;
        const bottom = Math.max(pointer.box.bottom, ...pointer.options.map(option => option.box.bottom)) + 12;
        await page.screenshot({ path: `${output}/${context}-pointer.png`, clip: { x: Math.max(0, pointer.box.x - 12), y: Math.max(0, top), width: Math.min(pointer.box.width + 24, 1440 - Math.max(0, pointer.box.x - 12)), height: Math.min(bottom - top, 1100 - Math.max(0, top)) } });
      }
      await close();
      await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
      assert.ok(await select.evaluate(element => document.activeElement === element), `${name}: tab returns focus`);
      await page.waitForTimeout(180);
      const keyboardClosed = await measure(select);
      assert.equal(keyboardClosed.outline, "none", `${name}: keyboard focus adds an outer box`);
      assert.equal(keyboardClosed.border, "rgb(104, 104, 104)", `${name}: keyboard focus is not visible`);
      assert.equal(keyboardClosed.borderWidth, "1px", `${name}: keyboard focus changes control geometry`);
      await select.press("Space"); await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(180);
      const keyboardOpen = await measure(select);
      const focusOption = keyboardOpen.options.find(option => option.focused);
      assert.ok(focusOption, `${name}: keyboard option focus missing`);
      assert.equal(focusOption.shadow, "none", `${name}: keyboard option has an extra frame`);
      assert.notEqual(focusOption.background, "rgb(255, 255, 255)", `${name}: keyboard option focus invisible`);
      await close();
      await select.click(); await page.waitForTimeout(180);
      const reopened = await measure(select);
      assert.equal(reopened.border, "rgb(229, 229, 229)", `${name}: pointer inherits previous keyboard frame`);
      await close();
      results.push({ name, pointer, keyboardClosed, keyboardOpen });
      console.log(`PASS ${name}: edges, text, pointer and keyboard states`);
    }
    if (context === "settings") {
      await page.keyboard.press("Escape"); await page.waitForTimeout(450);
      assert.equal(await page.getByRole("dialog").count(), 0, "Escape after the picker closes must still close settings");
    }
  }
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
} finally {
  await writeFile(`${output}/verification.json`, JSON.stringify({ results, errors, requests, browser: await browser.version() }, null, 2));
  await browser.close();
}
