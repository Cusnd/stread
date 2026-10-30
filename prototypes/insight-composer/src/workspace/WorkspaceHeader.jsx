import { useRef } from "react";
import { LayoutGroup } from "motion/react";
import { MotionSelection } from "../Motion.jsx";
import { Books, Hash, List, ListChecks, Plus, SlidersHorizontal } from "../icons";
import { NavigationLoadingLine } from "../NavigationLoadingLine.jsx";
import { useDesktopHeader } from "../DesktopChrome.jsx";

export function WorkspaceHeader({ page = "collection", onNavigate, onPreload, onImport, onAddTask, onReference, onReview, onSettings, pendingCount = 0, onToggleNavigation, navigationExpanded, loading = false }) {
  const headerRef = useRef(null);
  useDesktopHeader(headerRef);
  const navigationLabel = page === "collection" ? "分类" : "导航";
  const contentTarget = page === "queue" ? "#workspace-queue-title" : page === "flow" ? "#workspace-flow-title" : "#workspace-collection-title";
  const contentLabel = page === "queue" ? "跳至任务列表" : page === "flow" ? "跳至 Flow 内容" : "跳至资料列表";
  return <LayoutGroup id="workspace-header"><header ref={headerRef} className="workspace-ui workspace-header" data-page={page} aria-busy={loading || undefined}>
    <a className="workspace-skip-link" href={contentTarget}>{contentLabel}</a>
    <div className="workspace-brand">{onToggleNavigation ? <button type="button" className="workspace-icon-button" disabled={loading} onClick={onToggleNavigation} aria-label={(navigationExpanded ? "收起" : "展开") + navigationLabel} aria-expanded={Boolean(navigationExpanded)} data-focus-key={page + "-navigation-toggle"}><List size={18} /></button> : <Books size={18} aria-hidden="true" />}<span className="workspace-divider" /><nav className="workspace-primary-navigation" aria-label="工作台页面">{[{ id: "collection", label: "Collection" }, { id: "flow", label: "Flow" }, { id: "queue", label: "Queue" }].map((item) => <a key={item.id} href={"?view=" + item.id} onPointerEnter={() => onPreload?.(item.id)} onFocus={() => onPreload?.(item.id)} aria-current={page === item.id ? "page" : undefined} data-focus-key={"workspace-page-" + item.id} onClick={(event) => { if (!onNavigate || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); onNavigate(item.id); }}>{item.label}{page === item.id && <MotionSelection layoutId="page-indicator" className="workspace-page-indicator" />}</a>)}</nav></div>
    <div className="workspace-header-actions">{onSettings && <button type="button" className="workspace-icon-button" title="设置" aria-label="设置" aria-haspopup="dialog" disabled={loading} onClick={onSettings} data-focus-key="workspace-settings"><SlidersHorizontal size={17} /></button>}{onReference && <button type="button" className="workspace-icon-button" title="查找洞见编号" aria-label="查找洞见编号" disabled={loading} onClick={onReference} data-focus-key="workspace-reference"><Hash size={17} /></button>}{onReview && <button type="button" className="workspace-review-button" title="文档修订" aria-label={pendingCount ? `${pendingCount} 项待审阅修订` : "文档修订"} disabled={loading} onClick={onReview} data-focus-key="workspace-review"><ListChecks size={17} />{pendingCount > 0 && <span>{pendingCount}</span>}</button>}{onImport && <button type="button" className="workspace-quiet-button workspace-import-button" disabled={loading} onClick={onImport} aria-label="添加资料" data-focus-key="workspace-import"><Plus size={15} /><span>添加资料</span></button>}{onAddTask && <button type="button" className="workspace-quiet-button workspace-import-button" disabled={loading} onClick={onAddTask} title="添加任务" aria-label="添加任务" aria-haspopup="dialog" data-focus-key="queue-add-task"><Plus size={15} /><span>添加任务</span></button>}</div>
    <NavigationLoadingLine />
  </header></LayoutGroup>;
}
