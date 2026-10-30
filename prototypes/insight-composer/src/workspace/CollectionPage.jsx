import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { MotionItem, MotionSelection } from "../Motion.jsx";
import { useContextMenu } from "../ContextMenu.jsx";
import { useReducedMotionPreference } from "../useReducedMotionPreference.js";
import { useImmediateReducedMotion } from "../useImmediateReducedMotion.js";
import { motionTransition } from "../motion-system.js";
import { Archive, ArrowCounterClockwise, BookmarkSimple, BookOpen, Books, Check, Folder, FolderOpen, Info, MagnifyingGlass, NotePencil, Plus, SortAscending, Tag, Tray, X } from "../icons";
import { canRemoveCollection, collectionPath, deriveCollection, indexCollection, parseTags, sortNames, statusNames } from "./model.js";
import { ActionError, focusByKey, MaterialIcon, useMedia, useTask, useView, WorkspaceDialog } from "./shared.jsx";
import { DecorativeIcon } from "../InterfaceMode.jsx";
import { EmptyState } from "../Feedback.jsx";
import { WORKSPACE_COMPACT_NAVIGATION_WIDTH } from "./workspace-layout.js";
import { MaterialDetails } from "./MaterialDetails.jsx";
import { CollectionForm, DocumentForm } from "./CollectionForms.jsx";
import { useReaderRuntime } from "../ReaderRuntime.jsx";
import { UI_SCALE_BASE } from "../ui-scale.js";
import { requestJson } from "../workspace-api.js";
import { cancelledEditDrafts, collectionDraftFor, documentDraftFor, rebaseCollectionDraft, rebaseDocumentDraft } from "./edit-drafts.js";

function CategoryNavigation({ workspace, current, counts, onNavigate, onCreate, onEdit, scale }) {
  const scope = useId();
  const topItems = [{ id: "all", label: "全部资料", Icon: Books }, { id: "plan", label: "阅读计划", Icon: BookmarkSimple }, { id: "uncategorized", label: "未分类", Icon: Tray }];
  const item = ({ id, label, Icon }, depth = 0, editable = false) => <MotionItem as="div" className="workspace-nav-row" key={id}><button type="button" className={"workspace-nav-item" + (current === id ? " workspace-selected" : "")} style={{ paddingLeft: (8 + depth * 14) * scale }} aria-current={current === id ? "page" : undefined} title={label} onClick={() => onNavigate(id)} data-focus-key={"category-" + id}>{current === id && <MotionSelection layoutId="category-selection" className="workspace-selection-layer workspace-nav-selection" />}<DecorativeIcon><Icon size={15} aria-hidden="true" /></DecorativeIcon><span className="workspace-nav-name">{label}</span><span className="workspace-count">{counts[id] || 0}</span></button>{editable && <button type="button" className="workspace-category-edit" aria-label={"编辑分类" + label} title="编辑分类" onClick={() => onEdit(workspace.collections.find((category) => category.id === id))} data-focus-key={"edit-category-" + id}><NotePencil size={13} /></button>}</MotionItem>;
  const nested = (parentId, seen = new Set()) => workspace.collections.filter((category) => category.parentId === parentId && !seen.has(category.id)).flatMap((category) => {
    const visited = new Set([...seen, category.id]);
    return [item({ ...category, Icon: current === category.id ? FolderOpen : Folder }, collectionPath(workspace.collections, category.id).length - 1, true), ...nested(category.id, visited)];
  });
  return <LayoutGroup id={scope}><nav className="workspace-category-navigation" aria-label="资料分类"><AnimatePresence initial={false} mode="popLayout">{topItems.map((entry) => item(entry))}</AnimatePresence><div className="workspace-nav-label"><span>我的分类</span><button type="button" className="workspace-icon-button" aria-label="新增分类" onClick={onCreate} data-focus-key="category-create"><Plus size={13} /></button></div><div className="workspace-category-tree"><AnimatePresence initial={false} mode="popLayout">{nested(null)}</AnimatePresence>{!workspace.collections.length && <p className="workspace-no-categories">还没有分类</p>}</div><div className="workspace-nav-bottom">{item({ id: "archived", label: "已归档", Icon: Archive })}</div></nav></LayoutGroup>;
}

