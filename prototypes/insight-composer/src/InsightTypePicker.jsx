import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useMotionPresence } from "./useMotionPresence.js";
import { useReducedMotionPreference } from "./useReducedMotionPreference.js";
import { motionTransition } from "./motion-system.js";
import { useComposerLayout } from "./ComposerSurface.jsx";
import { matchesShortcut } from "./reading-shortcuts";

function AnimatedTypeIcon({ type, types }) {
  const reduced = useReducedMotionPreference();
  const Current = types.find((item) => item.id === type).Icon;
  return <span className="type-glyph" aria-hidden="true">
    <AnimatePresence initial={false}><motion.span key={type} className="type-glyph-layer" data-type={type}
      initial={{ opacity: 0, y: reduced ? 0 : 2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -2 }}
      transition={motionTransition("control", reduced)}><Current size={17} weight="regular" /></motion.span></AnimatePresence>
  </span>;
}

function TypeMenu({ open, type, types, composerRef, triggerRef, inputRef, onOpenChange, onTypeChange }) {
  const menuRef = useRef(null);
  const sideRef = useRef(null);
  const [position, setPosition] = useState(null);
  const { present, entered, motionProps } = useMotionPresence(open, { kind: "surface", openState: { opacity: 1, y: 0, scale: 1 }, closedState: { opacity: 0, y: 3, scale: .985 } });

  useLayoutEffect(() => {
    if (!present) {
      sideRef.current = null;
      setPosition(null);
      return;
    }
    const update = () => {
      const frame = composerRef.current;
      const menu = menuRef.current;
      if (!frame || !menu) return;
      const rect = frame.getBoundingClientRect();
      const height = menu.getBoundingClientRect().height;
      const width = Math.min(232, window.innerWidth - 24);
      const frameStyle = getComputedStyle(frame);
      const topEdge = (document.querySelector(".topbar")?.getBoundingClientRect().bottom || 0) + 12;
      if (!sideRef.current) {
        const fitsAbove = rect.top >= topEdge + height + 8;
        const fitsBelow = window.innerHeight - rect.bottom >= height + 8 + 12;
        sideRef.current = fitsAbove || !fitsBelow ? "top" : "bottom";
      }
      const side = sideRef.current;
      const next = {
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) - rect.left - parseFloat(frameStyle.borderLeftWidth),
        offset: 8 + parseFloat(side === "top" ? frameStyle.borderTopWidth : frameStyle.borderBottomWidth),
        width,
        side,
        visible: rect.bottom > 0 && rect.top < window.innerHeight,
      };
      setPosition((old) => old && Object.keys(next).every((key) => next[key] === old[key]) ? old : next);
    };
    update();
    const observer = new ResizeObserver(update);
    if (composerRef.current) observer.observe(composerRef.current);
    if (menuRef.current) observer.observe(menuRef.current);
    // Observe placement changes for viewport constraints. The menu itself is
    // anchored by CSS to the composer, including every intermediate height.
    const placementObserver = new MutationObserver(update);
    if (composerRef.current) placementObserver.observe(composerRef.current, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      placementObserver.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [composerRef, present]);

  useLayoutEffect(() => {
    if (open && position?.visible) menuRef.current?.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  }, [open, Boolean(position?.visible)]);

  function onKeys(event) {
    const items = [...menuRef.current.querySelectorAll('[role="menuitemradio"]')];
    const index = items.indexOf(document.activeElement);
    if (matchesShortcut(event.nativeEvent, "close")) {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      onOpenChange(false);
      (event.shiftKey ? triggerRef : inputRef).current?.focus({ preventScroll: true });
      return;
    }
    let next = null;
    if (["ArrowRight", "ArrowDown"].includes(event.key)) next = (index + 1) % items.length;
    if (["ArrowLeft", "ArrowUp"].includes(event.key)) next = (index - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus({ preventScroll: true });
    }
  }

  if (!present || !composerRef.current) return null;
  const side = position?.side || "top";
  return createPortal(<div
    ref={menuRef}
    id="insight-type-menu"
    className="type-picker-positioner"
    role="menu"
    aria-label="选择洞见类型"
    aria-orientation="horizontal"
    aria-hidden={!open || undefined}
    inert={!open}
    data-side={side}
    data-state={open && entered ? "open" : "closed"}
    style={{
      left: position?.left ?? 0,
      [side === "top" ? "bottom" : "top"]: `calc(100% + ${position?.offset || 8}px)`,
      width: position?.width || 232,
      visibility: position?.visible ? "visible" : "hidden",
    }}
    onKeyDown={onKeys}
  ><motion.div {...motionProps} className="type-menu" data-motion-surface="type-menu">{types.map((item) => <button
    key={item.id}
    type="button"
    className="type-choice"
    role="menuitemradio"
    data-type={item.id}
    aria-checked={item.id === type}
    tabIndex={item.id === type ? 0 : -1}
    onClick={() => {
      onTypeChange(item.id);
      onOpenChange(false);
      inputRef.current?.focus({ preventScroll: true });
    }}
  >
    <span className="choice-icon" aria-hidden="true"><item.Icon size={16} weight="regular" /></span>
    <span className="choice-label">{item.label}</span>
    <span className="choice-indicator" aria-hidden="true" />
  </button>)}</motion.div></div>, composerRef.current);
}

export function InsightTypePicker({ types, type, open, disabled = false, label = "洞见类型", onOpenChange, onTypeChange, composerRef, triggerRef, inputRef }) {
  const current = types.find((item) => item.id === type);
  const layout = useComposerLayout();
  const reduced = useReducedMotionPreference();
  return <motion.div className="composer-type" data-composer-motion="type" initial={false}
    animate={{ left: layout?.expanded ? 11 : 7, top: layout?.context ? 39 : 7 }} transition={motionTransition("layout", reduced)}>
    <button
      ref={triggerRef}
      type="button"
      className="type-trigger"
      disabled={disabled}
      data-type={type}
      aria-label={label + "：" + current.label}
      title={label + "：" + current.label}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? "insight-type-menu" : undefined}
      onClick={() => onOpenChange(!open)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          onOpenChange(true);
        }
      }}
    ><AnimatedTypeIcon type={type} types={types} /></button>
    <span className="type-tooltip" role="tooltip">{current.label}</span>
    <TypeMenu open={open} type={type} types={types} composerRef={composerRef} triggerRef={triggerRef} inputRef={inputRef} onOpenChange={onOpenChange} onTypeChange={onTypeChange} />
  </motion.div>;
}
