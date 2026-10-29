export const MAX_PDF_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_PDF_PAGES = 2000;
const aborted = () => new DOMException("PDF loading aborted", "AbortError");
const checkAbort = (signal) => { if (signal.aborted) throw aborted(); };
const intercepted = () => new Error("原稿读取被浏览器或下载工具拦截，未收到文件内容。请重新打开预览后重试。");

export async function readPdfBytes(response, signal, maximumBytes = MAX_PDF_SOURCE_BYTES) {
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? "原稿访问授权已失效，请重新打开预览。" : "原始 PDF 暂时无法读取。");
  if (response.status === 204 || response.status === 205) throw intercepted();
  const declared = Number(response.headers.get("content-length"));
  if (declared > maximumBytes) { await response.body?.cancel(); throw new Error("原始 PDF 超过 100 MiB 限制。"); }
  if (!response.body) throw intercepted();
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    checkAbort(signal);
    while (true) {
      const { value, done } = await reader.read();
      checkAbort(signal);
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); throw new Error("原始 PDF 超过 100 MiB 限制。"); }
      chunks.push(value);
    }
    if (!size) throw intercepted();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

// Verify the original bytes before transferring their ownership to PDF.js.
// A PDF fingerprint or HTTP ETag is not the document's saved SHA-256.
export function loadPdfDocument({ url, expectedHash, createTask, fetchSource = fetch, crypto = globalThis.crypto, maximumBytes } = {}) {
  const controller = new AbortController();
  let task, disposed = false, destruction;
  const destroy = () => {
    if (task && !destruction) destruction = Promise.resolve(task.destroy()).catch(() => {});
    return destruction;
  };
  const promise = (async () => {
    const response = await fetchSource(url, { signal: controller.signal, credentials: "same-origin" });
    const bytes = await readPdfBytes(response, controller.signal, maximumBytes);
    if (expectedHash) {
      if (!/^[a-f0-9]{64}$/i.test(expectedHash)) throw new Error("原稿的 SHA-256 记录无效，已停止原页联动。");
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const actual = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      if (actual !== expectedHash.toLowerCase()) throw new Error("原始文件版本与本文记录不一致，已停止原页联动。");
    }
    checkAbort(controller.signal);
    task = createTask(bytes);
    const document = await task.promise;
    checkAbort(controller.signal);
    if (!Number.isInteger(document.numPages) || document.numPages < 1 || document.numPages > MAX_PDF_PAGES) throw new Error("PDF 页数须为 1–2,000 页。");
    return { document, sourceUrl: url, sourceHash: expectedHash || null,
      // Viewports are loaded for the requested page, not all 2,000 pages at open.
      pages: Array.from({ length: document.numPages }, (_, index) => ({ page: index + 1 })) };
  })().catch(async (error) => { await destroy(); if (disposed) throw aborted(); throw error; });
  return { promise, destroy() { disposed = true; controller.abort(); return destroy(); } };
}
