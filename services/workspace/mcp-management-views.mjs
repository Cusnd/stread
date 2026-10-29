import { excerpt, itemSummary, glossarySummary, page } from "./mcp-views.mjs";

export const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
export const clip = (value, maximum) => excerpt(typeof value === "string" ? value : "", 0, maximum).text;
export const readingPosition = (value) => value ? {
  ...pick(value, ["documentId", "revision", "blockId", "offsetRatio", "mode", "targetLanguage", "translationFirst", "page"]),
  ...(typeof value.sectionTitle === "string" ? { sectionTitle: clip(value.sectionTitle, 120) } : {}),
} : null;
export const documentView = (record) => ({
  ...pick(record, ["id", "revision", "version", "status", "archivedAt"]),
  title: clip(record.title, 160), titleTruncated: (record.title?.length || 0) > 160,
  kind: clip(record.kind, 80), kindTruncated: (record.kind?.length || 0) > 80,
  summary: clip(record.summary, 240), summaryTruncated: (record.summary?.length || 0) > 240,
  tags: (record.tags || []).slice(0, 5).map((tag) => clip(tag, 100)), tagCount: record.tags?.length || 0,
  collectionIds: (record.collectionIds || []).slice(0, 5), collectionCount: record.collectionIds?.length || 0,
  readingState: readingPosition(record.readingState),
});
export const collectionView = (value) => ({ ...pick(value, ["id", "parentId", "version"]), label: clip(value.label, 200) });
export const insightView = (value) => ({
  ...itemSummary(value), ...pick(value, ["archivedAt"]),
  ...(typeof value.documentTitle === "string" ? { documentTitle: clip(value.documentTitle, 160) } : {}),
  ...(value.review ? { review: pick(value.review, ["pending", "addedAt", "lastReviewedAt"]) } : {}),
});
export const glossaryView = (value) => ({ ...glossarySummary(value), ...pick(value, ["deletedAt"]), ...(value.documentTitle ? { documentTitle: clip(value.documentTitle, 200) } : {}) });

// A service page may stop earlier after compacting. Continue from the number
// actually returned, never the upstream limit, or records would be skipped.
export function servicePage(value, key, input, project) {
  const selected = page(value.items, key, { limit: input.limit }, project)[key];
  const offset = input.offset || 0;
  return { [key]: selected, page: { offset, count: selected.length, total: value.total, nextOffset: offset + selected.length < value.total ? offset + selected.length : null }, activityRevision: value.activityRevision };
}
export function historyView(session) {
  const insights = (session.insights || []).slice(0, 3).map(insightView);
  return {
    ...pick(session, ["id", "documentId", "documentRevision", "archived", "startedAt", "endedAt", "lastActivityAt", "activeMs", "mode", "insightCount"]),
    documentTitle: clip(session.documentTitle, 160),
    startPosition: readingPosition(session.startPosition), endPosition: readingPosition(session.endPosition),
    insights, insightsTruncated: (session.insightCount || 0) > insights.length,
    // A session can span many calendar days. The complete daily series belongs
    // to the separately paginated summary tool, not every history row.
    days: (session.days || []).slice(0, 7), dayCount: session.days?.length || 0, daysTruncated: (session.days?.length || 0) > 7,
  };
}
export function managementReceipt(value) {
  return {
    ...pick(value, ["requestId", "revision", "planVersion", "activityRevision", "glossaryRevision", "documentId"]),
    ...(value.record ? { document: documentView(value.record) } : {}),
    ...(value.collection ? { collection: collectionView(value.collection) } : {}),
    ...(value.insight ? { insight: insightView(value.insight) } : {}),
    ...(value.changeRequest ? { changeRequest: itemSummary(value.changeRequest) } : {}),
    ...(value.entry ? { entry: glossaryView(value.entry) } : {}),
    ...(value.planIds ? { planCount: value.planIds.length } : {}),
    ...(value.objects ? { objectCount: Object.keys(value.objects).length } : {}),
  };
}
