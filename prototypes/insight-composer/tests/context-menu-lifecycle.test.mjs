import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as helpers from '../src/context-menu.js';

// Execute the real hook, including its event listeners and returned callbacks.
// JSX is compiled rather than asserted as source text. This deterministic host
// does not emulate native popover painting, focus traversal or spring geometry.
const source = await readFile(new URL('../src/ContextMenu.jsx', import.meta.url), 'utf8');
const compiled = transformSync(source, { loader: 'jsx', jsx: 'automatic', format: 'cjs', target: 'es2022' }).code;

function environment() {
  let activeHost, ownerSequence = 0;
  const hooks = {
    useRef(initial) {
      const index = activeHost.cursor++;
      activeHost.cells[index] ||= { value: { current: initial } };
      return activeHost.cells[index].value;
    },
    useState(initial) {
      const host = activeHost, index = host.cursor++;
      host.cells[index] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [host.cells[index].value, next => {
        assert.equal(host.mounted, true, 'unmounted hooks cannot be updated');
        const value = typeof next === 'function' ? next(host.cells[index].value) : next;
        if (Object.is(host.cells[index].value, value)) return;
        host.cells[index].value = value; host.dirty = true;
      }];
    },
    useCallback(callback, deps) {
      const index = activeHost.cursor++, previous = activeHost.cells[index];
      if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) activeHost.cells[index] = { value: callback, deps };
      return activeHost.cells[index].value;
    },
    useId() {
      const index = activeHost.cursor++;
      activeHost.cells[index] ||= { value: `menu-owner-${++ownerSequence}` };
      return activeHost.cells[index].value;
    },
  };
  const effect = (callback, deps) => {
    const host = activeHost, index = host.cursor++, previous = host.cells[index];
    const changed = !previous || !deps || deps.some((value, offset) => !Object.is(value, previous.deps?.[offset]));
    host.cells[index] = { ...previous, callback, deps, effect: true };
    if (changed) host.pending.add(index);
  };
  hooks.useEffect = hooks.useLayoutEffect = effect;

  class Hub {
    listeners = new Map();
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    dispatchEvent(event) { for (const listener of [...(this.listeners.get(event.type) || [])]) listener(event); }
  }
  const document = new Hub(), window = new Hub();
  class Element {
    constructor(name, parent = null) { this.name = name; this.parent = parent; this.isConnected = true; this.dataset = {}; this.focusCalls = []; this.editable = false; }
    focus(options) { this.focusCalls.push(options); document.activeElement = this; }
    contains(other) { for (let current = other; current; current = current.parent) if (current === this) return true; return false; }
    closest() { return this.editable ? this : null; }
    getBoundingClientRect() { return { left: 120, top: 80, right: 420, bottom: 116 }; }
  }
  document.body = new Element('body'); document.documentElement = new Element('html'); document.activeElement = document.body;
  const surfaces = [];
  document.querySelectorAll = () => surfaces;
  window.visualViewport = new Hub();
  window.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  const jsx = (type, props, key) => ({ type, props: props || {}, key });
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, document, window, Element,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    console, innerWidth: 1200, innerHeight: 800,
    require(specifier) {
      if (specifier === 'react') return hooks;
      if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (specifier === 'react-dom') return { createPortal: value => value };
      if (specifier === './context-menu.js') return helpers;
      return {};
    },
  }, { filename: 'ContextMenu.compiled.cjs' });

  function host(input = {}) {
    const state = { cursor: 0, cells: [], pending: new Set(), dirty: true, mounted: true, input, output: null };
    const flush = () => {
      for (let limit = 0; limit < 30 && (state.dirty || state.pending.size); limit++) {
        if (state.dirty) {
          state.dirty = false; state.cursor = 0; activeHost = state;
          state.output = module.exports.useContextMenu(state.input);
        }
        for (const index of [...state.pending]) {
          state.pending.delete(index); const cell = state.cells[index];
          cell.cleanup?.(); cell.cleanup = cell.callback();
        }
      }
      assert.equal(state.dirty || state.pending.size > 0, false, 'hook effects converge');
      return state.output;
    };
    flush();
    return {
      flush,
      get value() { return state.output; },
      get main() { return state.output.element.props.children[0].props; },
      get child() { return state.output.element.props.children[1].props; },
      update(patch) { state.input = { ...state.input, ...patch }; state.dirty = true; return flush(); },
      open(config = {}, event = {}) {
        const trigger = config.trigger || new Element('row');
        const native = { type: 'contextmenu', target: trigger, currentTarget: trigger, clientX: 160, clientY: 100, defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...event };
        const result = state.output.open(native, { id: 'row', items: [{ id: 'read', label: 'Read' }], ...config, trigger });
        flush(); return { result, event: native, trigger };
      },
      close(reason) { state.output.close(reason); flush(); },
      unmount() { for (const cell of state.cells) if (cell?.effect) cell.cleanup?.(); state.mounted = false; },
    };
  }
  return { host, document, window, Element, surfaces };
}

