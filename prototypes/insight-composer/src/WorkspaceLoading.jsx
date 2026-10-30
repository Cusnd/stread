import { Component, useEffect, useSyncExternalStore } from "react";
import { WorkspaceHeader } from "./workspace/WorkspaceHeader.jsx";
import { ArticleNotesHeader } from "./notes/ArticleNotesHeader.jsx";
import { ReaderInterfaceScale } from "./InterfaceScale.jsx";
import { useReaderRuntime } from "./ReaderRuntime.jsx";
import { UI_SCALE_BASE } from "./ui-scale.js";
import { useMedia } from "./workspace/shared.jsx";
import { getServerWorkspaceNavigationSnapshot, getWorkspaceNavigationSnapshot, migrateWorkspaceNavigation, subscribeWorkspaceNavigation } from "./workspace-navigation.js";
import "./workspace/workspace.css";
import "./workspace-loading.css";

const noop = () => {};

export function WorkspacePagePlaceholder({ page = "collection", navigationExpanded = true }) {
  const runtime = useReaderRuntime();
  const { percent } = useSyncExternalStore(runtime.uiScale.subscribe, runtime.uiScale.getSnapshot);
  const scale = percent / UI_SCALE_BASE;
  const condensed = useMedia(`(max-width: ${1100 * scale}px)`);
  const compactDetails = useMedia(`(max-width: ${980 * scale}px)`);
  const compactNavigation = useMedia(`(max-width: ${640 * scale}px)`);
  return <main className={"workspace-ui workspace-page-placeholder" + (condensed ? " workspace-condensed-layout" : "") + (page === "collection" && compactDetails ? " workspace-compact-details" : "") + (page === "collection" && compactNavigation ? " workspace-compact-navigation" : "") + (!navigationExpanded ? " is-navigation-collapsed" : "")} data-page={page} aria-busy="true" aria-label="正在加载页面">
    <aside aria-hidden="true" />
    <div aria-hidden="true" />
    <div aria-hidden="true" />
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
    return <main className="workspace-module-error"><p role="alert">页面暂时未能载入。</p><button type="button" onClick={() => window.location.reload()}>重新加载</button></main>;
  }
}
