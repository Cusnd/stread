import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { DecorativeIcon } from "./InterfaceMode.jsx";
import { Check, CaretRight } from "./icons.jsx";
import { useMotionPresence } from "./useMotionPresence.js";
import { contextMenuPosition, contextMenuIndex, isContextMenuKey, isEditableContextTarget } from "./context-menu.js";
import "./context-menu.css";

const ownerEvent = "reader-context-menu-open";
const menuVisible = Object.freeze({ opacity: 1 });
const menuHidden = Object.freeze({ opacity: 0 });
const viewport = () => ({ left: window.visualViewport?.offsetLeft || 0, top: window.visualViewport?.offsetTop || 0, width: window.visualViewport?.width || innerWidth, height: window.visualViewport?.height || innerHeight });
function focusWithoutScroll(element) { if (element?.isConnected) element.focus({ preventScroll: true }); }

/** A manual native popover keeps menus above modal dialogs without an input
 * blocker. Native lifetime follows actual motion completion, not a timer. */
function MenuSurface({ open, session, owner, submenu = false, anchor, onAction, onClose, onChild, onReturn }) {
  const root = useRef(null), content = useRef(null), buttons = useRef([]);
  const [active, setActive] = useState(-1);
  const hoverTimer = useRef(null), current = useRef(null);
  current.current = { open, session, anchor };
  const { present, motionProps } = useMotionPresence(open, {
    openState: menuVisible, closedState: menuHidden,
    onExit: () => root.current?.hidePopover?.(),
  });
  const items = session?.items || [];
  const focusItem = useCallback((index) => { setActive(index); focusWithoutScroll(buttons.current[index]); }, []);

  useLayoutEffect(() => {
    if (!present || !root.current || !content.current) return;
    const surface = root.current;
    if (!surface.matches(":popover-open")) surface.showPopover();
    const measure = () => {
      if (!current.current.open) return;
      const view = viewport();
      surface.style.maxWidth = `${Math.max(0, view.width - 16)}px`;
      const chromeHeight = surface.offsetHeight - content.current.offsetHeight;
      content.current.style.maxHeight = `${Math.max(0, view.height - 16 - chromeHeight)}px`;
      const bounds = { width: surface.offsetWidth, height: surface.offsetHeight };
      const position = contextMenuPosition({ point: current.current.session.point, menu: { width: bounds.width, height: bounds.height }, viewport: view, anchorRect: submenu ? current.current.anchor?.getBoundingClientRect() : undefined, submenu });
      // Each invocation belongs at its own pointer/keyboard anchor. Position it
      // before paint, including a replacement during exit; never fly from the
      // previous target. Only the inner surface's opacity participates in motion.
      surface.style.left = `${position.left}px`;
      surface.style.top = `${position.top}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content.current);
    window.addEventListener("reader-ui-scale-change", measure);
    return () => { observer.disconnect(); window.removeEventListener("reader-ui-scale-change", measure); };
  }, [present, session?.generation, session?.id, anchor, submenu]);

  useLayoutEffect(() => {
    window.clearTimeout(hoverTimer.current);
    if (!open || !present) return;
    const first = contextMenuIndex(items, -1, "ArrowDown");
    setActive(first);
    if (!submenu || session.keyboard) focusWithoutScroll(buttons.current[first] || root.current);
    // Focusing a menu must not discard the source excerpt it acts on.
    const range = session.range;
    if (range?.startContainer?.isConnected && range?.endContainer?.isConnected) {
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range.cloneRange());
    }
  }, [open, present, session?.generation, session?.id]);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  if (!present || !session) return null;
  const openChild = (item, index, keyboard) => { if (!item.disabled && item.children?.length) onChild?.(item, buttons.current[index], keyboard); };
  const keys = (event) => {
    event.stopPropagation();
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); onChild?.(null); focusItem(contextMenuIndex(items, active, event.key)); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); const item = items[active]; if (item && !item.disabled) item.children ? openChild(item, active, true) : onAction(item, session.generation); }
    else if (event.key === "ArrowRight" && items[active]?.children) { event.preventDefault(); openChild(items[active], active, true); }
    else if (event.key === "ArrowLeft" && submenu) { event.preventDefault(); onReturn(); }
    else if (event.key === "Escape") { event.preventDefault(); submenu || anchor ? onReturn() : onClose("escape"); }
    else if (event.key === "Tab") { onClose("tab"); }
  };
  return createPortal(<div ref={root} popover="manual" className={"reader-context-position" + (submenu ? " reader-context-submenu" : "")}
    data-context-owner={owner} data-context-state={open ? "open" : "closing"}
    inert={!open || undefined} aria-hidden={!open || undefined} onKeyDown={keys}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    <motion.div {...motionProps} className="reader-context-surface">
      <div className="reader-context-clip">
          <div ref={content} className="reader-context-content" role="menu" aria-label={session.label || "操作"} tabIndex={-1}>
            {items.map((item, index) => {
              const Icon = item.icon;
              return <div key={item.id} className={"reader-context-slot" + (item.separatorBefore ? " reader-context-group" : "")}>
                <button ref={(node) => { buttons.current[index] = node; }} type="button" className={"reader-context-item" + (item.danger ? " is-danger" : "")}
                  data-active={active === index && !item.disabled || undefined}
                  role={typeof item.checked === "boolean" ? "menuitemradio" : "menuitem"} aria-checked={item.checked} aria-disabled={item.disabled || undefined}
                  disabled={item.disabled} aria-haspopup={item.children ? "menu" : undefined} aria-expanded={item.children ? Boolean(anchor === buttons.current[index]) : undefined}
                  tabIndex={active === index ? 0 : -1} onFocus={() => setActive(index)}
                  onPointerEnter={(event) => { if (event.pointerType === "touch" || item.disabled) return; setActive(index); window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(() => { if (current.current.open && current.current.session.generation === session.generation) item.children ? openChild(item, index, false) : onChild?.(null); }, 100); }}
                  onPointerLeave={() => window.clearTimeout(hoverTimer.current)}
                  onClick={() => { window.clearTimeout(hoverTimer.current); item.children ? openChild(item, index, true) : onAction(item, session.generation); }}>
                  {Icon && <DecorativeIcon><Icon className="reader-context-icon" size={15} aria-hidden="true" /></DecorativeIcon>}
                  <span className="reader-context-label">{item.label}</span>
                  {item.checked && <Check className="reader-context-check" size={14} aria-hidden="true" />}
                  {item.children && <CaretRight className="reader-context-arrow" size={13} aria-hidden="true" />}
                </button>
              </div>;
            })}
          </div>
      </div>
    </motion.div>
  </div>, document.body);
}

export function useContextMenu({ disabled = false, contextKey } = {}) {
  const owner = useId(), latest = useRef(null), sequence = useRef(0);
  const [session, setSession] = useState(null), [shown, setShown] = useState(false), [child, setChild] = useState(null);
  latest.current = { ...latest.current, disabled, contextKey };
  const close = useCallback((reason = "outside") => {
    const old = latest.current.session;
    if (!latest.current.open || !old) return;
    latest.current.open = false;
    setShown(false); setChild(null);
    if (["escape", "action", "tab"].includes(reason)) focusWithoutScroll(old.trigger);
    old.onClose?.({ reason });
  }, []);
  const open = useCallback((event, config) => {
    const keyboard = event.type === "keydown";
    if (latest.current.disabled || event.defaultPrevented || isEditableContextTarget(event.target) || (keyboard && !isContextMenuKey(event)) || !config.items?.length) return false;
    event.preventDefault(); event.stopPropagation();
    const trigger = config.trigger || event.currentTarget;
    const anchorRect = config.anchorRect || trigger.getBoundingClientRect();
    let range = null;
    const selection = window.getSelection();
    if (config.preserveSelection !== false && selection?.rangeCount && !selection.isCollapsed && trigger.contains(selection.getRangeAt(0).commonAncestorContainer)) range = selection.getRangeAt(0).cloneRange();
    close("replace");
    window.dispatchEvent(new CustomEvent(ownerEvent, { detail: owner }));
    const next = { ...config, trigger, keyboard, range, generation: ++sequence.current, contextKey: latest.current.contextKey, point: keyboard ? { x: anchorRect.left, y: anchorRect.bottom } : { x: event.clientX, y: event.clientY } };
    latest.current = { ...latest.current, session: next, open: true };
    setSession(next); setChild(null); setShown(true);
    return true;
  }, [owner, close]);
  useEffect(() => {
    if (disabled || (session && contextKey !== session.contextKey)) close("disabled");
  }, [disabled, contextKey, session, close]);
  useEffect(() => {
    if (!shown) return;
    const inside = (target) => target instanceof Element && [...document.querySelectorAll("[data-context-owner]")].some((node) => node.dataset.contextOwner === owner && node.contains(target));
    const outside = (event) => { if (!inside(event.target)) close("outside"); };
    const scroll = (event) => { if (!inside(event.target)) close("scroll"); };
    const resize = () => close("resize");
    const replaced = (event) => { if (event.detail !== owner) close("replace"); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.addEventListener(ownerEvent, replaced);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize); window.removeEventListener(ownerEvent, replaced); };
  }, [shown, owner, close]);
  useEffect(() => () => { const state = latest.current; if (state.open) state.session?.onClose?.({ reason: "unmount" }); }, []);
  const action = (item, generation) => { if (!latest.current.open || generation !== latest.current.session?.generation || item.disabled) return; close("action"); item.onSelect?.(); };
  const retainedChild = useRef(null);
  if (child) retainedChild.current = child;
  const childSession = retainedChild.current;
  return { open, close, targetId: shown ? session?.id : null, element: <>
    <MenuSurface open={shown} session={session} owner={owner} anchor={child?.anchor} onAction={action} onClose={close}
      onReturn={() => { setChild(null); focusWithoutScroll(child?.anchor); }}
      onChild={(item, anchor, keyboard) => setChild(item ? { ...session, id: item.id, label: item.label, items: item.children, anchor, keyboard } : null)} />
    <MenuSurface open={shown && Boolean(child)} session={childSession} owner={owner} submenu anchor={childSession?.anchor} onAction={action} onClose={close}
      onReturn={() => { setChild(null); focusWithoutScroll(childSession?.anchor); }} />
  </> };
}
