import { useLayoutEffect } from "react";
import { getDesktopControlsWidth, hasDesktopTitlebar, observeDesktopHeader } from "./desktop-chrome.js";
import "./desktop-chrome.css";

export function DesktopChrome() {
  useLayoutEffect(() => {
    if (!hasDesktopTitlebar(window.continuousReaderDesktop)) return;
    const root = document.documentElement;
    const overlay = navigator.windowControlsOverlay;
    const update = () => {
      const width = getDesktopControlsWidth({ overlay, viewportWidth: window.innerWidth, fullscreen: Boolean(document.fullscreenElement) });
      root.style.setProperty("--desktop-controls-width", `${width}px`);
      root.style.setProperty("--desktop-viewport-width", `${window.innerWidth}px`);
      root.dataset.desktopTitlebar = "windows";
      root.dataset.desktopControls = width ? "visible" : "hidden";
    };
    update();
    overlay?.addEventListener("geometrychange", update);
    window.addEventListener("resize", update);
    document.addEventListener("fullscreenchange", update);
    return () => {
      overlay?.removeEventListener("geometrychange", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("fullscreenchange", update);
      delete root.dataset.desktopTitlebar;
      delete root.dataset.desktopControls;
      root.style.removeProperty("--desktop-controls-width");
      root.style.removeProperty("--desktop-viewport-width");
    };
  }, []);
  return null;
}

export function useDesktopHeader(headerRef) {
  useLayoutEffect(() => observeDesktopHeader(headerRef.current, window.continuousReaderDesktop), [headerRef]);
}
