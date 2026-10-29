import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { IconStyleProvider } from "./icons.jsx";
import { WorkspaceLoadingShell, WorkspacePageBoundary } from "./WorkspaceLoading.jsx";
import { loadWithNavigation } from "./workspace-loaders.js";
import { DesktopChrome } from "./DesktopChrome.jsx";
import { installDevelopmentState } from "./development-state.js";
import { ContinuousMotion } from "./Motion.jsx";
import "./styles.css";

// Dispatch before loading/mounting the workspace shell. Preview navigation must
// not trigger workspace polling, legacy imports or formal reading checkpoints.
const query = new URLSearchParams(window.location.search);
const preview = query.has("preview") || query.has("draft");
const iconPreview = !preview && query.has("icon-preview");
if (import.meta.hot && !preview && !iconPreview) installDevelopmentState(import.meta.hot, window);
const Entry = preview
  ? lazy(() => import("./PreviewHost.jsx").then((module) => ({ default: module.PreviewHost })))
  : iconPreview
  ? lazy(() => import("./IconGallery.jsx").then((module) => ({ default: module.IconGallery })))
  : lazy(() => loadWithNavigation(() => import("./WorkspaceApp.jsx")).then((module) => ({ default: module.WorkspaceApp })));

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DesktopChrome />
    <ContinuousMotion><IconStyleProvider persist={!preview}>
      <WorkspacePageBoundary routeKey="entry"><Suspense fallback={preview || iconPreview ? <main className="paper-loading" aria-live="polite">正在打开…</main> : <WorkspaceLoadingShell page={query.get("view")} />}><Entry {...(preview ? { previewId: query.get("preview"), draftId: query.get("draft") } : {})} /></Suspense></WorkspacePageBoundary>
    </IconStyleProvider></ContinuousMotion>
  </React.StrictMode>,
);
