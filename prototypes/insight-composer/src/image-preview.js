// Preserve revision-qualified URLs and source DOM; exclude collapsed fallbacks
// and deduplicate paired source/translation images in the gallery.
export function imagePreviewFromClick(event) {
  if (event.defaultPrevented || event.button > 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  const image = event.target.closest("img") || event.target.closest("a")?.querySelector("img");
  if (!image || !event.currentTarget.contains(image)) return null;
  event.preventDefault();
  const src = image.currentSrc || image.src;
  const seen = new Set();
  const slides = [...event.currentTarget.querySelectorAll("img")].filter((item) => !item.closest("details:not([open])") && item.getClientRects().length).flatMap((item) => {
    const url = item.currentSrc || item.src;
    if (!url || seen.has(url)) return [];
    seen.add(url);
    const width = item.naturalWidth || Number(item.getAttribute("width")), height = item.naturalHeight || Number(item.getAttribute("height"));
    return [{ src: url, alt: item.alt || "文章图片", ...(width > 0 && height > 0 ? { width, height } : {}) }];
  });
  const index = slides.findIndex((slide) => slide.src === src);
  if (index < 0) return null;
  const trigger = image.closest("a") || image;
  trigger.focus({ preventScroll: true });
  return { slides, index, trigger };
}

export function imageKeyboardProps(linked = false, alt = "") {
  return linked ? {} : { role: "button", tabIndex: 0, "aria-haspopup": "dialog", "aria-label": alt ? "查看大图：" + alt : "查看大图", title: "查看大图", onKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.click();
  } };
}