test('opening freezes the invocation point and trigger without executing a business action', () => {
  const env = environment(), h = env.host({ contextKey: 'collection' }); let actions = 0;
  const item = { id: 'read', onSelect() { actions++; } };
  const invocation = h.open({ id: 'paper-b', items: [item] });
  assert.equal(invocation.result, true); assert.equal(invocation.event.defaultPrevented, true); assert.equal(invocation.event.stopped, true);
  assert.equal(h.value.targetId, 'paper-b'); assert.equal(h.main.open, true); assert.equal(h.main.session.trigger, invocation.trigger);
  assert.deepEqual({ ...h.main.session.point }, { x: 160, y: 100 }); assert.equal(actions, 0);
});

test('keyboard invocation anchors to the trigger or explicit source rectangle', () => {
  const env = environment(), h = env.host();
  h.open({}, { type: 'keydown', key: 'F10', shiftKey: true });
  assert.deepEqual({ ...h.main.session.point }, { x: 120, y: 116 });
  h.open({ anchorRect: { left: 340, top: 220, right: 390, bottom: 242 } }, { type: 'keydown', key: 'ContextMenu' });
  assert.deepEqual({ ...h.main.session.point }, { x: 340, y: 242 });
});

test('editable targets, disabled owners and unsupported keyboard chords do not intercept input', () => {
  const env = environment(), h = env.host(); const editable = new env.Element('input'); editable.editable = true;
  for (const event of [{ target: editable }, { type: 'keydown', key: 'Enter' }, { type: 'keydown', key: 'F10', shiftKey: true, ctrlKey: true }, { defaultPrevented: true }]) {
    const result = h.open({}, event); assert.equal(result.result, false); assert.equal(h.value.targetId, null);
  }
  h.update({ disabled: true }); const blocked = h.open(); assert.equal(blocked.result, false); assert.equal(blocked.event.defaultPrevented, false);
});

test('close retains exit content, restores focus only for explicit return reasons, and calls onClose once', () => {
  for (const reason of ['escape', 'action', 'tab', 'outside', 'scroll', 'resize', 'replace']) {
    const env = environment(), h = env.host(), closed = [];
    const { trigger } = h.open({ onClose: event => closed.push(event.reason) });
    const unrelated = new env.Element('other-control'); unrelated.focus();
    h.close(reason); h.close(reason);
    assert.equal(h.value.targetId, null); assert.equal(h.main.open, false); assert.ok(h.main.session, 'exit keeps the previous menu content');
    assert.deepEqual(closed, [reason]);
    assert.equal(env.document.activeElement, ['escape', 'action', 'tab'].includes(reason) ? trigger : unrelated, reason);
    if (trigger.focusCalls.length) assert.equal(trigger.focusCalls.at(-1).preventScroll, true);
  }
});

