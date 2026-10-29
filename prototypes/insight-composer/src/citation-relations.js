// Relation data is separate from article text. Only known, resolved identities
// become interactive; citation numbers alone are never interpreted as targets.
export function citationTargetIds(relation) {
  const source = relation?.source || {};
  return [source.nodeId || source.itemId || source.blockId].filter(Boolean);
}

export function citationIndex(relations) {
  const byId = new Map(), byTarget = new Map();
  for (const relation of relations?.outgoing || []) {
    if (!relation?.id || relation.sourceMissing) continue;
    byId.set(relation.id, relation);
    for (const id of citationTargetIds(relation)) byTarget.set(id, relation);
  }
  return { byId, byTarget };
}

export function citationHash(href) {
  if (typeof href !== "string" || !href.startsWith("#")) return null;
  try { return decodeURIComponent(href.slice(1)); } catch { return null; }
}

export function externalReferenceUrl(relation) {
  const { doi, arxiv } = relation?.identifiers || {};
  const doiValue = typeof doi === "string" ? doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim() : "";
  if (/^10\.\d{4,9}\/[^\s<>]+$/i.test(doiValue)) {
    try { return "https://doi.org/" + encodeURI(doiValue).replace(/[?#]/g, encodeURIComponent); }
    catch { return null; } // Malformed legacy metadata must not break the reader.
  }
  const arxivValue = typeof arxiv === "string" ? arxiv.replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "").replace(/^arxiv:\s*/i, "").replace(/\.pdf$/i, "").trim() : "";
  if (/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v\d+)?$/i.test(arxivValue)) return "https://arxiv.org/abs/" + arxivValue;
  return null;
}

export function referencePreviewPosition(anchor, panel, viewport, topInset = 64) {
  const margin = 12, gap = 8;
  const width = Math.min(panel.width || 384, Math.max(0, viewport.width - margin * 2));
  const maxHeight = Math.max(120, viewport.height - topInset - margin * 2);
  const height = Math.min(panel.height || 220, maxHeight);
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - height;
  const top = below + height <= viewport.height - margin ? below : above >= topInset ? above : Math.max(topInset, viewport.height - margin - height);
  const left = Math.min(Math.max(margin, anchor.left), Math.max(margin, viewport.width - width - margin));
  return { left, top, width, maxHeight };
}

export function incomingCitationSources(relation) {
  const entries = relation?.occurrences?.length ? relation.occurrences : relation?.source ? [relation.source] : [];
  const groups = new Map();
  for (const source of entries) {
    if (!source?.blockId) continue;
    const key = JSON.stringify([source.blockId, source.itemId, source.nodeId, source.field]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(source);
  }
  return [...groups.values()].flatMap((sources) => {
    // Translation offsets differ. Choose one language per source field, then
    // retain repeated citations within that language at their distinct ranges.
    const preferred = sources.some((source) => source.variant === "source") ? "source" : sources[0].variant;
    const seen = new Set();
    return sources.filter((source) => {
      if (source.variant !== preferred) return false;
      const key = JSON.stringify([source.start, source.end]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  });
}

export function citationCandidateDetails(candidate) {
  const authors = typeof candidate.authors === "string" ? candidate.authors : (candidate.authors || []).map((author) => typeof author === "string" ? author : author?.name).filter(Boolean).join(", ");
  const metadata = [authors, candidate.year].filter(Boolean).join(" · ");
  const labels = { year: "年份", doi: "DOI", arxiv: "arXiv 编号", arxivVersion: "arXiv 版本", title: "题名", "ambiguous-identifiers": "文献标识" };
  const differences = (candidate.evidence || []).flatMap((item) => {
    if (item.kind === "difference" || item.kind === "conflict") {
      const label = labels[item.field] || "文献信息";
      return [item.reference && item.document ? `${label}不同：引用 ${item.reference} · 库内 ${item.document}` : `${label}存在冲突，需核对`];
    }
    return item.kind === "title" && item.match === "similar" ? ["题名相近，尚未确认"] : [];
  });
  return { metadata, differences: [...new Set(differences)] };
}
