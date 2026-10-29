// Browser-history entries own reading journeys. They survive a refresh without
// sharing another tab's temporary navigation or changing document content.
export function readerReturnRoute(entry, origin) {
  const route = origin?.page === "flow" || origin?.page === "collection" ? origin : entry?.readerReturn;
  if (route?.page === "flow") return {
    page: "flow",
    section: ["overview", "insights", "plan", "history"].includes(route.section) ? route.section : "overview",
  };
  return { page: "collection" };
}

export function relatedTrail(entry) {
  return (Array.isArray(entry?.readerTrail) ? entry.readerTrail : [])
    .filter((item) => item?.route?.page === "reader" && typeof item.route.documentId === "string")
    .slice(-20);
}

export function readingStateForEntry(entry, documentId, fallback = null) {
  const state = entry?.readerPosition;
  return state?.documentId === documentId ? state : fallback;
}

export function relatedDestinationState(documentId, source, previous = null) {
  if (!source?.blockId) return previous?.documentId === documentId ? previous : null;
  const variant = source.variant || "source";
  return {
    ...(previous?.documentId === documentId ? previous : {}), documentId,
    blockId: source.blockId, source, offsetRatio: 0,
    // The address may refer to a translation not selected in this article yet.
    mode: previous?.mode === "bilingual" ? "bilingual" : variant === "source" ? "source" : "translation",
    ...(variant !== "source" ? { targetLanguage: variant } : {}),
    viewportOffset: undefined,
  };
}

export function pushRelatedTrail(entry, route, title, readingState) {
  const trail = relatedTrail(entry);
  if (route?.page !== "reader") return trail;
  return [...trail, { route: { ...route }, title, readingState }].slice(-20);
}
