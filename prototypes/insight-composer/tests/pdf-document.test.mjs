import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import { loadPdfDocument } from "../src/pdf-document.js";
import { documentAssetUrl, documentPdfBytesUrl } from "../src/document-resource.js";

const bytes = new TextEncoder().encode("a verified PDF fixture");
const hash = createHash("sha256").update(bytes).digest("hex");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(options = {}) {
  const calls = { fetch: [], tasks: [], destroyed: 0 };
  const task = { promise: Promise.resolve({ numPages: 2 }), destroy() { calls.destroyed++; } };
  const load = loadPdfDocument({ url: "/api/authoring/previews/p/assets/source.pdf?access=grant", expectedHash: hash, crypto: webcrypto,
    fetchSource: async (...args) => { calls.fetch.push(args); return new Response(bytes); },
    createTask: (value) => { calls.tasks.push(value); return task; }, ...options });
  return { load, calls, task };
}

test("original bytes are hashed before PDF.js receives them and pages remain lazy", async () => {
  const { load, calls } = fixture();
  const result = await load.promise;
  assert.equal(calls.tasks.length, 1); assert.deepEqual(calls.tasks[0], bytes);
  assert.equal(calls.fetch[0][1].credentials, "same-origin");
  assert.equal(result.sourceHash, hash);
  assert.deepEqual(result.pages, [{ page: 1 }, { page: 2 }]);
  await load.destroy(); await load.destroy(); assert.equal(calls.destroyed, 1);
});

test("a wrong or malformed saved hash never reaches the PDF parser", async () => {
  for (const expectedHash of ["0".repeat(64), "not-a-hash"]) {
    const { load, calls } = fixture({ expectedHash });
    await assert.rejects(load.promise, /版本|SHA-256/); assert.equal(calls.tasks.length, 0);
  }
});

test("streamed and declared oversized originals stop before parsing", async () => {
  for (const declared of [null, "20"]) {
    const { load, calls } = fixture({ maximumBytes: 8,
      fetchSource: async () => new Response(bytes, { headers: declared ? { "content-length": declared } : {} }) });
    await assert.rejects(load.promise, /100 MiB/); assert.equal(calls.tasks.length, 0);
  }
});

test("expired preview access and empty originals produce actionable loading failures", async () => {
  for (const [response, expected] of [[new Response("Denied", { status: 403 }), /授权/], [new Response(new Uint8Array()), /浏览器或下载工具拦截/],
    [new Response(null, { status: 204, statusText: "Intercepted by the IDM Advanced Integration" }), /浏览器或下载工具拦截/], [new Response(null), /浏览器或下载工具拦截/]]) {
    const { load, calls } = fixture({ fetchSource: async () => response });
    await assert.rejects(load.promise, expected); assert.equal(calls.tasks.length, 0);
  }
});

test("managed PDF byte transport uses an extensionless hash URL while original links stay unchanged", () => {
  const source = { path: "source.pdf", sha256: hash };
  const before = globalThis.location;
  globalThis.location = { origin: "https://reader.example" };
  try {
    const document = { source, assetBase: "/api/documents/doc/assets/", revision: 7 };
    assert.equal(documentPdfBytesUrl(document, "/api/documents/doc"), `/api/documents/doc/assets-by-hash/${hash}?revision=7`);
    assert.equal(documentPdfBytesUrl(document), `/api/documents/doc/assets-by-hash/${hash}?revision=7`);
    assert.equal(documentAssetUrl(document, source.path), "/api/documents/doc/assets/source.pdf?revision=7");
    const preview = { source, assetBase: "/api/authoring/previews/p/assets/", previewAccess: "grant" };
    assert.equal(documentPdfBytesUrl(preview, "/api/authoring/previews/p"), `/api/authoring/previews/p/assets-by-hash/${hash}?access=grant`);
    assert.equal(documentAssetUrl(preview, source.path), "/api/authoring/previews/p/assets/source.pdf?access=grant");
    assert.equal(documentPdfBytesUrl({ ...preview, assetBase: "https://other.example/api/authoring/previews/p/assets/" }), `https://other.example/api/authoring/previews/p/assets-by-hash/${hash}`);
    assert.equal(documentPdfBytesUrl({ source, assetBase: "/articles/sample/" }), "/articles/sample/source.pdf");
  } finally { if (before === undefined) delete globalThis.location; else globalThis.location = before; }
});

test("closing while the original is loading aborts the fetch and suppresses a late response", async () => {
  const fetch = deferred(); let signal;
  const { load, calls } = fixture({ fetchSource: (_url, options) => { signal = options.signal; return fetch.promise; } });
  const rejected = assert.rejects(load.promise, { name: "AbortError" });
  await load.destroy(); assert.equal(signal.aborted, true);
  fetch.resolve(new Response(bytes)); await rejected; assert.equal(calls.tasks.length, 0);
});

test("closing during parsing destroys its task and cannot publish late metadata", async () => {
  const parsed = deferred(), started = deferred(); let destroyed = 0;
  const { load } = fixture({ createTask: () => { started.resolve(); return { promise: parsed.promise, destroy: () => { destroyed++; } }; } });
  const rejected = assert.rejects(load.promise, { name: "AbortError" });
  await started.promise;
  await load.destroy(); parsed.resolve({ numPages: 2 }); await rejected;
  assert.equal(destroyed, 1);
});

test("invalid page counts destroy parsed documents before they enter the panel", async () => {
  for (const numPages of [0, 2001, 1.5]) {
    let destroyed = 0;
    const { load } = fixture({ createTask: () => ({ promise: Promise.resolve({ numPages }), destroy: () => { destroyed++; } }) });
    await assert.rejects(load.promise, /2,000/); assert.equal(destroyed, 1);
  }
});

test("original asset URLs retain revision and preview grants without leaking grants to external origins", () => {
  assert.equal(documentAssetUrl({ assetBase: "/api/documents/doc/assets/", revision: 7 }, "source.pdf"), "/api/documents/doc/assets/source.pdf?revision=7");
  const before = globalThis.location;
  globalThis.location = { origin: "https://reader.example" };
  try {
    assert.equal(documentAssetUrl({ assetBase: "/api/authoring/previews/p/assets/", previewAccess: "grant" }, "source.pdf"), "/api/authoring/previews/p/assets/source.pdf?access=grant");
    assert.equal(documentAssetUrl({ assetBase: "https://other.example/", previewAccess: "grant" }, "source.pdf"), "https://other.example/source.pdf");
    assert.equal(documentAssetUrl({ assetBase: "/articles/sample/" }, "source.pdf"), "/articles/sample/source.pdf");
  } finally { if (before === undefined) delete globalThis.location; else globalThis.location = before; }
});
