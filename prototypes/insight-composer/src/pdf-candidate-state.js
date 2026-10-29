// Only immutable authoring candidates can carry view state across API roots.
// A missing hash cannot prove that the underlying source is unchanged.
export function preservePdfCandidateView(previous, next) {
  const candidate = (value) => typeof value === "string" && /^\/api\/authoring\/previews\/[^/]+$/.test(value);
  return Boolean(previous && previous.apiBase !== next.apiBase && candidate(previous.apiBase) && candidate(next.apiBase)
    && next.sourceHash && previous.sourceHash === next.sourceHash);
}

export function clampPdfPage(pages, requested) {
  const numbers = pages.map((item) => item.page).sort((a, b) => a - b);
  return numbers.find((page) => page >= requested) ?? numbers.at(-1) ?? 1;
}

export function reconcilePdfTargets(paper, targets, regions) {
  const blocks = new Map((paper?.blocks || []).map((block) => [block.id, block]));
  return targets.filter((target) => {
    const block = blocks.get(target.blockId);
    if (!block || block.origin === "user" || target.itemId && !block.items?.some((item) => item.id === target.itemId && item.origin !== "user")) return false;
    return regions.some((region) => region.blockId === target.blockId && (!target.itemId || !region.itemId || region.itemId === target.itemId));
  }).map((target) => ({ blockId: target.blockId, ...(target.itemId ? { itemId: target.itemId } : {}) }));
}
