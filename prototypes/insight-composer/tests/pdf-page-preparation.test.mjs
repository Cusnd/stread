import assert from "node:assert/strict";
import test from "node:test";
import { createPdfPageResources, MAX_PDF_PAGE_PIXELS, preparePdfPage } from "../src/pdf-page-preparation.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture({ getPage, rendered = Promise.resolve(), decoded = Promise.resolve() } = {}) {
  const events = { ready: [], failed: [], revoked: [], cancelled: 0, cleanups: 0, renders: 0 };
  const canvas = { width: 0, height: 0, getContext: () => ({}), toBlob: (done) => done(new Blob(["png"])) };
  const pdfPage = { getViewport: ({ scale }) => ({ width: 300 * scale, height: 400 * scale, rotation: 90 }),
    render() { events.renders++; return { promise: rendered, cancel: () => { events.cancelled++; } }; }, cleanup() { events.cleanups++; } };
  const document = { getPage: getPage || (async () => pdfPage) };
  const options = { createCanvas: () => canvas, createImage: () => ({ naturalWidth: 300, decode: () => decoded }),
    createObjectURL: () => "blob:page", revokeObjectURL: (url) => events.revoked.push(url),
    onReady: (page) => events.ready.push(page), onError: (page, error) => events.failed.push({ page, error }) };
  return { events, canvas, pdfPage, document, options };
}

test("the visible page changes only after rendering and image decoding both complete", async () => {
  const rendered = deferred(), decoded = deferred(), f = fixture({ rendered: rendered.promise, decoded: decoded.promise });
  const dispose = preparePdfPage(f.document, { page: 2 }, f.options);
  await tick(); assert.equal(f.events.ready.length, 0);
  rendered.resolve(); await tick(); assert.equal(f.events.ready.length, 0);
  decoded.resolve(); await tick();
  assert.deepEqual(f.events.ready[0], { page: 2, width: 300, height: 400, rotation: 90, requestedWidth: 1200, pixelWidth: 1200, pixelHeight: 1600, imageUrl: "blob:page" });
  assert.equal(f.canvas.width, 0); assert.equal(f.events.cleanups, 1);
  dispose(); assert.deepEqual(f.events.revoked, [], "ownership transferred to the presence lifecycle");
});

test("cancelled getPage completion cannot begin a render", async () => {
  const page = deferred(), f = fixture({ getPage: () => page.promise });
  const dispose = preparePdfPage(f.document, { page: 2 }, f.options);
  dispose(); page.resolve(f.pdfPage); await tick();
  assert.equal(f.events.renders, 0); assert.deepEqual(f.events.ready, []); assert.deepEqual(f.events.failed, []);
});

test("retargeting cancels the render task and discards late render completion", async () => {
  const rendered = deferred(), f = fixture({ rendered: rendered.promise });
  const dispose = preparePdfPage(f.document, { page: 2 }, f.options);
  await tick(); dispose(); assert.equal(f.events.cancelled, 1);
  rendered.resolve(); await tick();
  assert.deepEqual(f.events.ready, []); assert.deepEqual(f.events.failed, []); assert.equal(f.canvas.width, 0);
});

test("closing during decode releases an uncommitted blob and cannot replace a newer page", async () => {
  const decoded = deferred(), f = fixture({ decoded: decoded.promise });
  const dispose = preparePdfPage(f.document, { page: 2 }, f.options);
  await tick(); dispose(); decoded.resolve(); await tick();
  assert.deepEqual(f.events.ready, []); assert.deepEqual(f.events.revoked, ["blob:page"]);
});

test("a completion rejected by the latest render identity releases its image", async () => {
  const f = fixture();
  preparePdfPage(f.document, { page: 2 }, { ...f.options, onReady: () => false });
  await tick(); assert.deepEqual(f.events.revoked, ["blob:page"]);
});

test("failed rendering reports the requested page without clearing the previous frame", async () => {
  const rendered = deferred(), f = fixture({ rendered: rendered.promise });
  preparePdfPage(f.document, { page: 3 }, f.options);
  await tick(); rendered.reject(new Error("bad page")); await tick();
  assert.deepEqual(f.events.ready, []); assert.equal(f.events.failed[0].page.page, 3);
  assert.equal(f.events.failed[0].error.message, "bad page"); assert.equal(f.canvas.width, 0);
});

test("the canvas pixel budget bounds magnified pages without changing their display geometry", async () => {
  const f = fixture();
  preparePdfPage(f.document, { page: 1 }, { ...f.options, requestedWidth: 50000 });
  await tick(); const page = f.events.ready[0];
  assert.ok(page.pixelWidth * page.pixelHeight <= MAX_PDF_PAGE_PIXELS);
  assert.equal(page.width, 300); assert.equal(page.height, 400);
});

test("exiting images live through motion and stale exits cannot revoke the newest page", () => {
  const revoked = [], resources = createPdfPageResources((url) => revoked.push(url));
  resources.add("blob:1"); resources.add("blob:2"); resources.add("blob:3");
  assert.deepEqual(revoked, []);
  resources.retain("blob:3"); resources.retain("blob:3");
  assert.deepEqual(revoked, ["blob:1", "blob:2"]);
  resources.dispose(); resources.dispose(); assert.deepEqual(revoked, ["blob:1", "blob:2", "blob:3"]);
});

function croppedPdf() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R 9 0 R] /Count 4 >>"];
  for (const rotation of [0, 90, 180, 270]) {
    const contentId = objects.length + 2, content = "0.2 0.4 0.8 rg 75 100 150 200 re f";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /CropBox [50 60 350 460] /Rotate ${rotation} /Resources << >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let output = "%PDF-1.7\n", offsets = [0];
  for (const [index, body] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${body}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("");
  return new Uint8Array(Buffer.from(output + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
}

test("real PDF.js renders cropped pages at every quarter rotation using the displayed geometry", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const loading = getDocument({ data: croppedPdf() });
  try {
    const document = await loading.promise;
    for (let page = 1; page <= 4; page++) {
      let coloredPixels = 0;
      const ready = await new Promise((resolve, reject) => preparePdfPage(document, { page }, {
        requestedWidth: 300, createCanvas: () => {
          const canvas = createCanvas(1, 1);
          canvas.toBlob = (done) => {
            const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
            for (let i = 0; i < data.length; i += 4) if (data[i + 2] > data[i] + 50) coloredPixels++;
            done(new Blob([canvas.toBuffer("image/png")]));
          };
          return canvas;
        },
        createImage: () => ({ naturalWidth: 300, decode: async () => {} }), createObjectURL: () => "blob:rendered", revokeObjectURL: () => {},
        onReady: resolve, onError: (_page, error) => reject(error),
      }));
      assert.deepEqual([ready.width, ready.height], page % 2 ? [300, 400] : [400, 300]);
      assert.equal(ready.rotation, (page - 1) * 90); assert.ok(coloredPixels > 10000, "PDF drawing appeared in the raster output");
    }
  } finally { await loading.destroy(); }
});
