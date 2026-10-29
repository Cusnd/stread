import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { normalizeObjectPreferences, objectPreferencesKey, objectWidth } from "./object-preferences";
import { useReaderRuntime } from "./ReaderRuntime";
import { animate, motionValue } from "motion";
import { motion } from "motion/react";
import { motionTransition } from "./motion-system.js";
import { useReducedMotionPreference } from "./useReducedMotionPreference.js";
import { useContextMenu } from "./ContextMenu.jsx";
import { ArrowsInSimple, ArrowsOutSimple, Crosshair, SlidersHorizontal } from "./icons";
import { captureArticleSelection, selectionContextHit } from "./reader-context-selection.js";

const ObjectSession = createContext(null);
const ObjectControls = createContext(null);
export const useObjectControls = () => useContext(ObjectControls);
export function ObjectSizingProvider({ sessionKey, documentId = sessionKey, documentRevision, onLocateSource, onOpenImage, requestMenuItem, children }) {
  const runtime = useReaderRuntime();
  const contextMenu = useContextMenu({ contextKey: `${documentId}:${documentRevision}` });
  const sync = useMemo(() => runtime.objects.createSync({ documentId, sessionKey, documentRevision }), [documentId, sessionKey, documentRevision, runtime]);
  const snapshot = useSyncExternalStore(sync.subscribe, sync.getSnapshot, sync.getSnapshot);
  useEffect(() => sync.start(), [sync]);
  return <ObjectSession.Provider key={sessionKey} value={{ documentId, sessionKey, sync, snapshot, contextMenu, onLocateSource, onOpenImage, requestMenuItem }}>{children}{contextMenu.element}</ObjectSession.Provider>;
}

