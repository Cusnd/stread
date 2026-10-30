import { Component, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { WorkspaceHeader } from "./workspace/WorkspaceHeader.jsx";
import { ArticleNotesHeader } from "./notes/ArticleNotesHeader.jsx";
import { ReaderInterfaceScale } from "./InterfaceScale.jsx";
import { useReaderRuntime } from "./ReaderRuntime.jsx";
import { UI_SCALE_BASE } from "./ui-scale.js";
import { useMedia } from "./workspace/shared.jsx";
import { getServerWorkspaceNavigationSnapshot, getWorkspaceNavigationSnapshot, migrateWorkspaceNavigation, subscribeWorkspaceNavigation } from "./workspace-navigation.js";
import { flowPanelLayout, WORKSPACE_COMPACT_NAVIGATION_WIDTH, WORKSPACE_NAVIGATION_WIDTH } from "./workspace/workspace-layout.js";
import "./workspace/workspace.css";
import "./workspace/flow.css";
import "./workspace-loading.css";

const noop = () => {};

export function WorkspacePagePlaceholder({ page = "collection", navigationExpanded = true, view = {} }) {
  const runtime = useReaderRuntime();
  const { percent } = useSyncExternalStore(runtime.uiScale.subscribe, runtime.uiScale.getSnapshot);
  const scale = percent / UI_SCALE_BASE;
  const condensed = useMedia(`(max-width: ${1100 * scale}px)`);
  const compactDetails = useMedia(`(max-width: ${980 * scale}px)`);
  const compactNavigation = useMedia(`(max-width: ${WORKSPACE_COMPACT_NAVIGATION_WIDTH * scale}px)`);
  const navWidth = !compactNavigation && navigationExpanded ? WORKSPACE_NAVIGATION_WIDTH * scale : 0;
  const contentRef = useRef(null);
  const [contentWidth, setContentWidth] = useState(() => (globalThis.document?.body?.clientWidth || globalThis.innerWidth) - navWidth);
  useLayoutEffect(() => {
    if (!contentRef.current) return;
    setContentWidth(contentRef.current.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setContentWidth(entry.contentRect.width));
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [page]);
  const section = ["overview", "insights", "plan", "history"].includes(view.section) ? view.section : "overview";
  const flow = flowPanelLayout({ ...view, section, scale, availableWidth: contentWidth, viewportWidth: globalThis.innerWidth });
  const columns = `${navWidth}px minmax(0, 1fr)${page === "collection" && !compactDetails ? ` ${(condensed ? 286 : 306) * scale}px` : ""}`;
  return <main className={"workspace-ui workspace-page-placeholder" + (condensed ? " workspace-condensed-layout" : "") + (compactNavigation ? " workspace-placeholder-compact" : "")} style={{ gridTemplateColumns: columns }} data-page={page} aria-busy="true" aria-label="正在加载页面">
    <aside className="workspace-placeholder-navigation" aria-hidden="true" />
    {page === "flow" ? <section ref={contentRef} aria-hidden="true" className={"flow-workspace workspace-flow-placeholder-content" + (flow.sideRail ? " flow-has-rail" : "") + (flow.compact ? " flow-compact-content" : "") + (condensed ? " flow-condensed-layout" : "") + (section === "overview" ? " flow-overview-workspace" : "")} style={{ gridTemplateColumns: flow.columns, "--flow-rail-width": flow.railWidth + "px" }}>
      {section === "overview" && <><div className="workspace-catalog-heading flow-page-heading flow-overview-heading" /><div className="flow-week" /></>}
      <div className="workspace-catalog flow-main" />
      <div className="flow-panel-resize" style={{ visibility: "hidden" }} />
      <aside className="flow-rail" aria-hidden={!flow.sideRail && !flow.stacked || undefined} />
    </section> : <div aria-hidden="true" />}
    {page === "collection" && !compactDetails && <div aria-hidden="true" />}
  </main>;
}

export function WorkspaceLoadingShell({ page = "collection" }) {
  const visiblePage = ["flow", "queue"].includes(page) ? page : "collection";
  const { navigationExpanded } = useSyncExternalStore(subscribeWorkspaceNavigation, getWorkspaceNavigationSnapshot, getServerWorkspaceNavigationSnapshot);
  useEffect(() => { migrateWorkspaceNavigation(); }, []);
  if (page === "notes") return <div className="workspace-app article-notes-page"><ReaderInterfaceScale /><ArticleNotesHeader title="" /><main className="article-notes-layout" aria-busy="true" aria-label="正在加载笔记"><aside className="article-notes-sidebar" /><section className="article-notes-content" /></main></div>;
  return <div className="workspace-app">
    <ReaderInterfaceScale />
    <WorkspaceHeader page={visiblePage} loading navigationExpanded={navigationExpanded} onToggleNavigation={noop} onSettings={noop} onReference={noop} onReview={noop} onImport={visiblePage === "collection" ? noop : undefined} onAddTask={visiblePage === "queue" ? noop : undefined} />
    <WorkspacePagePlaceholder page={visiblePage} navigationExpanded={navigationExpanded} />
  </div>;
}

export class WorkspacePageBoundary extends Component {
  state = { error: null, routeKey: this.props.routeKey };
  static getDerivedStateFromError(error) { return { error }; }
  static getDerivedStateFromProps(props, state) { return props.routeKey !== state.routeKey ? { error: null, routeKey: props.routeKey } : null; }
  render() {
    if (!this.state.error) return this.props.children;
    return <main className="workspace-module-error"><p role="alert">页面暂时未能载入。</p><button type="button" className="ui-button" data-ui-button="entry" onClick={() => window.location.reload()}>重新加载</button></main>;
  }
}
