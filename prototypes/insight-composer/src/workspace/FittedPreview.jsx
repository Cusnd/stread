import { useLayoutEffect, useRef, useState } from "react";

/** Fill a bounded parent by default; maxHeight instead budgets a content-sized prefix. */
export function FittedPreview({ items = [], maxItems = 5, maxHeight, itemSelector = "[data-fitted-item]", className = "", children }) {
  const rootRef = useRef(null);
  const measureRef = useRef(null);
  const limit = Math.max(0, Number.isFinite(maxItems) ? Math.floor(maxItems) : 5);
  const heightLimit = Number.isFinite(maxHeight) ? Math.max(0, maxHeight) : null;
  const candidates = items.slice(0, limit);
  const [fit, setFit] = useState({ count: candidates.length, height: 0 });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const content = measureRef.current;
    if (!root || !content) return;
    let frame = 0;
    let active = true;
    const measure = () => {
      frame = 0;
      if (!active) return;
      // Never derive a content-sized budget from the previous visible prefix.
      const available = heightLimit ?? root.clientHeight;
      const top = content.getBoundingClientRect().top;
      let fitting = 0;
      let height = 0;
      if (available > 0) {
        for (const item of content.querySelectorAll(itemSelector)) {
          const bottom = item.getBoundingClientRect().bottom - top;
          if (fitting >= Math.min(items.length, limit) || bottom > available) break;
          fitting += 1;
          height = Math.max(height, bottom);
        }
      }
      const fittedHeight = heightLimit === null ? 0 : Math.min(available, Math.ceil(height));
      setFit((current) => current.count === fitting && current.height === fittedHeight ? current : { count: fitting, height: fittedHeight });
    };
    const schedule = () => {
      if (!active || frame) return;
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    observer.observe(content);
    measure();
    return () => {
      active = false;
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [items, limit, heightLimit, itemSelector, children]);

  return <div ref={rootRef} className={"flow-fitted-preview" + (className ? " " + className : "")} style={heightLimit === null ? undefined : { height: fit.height, flex: "0 0 auto" }}>
    <div className="flow-fitted-preview-content">{children(candidates.slice(0, fit.count), { measurement: false })}</div>
    <div ref={measureRef} className="flow-fitted-preview-measurement" aria-hidden="true" inert>
      {children(candidates, { measurement: true })}
    </div>
  </div>;
}
