import { createContext, forwardRef, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, useSpring } from "motion/react";
import { useMotionPresence } from "./useMotionPresence.js";
import { motionTransition } from "./motion-system.js";
import { useReducedMotionPreference } from "./useReducedMotionPreference.js";
import { sourceElement } from "./document-content";
import { matchesShortcut } from "./reading-shortcuts";

export const MAX_COMPOSER_HEIGHT = 160;
export const COMPOSER_TITLE_HEIGHT = 32;
const ComposerLayout = createContext(null);
export const useComposerLayout = () => useContext(ComposerLayout);

export const ComposerTextarea = forwardRef(function ComposerTextarea(props, ref) {
  const layout = useComposerLayout();
  const reduced = useReducedMotionPreference();
  return <motion.textarea {...props} ref={ref} initial={false}
    animate={{ left: layout.left, top: layout.inputTop, width: layout.width, height: layout.height }}
    transition={motionTransition("layout", reduced)} onAnimationComplete={layout.onGeometrySettled} data-composer-motion="input" />;
});

export function ComposerActions({ children, requestDraft }) {
  const layout = useComposerLayout();
  const reduced = useReducedMotionPreference();
  return <motion.div className="composer-actions" data-composer-motion="actions" initial={false}
    animate={{ left: layout.expanded ? 50 : layout.surfaceWidth - (requestDraft ? 100 : 161), top: layout.context ? 39 : 7 }}
    transition={motionTransition("layout", reduced)}>{children}</motion.div>;
}
export function composerAnchor(rect, headerHeight, viewportHeight, maximumHeight = MAX_COMPOSER_HEIGHT) {
  if (!rect) return "document";
  const minimumTop = Math.min(headerHeight + 62, Math.max(headerHeight + 12, viewportHeight - maximumHeight - 16));
  return rect.bottom + 8 + maximumHeight <= viewportHeight - 16 || rect.top - minimumTop - 8 < maximumHeight ? "below" : "above";
}

export function ComposerTitleField({ title, titleRef, inputRef, readOnly, onChange }) {
  const reduced = useReducedMotionPreference();
  return <motion.input initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={motionTransition("content", reduced)} data-composer-motion="title" ref={titleRef} className="composer-title-input" type="text" aria-label="洞见标题（可选）" placeholder="标题" maxLength={200} readOnly={readOnly} value={title || ""} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { event.preventDefault(); inputRef.current?.focus({ preventScroll: true }); }
  }} />;
}

