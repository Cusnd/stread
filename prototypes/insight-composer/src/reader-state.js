import { normalizeHtmlSource, sourceText } from "./document-content.js";

export function reconcileInsight(paper, input) {
  const first = input.sources?.[0];
  const note = !input.blockId && first ? { ...first, ...input, blockId: first.blockId } : input;
  if (!paper || !note.blockId) return note;
  const block = paper.blocks.find((item) => item.id === note.blockId);
  if (!block) return { ...note, referenceStatus: "unresolved" };
  const mapped = normalizeHtmlSource(paper, note);
  if (mapped !== note) return mapped;
  if (note.referenceStatus === "unresolved") return note;
  const text = sourceText(paper, note);
  const exact = note.sourceType === "math" || note.field === "tex"
    ? text === note.quote
    : Number.isInteger(note.start) && Number.isInteger(note.end)
      ? note.start >= 0 && note.end > note.start && text.slice(note.start, note.end) === note.quote
      : !note.quote || text.includes(note.quote);
  return exact ? note : { ...note, referenceStatus: "unresolved" };
}

export function insightWrite(draft, documentId, revision) {
  const { left, top, bottom, width, height, review, documentTitle, clientIntentId, ...value } = draft;
  const next = { ...value, documentId, revision: value.revision ?? revision, body: (value.body || "").trim() };
  // An absent title preserves older records; an explicit empty title clears it.
  if (typeof value.title === "string") next.title = value.title.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
  if (!next.id) delete next.id;
  return next;
}

export function mergeSavedInsights(current, incoming) {
  const known = new Map(current.map((item) => [item.id, item]));
  return incoming.map((item) => {
    const previous = known.get(item.id);
    return previous && (previous.version || 0) > (item.version || 0) ? previous : item;
  }).filter((item) => !item.archivedAt && !item.deletedAt);
}

export function upsertInsight(items, saved) {
  const previous = items.find((item) => item.id === saved.id);
  if (previous && (previous.version || 0) > (saved.version || 0)) return items;
  if (saved.archivedAt || saved.deletedAt) return items.filter((item) => item.id !== saved.id);
  // Content-write receipts do not include independently stored review membership.
  // Keep the last authoritative membership until a review receipt/envelope replaces it.
  const next = previous?.review && saved.review === undefined ? { ...saved, review: previous.review } : saved;
  return previous ? items.map((item) => item.id === saved.id ? next : item) : [...items, next];
}

export function sourceCitation(paper, source) {
  const block = paper.blocks.find((item) => item.id === source?.blockId);
  return JSON.stringify({ document_id: paper.id, revision: paper.revision,
    ...(source?.blockId ? { block_id: source.blockId, variant: source.variant || "source", ...(source.field || block?.type === "math" ? { field: source.field || "tex" } : {}),
      ...(source.itemId ? { item_id: source.itemId } : {}), ...(source.nodeId ? { node_id: source.nodeId } : {}),
      ...(source.row === undefined ? {} : { row: source.row, column: source.column }),
      ...(source.quote ? { quote: source.quote, start: source.start, end: source.end } : {}) } : {}),
  });
}
