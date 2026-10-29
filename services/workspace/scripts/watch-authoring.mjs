import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { parseFragment } from "parse5";
import { hash } from "../errors.mjs";
import { mediaTypeFor } from "../resources.mjs";
import { localWorkspaceUrl } from "../local-endpoint.mjs";
import { safeHtmlAsset } from "../../../prototypes/insight-composer/src/html-content.js";

const args = process.argv.slice(2);
if (args.length < 2 || args.includes("--help")) {
  console.log("node services/workspace/scripts/watch-authoring.mjs <authoring.json> <resource-root> [--url http://127.0.0.1:4177] [--previous preview-id] [--once]");
  process.exit(args.includes("--help") ? 0 : 1);
}
const authoringPath = resolve(args.shift()), resourceRoot = await realpath(resolve(args.shift()));
let base = "http://127.0.0.1:4177", previousPreviewId, once = false;
while (args.length) {
  const flag = args.shift();
  if (flag === "--url") base = args.shift();
  else if (flag === "--previous") previousPreviewId = args.shift();
  else if (flag === "--once") once = true;
  else throw new Error("Unknown option: " + flag);
}
try { base = localWorkspaceUrl(base).origin; }
catch (error) { console.error(error.message); process.exit(1); }
const headers = process.env.CONTINUOUS_READER_AUTH_TOKEN ? { Authorization: "Bearer " + process.env.CONTINUOUS_READER_AUTH_TOKEN } : {};
const uploaded = new Map(); let lastSignature, lastBindings = {}, stopping = false;
process.once("SIGINT", () => { stopping = true; }); process.once("SIGTERM", () => { stopping = true; });
async function upload(bytes, filename) {
  const key = mediaTypeFor(filename) + ":" + hash(bytes);
  if (uploaded.has(key)) return uploaded.get(key);
  const response = await fetch(base + "/api/sources?filename=" + encodeURIComponent(basename(filename)), { method: "POST", redirect: "error", headers: { ...headers, "Content-Type": mediaTypeFor(filename) }, body: bytes });
  const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value));
  uploaded.set(key, value.sourceId); return value.sourceId;
}
function resourcePaths(input) {
  const paths = new Set();
  if (typeof input.source?.path === "string") paths.add(input.source.path);
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.src === "string") paths.add(value.src);
    if (typeof value.fallback?.image === "string") paths.add(value.fallback.image);
    if (typeof value.html === "string") {
      const visit = (node) => { if (node.tagName === "img") { const src = node.attrs.find((attr) => attr.name === "src")?.value; if (src) paths.add(src); } for (const child of node.childNodes || []) visit(child); };
      visit(parseFragment(value.html));
    }
    for (const child of Object.values(value)) if (child && typeof child === "object") walk(child);
  }
  walk(input); return [...paths].sort();
}
async function update() {
  const raw = await readFile(authoringPath), files = [], missing = []; let bindings = {};
  let input; try { input = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, "")); } catch { bindings = lastBindings; }
  if (input) for (const path of resourcePaths(input)) {
    if (!safeHtmlAsset(path)) { missing.push(path); continue; }
    try {
      const actual = await realpath(resolve(resourceRoot, path)), within = relative(resourceRoot, actual);
      if (within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) throw new Error("Resource escapes root");
      files.push({ path, bytes: await readFile(actual) });
    } catch { missing.push(path); }
  }
  const signature = hash(raw) + JSON.stringify(files.map((file) => [file.path, hash(file.bytes)])) + JSON.stringify(missing);
  if (signature === lastSignature) return;
  for (const file of files) bindings[file.path] = await upload(file.bytes, file.path);
  const authoringSourceId = await upload(raw, basename(authoringPath));
  const response = await fetch(base + "/api/authoring/previews", { method: "POST", redirect: "error", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ authoringSourceId, resources: bindings, requestId: randomUUID(), ...(previousPreviewId ? { previousPreviewId } : {}) }) });
  const value = await response.json();
  lastSignature = signature;
  if (!response.ok) { console.error(JSON.stringify(value, null, 2)); if (once) process.exitCode = 1; return; }
  previousPreviewId = value.preview.id; lastBindings = bindings;
  const receiptPath = resolve(dirname(authoringPath), "preview-receipt.json");
  await writeFile(receiptPath, JSON.stringify(value, null, 2) + "\n");
  console.log(JSON.stringify({ previewUrl: new URL(value.preview.previewUrl, base).href, snapshotUrl: new URL(value.preview.snapshotUrl, base).href, previewId: value.preview.id, hash: value.preview.hash, receiptPath, warningCount: value.validation.warningCount }));
}
do {
  try { await update(); } catch (error) { console.error(error.message); if (once) process.exitCode = 1; }
  if (!once && !stopping) await sleep(1000);
} while (!once && !stopping);