// Keep the textarea mounted while its geometry changes. The mirror measures the
// destination width, so an animated intermediate width cannot toggle layouts.
export function ComposerSurface({ draft, closing = false, onExitComplete, position, composerRef, inputRef, titleExpanded = false, typeMenu, colorMenu, onSave, context, children }) {
  const mirrorRef = useRef(null);
  const expandedRef = useRef(false);
  const composingRef = useRef(false);
  const [compositionRevision, setCompositionRevision] = useState(0);
  const hasBody = Boolean(draft.body);
  const [menuSide, setMenuSide] = useState("bottom");
  const [layout, setLayout] = useState({ expanded: false, left: 78, top: 10, width: 372, height: 22, frameHeight: 44, lines: 1 });
  const presence = useMotionPresence(!closing, { kind: "surface", openState: { opacity: 1, y: 0 }, closedState: { opacity: 0, y: 3 }, onExit: onExitComplete });
  const frameHeight = useSpring(layout.frameHeight + (context ? 32 : 0), motionTransition("layout"));
  useLayoutEffect(() => {
    const next = layout.frameHeight + (context ? 32 : 0);
    if (presence.reduced) frameHeight.jump(next);
    else frameHeight.set(next);
  }, [layout.frameHeight, Boolean(context), presence.reduced, frameHeight]);
  const bindSurface = useCallback((node) => {
    composerRef.current = node;
    if (!node) return;
    const block = sourceElement(document, draft);
    const headerHeight = document.querySelector(".topbar")?.getBoundingClientRect().bottom || 56;
    node.dataset.anchor ||= composerAnchor(block?.getBoundingClientRect(), headerHeight, window.innerHeight, MAX_COMPOSER_HEIGHT + (draft.intent === "change-request" ? 0 : COMPOSER_TITLE_HEIGHT) + (context ? 32 : 0));
  }, [composerRef, draft.blockId, draft.nodeId, draft.variant, draft.field, draft.row, draft.column, Boolean(context)]);

  useLayoutEffect(() => {
    if (!mirrorRef.current) return;
    const mirror = mirrorRef.current;
    const borderStyle = composerRef.current && getComputedStyle(composerRef.current);
    const borderWidth = borderStyle ? parseFloat(borderStyle.borderLeftWidth) + parseFloat(borderStyle.borderRightWidth) : 2;
    const compactWidth = Math.max(1, position.width - borderWidth - 48 - 106 - (draft.intent === "change-request" ? 0 : 61));
    const fullWidth = Math.max(1, position.width - borderWidth - 24);
    const lineHeight = 22;
    const measure = (observedHeight) => {
      if (composingRef.current) return;
      const lineCount = (width) => {
        const changedWidth = mirror.style.width !== width + "px";
        if (changedWidth) mirror.style.width = width + "px";
        const height = !changedWidth && observedHeight != null ? observedHeight : mirror.getBoundingClientRect().height;
        // Only five visible lines and the overflow state affect the layout.
        return Math.min(6, Math.max(1, Math.round(height / lineHeight)));
      };
      if (!hasBody) expandedRef.current = false;
      let expanded = titleExpanded || expandedRef.current;
      let lines = lineCount(expanded ? fullWidth : compactWidth);
      if (!expanded && lines > 1) {
        expanded = true;
        lines = lineCount(fullWidth);
      }
      expandedRef.current = expanded;
      const width = expanded ? fullWidth : compactWidth;
      const height = Math.min(5, lines) * lineHeight;
      const next = {
        expanded, width, lines, height,
        left: expanded ? 12 : 48,
        top: (expanded ? 40 : 10) + (titleExpanded ? COMPOSER_TITLE_HEIGHT : 0),
        frameHeight: (expanded ? height + 50 : 44) + (titleExpanded ? COMPOSER_TITLE_HEIGHT : 0),
      };
      setLayout((old) => Object.keys(next).every((key) => old[key] === next[key]) ? old : next);
    };
    measure();
    // Text updates let the browser lay out the mirror normally. Its observer
    // runs only when the number of visual lines changes, rather than forcing a
    // synchronous layout and recreating an observer for every keystroke.
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.height));
    observer.observe(mirror);
    return () => observer.disconnect();
  }, [hasBody, draft.intent, position.width, compositionRevision, titleExpanded, composerRef]);

  useLayoutEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, [inputRef]);

  const keepEndCaretVisible = useCallback(() => {
    const field = inputRef.current;
    if (field && document.activeElement === field && field.selectionStart === field.value.length && field.selectionEnd === field.value.length) {
      field.scrollTop = field.scrollHeight;
    }
  }, [inputRef]);

  useLayoutEffect(() => {
    if (presence.reduced) keepEndCaretVisible();
  }, [presence.reduced, layout.height, layout.width, keepEndCaretVisible]);

  const layoutContext = useMemo(() => ({ ...layout, context: Boolean(context), inputTop: layout.top + (context ? 32 : 0), surfaceWidth: position.width, onGeometrySettled: keepEndCaretVisible }), [layout, Boolean(context), position.width, keepEndCaretVisible]);

  useLayoutEffect(() => {
    if (!colorMenu) return;
    const surface = composerRef.current;
    const trigger = surface?.querySelector(".color-trigger");
    const menu = surface?.querySelector(".color-menu");
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const headerBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom || 56;
    const below = window.innerHeight - 16 - rect.bottom;
    setMenuSide(below >= menu.offsetHeight + 6 || rect.top - headerBottom - 12 < menu.offsetHeight + 6 ? "bottom" : "top");
  }, [typeMenu, colorMenu, composerRef]);

  return <motion.section
    {...presence.motionProps}
    ref={bindSurface}
    role="dialog"
    aria-label={draft.intent === "change-request" ? "AI 请求" : draft.id ? "编辑洞见" : "新建洞见"}
    className="composer"
    data-motion-surface="composer"
    data-closing={closing || undefined}
    inert={closing}
    aria-hidden={closing || undefined}
    data-intent={draft.intent}
    data-context={Boolean(context)}
    data-title={titleExpanded}
    data-layout={layout.expanded ? "expanded" : "compact"}
    data-visible-lines={Math.min(5, layout.lines)}
    data-menu-side={menuSide}
    style={{
      ...position,
      height: frameHeight,
      "--input-left": layout.left + "px",
      "--input-top": layout.top + (context ? 32 : 0) + "px",
      "--input-width": layout.width + "px",
      "--input-height": layout.height + "px",
      "--input-overflow": layout.lines > 5 ? "auto" : "hidden",
      "--title-top": 40 + (context ? 32 : 0) + "px",
    }}
    onCompositionStart={() => { composingRef.current = true; }}
    onCompositionEnd={() => { composingRef.current = false; setCompositionRevision((value) => value + 1); }}
    onTransitionEnd={(event) => {
      if (event.target === inputRef.current && ["height", "width"].includes(event.propertyName)) keepEndCaretVisible();
    }}
    onKeyDown={(event) => {
      if (matchesShortcut(event.nativeEvent, "save")) {
        event.preventDefault(); event.stopPropagation(); onSave();
      }
    }}
  >
    <ComposerLayout.Provider value={layoutContext}>
      {context}
      {children}
    </ComposerLayout.Provider>
    <div ref={mirrorRef} className="composer-measure" aria-hidden="true" style={{ maxHeight: 132, overflow: "hidden" }}>{draft.body + "\u200b"}</div>
  </motion.section>;
}
