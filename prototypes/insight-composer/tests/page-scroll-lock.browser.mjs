import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const dependency = name => require(process.env.READER_TEST_NODE_MODULES ? resolve(process.env.READER_TEST_NODE_MODULES, name) : name);
const { chromium } = dependency("playwright");
const { PNG } = dependency("pngjs");
const [lock, base, scrollbars, dialogs] = await Promise.all([
  "page-scroll-lock.js", "styles.css", "scrollbars.css", "workspace-shell.css",
].map(name => readFile(resolve(frontend, "src", name), "utf8")));
const html = `<!doctype html><html><head><style>${scrollbars}${base.replace('@import "./scrollbars.css";', "")}${dialogs}
html { scroll-behavior: auto; } body { padding-right: 3px; }
#content { height: 1600px; } #header { position: fixed; inset: 0 auto auto 0; width: 100vw; height: 56px; background: white; }
#overlay { position: fixed; inset: 0; background: #24282d30; }
</style></head><body><div id="header"></div><div id="content"></div>
<dialog id="first" class="workspace-service-dialog" data-state="open">First dialog</dialog>
<dialog id="second" class="workspace-service-dialog" data-state="open">Second dialog</dialog>
<script type="module">import { acquirePageScrollLock } from '/lock.js'; window.lock = acquirePageScrollLock;</script></body></html>`;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/lock.js" ? "text/javascript" : "text/html; charset=utf-8");
  response.end(request.url === "/lock.js" ? lock : html);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.READER_TEST_BROWSER || resolve(process.env.ProgramFiles || "C:/Program Files", "Google/Chrome/Application/chrome.exe") });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const geometry = () => page.evaluate(() => {
    const rect = id => { const box = document.getElementById(id).getBoundingClientRect(); return [box.x, box.width]; };
    return { content: rect("content"), header: rect("header"), scrollY, rootStyle: document.documentElement.getAttribute("style"), bodyStyle: document.body.getAttribute("style") };
  });
  const uniformEdge = async () => {
    const png = PNG.sync.read(await page.screenshot());
    const pixel = x => [...png.data.subarray((550 * png.width + x) * 4, (550 * png.width + x) * 4 + 3)];
    assert.deepEqual(pixel(799), pixel(780), "backdrop reaches the right window edge");
    assert.ok(pixel(799)[0] < 240, "the edge is dimmed with the page");
  };
  for (const height of [1600, 200]) {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => typeof window.lock === "function");
    await page.evaluate(value => { document.getElementById("content").style.height = `${value}px`; document.documentElement.style.scrollbarGutter = "stable"; window.scrollTo(0, 120); }, height);
    const before = await geometry();
    await page.evaluate(() => { window.releaseFirst = lock(); document.getElementById("first").showModal(); });
    await page.waitForTimeout(180);
    const opened = await geometry();
    assert.deepEqual(opened.content, before.content, "reading content does not shift when a modal locks scrolling");
    assert.deepEqual(opened.header, before.header, "desktop header remains aligned");
    assert.equal(opened.scrollY, before.scrollY, "opening preserves the reading position");
    await uniformEdge();
    await page.evaluate(() => { window.releaseSecond = lock(); document.getElementById("second").showModal(); document.getElementById("first").close(); releaseFirst(); });
    await page.waitForTimeout(180);
    await uniformEdge();
    assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "hidden");
    await page.evaluate(() => { document.getElementById("second").close(); releaseSecond(); });
    assert.deepEqual(await geometry(), before, "final close restores geometry, scroll position and inline styles");
    await page.evaluate(() => { window.releaseOverlay = lock(); const overlay = document.createElement("div"); overlay.id = "overlay"; document.body.append(overlay); });
    await uniformEdge();
    await page.evaluate(() => { document.getElementById("overlay").remove(); releaseOverlay(); });
    assert.deepEqual(await geometry(), before);
  }
  console.log("PASS full-window modal and overlay dimming, stable content/header positions, nested locks and style restoration");
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
