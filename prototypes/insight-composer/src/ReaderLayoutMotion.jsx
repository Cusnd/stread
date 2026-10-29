import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { animate, motionValue } from "motion";
import { motionTransition } from "./motion-system.js";
import { useReducedMotionPreference } from "./useReducedMotionPreference.js";
import { useReaderRuntime } from "./ReaderRuntime";

// Reflow the real article, retaining spring values when its destination changes.
// The rail and reading anchor wait for actual completion, not a timer.
export function ReaderLayoutMotion({ tocDocked, marginVisible, tool, readingWidthPercent, resizing, panelWidth }) {
  const runtime = useReaderRuntime();
  const { percent } = useSyncExternalStore(runtime.uiScale.subscribe, runtime.uiScale.getSnapshot);
  const reduced = useReducedMotionPreference();
  const owner = useRef(null);
  const latest = useRef(null);
  latest.current = { tocDocked, marginVisible, tool, readingWidthPercent, resizing, reduced };
  useLayoutEffect(() => {
    const root = document.querySelector(".reader-app");
    const main = root?.querySelector(".reader-main");
    const layout = root?.querySelector(".reading-layout");
    if (!root || !main || !layout) return;
    root.dataset.readerLayoutMotion = "true";
    const slots = {
      left: [main, "margin-left", "px"], right: [main, "margin-right", "px"],
      paddingLeft: [main, "padding-left", "px"], paddingRight: [main, "padding-right", "px"],
      margin: [layout, "--layout-margin-width", "px"], gap: [layout, "--layout-reading-gap", "px"],
      ratio: [layout, "--layout-reading-ratio", ""],
    };
    const values = Object.fromEntries(Object.keys(slots).map((key) => [key, motionValue(0)]));
    const unsubscribers = Object.entries(values).map(([key, value]) => value.on("change", (next) => {
      const [element, property, unit] = slots[key];
      element.style.setProperty(property, next + unit);
    }));
    let initialized = false, generation = 0, previous = null, controls = [];
    function update() {
      const options = latest.current;
      const style = getComputedStyle(root);
      const wide = window.innerWidth > 850;
      const oldPadding = [main.style.paddingLeft, main.style.paddingRight];
      main.style.removeProperty("padding-left"); main.style.removeProperty("padding-right");
      const mainStyle = getComputedStyle(main);
      const paddingLeft = parseFloat(mainStyle.paddingLeft), paddingRight = parseFloat(mainStyle.paddingRight);
      main.style.paddingLeft = oldPadding[0]; main.style.paddingRight = oldPadding[1];
      const target = {
        left: options.tocDocked && wide ? root.querySelector(".toc")?.offsetWidth || 0 : 0,
        right: !wide ? 0 : options.tool === "pdf" ? root.querySelector(".pdf-drawer")?.offsetWidth || 0 : ["sidebar", "glossary"].includes(options.tool) ? root.querySelector(".insights-drawer")?.offsetWidth || 0 : 0,
        margin: options.marginVisible ? parseFloat(style.getPropertyValue("--margin-width")) || 0 : 0,
        gap: options.marginVisible ? parseFloat(style.getPropertyValue("--reading-gap")) || 0 : 0,
        ratio: options.readingWidthPercent / 100,
        paddingLeft, paddingRight,
      };
      if (initialized && !options.resizing && !options.reduced && Object.keys(target).every((key) => target[key] === previous[key])) return;
      const current = ++generation;
      previous = target;
      if (!initialized || options.resizing || options.reduced) {
        for (const [key, next] of Object.entries(target)) {
          values[key].jump(next);
          const [element, property, unit] = slots[key];
          element.style.setProperty(property, next + unit);
        }
        initialized = true;
        delete root.dataset.layoutMoving;
        return;
      }
      root.dataset.layoutMoving = "true";
      controls = Object.entries(target).map(([key, next]) => animate(values[key], next, {
        ...motionTransition("layout"),
        ...(key === "ratio" ? { restDelta: 0.0005, restSpeed: 0.005 } : {}),
      }));
      Promise.all(controls).then(() => {
        if (current === generation) delete root.dataset.layoutMoving;
      }, () => {});
    }
    owner.current = { update };
    update();
    const observer = new ResizeObserver(update);
    for (const selector of [".toc", ".insights-drawer", ".pdf-drawer"]) {
      const element = root.querySelector(selector);
      if (element) observer.observe(element);
    }
    window.addEventListener("resize", update);
    window.addEventListener("reader-ui-scale-change", update);
    return () => {
      ++generation;
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("reader-ui-scale-change", update);
      controls.forEach((control) => control.stop());
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      Object.values(values).forEach((value) => value.destroy());
      Object.values(slots).forEach(([element, property]) => element.style.removeProperty(property));
      delete root.dataset.layoutMoving;
      delete root.dataset.readerLayoutMotion;
      owner.current = null;
    };
  }, []);
  useLayoutEffect(() => { owner.current?.update(); }, [tocDocked, marginVisible, tool, readingWidthPercent, resizing, panelWidth, percent, reduced]);
  return null;
}