export function CollectionPage({ workspace, command, openDocument, onImport, view = {}, setView, busy }) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => window.continuousReaderDesktop?.ready?.());
    return () => cancelAnimationFrame(frame);
  }, []);
  const reduced = useReducedMotionPreference();
  const layoutMotionRef = useImmediateReducedMotion(reduced);
  const navigationMotionRef = useImmediateReducedMotion(reduced);
  const runtime = useReaderRuntime();
  const { percent } = useSyncExternalStore(runtime.uiScale.subscribe, runtime.uiScale.getSnapshot);
  const scale = percent / UI_SCALE_BASE;
  const change = useView(view, setView);
  const currentView = useRef(view);
  currentView.current = view;
  const task = useTask(busy);
  const listRef = useRef(null);
  const detailTimer = useRef(null);
  const firstMount = useRef(true);
  const mobileNav = useMedia(`(max-width: ${WORKSPACE_COMPACT_NAVIGATION_WIDTH * scale}px)`);
  const mobileDetails = useMedia(`(max-width: ${980 * scale}px)`);
  const condensedLayout = useMedia(`(max-width: ${1100 * scale}px)`);
  const navigationExpanded = view.navigationExpanded ?? !mobileNav;
  const collectionIndex = useMemo(() => indexCollection(workspace), [workspace.documents, workspace.collections, workspace.planIds]);
  const derived = useMemo(() => deriveCollection(workspace, view, collectionIndex), [collectionIndex, view.collectionId, view.query, view.status, view.tags, view.sort, view.selectedId]);
  const [undo, setUndo] = useState(null);
  const [editRecovery, setEditRecovery] = useState(null);
  const overlay = view.overlay || (mobileNav && navigationExpanded ? { kind: "nav" } : null);
  const contextTargetVersion = useRef(null);
  const materialMenuVersion = (material) => material ? JSON.stringify([material.id, material.version, material.archivedAt, material.status, workspace.planIds.includes(material.id)]) : null;
  const contextMenu = useContextMenu({ disabled: task.pending || Boolean(overlay), contextKey: JSON.stringify([derived.collectionId, view.query, view.status, view.tags, view.sort]) });
  const currentContextVersion = materialMenuVersion(workspace.documents.find((material) => material.id === contextMenu.targetId));
  useEffect(() => {
    if (contextMenu.targetId && currentContextVersion !== contextTargetVersion.current) contextMenu.close("changed");
  }, [contextMenu.targetId, currentContextVersion, contextMenu.close]);
  const filterTags = view.tags || [];
  const archivedTags = derived.collectionId === "archived";
  const allTags = useMemo(() => [...new Set(workspace.documents.filter((item) => Boolean(item.archivedAt) === archivedTags).flatMap((item) => item.tags))].sort((a, b) => a.localeCompare(b, "zh-CN")), [workspace.documents, archivedTags]);
  const cancelPendingDetail = () => { window.clearTimeout(detailTimer.current); detailTimer.current = null; };
  useEffect(() => cancelPendingDetail, [mobileDetails, derived.collectionId, view.query, view.status, view.tags, view.sort, overlay?.kind]);
  useLayoutEffect(() => {
    const patch = {};
    if (view.selectedId !== (derived.selected?.id || null)) patch.selectedId = derived.selected?.id || null;
    if (view.collectionId && view.collectionId !== derived.collectionId) patch.collectionId = derived.collectionId;
    if (view.navigationExpanded === undefined) patch.navigationExpanded = !mobileNav;
    if (Object.keys(patch).length) change(patch);
  }, [derived.selected?.id, derived.collectionId, view.selectedId, view.collectionId, view.navigationExpanded, mobileNav, change]);
  useLayoutEffect(() => {
    if (!firstMount.current || !listRef.current) return;
    firstMount.current = false;
    listRef.current.scrollTop = view.listScrollTop || 0;
  }, []);
  useEffect(() => { if (!mobileDetails && view.overlay?.kind === "detail") change({ overlay: null }); }, [mobileDetails, view.overlay?.kind, change]);
  const setFilters = (patch) => {
    if (listRef.current) listRef.current.scrollTop = 0;
    change({ ...patch, listScrollTop: 0 });
  };
  const closeOverlay = () => {
    if (task.pending) return;
    task.setError("");
    setEditRecovery(null);
    const drafts = cancelledEditDrafts(view.overlay?.kind);
    if (view.overlay?.back) {
      change({ ...drafts, overlay: { ...view.overlay.back, initialFocusKey: view.overlay.returnFocusKey } });
    } else change({ ...drafts, overlay: null, ...(mobileNav && navigationExpanded ? { navigationExpanded: false } : {}) });
  };
  const openOverlay = (kind, extra = {}) => {
    task.setError("");
    const back = overlay && ["detail", "nav"].includes(overlay.kind) ? overlay : null;
    change({ overlay: { kind, ...extra, back, returnFocusKey: document.activeElement?.dataset.focusKey } });
  };
  const navigateCategory = (collectionId) => {
    task.setError("");
    setFilters({ collectionId, overlay: null, ...(mobileNav ? { navigationExpanded: false } : {}) });
  };
  const editCollection = (collection) => {
    const current = view.collectionDraft;
    const draft = current && current.id === (collection?.id || null) ? current : collectionDraftFor(collection);
    task.setError("");
    setEditRecovery(null);
    change({ collectionDraft: draft, overlay: { kind: "edit-collection", back: overlay && ["detail", "nav"].includes(overlay.kind) ? overlay : null, returnFocusKey: document.activeElement?.dataset.focusKey } });
  };
  const editMaterial = (material) => {
    const current = view.documentDraft;
    const draft = current?.documentId === material.id ? current : documentDraftFor(material);
    task.setError("");
    setEditRecovery(null);
    change({ documentDraft: draft, overlay: { kind: "edit-document", documentId: material.id, back: overlay?.kind === "detail" ? overlay : null, returnFocusKey: document.activeElement?.dataset.focusKey } });
  };
  const read = (material, restart = false) => task.run(() => openDocument(material.id, { restart }));
  const togglePlan = (material) => task.run(() => command({ kind: workspace.planIds.includes(material.id) ? "plan.remove" : "plan.add", documentId: material.id }));
  const setStatus = (material, status) => task.run(() => command({ kind: "document.update", documentId: material.id, expectedVersion: material.version, patch: { status } }));
  const restore = async (material) => {
    const result = await task.run(() => command({ kind: "document.restore", documentId: material.id, expectedVersion: material.version }));
    if (result.ok) { setUndo(null); change({ overlay: null }); }
  };
  const archive = async () => {
    const material = workspace.documents.find((item) => item.id === overlay.documentId);
    if (!material) { task.setError("资料已不在当前列表中，请刷新后重试。"); return; }
    const result = await task.run(() => command({ kind: "document.archive", documentId: material.id, expectedVersion: material.version }));
    if (result.ok) { setUndo({ id: material.id, title: material.title }); change({ overlay: null, ...(mobileNav ? { navigationExpanded: false } : {}) }); }
  };
  const saveMaterial = async () => {
    const draft = view.documentDraft;
    if (editRecovery && !editRecovery.ready) return;
    if (!draft.title.trim()) { task.setError("请输入资料标题。"); return; }
    const result = await task.run(async () => {
      try { return await command({ kind: "document.update", documentId: draft.documentId, expectedVersion: draft.expectedVersion, patch: { title: draft.title.trim(), kind: draft.kind, summary: draft.summary.trim(), collectionIds: draft.collectionIds, tags: parseTags(draft.tagsText), status: draft.status } }); }
      catch (error) { if (error.code === "REVISION_CONFLICT") setEditRecovery({ ready: false }); throw error; }
    });
    if (result.ok) change({ documentDraft: null, overlay: overlay.back ? { ...overlay.back, initialFocusKey: overlay.returnFocusKey } : null });
  };
  const saveCollection = async () => {
    const draft = view.collectionDraft;
    if (editRecovery && !editRecovery.ready) return;
    const label = draft.label.trim();
    if (!label) { task.setError("请输入分类名称。"); return; }
    const result = await task.run(async () => {
      try { return await command(draft.id ? { kind: "collection.update", collectionId: draft.id, expectedVersion: draft.expectedVersion, patch: { label, parentId: draft.parentId } } : { kind: "collection.create", label, parentId: draft.parentId }); }
      catch (error) { if (error.code === "REVISION_CONFLICT") setEditRecovery({ ready: false }); throw error; }
    });
    if (result.ok) change({ collectionDraft: null, collectionId: result.value.collection?.id || draft.id || derived.collectionId, query: "", status: "all", tags: [], listScrollTop: 0, overlay: overlay.back ? { ...overlay.back, initialFocusKey: overlay.returnFocusKey } : null });
  };
  const reloadEdit = async () => {
    const kind = view.overlay?.kind;
    const id = kind === "edit-document" ? view.documentDraft?.documentId : view.collectionDraft?.id;
    const result = await task.run(async () => {
      const latest = kind === "edit-document" ? (await requestJson("/api/documents/" + encodeURIComponent(id))).record : (await requestJson("/api/workspace?includeArchived=1")).collections.find((item) => item.id === id);
      if (!latest) throw new Error("内容已移除。你的输入仍保留，可以复制后取消编辑。");
      const current = currentView.current;
      if (current.overlay?.kind !== kind) return null;
      const draft = kind === "edit-document" ? current.documentDraft : current.collectionDraft;
      if ((kind === "edit-document" ? draft?.documentId : draft?.id) !== id) return null;
      return kind === "edit-document" ? rebaseDocumentDraft(draft, latest) : rebaseCollectionDraft(draft, latest);
    });
    if (result.ok && result.value) {
      change({ [kind === "edit-document" ? "documentDraft" : "collectionDraft"]: result.value.draft });
      setEditRecovery({ ready: true, conflicts: result.value.conflicts });
    }
  };
  const removeCollection = async () => {
    const draft = view.collectionDraft;
    if (!canRemoveCollection(workspace, draft.id)) { task.setError("分类仍有资料或子分类，无法移除。"); return; }
    const result = await task.run(() => command({ kind: "collection.remove", collectionId: draft.id, expectedVersion: draft.expectedVersion }));
    if (result.ok) change({ collectionDraft: null, collectionId: derived.collectionId === draft.id ? draft.parentId || "all" : derived.collectionId, overlay: overlay.back?.kind === "nav" ? overlay.back : null });
  };
  const select = (material, showDetail) => {
    change({ selectedId: material.id, focusKey: "material-" + material.id, ...(showDetail && mobileDetails ? { overlay: { kind: "detail", documentId: material.id, returnFocusKey: "material-" + material.id } } : {}) });
  };
  const clickMaterial = (event, material) => {
    cancelPendingDetail();
    if (!mobileDetails || event.detail === 0 || material.archivedAt) { select(material, true); return; }
    select(material, false);
    // A modal opened on the first click would intercept the second click.
    // Keep selection immediate; defer only the narrow-window detail modal.
    if (event.detail === 1) detailTimer.current = window.setTimeout(() => { detailTimer.current = null; select(material, true); }, 500);
  };
  const doubleClickMaterial = (material) => {
    cancelPendingDetail();
    if (!material.archivedAt && !task.pending) read(material, material.status === "done");
  };
  const openMaterialMenu = (event, material) => {
    if (event.type === "keydown" && event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    cancelPendingDetail();
    contextTargetVersion.current = materialMenuVersion(material);
    contextMenu.open(event, {
      id: material.id,
      trigger: event.currentTarget,
      items: material.archivedAt ? [
        { id: "restore", label: "恢复资料", icon: ArrowCounterClockwise, onSelect: () => restore(material) },
      ] : [
        { id: "read", label: material.status === "reading" ? "继续阅读" : material.status === "done" ? "重新阅读" : "开始阅读", icon: BookOpen, onSelect: () => read(material, material.status === "done") },
        { id: "plan", label: workspace.planIds.includes(material.id) ? "移出阅读计划" : "加入阅读计划", icon: BookmarkSimple, onSelect: () => togglePlan(material) },
        { id: "status", label: "阅读状态", icon: Check, separatorBefore: true, children: Object.entries(statusNames).map(([status, label]) => ({ id: status, label, checked: material.status === status, onSelect: () => setStatus(material, status) })) },
        { id: "edit", label: "编辑资料…", icon: NotePencil, onSelect: () => editMaterial(material) },
        { id: "archive", label: "归档资料…", icon: Archive, separatorBefore: true, onSelect: () => openOverlay("archive", { documentId: material.id }) },
      ],
    });
  };
  const listKeys = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    cancelPendingDetail();
    const row = event.target.closest("[data-material-id]");
    if (!row || !derived.rows.length) return;
    event.preventDefault();
    const index = derived.rows.findIndex((material) => material.id === row.dataset.materialId);
    const next = event.key === "Home" ? 0 : event.key === "End" ? derived.rows.length - 1 : Math.max(0, Math.min(derived.rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    const material = derived.rows[next];
    select(material, false);
    requestAnimationFrame(() => { focusByKey("material-" + material.id); document.activeElement?.scrollIntoView({ block: "nearest" }); });
  };
  const navigation = <CategoryNavigation scale={scale} workspace={workspace} current={derived.collectionId} counts={derived.counts} onNavigate={navigateCategory} onCreate={() => editCollection(null)} onEdit={editCollection} />;
  const detail = <MaterialDetails material={derived.selected} workspace={workspace} onRead={read} onPlan={togglePlan} onStatus={setStatus} onEdit={editMaterial} onArchive={(material) => openOverlay("archive", { documentId: material.id })} onRestore={restore} pending={task.pending} />;
  const dialogTitles = { nav: "资料分类", detail: "资料详情", tags: "按标签筛选", sort: "资料排序", "edit-document": "编辑资料", "edit-collection": view.collectionDraft?.id ? "编辑分类" : "新增分类", archive: "归档资料" };
  const archiveMaterial = overlay?.kind === "archive" ? workspace.documents.find((item) => item.id === overlay.documentId) : null;
  const emptyStateKey = derived.filtered ? "filtered" : derived.collectionId === "plan" ? "plan" : derived.collectionId === "archived" ? "archived" : "category";
  const columns = mobileNav ? "minmax(0, 1fr)" : `${navigationExpanded ? 184 * scale : 0}px minmax(0, 1fr)${mobileDetails ? "" : ` ${(condensedLayout ? 286 : 306) * scale}px`}`;
  return <LayoutGroup id="collection"><motion.main ref={layoutMotionRef} initial={false} animate={{ gridTemplateColumns: columns }} transition={motionTransition("layout", reduced)} className={"workspace-ui workspace-page workspace-collection" + (condensedLayout ? " workspace-condensed-layout" : "") + (mobileDetails ? " workspace-compact-details" : "") + (mobileNav ? " workspace-compact-navigation" : "") + (!navigationExpanded ? " workspace-nav-collapsed" : "")}>
    <motion.aside ref={navigationMotionRef} layoutScroll initial={false} animate={{ opacity: navigationExpanded && !mobileNav ? 1 : 0 }} transition={motionTransition("content", reduced)} className="workspace-category-column" inert={!navigationExpanded || mobileNav} aria-hidden={!navigationExpanded || mobileNav || undefined}>{navigation}</motion.aside>
    <section className="workspace-catalog" aria-labelledby="workspace-collection-title">
      <div className="workspace-catalog-heading"><h1 id="workspace-collection-title" title={derived.title} tabIndex={-1}>{derived.title}</h1><span className="workspace-count">{derived.rows.length}</span><button type="button" className="workspace-icon-button workspace-details-toggle" disabled={!derived.selected} aria-label="打开资料详情" title="资料详情" onClick={() => openOverlay("detail", { documentId: derived.selected.id })} data-focus-key="collection-details"><Info size={18} /></button><label className="workspace-search"><MagnifyingGlass size={14} aria-hidden="true" /><input type="search" aria-label="搜索资料" placeholder={derived.collectionId === "all" ? "搜索全部资料" : derived.collectionId === "plan" ? "搜索阅读计划" : "搜索当前分类"} value={view.query || ""} onChange={(event) => setFilters({ query: event.target.value })} data-focus-key="collection-search" /></label></div>
      <div className="workspace-filterbar" role="group" aria-label="资料筛选">{[{ id: "all", label: "全部" }, { id: "reading", label: "在读" }, { id: "unread", label: "未读" }, { id: "done", label: "已读" }].map((item) => <button type="button" key={item.id} className={(view.status || "all") === item.id ? "workspace-selected" : ""} aria-pressed={(view.status || "all") === item.id} onClick={() => setFilters({ status: item.id })} data-focus-key={"collection-status-" + item.id}>{(view.status || "all") === item.id && <MotionSelection layoutId="collection-status" className="workspace-selection-layer" />}{item.label}</button>)}<div className="workspace-filter-actions"><button type="button" className={filterTags.length ? "workspace-selected" : ""} onClick={() => openOverlay("tags")} aria-label={filterTags.length ? "标签筛选，已选" + filterTags.join("、") : "按标签筛选"} title={filterTags.join("、") || "按标签筛选"} aria-haspopup="dialog" data-focus-key="collection-tags"><Tag size={14} /><span>标签{filterTags.length ? " " + filterTags.length : ""}</span></button><button type="button" className={"workspace-sort-button" + (view.sort && view.sort !== "original" ? " workspace-selected" : "")} onClick={() => openOverlay("sort")} title={"排序，" + sortNames[view.sort || "original"]} aria-label={"排序，" + sortNames[view.sort || "original"]} aria-haspopup="dialog" data-focus-key="collection-sort"><SortAscending size={16} /></button></div></div>
      {!overlay && <ActionError message={task.error} onDismiss={() => task.setError("")} />}
      <AnimatePresence initial={false}>{undo && <MotionItem as="div" key="archive-notice" className="workspace-undo" role="status"><span>已归档 {undo.title}</span><button type="button" disabled={task.pending || !workspace.documents.some((item) => item.id === undo.id && item.archivedAt)} onClick={() => { const material = workspace.documents.find((item) => item.id === undo.id); if (material) restore(material); }}><ArrowCounterClockwise size={14} />撤销</button><button type="button" className="workspace-icon-button" aria-label="关闭归档提示" onClick={() => setUndo(null)}><X size={14} /></button></MotionItem>}</AnimatePresence>
      <motion.div layoutScroll className="workspace-list-scroll" ref={listRef} onScroll={(event) => change({ listScrollTop: event.currentTarget.scrollTop })}>
        <div className="workspace-list-heading"><span>资料</span><span>阅读状态</span></div><ul className="workspace-document-list" aria-label="资料列表" onKeyDown={listKeys}><AnimatePresence initial={false} mode="popLayout">{derived.rows.map((material) => <MotionItem key={material.id}><button type="button" className={"workspace-document-row" + (derived.selected?.id === material.id ? " workspace-selected" : "")} aria-pressed={derived.selected?.id === material.id} aria-label={material.title + "，" + statusNames[material.status]} title={material.title} data-material-id={material.id} data-context-target={contextMenu.targetId === material.id || undefined} onContextMenu={(event) => openMaterialMenu(event, material)} onKeyDown={(event) => openMaterialMenu(event, material)} data-focus-key={"material-" + material.id} onClick={(event) => clickMaterial(event, material)} onDoubleClick={() => doubleClickMaterial(material)} onBlur={cancelPendingDetail}>{derived.selected?.id === material.id && <MotionSelection layoutId="collection-row" className="workspace-selection-layer" />}<DecorativeIcon><MaterialIcon kind={material.kind} /></DecorativeIcon><span className="workspace-document-row-copy"><span className="workspace-document-title">{material.title}</span><span className="workspace-document-row-meta">{[material.kind, ...material.tags].join(" · ")}</span></span><span className={"workspace-row-status workspace-status-" + material.status}>{statusNames[material.status]}</span></button></MotionItem>)}</AnimatePresence></ul>
        <AnimatePresence initial={false} mode="popLayout">{!derived.rows.length && <EmptyState key={emptyStateKey} className="workspace-empty-catalog" action={derived.filtered ? <button className="workspace-quiet-button" type="button" onClick={() => setFilters({ query: "", status: "all", tags: [] })}>清除筛选</button> : derived.collectionId === "plan" || derived.collectionId === "archived" ? <button className="workspace-quiet-button" type="button" onClick={() => navigateCategory("all")}>浏览全部资料</button> : onImport && <button className="workspace-quiet-button" type="button" onClick={onImport}><Plus size={14} />添加资料</button>}>{derived.filtered ? "没有符合条件的资料" : derived.collectionId === "plan" ? "阅读计划里还没有资料" : derived.collectionId === "archived" ? "还没有已归档资料" : "这个分类还没有资料"}</EmptyState>}</AnimatePresence>
        <MotionItem as="div" initial={false} className="workspace-list-footer"><span className="workspace-result-summary"><AnimatePresence initial={false} mode="popLayout"><MotionItem as="span" layout={false} key={`${derived.rows.length}:${derived.filtered}`} transition={motionTransition("content", reduced)}>{derived.rows.length} 份资料{derived.filtered ? " · 已筛选" : ""}</MotionItem></AnimatePresence></span><AnimatePresence initial={false} mode="popLayout">{derived.filtered && <MotionItem as="button" key="clear-filters" layout={false} type="button" onClick={() => setFilters({ query: "", status: "all", tags: [] })} data-focus-key="collection-clear-filters" transition={motionTransition("content", reduced)}>清除筛选</MotionItem>}</AnimatePresence></MotionItem>
      </motion.div>
    </section>
    <aside className="workspace-details" aria-label="资料详情">{detail}</aside>
    <WorkspaceDialog open={Boolean(overlay)} title={dialogTitles[overlay?.kind] || "资料详情"} onClose={closeOverlay} contentKey={overlay?.kind + ":" + (overlay?.documentId || view.collectionDraft?.id || "")} initialFocusKey={overlay?.initialFocusKey || (overlay?.kind === "detail" ? view.focusKey : undefined)} returnFocusKey={overlay?.kind === "nav" ? "collection-navigation-toggle" : undefined} className={overlay?.kind === "nav" ? "workspace-navigation-dialog" : overlay?.kind === "detail" ? "workspace-detail-dialog" : ["tags", "sort"].includes(overlay?.kind) ? "workspace-menu-dialog" : ""}>
      <ActionError message={task.error} onDismiss={() => task.setError("")} />
      {overlay?.kind === "nav" && navigation}
      {overlay?.kind === "detail" && detail}
      {overlay?.kind === "tags" && <>{allTags.length ? allTags.map((tag) => <button type="button" key={tag} className={"workspace-option-row" + (filterTags.includes(tag) ? " workspace-selected" : "")} aria-pressed={filterTags.includes(tag)} onClick={() => setFilters({ tags: filterTags.includes(tag) ? filterTags.filter((item) => item !== tag) : [...filterTags, tag] })}><span>{tag}</span>{filterTags.includes(tag) && <Check size={15} />}</button>) : <p className="workspace-dialog-copy">资料还没有标签。可以在资料详情中添加。</p>}<p className="workspace-option-hint">同时满足所有已选标签。</p><div className="workspace-menu-footer"><button type="button" disabled={!filterTags.length} onClick={() => setFilters({ tags: [] })}>清除标签</button><button type="button" onClick={closeOverlay}>完成</button></div></>}
      {overlay?.kind === "sort" && Object.entries(sortNames).map(([id, label]) => <button key={id} type="button" className={"workspace-option-row" + ((view.sort || "original") === id ? " workspace-selected" : "")} aria-pressed={(view.sort || "original") === id} onClick={() => { change({ sort: id, overlay: null }); }}><span>{id === "original" && derived.collectionId === "plan" ? "阅读计划顺序" : label}</span>{(view.sort || "original") === id && <Check size={15} />}</button>)}
      {overlay?.kind === "edit-document" && view.documentDraft && <DocumentForm draft={view.documentDraft} onChange={(patch) => change({ documentDraft: { ...view.documentDraft, ...patch } })} workspace={workspace} onSubmit={saveMaterial} onCancel={closeOverlay} pending={task.pending} recovery={editRecovery} onReload={reloadEdit} />}
      {overlay?.kind === "edit-collection" && view.collectionDraft && <CollectionForm draft={view.collectionDraft} onChange={(patch) => change({ collectionDraft: { ...view.collectionDraft, ...patch } })} workspace={workspace} onSubmit={saveCollection} onRemove={removeCollection} onCancel={closeOverlay} pending={task.pending} recovery={editRecovery} onReload={reloadEdit} />}
      {overlay?.kind === "archive" && <><p className="workspace-archive-title">{archiveMaterial?.title}</p><p className="workspace-dialog-copy">归档后会从阅读列表中隐藏。资料与洞见都会保留，可以在“已归档”中恢复。</p><div className="workspace-dialog-actions"><button type="button" className="workspace-text-button" onClick={closeOverlay}>取消</button><button type="button" className="workspace-primary-button" disabled={task.pending || !archiveMaterial} onClick={archive}><Archive size={15} />{task.pending ? "正在归档…" : "移入归档"}</button></div></>}
    </WorkspaceDialog>
    {contextMenu.element}
  </motion.main></LayoutGroup>;
}
