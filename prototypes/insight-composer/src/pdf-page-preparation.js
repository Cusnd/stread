export const MAX_PDF_PAGE_PIXELS = 16_000_000;

// Render to an independent canvas, then decode the resulting image before the
// visible page changes. Retargeting cannot draw into an older page's canvas.
export function preparePdfPage(document, page, { requestedWidth = 1200, createCanvas = () => globalThis.document.createElement("canvas"),
  createImage = () => new Image(), createObjectURL = (blob) => URL.createObjectURL(blob), revokeObjectURL = (url) => URL.revokeObjectURL(url), onReady, onError } = {}) {
  let disposed = false, renderTask, pdfPage, canvas, image, imageUrl, transferred = false;
  const check = () => { if (disposed) throw new DOMException("PDF rendering aborted", "AbortError"); };
  const run = async () => {
    try {
      pdfPage = await document.getPage(page.page); check();
      const geometry = pdfPage.getViewport({ scale: 1 });
      if (!(geometry.width > 0 && geometry.height > 0) || !Number.isFinite(geometry.width + geometry.height)) throw new Error("PDF 原页尺寸无效。");
      const scale = Math.min(Math.max(1, requestedWidth) / geometry.width, Math.sqrt(MAX_PDF_PAGE_PIXELS / (geometry.width * geometry.height)));
      const viewport = pdfPage.getViewport({ scale });
      canvas = createCanvas(); canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("浏览器无法绘制 PDF 原页。");
      renderTask = pdfPage.render({ canvasContext: context, viewport, background: "rgb(255,255,255)" });
      await renderTask.promise; check();
      const pixelWidth = canvas.width, pixelHeight = canvas.height;
      const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PDF 原页图像无法生成。")), "image/png"));
      check();
      canvas.width = canvas.height = 0;
      imageUrl = createObjectURL(blob);
      image = createImage(); image.decoding = "async"; image.src = imageUrl;
      await image.decode(); check();
      if (!image.naturalWidth) throw new Error("PDF 原页图像无法解码。");
      transferred = onReady?.({ ...page, width: geometry.width, height: geometry.height, rotation: geometry.rotation,
        imageUrl, requestedWidth, pixelWidth, pixelHeight });
      transferred = transferred !== false;
    } catch (error) {
      if (!disposed && error.name !== "RenderingCancelledException") onError?.(page, error);
    } finally {
      if (canvas) canvas.width = canvas.height = 0;
      if (imageUrl && !transferred) revokeObjectURL(imageUrl);
      pdfPage?.cleanup();
    }
  };
  void run();
  return () => { disposed = true; renderTask?.cancel(); if (image && !transferred) image.src = ""; };
}

// Keep exited page images alive until their fade completes. The latest callback
// can collect every older URL without revoking the current frame on a reversal.
export function createPdfPageResources(revoke = (url) => URL.revokeObjectURL(url)) {
  const urls = new Set();
  return {
    add(url) { urls.add(url); },
    retain(current) { for (const url of urls) if (url !== current) { revoke(url); urls.delete(url); } },
    dispose() { for (const url of urls) revoke(url); urls.clear(); },
  };
}