test('replacement invalidates captured actions and lets the new action hand focus directly to an editor', () => {
  const env = environment(), h = env.host(), closed = []; let oldActions = 0, newActions = 0;
  const oldItem = { id: 'old', onSelect() { oldActions++; } };
  h.open({ id: 'a', items: [oldItem], onClose: event => closed.push(event.reason) });
  const oldCallback = h.main.onAction, oldGeneration = h.main.session.generation;
  const editor = new env.Element('editor'); let focusAtAction;
  const newItem = { id: 'new', onSelect() { newActions++; focusAtAction = env.document.activeElement; editor.focus(); } };
  const { trigger } = h.open({ id: 'b', items: [newItem] });
  oldCallback(oldItem, oldGeneration); h.flush(); assert.equal(oldActions, 0); assert.equal(h.value.targetId, 'b');
  h.main.onAction(newItem, h.main.session.generation); h.flush();
  assert.equal(newActions, 1); assert.equal(focusAtAction, trigger); assert.equal(env.document.activeElement, editor);
  h.value.close('escape'); h.flush(); assert.equal(env.document.activeElement, editor); assert.deepEqual(closed, ['replace']);
});

test('repeated or disabled action callbacks cannot mutate business data twice', () => {
  const env = environment(), h = env.host(); let actions = 0;
  const item = { id: 'save', onSelect() { actions++; } }; h.open({ items: [item] });
  const callback = h.main.onAction, generation = h.main.session.generation;
  callback({ ...item, disabled: true }, generation); assert.equal(actions, 0);
  callback(item, generation); callback(item, generation); h.flush(); assert.equal(actions, 1);
});

test('different menu owners replace one another, while their own opening event is ignored', () => {
  const env = environment(), a = env.host(), b = env.host(), reasons = [];
  a.open({ id: 'reader', onClose: event => reasons.push(event.reason) });
  assert.equal(a.value.targetId, 'reader');
  b.open({ id: 'object' }); a.flush();
  assert.equal(a.value.targetId, null); assert.equal(b.value.targetId, 'object'); assert.deepEqual(reasons, ['replace']);
  a.unmount(); b.unmount();
});

test('business context replacement and pending-state disabling close once without stealing focus', () => {
  for (const patch of [{ contextKey: 'revision-2' }, { disabled: true }]) {
    const env = environment(), h = env.host({ contextKey: 'revision-1' }), reasons = [];
    h.open({ onClose: event => reasons.push(event.reason) }); const input = new env.Element('filter'); input.focus();
    h.update(patch); assert.equal(h.value.targetId, null); assert.deepEqual(reasons, ['disabled']); assert.equal(env.document.activeElement, input);
  }
});

test('inside scroll stays local, outside pointer or viewport change closes, and listeners release', () => {
  const env = environment(), h = env.host(), reasons = [];
  h.open({ onClose: event => reasons.push(event.reason) });
  const surface = new env.Element('surface'); surface.dataset.contextOwner = h.main.owner; env.surfaces.push(surface);
  const menuItem = new env.Element('menu-item', surface);
  env.document.dispatchEvent({ type: 'scroll', target: menuItem }); h.flush(); assert.ok(h.value.targetId);
  env.document.dispatchEvent({ type: 'pointerdown', target: new env.Element('outside') }); h.flush(); assert.equal(h.value.targetId, null); assert.deepEqual(reasons, ['outside']);
  assert.equal(env.document.listeners.get('pointerdown').size, 0); assert.equal(env.document.listeners.get('scroll').size, 0);
  h.open({ onClose: event => reasons.push(event.reason) }); env.window.visualViewport.dispatchEvent({ type: 'resize' }); h.flush();
  assert.equal(h.value.targetId, null); assert.deepEqual(reasons, ['outside', 'resize']);
});

test('unmount reports its own reason and removes document listeners without returning focus', () => {
  const env = environment(), h = env.host(), reasons = [];
  const { trigger } = h.open({ onClose: event => reasons.push(event.reason) }); h.unmount();
  assert.deepEqual(reasons, ['unmount']); assert.equal(trigger.focusCalls.length, 0);
  assert.equal(env.document.listeners.get('pointerdown').size, 0); assert.equal(env.document.listeners.get('scroll').size, 0);
});
