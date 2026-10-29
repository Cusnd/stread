import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { citationHash, citationIndex, referencePreviewPosition } from "./citation-relations.js";

export function useCitationPreview({ articleRef, relations, renderKey, disabled, isCloseShortcut }) {
  const index = useMemo(() => citationIndex(relations), [relations]);
  const [open, setOpen] = useState(null);
  const openRef = useRef(null), panelRef = useRef(null), enterTimer = useRef(null), leaveTimer = useRef(null), restoringFocus = useRef(false);
  const [position, setPosition] = useState({ left: 12, top: 80, width: 384, maxHeight: 500 });
  const cancelTimers = useCallback(() => { clearTimeout(enterTimer.current); clearTimeout(leaveTimer.current); }, []);
  const close = useCallback((restoreFocus = false) => {
    cancelTimers();
    const previous = openRef.current;
    openRef.current = null; setOpen(null);
    if (restoreFocus && previous?.trigger?.isConnected) {
      restoringFocus.current = true;
      previous.trigger.focus({ preventScroll: true });
      queueMicrotask(() => { restoringFocus.current = false; });
    }
  }, [cancelTimers]);
  const show = useCallback((trigger, pinned = false) => {
    cancelTimers();
    const id = trigger?.dataset.referenceId;
    if (!id || !index.byId.has(id) || disabled) return;
    const current = openRef.current;
    if (current?.pinned && !pinned) return;
    if (current?.id === id && current.trigger === trigger && current.pinned === pinned) return;
    const next = { id, trigger, pinned };
    openRef.current = next; setOpen(next);
  }, [index, disabled, cancelTimers]);
  const keepOpen = useCallback(() => { clearTimeout(leaveTimer.current); }, []);
  const leave = useCallback(() => {
    clearTimeout(enterTimer.current);
    if (openRef.current?.pinned) return;
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      if (!panelRef.current?.contains(document.activeElement) && document.activeElement !== openRef.current?.trigger) close();
    }, 160);
  }, [close]);

  // Add keyboard entry points without replacing the authored DOM or selection
  // text. Cleanup restores every attribute when a document/mode is changed.
  useLayoutEffect(() => {
    const root = articleRef.current;
    if (!root || !index.byId.size) return;
    const changes = [];
    const decorate = (element, relation, entry) => {
      const attributes = { "data-reference-id": relation.id, "aria-haspopup": "dialog", ...(entry ? { tabIndex: "0", "aria-label": "查看参考文献" + (relation.label ? " " + relation.label : "") } : {}) };
      for (const [name, value] of Object.entries(attributes)) {
        changes.push([element, name, element.getAttribute(name)]); element.setAttribute(name, value);
      }
    };
    const blocks = [...root.querySelectorAll("[data-article-block], [data-source-item], [data-node-id]")];
    const actualTargets = new Map(index.byTarget);
    for (const relation of index.byId.values()) {
      const source = relation.source || {};
      const matches = blocks.filter((element) => source.nodeId
        ? element.dataset.nodeId === source.nodeId && (element.dataset.blockId || element.closest("[data-article-block]")?.dataset.articleBlock) === source.blockId
        : source.itemId ? element.dataset.sourceItem === source.itemId : element.dataset.articleBlock === source.blockId);
      for (const element of matches) {
        decorate(element, relation, true);
        if (element.id) actualTargets.set(element.id, relation);
        if (source.nodeId && element.parentElement?.id) actualTargets.set(element.parentElement.id, relation);
      }
    }
    for (const link of root.querySelectorAll("a[href^='#']")) {
      const relation = actualTargets.get(citationHash(link.getAttribute("href")));
      if (relation) decorate(link, relation, false);
    }
    return () => { for (const [element, name, value] of changes.reverse()) value === null ? element.removeAttribute(name) : element.setAttribute(name, value); };
  }, [articleRef, index, renderKey]);

  useEffect(() => { if (disabled || openRef.current && !index.byId.has(openRef.current.id)) close(); }, [disabled, index, close]);
  useEffect(() => close(), [renderKey, close]);
  useEffect(() => () => cancelTimers(), [cancelTimers]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!open.trigger.isConnected) { close(); return; }
      const anchor = open.trigger.getBoundingClientRect();
      const topInset = (document.querySelector(".topbar")?.getBoundingClientRect().bottom || 56) + 8;
      if (anchor.bottom < topInset || anchor.top > window.innerHeight) { close(); return; }
      const panel = panelRef.current?.getBoundingClientRect() || {};
      setPosition(referencePreviewPosition(anchor, panel, { width: window.innerWidth, height: window.innerHeight }, topInset));
    };
    update();
    if (open.pinned) panelRef.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(update);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { passive: true });
    return () => { observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update); };
  }, [open, close]);
  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (panelRef.current?.contains(event.target) || open.trigger.contains(event.target)) return;
      close();
    };
    const key = (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" || isCloseShortcut?.(event)) { event.preventDefault(); event.stopImmediatePropagation(); close(open.pinned || panelRef.current?.contains(document.activeElement)); }
    };
    const selection = () => {
      const selected = window.getSelection();
      if (selected && !selected.isCollapsed && articleRef.current?.contains(selected.anchorNode)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("selectionchange", selection);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", key, true); document.removeEventListener("selectionchange", selection); };
  }, [open, close, articleRef, isCloseShortcut]);

  const hit = (event, allowSelection = false) => {
    if (disabled || event.buttons || !allowSelection && window.getSelection()?.isCollapsed === false) return null;
    const target = event.target.closest?.("[data-reference-id]");
    if (!target || !articleRef.current?.contains(target)) return null;
    if (event.target.closest?.("button, input, textarea, select")) return null;
    const link = event.target.closest?.("a");
    // A highlighted citation remains a citation link. Ordinary highlighted
    // prose still belongs to the insight interaction.
    if (event.target.closest?.("[data-insight-id]") && link !== target) return null;
    if (link && link !== target) return null;
    return target;
  };
  const articleEvents = {
    onPointerOver(event) {
      const trigger = hit(event);
      if (!trigger || event.relatedTarget instanceof Node && trigger.contains(event.relatedTarget)) return;
      cancelTimers();
      enterTimer.current = setTimeout(() => show(trigger), 240);
    },
    onPointerOut(event) { const trigger = event.target.closest?.("[data-reference-id]"); if (trigger && !(event.relatedTarget instanceof Node && trigger.contains(event.relatedTarget))) leave(); },
    onFocus(event) { if (restoringFocus.current) return; const trigger = hit(event, true); if (trigger) show(trigger); },
    onBlur(event) { if (!panelRef.current?.contains(event.relatedTarget)) leave(); },
    onKeyDown(event) {
      if (event.isComposing || event.keyCode === 229 || !["Enter", " "].includes(event.key)) return;
      const trigger = hit(event, true);
      if (trigger && event.target === trigger) { event.preventDefault(); event.stopPropagation(); show(trigger, true); }
    },
  };
  const interceptClick = (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
    const trigger = hit(event);
    if (!trigger) return false;
    event.preventDefault(); show(trigger, true); return true;
  };
  return { open, relation: index.byId.get(open?.id), panelRef, position, close, keepOpen, leave, articleEvents, interceptClick,
    pin: () => { if (openRef.current && !openRef.current.pinned) show(openRef.current.trigger, true); } };
}
