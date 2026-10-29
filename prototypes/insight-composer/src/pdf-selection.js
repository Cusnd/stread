// PDF linkage follows stable article block identities in either language.
// It is independent of insight creation, including read-only documents.
export function selectedArticleTargets(root, selection = window.getSelection()) {
  if (!root || !selection?.rangeCount || selection.isCollapsed) return [];
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer) || !range.toString().trim()) return [];
  return [...root.querySelectorAll("[data-article-block]")]
    .filter((element) => element.getClientRects().length && range.intersectsNode(element))
    .flatMap((element) => {
      const blockId = element.dataset.articleBlock;
      const items = [...element.querySelectorAll("[data-source-item]")].filter((item) => range.intersectsNode(item));
      return items.length ? items.map((item) => ({ blockId, itemId: item.dataset.sourceItem })) : [{ blockId }];
    });
}

export function selectedArticleBlocks(root, selection = window.getSelection()) {
  return [...new Set(selectedArticleTargets(root, selection).map((target) => target.blockId))];
}

export function pointedArticleTarget(root, target) {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  if (!root?.contains(element) || element.closest("button, input, textarea, select, summary, [role='separator'], [role='slider']")) return null;
  const blockId = element.closest("[data-article-block]")?.dataset.articleBlock;
  if (!blockId) return null;
  const itemId = element.closest("[data-source-item]")?.dataset.sourceItem;
  return { blockId, ...(itemId ? { itemId } : {}) };
}

export function pointedArticleBlock(root, target) {
  return pointedArticleTarget(root, target)?.blockId || null;
}

export function clickedArticleTarget(root, target) {
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  return element?.closest("a") && !element.closest("a")?.querySelector("img") ? null : pointedArticleTarget(root, target);
}

export function clickedArticleBlock(root, target) {
  return clickedArticleTarget(root, target)?.blockId || null;
}
