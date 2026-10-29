import { sourceElement } from "./document-content.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function readingLine() {
  return (document.querySelector(".topbar")?.getBoundingClientRect().bottom || 56) + 46;
}
export function captureReadingPosition(root, line = readingLine()) {
  if (!root) return null;
  // Closed <details> descendants can retain non-empty layout rects in Chromium.
  // They must not become an automatic checkpoint that later opens the disclosure.
  const blocks = [...root.querySelectorAll("[data-article-block]")].filter((item) => item.getClientRects().length
    && !item.closest("details:not([open])")
    && (!item.checkVisibility || item.checkVisibility({ visibilityProperty: true })));
  const block = blocks.find((item) => item.getBoundingClientRect().bottom > line) || blocks.at(-1);
  if (!block) return null;
  const box = block.getBoundingClientRect();
  return { blockId: block.dataset.articleBlock, offsetRatio: clamp((line - box.top) / Math.max(1, box.height), 0, 1), viewportOffset: box.top };
}
function readingPositionDelta(root, anchor, { exactTop = false } = {}) {
  if (!root || !anchor?.blockId) return null;
  const articleBlock = [...root.querySelectorAll("[data-article-block]")].find((item) => item.dataset.articleBlock === anchor.blockId);
  const block = anchor.source ? sourceElement(root, anchor.source, false)
    : anchor.itemId ? [...(articleBlock?.querySelectorAll("[data-source-item]") || [])].find((item) => item.dataset.sourceItem === anchor.itemId) : articleBlock;
  if (!block) return null;
  for (let details = block.closest("details"); details; details = details.parentElement?.closest("details")) details.open = true;
  const box = block.getBoundingClientRect();
  const delta = exactTop && Number.isFinite(anchor.viewportOffset) ? box.top - anchor.viewportOffset
    : box.top + clamp(anchor.offsetRatio || 0, 0, 1) * box.height - readingLine();
  return delta;
}
export function readingPositionTop(root, anchor, options) {
  const delta = readingPositionDelta(root, anchor, options);
  return delta === null ? null : window.scrollY + delta;
}
export function restoreReadingPosition(root, anchor, { exactTop = false, behavior = "instant" } = {}) {
  const delta = readingPositionDelta(root, anchor, { exactTop });
  if (delta === null) return false;
  window.scrollBy({ top: delta, behavior });
  return true;
}
export function sourceNavigationAnchor(source, viewportOffset = readingLine()) {
  return { blockId: source.blockId, source, offsetRatio: 0, viewportOffset };
}
export function sourceRegions(paper) {
  const known = new Map((paper?.blocks || []).filter((block) => block.origin !== "user").map((block) => [block.id, new Set((block.items || []).filter((item) => item.origin !== "user").map((item) => item.id))]));
  const supplied = (paper?.blocks || []).flatMap((block) => !known.has(block.id) ? [] : [block, ...(block.items || []).filter((item) => item.origin !== "user")].flatMap((object) =>
    (object.source || []).filter((source) => Number.isInteger(source.page) && source.page > 0).map((source, index) => ({
      blockId: block.id, ...(object === block ? {} : { itemId: object.id }), page: source.page, regionIndex: index,
      ...(validBox(source.box) ? { box: source.box } : {}),
    }))));
  // Source geometry belongs to the reading file. Page-only references remain
  // page-only; opening the Reader never infers or merges another source map.
  return supplied.sort((a, b) => a.page - b.page || (a.box?.[1] ?? 1) - (b.box?.[1] ?? 1))
    .map((region, regionIndex) => ({ ...region, regionIndex }));
}
export function validBox(box) {
  return Array.isArray(box) && box.length === 4 && box.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) && box[0] < box[2] && box[1] < box[3];
}
export function regionForBlock(regions, blockId, preferredPage, itemId) {
  const blockRegions = regions.filter((region) => region.blockId === blockId);
  const itemRegions = itemId ? blockRegions.filter((region) => region.itemId === itemId) : [];
  const parentRegions = blockRegions.filter((region) => !region.itemId);
  const matching = itemRegions.length ? itemRegions : parentRegions.length ? parentRegions : blockRegions;
  return matching.find((region) => region.page === preferredPage) || matching[0] || null;
}
export function blockAtPage(regions, page, y) {
  const matching = regions.filter((region) => region.page === page);
  const boxes = matching.filter((region) => region.box);
  if (boxes.length) return boxes.find((region) => region.box[1] <= y && region.box[3] >= y)
    || boxes.find((region) => region.box[1] > y) || boxes.at(-1);
  return matching[0] || null;
}
export function createScrollOwnership() {
  let owner = "reader";
  const suppressUntil = { reader: 0, pdf: 0 };
  return {
    user(side) { owner = side; suppressUntil[side] = 0; },
    programmatic(side = "reader", now = Date.now()) { suppressUntil[side] = now + 180; },
    drives(side, now = Date.now()) { return owner === side && now >= suppressUntil[side]; },
    owner() { return owner; },
  };
}
