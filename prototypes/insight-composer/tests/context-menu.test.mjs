import test from 'node:test';
import assert from 'node:assert/strict';
import { contextMenuPosition, contextMenuIndex, isContextMenuKey } from '../src/context-menu.js';

const viewport = { width: 800, height: 600 };
const menu = { width: 224, height: 200 };

test('main menu opens at its point and flips independently at the right and bottom edges', () => {
  for (const [point, expected] of [
    [{ x: 100, y: 90 }, { left: 100, top: 90, originX: 'left', originY: 'top' }],
    [{ x: 780, y: 90 }, { left: 556, top: 90, originX: 'right', originY: 'top' }],
    [{ x: 100, y: 580 }, { left: 100, top: 380, originX: 'left', originY: 'bottom' }],
    [{ x: 780, y: 580 }, { left: 556, top: 380, originX: 'right', originY: 'bottom' }],
  ]) assert.deepEqual(contextMenuPosition({ point, menu, viewport }), expected);
});

test('a menu that exactly fits the viewport margin does not flip', () => {
  assert.deepEqual(contextMenuPosition({ point: { x: 568, y: 392 }, menu, viewport }), {
    left: 568, top: 392, originX: 'left', originY: 'top',
  });
});

test('main menu clamps a point outside the visual viewport and uses its nonzero offset', () => {
  const shiftedViewport = { left: 40, top: 70, width: 800, height: 600 };
  assert.deepEqual(contextMenuPosition({ point: { x: 820, y: 650 }, menu, viewport: shiftedViewport }), {
    left: 596, top: 450, originX: 'right', originY: 'bottom',
  });
  assert.deepEqual(contextMenuPosition({ point: { x: -100, y: -200 }, menu, viewport: shiftedViewport }), {
    left: 48, top: 78, originX: 'left', originY: 'top',
  });
  assert.deepEqual(contextMenuPosition({ point: { x: 2000, y: 2000 }, menu, viewport: shiftedViewport }), {
    left: 608, top: 462, originX: 'right', originY: 'bottom',
  });
});

test('an oversized menu keeps its leading edges reachable instead of using negative coordinates', () => {
  // The component must constrain or scroll oversized content: position alone
  // cannot fit a menu wider or taller than the available viewport.
  assert.deepEqual(contextMenuPosition({
    point: { x: 400, y: 300 }, menu: { width: 1000, height: 900 },
    viewport: { left: 40, top: 70, width: 800, height: 600 },
  }), { left: 48, top: 78, originX: 'right', originY: 'bottom' });
});

test('submenu follows the row edge and ignores the pointer position', () => {
  assert.deepEqual(contextMenuPosition({
    point: { x: 2, y: 2 }, menu, viewport, submenu: true,
    anchorRect: { left: 100, top: 120, right: 324, bottom: 150 },
  }), { left: 328, top: 120, originX: 'left', originY: 'top' });
});

test('submenu flips horizontally but clamps vertically rather than opening above the row', () => {
  assert.deepEqual(contextMenuPosition({
    point: { x: 700, y: 570 }, menu, viewport, submenu: true,
    anchorRect: { left: 560, top: 570, right: 784, bottom: 598 },
  }), { left: 332, top: 392, originX: 'right', originY: 'top' });
});

test('submenu honors custom gaps and margins in an offset visual viewport', () => {
  assert.deepEqual(contextMenuPosition({
    point: { x: 0, y: 0 }, menu, viewport: { left: 40, top: 70, width: 800, height: 600 },
    submenu: true, gap: 10, margin: 12,
    anchorRect: { left: 600, top: 650, right: 824, bottom: 680 },
  }), { left: 366, top: 458, originX: 'right', originY: 'top' });
});

test('submenu clamps an oversized surface to the visual viewport leading margin', () => {
  assert.deepEqual(contextMenuPosition({
    point: { x: 400, y: 300 }, menu: { width: 1000, height: 900 },
    viewport: { left: 40, top: 70, width: 800, height: 600 }, submenu: true,
    anchorRect: { left: 400, top: 300, right: 624, bottom: 332 },
  }), { left: 48, top: 78, originX: 'right', originY: 'top' });
});

test('context-menu keyboard triggers accept the menu key or Shift+F10 only', () => {
  assert.equal(isContextMenuKey({ key: 'ContextMenu' }), true);
  assert.equal(isContextMenuKey({ key: 'F10', shiftKey: true }), true);
  for (const event of [
    { key: 'F10' }, { key: 'F10', shiftKey: false }, { key: 'Enter' },
    { key: 'F9', shiftKey: true }, { key: 'Escape', shiftKey: true },
    { key: 'ContextMenu', isComposing: true }, { key: 'F10', shiftKey: true, isComposing: true },
  ]) assert.equal(isContextMenuKey(event), false, JSON.stringify(event));
});

test('control, meta and alt modifiers suppress both context-menu key bindings', () => {
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(isContextMenuKey({ key: 'ContextMenu', [modifier]: true }), false, modifier);
    assert.equal(isContextMenuKey({ key: 'F10', shiftKey: true, [modifier]: true }), false, modifier);
  }
});

const items = [
  { id: 'disabled-first', disabled: true },
  { id: 'read' },
  { id: 'disabled-middle', disabled: true },
  { id: 'status', disabled: false },
  { id: 'archive' },
  { id: 'disabled-last', disabled: true },
];

test('menu navigation returns original item indexes while skipping disabled items and wrapping', () => {
  for (const [current, key, expected] of [
    [-1, 'ArrowDown', 1], [-1, 'ArrowUp', 4],
    [1, 'ArrowDown', 3], [3, 'ArrowDown', 4], [4, 'ArrowDown', 1],
    [4, 'ArrowUp', 3], [3, 'ArrowUp', 1], [1, 'ArrowUp', 4],
    [2, 'ArrowDown', 3], [2, 'ArrowUp', 1],
    [4, 'Home', 1], [1, 'End', 4], [-1, 'Home', 1], [-1, 'End', 4],
  ]) assert.equal(contextMenuIndex(items, current, key), expected, `${key} from ${current}`);
});

test('empty and entirely disabled menus expose no navigation target', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    assert.equal(contextMenuIndex([], -1, key), -1, key);
    assert.equal(contextMenuIndex([{ id: 'one', disabled: true }, { id: 'two', disabled: true }], 0, key), -1, key);
  }
});

test('one enabled menu item remains selected in every navigation direction', () => {
  const one = [{ id: 'before', disabled: true }, { id: 'only' }, { id: 'after', disabled: true }];
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) assert.equal(contextMenuIndex(one, 1, key), 1, key);
});

test('unhandled keys preserve the current index and navigation leaves caller items untouched', () => {
  const frozen = Object.freeze(items.map(item => Object.freeze({ ...item })));
  for (const key of ['Enter', 'Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'a']) {
    assert.equal(contextMenuIndex(frozen, 3, key), 3, key);
    assert.equal(contextMenuIndex(frozen, -1, key), -1, key);
  }
  assert.equal(contextMenuIndex(frozen, 1, 'ArrowDown'), 3);
  assert.deepEqual(frozen, items);
});
