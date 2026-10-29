import { useLayoutEffect, useRef, useState } from "react";

// Fit one complete page to the pane. Magnification adds user-controlled panning;
// a new source highlight never changes the page's position within the viewport.
export function usePdfPageView(scroller, open, page, zoom) {
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const center = useRef({ x: .5, y: .5 });
  const displayedPage = useRef(null);
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!open || !root) return;
    const measure = () => setViewport((previous) => {
      const next = { width: root.clientWidth, height: root.clientHeight };
      return next.width === previous.width && next.height === previous.height ? previous : next;
    });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [open, scroller]);
  const scale = page && viewport.width && viewport.height
    ? Math.max(0, Math.min((viewport.width - 32) / page.width, (viewport.height - 32) / page.height)) * zoom : 0;
  const width = (page?.width || 0) * scale, height = (page?.height || 0) * scale;
  const stageWidth = Math.max(viewport.width, width + 32), stageHeight = Math.max(viewport.height, height + 32);
  function captureCenter() {
    const root = scroller.current;
    // Candidate refresh temporarily removes the page. Ignore the resulting
    // scroll reset so the same source page can restore its previous pan center.
    if (root && page) center.current = {
      x: (root.scrollLeft + root.clientWidth / 2) / Math.max(1, root.scrollWidth),
      y: (root.scrollTop + root.clientHeight / 2) / Math.max(1, root.scrollHeight),
    };
  }
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!open || !root || !scale) return;
    if (displayedPage.current !== page?.page) center.current = { x: .5, y: .5 };
    displayedPage.current = page?.page;
    root.scrollTo({ left: center.current.x * stageWidth - root.clientWidth / 2,
      top: center.current.y * stageHeight - root.clientHeight / 2, behavior: "instant" });
    captureCenter();
  }, [open, page?.page, stageWidth, stageHeight, scale, scroller]);
  return { width, height, stageWidth, stageHeight, captureCenter };
}
