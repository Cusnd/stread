// Isolated visual fixture: no workspace, saved profile or reading activity.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Reader } from "../../src/App.jsx";
import { createPreviewReaderRuntime } from "../../src/reader-runtime.js";
import { ContinuousMotion } from "../../src/Motion.jsx";
import { IconStyleProvider } from "../../src/icons.jsx";
import { WorkspaceHeader } from "../../src/workspace/WorkspaceHeader.jsx";
import { WorkspacePagePlaceholder } from "../../src/WorkspaceLoading.jsx";
import { DesktopChrome } from "../../src/DesktopChrome.jsx";
import { commitPageMotion, stopPageMotion } from "../../src/page-motion.js";
import { prepareReaderDocument } from "../../src/html-content.js";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
if (params.has("baseline")) {
  const style = document.createElement("style");
  style.textContent = ".reader-app { view-transition-name: none !important; } .reader-main { view-transition-name: reader-content !important; }";
  document.head.append(style);
}
if (params.has("desktop")) {
  window.continuousReaderDesktop = { platform: "win32", titleBarOverlay: true, setTitlebarHeight() {} };
  Object.defineProperty(navigator, "windowControlsOverlay", { configurable: true, value: {
    visible: true, getTitlebarAreaRect: () => ({ x: 0, width: innerWidth - 138 }),
    addEventListener() {}, removeEventListener() {},
  } });
}
const runtime = createPreviewReaderRuntime("reader-opening", { uiScale: { percent: Number(params.get("scale")) || 80 }, view: { tocMode: params.has("unpinned") ? "hidden" : "pinned", showMargins: false } });
runtime.mode = "fixture";
runtime.capabilities.glossary = true;
const paper = await prepareReaderDocument(await fetch("/articles/attention-is-all-you-need/document.json").then((response) => response.json()));
paper.assetBase = "/articles/attention-is-all-you-need/";
// Freeze actual browser snapshots for inspection without changing product CSS.
const nativeAnimate = Element.prototype.animate;
const nativeTransition = document.startViewTransition;
if (params.has("freeze")) {
  Element.prototype.animate = function (...args) {
    const animation = nativeAnimate.apply(this, args);
    if (params.has("mode-only") && this.matches(".article")) { animation.pause(); animation.currentTime = Number(params.get("freeze")); }
    return animation;
  };
  const start = document.startViewTransition.bind(document);
  document.startViewTransition = (...args) => {
    const transition = start(...args);
    const freeze = !params.has("mode-only") || document.documentElement.dataset.pageMotionScope === "reader-content";
    transition.ready.then(() => freeze && document.getAnimations().filter((animation) => animation.effect?.pseudoElement?.startsWith("::view-transition")).forEach((animation) => {
      animation.pause(); animation.currentTime = Number(params.get("freeze"));
    })).catch(() => {});
    return transition;
  };
}
function Fixture() {
  const [opened, setOpened] = useState(false);
  const navigate = (next) => commitPageMotion(() => flushSync(() => setOpened(next)), { scope: params.has("baseline") ? "page" : "reader-page" });
  return <><DesktopChrome />{opened ? <Reader paper={paper} runtime={runtime} insightItems={[]} initialReadingState={params.has("restore") ? { blockId: params.get("restore") || "S3", offsetRatio: 0, mode: "bilingual" } : null} onBack={() => navigate(false)} /> : <div className="workspace-app"><WorkspaceHeader /><WorkspacePagePlaceholder /><button style={{ position: "fixed", top: 100, left: 300, zIndex: 40 }} onClick={() => navigate(true)}>打开验证文章</button></div>}</>;
}
const root = createRoot(document.getElementById("root"));
root.render(<React.StrictMode><ContinuousMotion><IconStyleProvider persist={false}><Fixture /></IconStyleProvider></ContinuousMotion></React.StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => {
  stopPageMotion();
  root.unmount();
  Element.prototype.animate = nativeAnimate;
  document.startViewTransition = nativeTransition;
});
