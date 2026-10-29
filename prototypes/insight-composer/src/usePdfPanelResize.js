import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { captureReadingPosition, restoreReadingPosition } from "./reading-position";
import { useReaderRuntime } from "./ReaderRuntime";
import { pdfPanelBounds, pdfPanelWidthForKey, resolvePdfPanelWidth } from "./pdf-panel-width";

export function usePdfPanelResize({ open, articleRef, pinnedToc, ownership }) {
  const runtime = useReaderRuntime();
  const anchor = useRef(null), drag = useRef(null), releaseFrame = useRef(0);
  const current = useRef(null);
  const [bounds, setBounds] = useState(() => pdfPanelBounds(document.body.getBoundingClientRect().width || document.documentElement.clientWidth));
  const [dragWidth, setDragWidth] = useState(null);
  const [resizing, setResizing] = useState(false);
  const { percent } = useSyncExternalStore(runtime.uiScale.subscribe, runtime.uiScale.getSnapshot);
  const remember = useCallback(() => {
    if (!drag.current) anchor.current = captureReadingPosition(articleRef.current);
  }, [articleRef]);
  const subscribe = useCallback((listener) => runtime.pdfWidth.subscribe(() => {
    if (current.current?.open) {
      remember();
      if (!drag.current) {
        setResizing(true);
        cancelAnimationFrame(releaseFrame.current);
        releaseFrame.current = requestAnimationFrame(() => {
          releaseFrame.current = requestAnimationFrame(() => setResizing(false));
        });
      }
    }
    listener();
  }), [remember, runtime]);
  const preferred = useSyncExternalStore(subscribe, runtime.pdfWidth.getSnapshot);
  const width = resolvePdfPanelWidth(dragWidth ?? preferred, bounds);
  current.current = { open, width, bounds, articleRef, ownership };

  useLayoutEffect(() => {
    const measure = () => {
      const root = articleRef.current?.closest(".reader-app");
      const navigation = pinnedToc ? root?.querySelector(".toc")?.getBoundingClientRect().width || 0 : 0;
      // The document viewport can include its stable scrollbar gutter. Use the
      // actual layout width so that gutter is not taken from the reading column.
      const availableWidth = root?.getBoundingClientRect().width || document.body.getBoundingClientRect().width || document.documentElement.clientWidth;
      const next = pdfPanelBounds(availableWidth, navigation);
      setBounds((previous) => previous.min === next.min && previous.max === next.max && previous.defaultWidth === next.defaultWidth ? previous : next);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("reader-ui-scale-change", measure);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener("reader-ui-scale-change", measure); };
  }, [pinnedToc, percent, articleRef]);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    ownership?.programmatic("reader");
    restoreReadingPosition(articleRef.current, anchor.current);
    if (!drag.current) anchor.current = null;
  }, [width, open, resizing, articleRef, ownership]);

  function finish(cancel = false) {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    if (!cancel) runtime.pdfWidth.update(current.current.width);
    setDragWidth(null);
    // Keep the final reflow synchronous, then restore normal panel motion.
    cancelAnimationFrame(releaseFrame.current);
    releaseFrame.current = requestAnimationFrame(() => setResizing(false));
    if (state.element.hasPointerCapture?.(state.pointerId)) state.element.releasePointerCapture(state.pointerId);
  }

  useEffect(() => {
    if (!open) finish(true);
  }, [open]);
  useEffect(() => {
    const cancel = () => finish(true);
    const key = (event) => {
      if (!drag.current || event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); finish(true);
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
      cancelAnimationFrame(releaseFrame.current);
      const state = drag.current;
      drag.current = null;
      if (state?.element.hasPointerCapture?.(state.pointerId)) state.element.releasePointerCapture(state.pointerId);
    };
  }, []);

  function changeWidth(next) {
    remember();
    cancelAnimationFrame(releaseFrame.current);
    setResizing(true);
    runtime.pdfWidth.update(next);
    releaseFrame.current = requestAnimationFrame(() => {
      releaseFrame.current = requestAnimationFrame(() => setResizing(false));
    });
  }
  const separatorProps = {
    role: "separator", tabIndex: open ? 0 : -1, "aria-orientation": "vertical",
    "aria-label": "调整原页面板宽度", "aria-controls": "reader-pdf-panel",
    "aria-valuemin": bounds.min, "aria-valuemax": bounds.max, "aria-valuenow": width,
    "aria-valuetext": `${width} 像素`, "data-resizing": resizing || undefined,
    title: "拖动调整宽度 · 双击还原 · 左右方向键微调",
    onPointerDown(event) {
      if (event.button !== 0 || !event.isPrimary || !open || window.innerWidth <= 850) return;
      event.preventDefault(); event.stopPropagation();
      remember();
      drag.current = { pointerId: event.pointerId, element: event.currentTarget, x: event.clientX, width };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus({ preventScroll: true });
      cancelAnimationFrame(releaseFrame.current);
      setDragWidth(width); setResizing(true);
    },
    onPointerMove(event) {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      setDragWidth(Math.max(current.current.bounds.min, Math.min(current.current.bounds.max, state.width + state.x - event.clientX)));
    },
    onPointerUp(event) {
      if (event.pointerId !== drag.current?.pointerId) return;
      event.preventDefault(); event.stopPropagation(); finish();
    },
    onPointerCancel() { finish(true); },
    onLostPointerCapture() { finish(true); },
    onDoubleClick(event) { event.preventDefault(); event.stopPropagation(); changeWidth(null); },
    onKeyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const next = pdfPanelWidthForKey(event.key, width, bounds, event.shiftKey);
      if (next === null) return;
      event.preventDefault(); event.stopPropagation(); changeWidth(next);
    },
  };
  return { width, resizing, separatorProps };
}
