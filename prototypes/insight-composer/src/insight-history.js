// Store undo receipts in the tab, not a second authoritative insight collection.
export function readInsightHistory(storage, key) {
  try {
    const value = JSON.parse(storage.getItem("reader-insight-history:" + key) || "{}");
    return {
      deleted: Array.isArray(value.deleted) ? value.deleted.filter((item) => item?.id && item.archivedAt) : [],
      references: Array.isArray(value.references) ? value.references.filter((item) => typeof item === "string") : [],
    };
  } catch { return { deleted: [], references: [] }; }
}

export function rememberDeleted(history, insight) {
  return { ...history, deleted: [...history.deleted.filter((item) => item.id !== insight.id), insight] };
}

export function rememberReferences(history, insights) {
  const references = [...new Set([...history.references, ...insights.flatMap((item) => [item.reference, ...Object.values(item.references || {})]).filter(Boolean)])];
  return references.length === history.references.length ? history : { ...history, references };
}

export function forgetRestored(history, id) {
  return { ...history, deleted: history.deleted.filter((item) => item.id !== id) };
}

export function reconcileInsightHistory(history, insights) {
  const restored = new Map(insights.filter((item) => !item.archivedAt && !item.deletedAt).map((item) => [item.id, item]));
  const deleted = history.deleted.filter((item) => (restored.get(item.id)?.version || 0) <= (item.version || 0));
  return deleted.length === history.deleted.length ? history : { ...history, deleted };
}
