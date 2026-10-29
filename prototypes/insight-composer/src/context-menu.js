// Position and keyboard rules are independent of rendering and business actions.
export function contextMenuPosition({ point = { x: 0, y: 0 }, menu, viewport, anchorRect, submenu = false, gap = 4, margin = 8 }) {
  const startX = (viewport.left || 0) + margin, startY = (viewport.top || 0) + margin;
  const endX = (viewport.left || 0) + viewport.width - margin, endY = (viewport.top || 0) + viewport.height - margin;
  let left = submenu && anchorRect ? anchorRect.right + gap : point.x;
  let top = submenu && anchorRect ? anchorRect.top : point.y;
  let originX = 'left', originY = 'top';
  if (left + menu.width > endX) { left = submenu && anchorRect ? anchorRect.left - menu.width - gap : point.x - menu.width; originX = 'right'; }
  if (!submenu && top + menu.height > endY) { top = point.y - menu.height; originY = 'bottom'; }
  left = Math.max(startX, Math.min(left, endX - menu.width));
  top = Math.max(startY, Math.min(top, endY - menu.height));
  return { left, top, originX, originY };
}

export function contextMenuIndex(items, current, key) {
  const enabled = items.map((item, index) => item.disabled ? -1 : index).filter(index => index >= 0);
  if (!enabled.length) return -1;
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled.at(-1);
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return current;
  if (current < 0) return key === 'ArrowDown' ? enabled[0] : enabled.at(-1);
  if (key === 'ArrowDown') return enabled.find(index => index > current) ?? enabled[0];
  return enabled.findLast(index => index < current) ?? enabled.at(-1);
}

export function isContextMenuKey(event) {
  if (event.isComposing || event.nativeEvent?.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey === true);
}

export function isEditableContextTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}
