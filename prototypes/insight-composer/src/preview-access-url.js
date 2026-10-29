// Preview credentials are kept in the current page/paper only. Never copy them
// to storage, a production document, an external image, or an ordinary link.
export function previewAccessUrl(value, capability, origin = globalThis.location?.origin) {
  if (!capability || !origin || typeof value !== "string") return value;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !/^\/api\/authoring\/(previews|drafts)\/[^/]+(?:\/|$)/.test(url.pathname)) return value;
    url.searchParams.set("access", capability);
    return /^[a-z][a-z0-9+.-]*:/i.test(value) ? url.href : url.pathname + url.search + url.hash;
  } catch { return value; }
}
