const abortError = () => new DOMException("Preview preparation aborted", "AbortError");
const checkAbort = (signal) => { if (signal?.aborted) throw abortError(); };
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

export function visiblePreviewImages(root, viewportHeight = window.innerHeight, viewportWidth = window.innerWidth) {
  return [...root.querySelectorAll(".article img")].filter((image) => {
    const rect = image.getBoundingClientRect();
    return image.getClientRects().length && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
  });
}

function imageReady(image, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); image.removeEventListener("load", loaded); image.removeEventListener("error", failed); signal?.removeEventListener("abort", aborted); };
    const failed = () => { cleanup(); reject(new Error("首屏图片未能加载，请检查预览资源。")); };
    const aborted = () => { cleanup(); reject(abortError()); };
    const loaded = () => {
      cleanup();
      if (!image.naturalWidth) { reject(new Error("首屏图片无法解码。")); return; }
      Promise.resolve(image.decode?.()).then(resolve, () => reject(new Error("首屏图片无法解码。")));
    };
    if (signal?.aborted) { aborted(); return; }
    if (image.complete) { loaded(); return; }
    image.addEventListener("load", loaded, { once: true }); image.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(failed, 15000);
  });
}

// This is a first-viewport readiness signal, not an attestation that hidden,
// offscreen, expanded or translated content has been inspected.
export async function waitForInitialPreviewRender(root, signal) {
  checkAbort(signal);
  if (document.fonts?.ready) await document.fonts.ready;
  await frame(); checkAbort(signal);
  const images = visiblePreviewImages(root);
  await Promise.all(images.map((image) => imageReady(image, signal)));
  let previous = "", stable = 0;
  for (let attempt = 0; attempt < 60 && stable < 3; attempt++) {
    await frame(); checkAbort(signal);
    const article = root.querySelector(".article");
    if (!article) throw new Error("阅读器正文尚未准备好。");
    const rect = article.getBoundingClientRect(), size = [rect.width, rect.height].map((value) => Math.round(value * 2) / 2).join(":");
    stable = size === previous ? stable + 1 : 0; previous = size;
  }
  if (stable < 3) throw new Error("首屏布局仍在变化，请重试预览。");
  checkAbort(signal);
  return { scope: "initial-viewport", imageCount: images.length };
}