// Width and typography are independent view preferences; source DOM and addresses stay intact.
export function ObjectFrame({ as: Tag = "figure", block, label, className = "", children, ...attributes }) {
  const runtime = useReaderRuntime();
  const session = useContext(ObjectSession), sessionKey = session?.sessionKey;
  const root = useRef(null), drag = useRef(null), imageCap = useRef(null);
  const preferencesRef = useRef(null), savedScrolls = useRef(null);
  const [preferences, setPreferences] = useState(() => session?.snapshot.objects[block.id] || runtime.objects.read(sessionKey, block.id));
  const { fontSize: bodyFontSize } = useSyncExternalStore(runtime.reading.subscribe, runtime.reading.getSnapshot, runtime.reading.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  const [sizePanelOpen, setSizePanelOpen] = useState(false);
  const contextSelection = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [bounds, setBounds] = useState({ base: 0, min: 0, max: 0, offset: 0 });
  preferencesRef.current = preferences;
  const width = objectWidth(preferences, bounds, expanded);
  const reduced = useReducedMotionPreference();
  const widthMotion = useMemo(() => motionValue(0), []);
  const widthOwner = useRef({ initialized: false, generation: 0 });
  const MotionTag = motion[Tag];
  useLayoutEffect(() => {
    if (!Number.isFinite(width)) return;
    const current = ++widthOwner.current.generation;
    const settle = () => { if (current === widthOwner.current.generation) restoreScrolls(); };
    if (!widthOwner.current.initialized || dragging || reduced || root.current?.closest("[data-layout-moving]")) {
      widthMotion.jump(width); widthOwner.current.initialized = true; settle();
    } else {
      animate(widthMotion, width, motionTransition("layout")).then(settle, () => {});
    }
  }, [width, dragging, expanded, reduced, widthMotion]);
  useEffect(() => {
    const unsubscribe = widthMotion.on("change", () => root.current?.dispatchEvent(new CustomEvent("reader-object-size", { bubbles: true })));
    return () => { ++widthOwner.current.generation; unsubscribe(); widthMotion.stop(); };
  }, [widthMotion]);
  function remember(patch, persist = true) {
    const next = { ...preferencesRef.current, ...patch };
    preferencesRef.current = next; setPreferences(next);
    if (persist) {
      if (session) session.sync.update(block.id, patch);
      else runtime.objects.save(sessionKey, block.id, next);
    }
  }
  const syncedPreferences = session?.snapshot.objects[block.id];
  useLayoutEffect(() => {
    if (!dragging && syncedPreferences) { preferencesRef.current = syncedPreferences; setPreferences(syncedPreferences); }
  }, [syncedPreferences, dragging]);
  useEffect(() => {
    if (!runtime.objects.externalStorage) return;
    const update = (event) => {
      if (event.key === objectPreferencesKey(sessionKey) || event.key === objectPreferencesKey(session?.documentId) || event.key === null) {
        if (session) void session.sync.sync();
        else setPreferences(runtime.objects.read(sessionKey, block.id));
      }
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [sessionKey, block.id, session?.sync, runtime]);
  useLayoutEffect(() => {
    const element = root.current, article = element.closest(".article"), main = element.closest(".reader-main");
    if (!article || !main) return;
    function measure() {
      const column = article.getBoundingClientRect(), mainBox = main.getBoundingClientRect();
      if (block.type === "figure" && imageCap.current === null) {
        const media = element.querySelector(".figure-image-link");
        const limit = media ? parseFloat(getComputedStyle(media).maxWidth) : NaN;
        imageCap.current = Number.isFinite(limit) ? limit : Infinity;
      }
      const base = Math.min(column.width, imageCap.current ?? Infinity);
      const offset = block.type === "figure" ? Math.max(0, (column.width - base) / 2) : 0;
      const edge = Math.min(document.documentElement.clientWidth - 20, mainBox.right - parseFloat(getComputedStyle(main).paddingRight));
      const max = Math.max(1, Math.min(base * 4, edge - column.left - offset));
      const next = { base: Math.min(base, max), min: Math.min(160, base, max), max, offset };
      setBounds((old) => Object.keys(next).every((key) => Math.abs(next[key] - old[key]) < .5) ? old : next);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(article); observer.observe(main);
    window.addEventListener("resize", measure);
    window.addEventListener("reader-ui-scale-change", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("reader-ui-scale-change", measure); };
  }, [block.type]);
  useLayoutEffect(() => {
    if (bounds.base && preferences.legacyWidth) {
      const migrated = normalizeObjectPreferences({ widthPercent: preferences.legacyWidth / bounds.base * 100 });
      if (session) session.sync.importLegacy(block.id, migrated);
      else remember({ ...migrated, legacyWidth: undefined });
    }
  }, [bounds.base, preferences.legacyWidth]);
  useLayoutEffect(() => {
    // Fade the rail before the growing surface reaches it. The reader also
    // observes the intermediate geometry and restores notes during contraction.
    root.current?.dispatchEvent(new CustomEvent("reader-object-size", { bubbles: true }));
  }, [width, expanded, dragging, preferences.fontSize, bodyFontSize]);
  function toggle() {
    if (!expanded && !savedScrolls.current) savedScrolls.current = [...root.current.querySelectorAll(".html-table-scroll, .paper-table-scroll")].map((element) => element.scrollLeft);
    setExpanded((value) => !value);
  }
  function restoreScrolls(event) {
    if (event && (event.target !== root.current || event.propertyName !== "width")) return;
    if (!expanded && savedScrolls.current) {
      root.current.querySelectorAll(".html-table-scroll, .paper-table-scroll").forEach((element, index) => { element.scrollLeft = savedScrolls.current[index] || 0; });
      savedScrolls.current = null;
    }
  }
  useLayoutEffect(() => {
    if (!expanded && (window.matchMedia("(prefers-reduced-motion: reduce)").matches || Math.abs(root.current.getBoundingClientRect().width - width) < .5)) restoreScrolls();
  }, [expanded, width]);
  function start(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const actual = root.current.getBoundingClientRect().width;
    drag.current = { x: event.clientX, width: actual, previous: preferences, wasExpanded: expanded };
    savedScrolls.current = null;
    setExpanded(false); remember({ widthPercent: actual / bounds.base * 100 }, false); setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
  }
  function move(event) {
    if (!drag.current) return;
    const value = Math.max(bounds.min, Math.min(bounds.max, drag.current.width + event.clientX - drag.current.x));
    remember({ widthPercent: value / bounds.base * 100 }, false);
  }
  function end(event, cancel = false) {
    const origin = drag.current;
    if (!origin) return;
    drag.current = null; setDragging(false);
    if (cancel) { preferencesRef.current = origin.previous; setPreferences(origin.previous); setExpanded(origin.wasExpanded); }
    else remember({ widthPercent: normalizeObjectPreferences(preferencesRef.current).widthPercent });
    if (Number.isInteger(event.pointerId) && event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keys(event) {
    if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); end(event, true); return; }
    const step = event.shiftKey ? 80 : 20;
    const values = { ArrowLeft: width - step, ArrowRight: width + step, Home: bounds.min, End: bounds.max };
    if (!(event.key in values)) return;
    event.preventDefault(); event.stopPropagation(); setExpanded(false);
    savedScrolls.current = null;
    remember({ widthPercent: Math.max(bounds.min, Math.min(bounds.max, values[event.key])) / bounds.base * 100 });
  }
  function captureSelection(event) {
    contextSelection.current = null;
    if (event.button !== 2) return;
    const snapshot = captureArticleSelection(root.current?.closest(".article"), window.getSelection());
    if (selectionContextHit(snapshot, event.target, event)) contextSelection.current = { snapshot, capturedAt: performance.now() };
  }
  function openContext(event) {
    if (event.defaultPrevented || !session?.contextMenu) return;
    const keyboard = event.type === "keydown";
    const pending = contextSelection.current;
    contextSelection.current = null;
    const selection = captureArticleSelection(root.current?.closest(".article"), window.getSelection());
    // The article owns its original text/math source, even when the selected
    // words happen to be in a table, figure caption, or semantic HTML object.
    if (selectionContextHit(selection, event.target, { keyboard, clientX: event.clientX, clientY: event.clientY })
      || !keyboard && pending && performance.now() - pending.capturedAt < 2000 && selectionContextHit(pending.snapshot, event.target, event)) return;
    if (event.target.closest("button, input, textarea, select, summary, [contenteditable='true'], [role='slider'], [role='separator']")) return;
    if (event.target.closest("[data-insight-id]")) return;
    const link = event.target.closest("a");
    if (link && !link.querySelector("img")) return;
    const image = event.target.closest("img") || [...root.current.querySelectorAll("img")].find((item) => !item.closest("details:not([open])") && item.getClientRects().length);
    const hasSource = block.origin !== "user" && (block.source || []).some((source) => Number.isInteger(source.page) && source.page > 0);
    const requestSource = event.target.closest("[data-block-id]") || [...root.current.querySelectorAll("[data-block-id]")].find((element) => element.getClientRects().length && !element.closest("details:not([open])"));
    const items = [
      ...(image && session.onOpenImage ? [{ id: "open-image", label: "打开大图", icon: ArrowsOutSimple, onSelect: () => session.onOpenImage(image) }] : []),
      { id: "expand", label: expanded ? "收起" : "展开查看", icon: expanded ? ArrowsInSimple : ArrowsOutSimple, disabled: !controls.canExpand, onSelect: toggle },
      { id: "size", label: "调整大小…", icon: SlidersHorizontal, onSelect: () => setSizePanelOpen(true) },
      ...(requestSource && session.requestMenuItem ? [{ ...session.requestMenuItem(requestSource), separatorBefore: true }] : []),
      ...(hasSource && session.onLocateSource ? [{ id: "locate-source", label: "在原页定位", icon: Crosshair, separatorBefore: true, onSelect: () => session.onLocateSource(block.id) }] : []),
    ];
    session.contextMenu.open(event, { id: "object:" + block.id, trigger: root.current, items });
  }
  const controls = { expanded, toggle, width, widthPercent: bounds.base ? Math.round(width / bounds.base * 100) : 100,
    sizePanelOpen, setSizePanelOpen,
    syncStatus: session?.snapshot.status, syncError: session?.snapshot.error, retrySync: session?.sync.sync,
    minPercent: bounds.base ? Math.ceil(bounds.min / bounds.base * 100) : 100,
    maxPercent: bounds.base ? Math.ceil(bounds.max / bounds.base * 100) : 100,
    setWidthPercent: (value) => { savedScrolls.current = null; setExpanded(false); remember({ widthPercent: normalizeObjectPreferences({ widthPercent: value }).widthPercent }); },
    fontSize: preferences.fontSize ?? bodyFontSize, followsBody: preferences.fontSize === null,
    setFontSize: (value) => remember({ fontSize: normalizeObjectPreferences({ fontSize: value }).fontSize }),
    custom: preferences.widthPercent !== null || preferences.fontSize !== null,
    reset: () => { setExpanded(false); remember({ ...normalizeObjectPreferences(), legacyWidth: undefined }); },
    canExpand: bounds.max > objectWidth(preferences, bounds) + 1 || expanded };
  return <ObjectControls.Provider value={controls}>
    <MotionTag {...attributes} ref={root} id={block.id} tabIndex={-1} data-article-block={block.id} className={className + " reader-object"} data-motion-surface="object"
      data-context-active={session?.contextMenu.targetId === "object:" + block.id || undefined} onPointerDownCapture={captureSelection} onContextMenu={openContext} onKeyDown={(event) => { if (!event.isComposing && (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey)) openContext(event); }}
      data-object-ready={bounds.base ? true : undefined} data-object-expanded={expanded || undefined} data-object-dragging={dragging || undefined}
      data-object-target-width={width ?? undefined} style={{ width: width == null ? undefined : widthMotion, marginInlineStart: bounds.offset || undefined,
        "--reader-object-text": preferences.fontSize === null ? "var(--reading-size)" : preferences.fontSize + "px",
        "--reader-caption-text": preferences.fontSize === null ? "var(--reading-size)" : preferences.fontSize + "px" }} onTransitionEnd={restoreScrolls}>
      {children}
      <div className="object-size-edge" aria-hidden="true" />
      <div className="object-resize" role="slider" tabIndex={0} aria-label={label + "宽度"} aria-orientation="horizontal"
        aria-valuemin={Math.round(bounds.min)} aria-valuemax={Math.round(bounds.max)} aria-valuenow={Math.round(width || 0)} aria-valuetext={Math.round(width || 0) + " 像素"}
        title="拖动调整宽度；方向键微调，Shift 加速" onPointerDown={start} onPointerMove={move} onPointerUp={(event) => end(event)} onPointerCancel={(event) => end(event, true)} onLostPointerCapture={(event) => end(event)} onKeyDown={keys}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M4 12 12 4M8 12l4-4" /></svg>
        <span className="object-size-value" aria-hidden="true">{Math.round(width || 0)} px</span>
      </div>
    </MotionTag>
  </ObjectControls.Provider>;
}
