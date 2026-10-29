// Capture before the browser's secondary-button default can replace a range.
// Keep DOM ranges transient; only the Reader's source descriptor is persisted.
export function captureArticleSelection(root, selection) {
  if (!root || !selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer) || !range.toString().trim()) return null;
  const elementOf = (node) => node.nodeType === 1 ? node : node.parentElement;
  const block = elementOf(range.startContainer)?.closest("[data-block-id]");
  if (!block || block !== elementOf(range.endContainer)?.closest("[data-block-id]")) return null;
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  if (!rects.length) return null;
  return { root, block, range: range.cloneRange(), text: range.toString(), rects, anchorRect: rects.at(-1) };
}

export function selectionContextHit(snapshot, target, { keyboard = false, clientX = 0, clientY = 0 } = {}) {
  if (!snapshot?.block?.isConnected || !snapshot.root.contains(target)
    || !snapshot.root.contains(snapshot.range.startContainer) || !snapshot.root.contains(snapshot.range.endContainer)
    || snapshot.range.toString() !== snapshot.text) return false;
  if (keyboard) return target === snapshot.root || snapshot.block.contains(target);
  if (!snapshot.block.contains(target)) return false;
  // The same paragraph is insufficient: right-clicking outside its selected
  // words must not operate on the old excerpt or another table cell.
  return snapshot.rects.some((rect) => clientX >= rect.left - 1 && clientX <= rect.right + 1 && clientY >= rect.top - 1 && clientY <= rect.bottom + 1);
}

export function restoreArticleSelection(snapshot, selection) {
  if (!snapshot || !selection || !snapshot.block?.isConnected
    || !snapshot.root.contains(snapshot.range.startContainer) || !snapshot.root.contains(snapshot.range.endContainer)
    || snapshot.range.toString() !== snapshot.text) return false;
  try {
    selection.removeAllRanges();
    selection.addRange(snapshot.range.cloneRange());
    return true;
  } catch { return false; }
}
