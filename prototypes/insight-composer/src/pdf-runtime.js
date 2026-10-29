import { getDocument, PDFWorker, version } from "pdfjs-dist/build/pdf.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export function createBrowserPdfTask(data) {
  // An explicit same-origin worker also works with Electron's reader:// scheme;
  // PDF.js's automatic URL-origin detection would otherwise wrap it in a blob.
  const port = new Worker(workerUrl, { type: "module" });
  const worker = new PDFWorker({ port });
  const base = new URL(`/assets/pdfjs-${version}/`, window.location.href).href;
  let task;
  try {
    task = getDocument({ data, worker, cMapUrl: base + "cmaps/", cMapPacked: true,
      standardFontDataUrl: base + "standard_fonts/", wasmUrl: base + "wasm/", iccUrl: base + "iccs/",
      // Source files are viewed, never used as executable document scripts.
      enableXfa: false, canvasMaxAreaInBytes: 64 * 1024 * 1024 });
  } catch (error) { worker.destroy(); port.terminate(); throw error; }
  let destroyed;
  return { promise: task.promise, destroy() {
    if (!destroyed) destroyed = Promise.resolve(task.destroy()).finally(() => { worker.destroy(); port.terminate(); });
    return destroyed;
  } };
}
