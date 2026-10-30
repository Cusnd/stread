import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ContinuousMotion } from "../../src/Motion.jsx";
import { ReaderRuntimeProvider } from "../../src/ReaderRuntime.jsx";
import { createPreviewReaderRuntime } from "../../src/reader-runtime.js";
import { ReaderInterfaceScale } from "../../src/InterfaceScale.jsx";
import { WorkspaceHeader } from "../../src/workspace/WorkspaceHeader.jsx";
import { CollectionPage } from "../../src/workspace/CollectionPage.jsx";
import { FlowPage } from "../../src/workspace/FlowPage.jsx";
import { QueuePage } from "../../src/workspace/QueuePage.jsx";
import { WorkspacePagePlaceholder } from "../../src/WorkspaceLoading.jsx";
import { WorkspaceSettings } from "../../src/WorkspaceSettings.jsx";
import { useMedia } from "../../src/workspace/shared.jsx";
import { matchesShortcut } from "../../src/reading-shortcuts.js";
import { getSnapshot, subscribe } from "../../src/navigation-loading.js";
import "../../src/styles.css";
import "../../src/workspace-shell.css";

const params = new URLSearchParams(location.search);
const runtime = createPreviewReaderRuntime("workspace-design-system", { uiScale: { percent: Number(params.get("scale") || 80) } });
const workspace = {
  revision: 1, planVersion: 1, collections: [], planIds: ["document-1"],
  documents: Array.from({ length: 40 }, (_, index) => ({ id: `document-${index + 1}`, title: `Synthetic reading material ${index + 1}`, kind: "论文", status: "unread", tags: [], collectionIds: [], version: 1 })),
};
window.workspaceDesign = { loadingEvents: [], loadingSnapshot: getSnapshot };
subscribe(() => window.workspaceDesign.loadingEvents.push(getSnapshot()));

function Fixture() {
  const { percent } = useSyncExternalStore(runtime.uiScale.subscribe, runtime.uiScale.getSnapshot);
  const compact = useMedia(`(max-width: ${640 * percent / 80}px)`);
  const [page, setPage] = useState(params.get("page") || "collection");
  const [loading, setLoading] = useState(params.get("loading") === "1");
  const [desktopNavigation, setDesktopNavigation] = useState(true);
  const [temporaryNavigation, setTemporaryNavigation] = useState(false);
  const [reader, setReader] = useState(null);
  const [settings, setSettings] = useState(false);
  const settingsTrigger = useRef(null);
  const [views, setViews] = useState({ collection: {}, flow: { section: "overview", panelWidth: 420 }, queue: { type: "conversion", status: "pending" } });
  const current = useRef(null);
  current.current = { page, loading, desktopNavigation, temporaryNavigation, reader, views, compact };
  useEffect(() => { setTemporaryNavigation(false); }, [page, compact]);
  useEffect(() => {
    const onKey = (event) => {
      if (event.defaultPrevented || !matchesShortcut(event, "settings", runtime.shortcuts.getSnapshot())) return;
      event.preventDefault();
      if (!settings) settingsTrigger.current = document.activeElement;
      setSettings((current) => !current);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settings]);
  const navigationExpanded = compact ? temporaryNavigation : desktopNavigation;
  const updateView = (next) => {
    if (typeof next.navigationExpanded === "boolean") {
      if (compact) setTemporaryNavigation(next.navigationExpanded);
      else setDesktopNavigation(next.navigationExpanded);
    }
    const { navigationExpanded: ignored, ...saved } = next;
    setViews((previous) => ({ ...previous, [page]: saved }));
  };
  Object.assign(window.workspaceDesign, {
    setPage, setLoading, setScale: runtime.uiScale.update,
    setView: (target, patch) => setViews((previous) => ({ ...previous, [target]: { ...previous[target], ...patch } })),
    getState: () => current.current,
  });
  const view = { ...views[page], navigationExpanded };
  const command = async () => { throw new Error("Read-only synthetic fixture"); };
  const openDocument = async (id) => setReader(id);
  return <><div className="workspace-app" inert={settings}><ReaderInterfaceScale />
    {reader ? <button type="button" onClick={() => setReader(null)}>返回工作区</button> : <>
      <WorkspaceHeader page={page} onNavigate={setPage} onSettings={(event) => { settingsTrigger.current = event.currentTarget; setSettings(true); }} onReference={() => {}} onReview={() => {}} onImport={page === "collection" ? () => {} : undefined} onAddTask={page === "queue" ? () => {} : undefined} navigationExpanded={navigationExpanded} onToggleNavigation={() => compact ? setTemporaryNavigation((value) => !value) : setDesktopNavigation((value) => !value)} />
      {loading ? <WorkspacePagePlaceholder page={page} view={view} navigationExpanded={navigationExpanded} /> : page === "collection" ? <CollectionPage workspace={workspace} view={view} setView={updateView} command={command} openDocument={openDocument} onImport={() => {}} /> : page === "flow" ? <FlowPage workspace={workspace} view={view} setView={updateView} command={command} openDocument={openDocument} overlayActive={settings} /> : <QueuePage workspace={workspace} view={view} setView={updateView} command={command} openDocument={openDocument} />}
    </>}
  </div><WorkspaceSettings open={settings} returnFocusRef={settingsTrigger} onClose={() => setSettings(false)} /></>;
}

createRoot(document.getElementById("root")).render(<React.StrictMode><ReaderRuntimeProvider value={runtime}><ContinuousMotion><Fixture /></ContinuousMotion></ReaderRuntimeProvider></React.StrictMode>);
