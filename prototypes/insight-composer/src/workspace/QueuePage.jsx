import { forwardRef, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { MotionFeedback, MotionItem, MotionSelection } from "../Motion.jsx";
import { ArrowCounterClockwise, ArrowUpRight, BookOpen, CaretRight, Check, Copy, MagnifyingGlass, Plus } from "../icons";
import { requestJson } from "../workspace-api.js";
import { beginNavigationLoading } from "../navigation-loading.js";
import { createVisiblePoller } from "../visible-poller.js";
import { relatedDestinationState } from "../related-navigation.js";
import { ActionError, useMedia, useTask, useView } from "./shared.jsx";
import { QueueTaskDialog } from "./QueueTaskDialog.jsx";
import { restoreQueueScroll } from "./queue-scroll.js";
import { queueDocumentTarget, queueDraftAfterSaveError, queueDraftFor, queueHandoff, queueListUrl, queueOutputLabel, queueResultLabel, queueSaveCommand, queueSourcePreview, queueSourceUrl, queueStatusLabel, queueTaskMatches, queueTaskMeta, queueTaskReveal, queueTaskTitle, queueTimeLabel, queueTypeLabel, queueTypes, queueView, readQueuePages } from "./queue-model.js";
import "./workspace.css";
import "./queue.css";

const emptyQueue = { tasks: [], total: 0, counts: {}, allCounts: {}, typeCounts: {} };

function useQueue(view, revision, refreshKey) {
  const key = queueListUrl(view) + ":" + view.limit;
  const [state, setState] = useState({ key, data: null, loading: true, error: "" });
  const latest = useRef({ key: "", signature: "" });
  const previousRequest = useRef({ key: "", refreshKey: null, settled: false });
  useEffect(() => {
    let active = true;
    const navigation = previousRequest.current.key !== key || previousRequest.current.refreshKey !== refreshKey || !previousRequest.current.settled;
    previousRequest.current = { key, refreshKey, settled: !navigation };
    const finish = navigation ? beginNavigationLoading() : () => {};
    setState((previous) => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: "" }));
    const poller = createVisiblePoller({ intervalMs: 2000, maxIntervalMs: 8000, isVisible: () => document.visibilityState === "visible",
      run: async (signal) => {
        try {
          const data = await readQueuePages(view, (url) => requestJson(url, { signal, conditional: true }));
          if (!active || signal.aborted) return false;
          const signature = JSON.stringify(data), changed = latest.current.key !== key || latest.current.signature !== signature;
          latest.current = { key, signature };
          setState((previous) => changed || previous.loading || previous.error ? { key, data, loading: false, error: "" } : previous);
          return changed;
        } finally {
          if (active && !signal.aborted) previousRequest.current.settled = true;
          finish();
        }
      },
      onError: (error) => { if (active) setState((previous) => ({ ...previous, key, loading: false, error: error.message || "暂时无法读取队列。" })); },
    });
    poller.start();
    window.addEventListener("focus", poller.wake);
    document.addEventListener("visibilitychange", poller.wake);
    return () => { active = false; poller.dispose(); finish(); window.removeEventListener("focus", poller.wake); document.removeEventListener("visibilitychange", poller.wake); };
  }, [key, revision, refreshKey]);
  return state.key === key ? { ...state, key } : { key, data: null, loading: true, error: "" };
}

function useQueueTask(id, data, refreshKey) {
  const [state, setState] = useState({ id, task: null, loading: false, error: "" });
  const previousRequest = useRef({ id: null, refreshKey: null, settled: false });
  useEffect(() => {
    if (!id) { previousRequest.current = { id, refreshKey, settled: true }; setState({ id, task: null, loading: false, error: "" }); return; }
    const navigation = previousRequest.current.id !== id || previousRequest.current.refreshKey !== refreshKey || !previousRequest.current.settled;
    previousRequest.current = { id, refreshKey, settled: !navigation };
    const finish = navigation ? beginNavigationLoading() : () => {};
    const controller = new AbortController();
    setState((previous) => ({ id, task: previous.id === id ? previous.task : null, loading: true, error: "" }));
    requestJson("/api/queue/" + encodeURIComponent(id), { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setState({ id, task: result.task, loading: false, error: "" });
    }).catch((error) => {
      if (!controller.signal.aborted) setState({ id, task: null, loading: false, error: error.message || "无法读取这项任务。" });
    }).finally(() => {
      if (!controller.signal.aborted) previousRequest.current.settled = true;
      finish();
    });
    return () => { controller.abort(); finish(); };
  }, [id, data, refreshKey]);
  return state.id === id ? state : { id, task: null, loading: Boolean(id), error: "" };
}

function QueueNavigation({ current, data, onNavigate }) {
  const id = useId();
  return <LayoutGroup id={id}><nav className="workspace-category-navigation queue-navigation" aria-label="任务类型">
    <div>{queueTypes.map((item) => {
      const selected = current.status !== "cancelled" && current.type === item.id;
      return <div className="workspace-nav-row" key={item.id}><button type="button" className={"workspace-nav-item" + (selected ? " workspace-selected" : "")} aria-current={selected ? "page" : undefined} data-focus-key={"queue-type-" + item.id} onClick={() => onNavigate({ type: item.id, status: current.status === "cancelled" ? "pending" : current.status })}>{selected && <MotionSelection layoutId="queue-nav-selection" className="workspace-selection-layer workspace-nav-selection" />}<span className="workspace-nav-name">{item.label}</span><span className="workspace-count">{data.typeCounts[item.id] ?? (item.id === "all" ? data.counts.all : 0) ?? 0}</span></button></div>;
    })}</div>
    <div className="queue-nav-cancelled"><button type="button" className={"workspace-nav-item" + (current.status === "cancelled" ? " workspace-selected" : "")} aria-current={current.status === "cancelled" ? "page" : undefined} data-focus-key="queue-type-cancelled" onClick={() => onNavigate({ type: "all", status: "cancelled" })}>{current.status === "cancelled" && <MotionSelection layoutId="queue-nav-selection" className="workspace-selection-layer workspace-nav-selection" />}<span className="workspace-nav-name">已撤回</span><span className="workspace-count">{data.allCounts?.cancelled || 0}</span></button></div>
  </nav></LayoutGroup>;
}

function SourcePreview({ task }) {
  const url = queueSourcePreview(task), sourceUrl = queueSourceUrl(task);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url) return null;
  return <a className={"queue-source-preview" + (failed ? " is-unavailable" : "")} href={sourceUrl} target="_blank" rel="noreferrer" title="查看源文件" aria-hidden={failed || undefined}><img src={url} alt={queueTaskTitle(task) + "的首页预览"} loading="lazy" onError={() => setFailed(true)} /></a>;
}

function TaskBody({ task, pending, onCopy, onEdit, onCancel, onRestore, onOpen, onReview, copied }) {
  const conversion = task.type === "conversion", editable = !["completed", "cancelled"].includes(task.status);
  const sourceUrl = queueSourceUrl(task), hasPreview = Boolean(queueSourcePreview(task));
  const documentTarget = queueDocumentTarget(task), resultTarget = queueDocumentTarget(task, true);
  const quote = task.source?.text || task.source?.quote || task.quote;
  return <div className={"queue-task-details" + (hasPreview ? " queue-task-with-preview" : "")}>
    <div className="queue-task-copy">
      <h3>{conversion ? "转换为可阅读文档" : queueTypeLabel(task.type)}</h3>
      {task.type === "question" && task.questionBody && task.questionBody !== task.body && <p className="queue-question-body">{task.questionBody}</p>}
      <p className="queue-request-body">{task.body || (conversion ? "完整保留正文、公式、图表与参考文献，复审通过后发布。" : task.title)}</p>
      {conversion && <div className="queue-output"><span>输出语言</span><p>{queueOutputLabel(task)}</p></div>}
      {quote && <blockquote className="queue-source-quote">{quote}</blockquote>}
      {task.statusReason && <p className={"queue-status-reason" + (task.status === "needs_attention" ? " needs-attention" : "")}><span>{queueStatusLabel(task.status)}</span>{task.statusReason}</p>}
      <div className="queue-task-links">
        {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">查看源文件</a>}
        {documentTarget && <button type="button" onClick={() => onOpen(task, false)}>回到原文<ArrowUpRight size={12} aria-hidden="true" /></button>}
        {editable && <button type="button" disabled={pending} onClick={() => onEdit(task)}>{conversion ? "编辑要求" : "编辑任务"}</button>}
        {task.relatedReference && <span className="queue-related-reference">{task.relatedReference}</span>}
      </div>
      <div className="queue-task-actions">
        {task.status === "completed" && resultTarget ? <button type="button" className="workspace-primary-button queue-primary-action" disabled={pending} onClick={() => onOpen(task, true)}><BookOpen size={16} />{queueResultLabel(task)}</button> : task.status === "cancelled" ? <button type="button" className="workspace-primary-button" disabled={pending} onClick={() => onRestore(task)}><ArrowCounterClockwise size={15} />恢复任务</button> : <button type="button" className="workspace-primary-button queue-primary-action" disabled={pending} onClick={() => onCopy(task)}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "已复制" : "复制给 Agent"}</button>}
        {task.proposal && task.status !== "cancelled" && <button type="button" className="workspace-quiet-button" disabled={pending} onClick={() => onReview?.(task)}>查看修改</button>}
        {task.preview?.url && task.status !== "completed" && <a className="workspace-quiet-button queue-preview-link" href={task.preview.url} target="_blank" rel="noreferrer">查看候选<ArrowUpRight size={14} aria-hidden="true" /></a>}
        {editable && <button type="button" className="workspace-quiet-button" disabled={pending} onClick={() => onCancel(task)}>撤回</button>}
      </div>
    </div>
    {hasPreview && <SourcePreview task={task} />}
  </div>;
}

const QueueTaskRow = forwardRef(function QueueTaskRow({ task, expanded, loading, pending, copiedReference, copiedTask, layoutOrder, onToggle, onCopyReference, onDetailsSettled, ...actions }, ref) {
  const title = queueTaskTitle(task), metadata = queueTaskMeta(task), detailId = "queue-task-" + task.id;
  function toggle(event) {
    const selection = window.getSelection();
    if (event.detail > 0 && selection && !selection.isCollapsed && event.currentTarget.closest(".queue-task-summary")?.contains(selection.anchorNode)) return;
    onToggle(task);
  }
  return <MotionItem ref={ref} as="li" className={"queue-task-row" + (expanded ? " is-expanded" : "")} layout="position" layoutDependency={layoutOrder} data-task-id={task.id}>
    <div className="queue-task-summary" onClick={(event) => { if (!event.target.closest("button, a, input, select, textarea, summary, [contenteditable], [role='button']")) toggle(event); }}>
      <div className="queue-task-heading"><h2><button type="button" className="queue-task-title" onClick={toggle} aria-expanded={expanded} aria-controls={detailId} title={title}>{title}</button></h2><div className="queue-task-meta"><button type="button" className="queue-copy-reference" onClick={() => onCopyReference(task)} aria-label={"复制任务编号 " + task.reference} title={"复制 " + task.reference}><code>{task.reference}</code>{copiedReference ? <Check size={13} /> : <Copy size={13} />}</button>{metadata.map((value, index) => <span key={index}>{value}</span>)}</div></div>
      <time dateTime={task.createdAt} className="queue-task-time">{queueTimeLabel(task.createdAt)}</time>
      <button type="button" className="workspace-icon-button queue-expand" data-focus-key={"queue-expand-" + task.id} aria-label={(expanded ? "收起" : "展开") + "任务 " + task.reference} aria-expanded={expanded} aria-controls={detailId} onClick={toggle}><CaretRight size={15} className={expanded ? "is-expanded" : ""} aria-hidden="true" /></button>
    </div>
    <MotionFeedback show={expanded} kind="disclosure" id={detailId} onAnimationComplete={onDetailsSettled}><div aria-busy={loading || undefined}><TaskBody task={task} pending={pending || loading} copied={copiedTask} {...actions} /></div></MotionFeedback>
  </MotionItem>;
});

export function QueuePage({ workspace, command, openDocument, view = {}, setView, busy, onImport, onReview }) {
  const current = queueView(view), change = useView(view, setView), action = useTask(busy);
  const mobileNavigation = useMedia("(max-width: 640px)");
  const viewRef = useRef(view); viewRef.current = view;
  const [refreshKey, setRefreshKey] = useState(0), [copied, setCopied] = useState(null);
  const copiedTimer = useRef(null), scrollRef = useRef(null), contentRef = useRef(null), restored = useRef(null), restoration = useRef(null), leaving = useRef(false);
  const resource = useQueue(current, workspace?.revision, refreshKey), data = resource.data || emptyQueue;
  const detail = useQueueTask(current.selectedId, resource.data, refreshKey);
  const tasks = useMemo(() => {
    const result = data.tasks.map((task) => detail.task?.id === task.id ? detail.task : task);
    if (detail.task && !result.some((task) => task.id === detail.task.id) && queueTaskMatches(detail.task, current)) result.unshift(detail.task);
    return result;
  }, [data, detail.task, current.type, current.status, current.query]);
  const layoutOrder = JSON.stringify(tasks.map((task) => task.id));
  const heading = current.status === "cancelled" ? "已撤回" : queueTypeLabel(current.type);
  const counts = data.facetCounts?.[current.type] || data.counts;
  const headingCount = current.status === "cancelled" ? data.allCounts?.cancelled : data.typeCounts[current.type] ?? data.counts.all;
  const statuses = ["pending", ...(counts.processing || current.status === "processing" ? ["processing"] : []), "needs_attention", "completed"];
  if (current.status === "all") statuses.unshift("all");

  useEffect(() => {
    const frame = requestAnimationFrame(() => window.continuousReaderDesktop?.ready?.());
    return () => { cancelAnimationFrame(frame); clearTimeout(copiedTimer.current); };
  }, []);
  useLayoutEffect(() => {
    if (!resource.data || restored.current === resource.key || !scrollRef.current || !contentRef.current) return;
    const pending = restoreQueueScroll({ scroll: scrollRef.current, content: contentRef.current, top: viewRef.current.scrollTop,
      isSettled: () => !viewRef.current.selectedId || contentRef.current?.querySelector(".queue-task-row.is-expanded .motion-feedback")?.style.height === "auto",
      onReady: ({ interrupted, scrollTop }) => {
        restored.current = resource.key;
        if (interrupted) change({ scrollTop });
      },
    });
    restoration.current = pending;
    return () => { pending.dispose(); if (restoration.current === pending) restoration.current = null; };
  }, [resource.data, resource.key, change]);
  useEffect(() => {
    if (detail.loading) return;
    const reveal = queueTaskReveal(detail.task, current);
    if (reveal) change(reveal);
  }, [detail.task, detail.loading, current.selectedId, current.type, current.status, current.query, change]);

  function filter(patch) {
    action.setError("");
    change({ ...patch, selectedId: null, scrollTop: 0, limit: 100 });
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }
  function toggle(task) { change({ selectedId: current.selectedId === task.id || current.selectedId === task.reference ? null : task.id }); }
  async function copy(task, referenceOnly = false) {
    try {
      await navigator.clipboard.writeText(referenceOnly ? task.reference : queueHandoff(task));
      clearTimeout(copiedTimer.current); setCopied({ id: task.id, referenceOnly });
      copiedTimer.current = setTimeout(() => setCopied(null), 1800);
    } catch { action.setError("暂时无法复制，请允许剪贴板访问后重试。"); }
  }
  function edit(task) { action.setError(""); change({ draft: queueDraftFor(task), savedDraft: null }); }
  function closeDraft() {
    if (action.pending) return;
    change({ savedDraft: viewRef.current.draft, draft: null }); action.setError("");
  }
  async function saveDraft() {
    const draft = viewRef.current.draft;
    if (!draft || action.pending) return;
    let input;
    try { input = queueSaveCommand(draft, crypto.randomUUID()); }
    catch (error) { action.setError(error.message); return; }
    change({ draft: { ...draft, pendingCommand: input, conflict: false, questionConflict: false } });
    const saved = await action.run(async () => {
      try { return await command(input); }
      catch (error) {
        change({ draft: queueDraftAfterSaveError(viewRef.current.draft, error) });
        throw error;
      }
    });
    if (!saved.ok) return;
    const task = saved.value.task;
    change({ draft: null, savedDraft: null, ...(task ? { selectedId: task.id, type: task.type, status: task.status, query: "", scrollTop: 0 } : {}) });
    setRefreshKey((value) => value + 1);
  }
  async function reloadDraft() {
    const draft = viewRef.current.draft;
    if (!draft?.taskId) return;
    const loaded = await action.run(() => requestJson("/api/queue/" + encodeURIComponent(draft.taskId)));
    if (!loaded.ok) return;
    if (["completed", "cancelled"].includes(loaded.value.task.status)) { action.setError("这项任务已完成或撤回，无法继续编辑。你的输入仍保留。"); return; }
    change({ draft: { ...viewRef.current.draft, expectedVersion: loaded.value.task.version, conflict: false, pendingCommand: null } });
  }
  async function updateStatus(task, kind) {
    const saved = await action.run(() => command({ kind, taskId: task.id, expectedVersion: task.version }));
    if (!saved.ok) return;
    change(kind === "queue.reopen" ? { type: task.type, status: "pending", selectedId: task.id, query: "", scrollTop: 0 } : { selectedId: null });
    setRefreshKey((value) => value + 1);
  }
  async function openTaskDocument(task, result) {
    const target = queueDocumentTarget(task, result);
    if (!target) return;
    leaving.current = true;
    change({ scrollTop: scrollRef.current?.scrollTop || 0 });
    try { await openDocument(target.documentId, { ...target.options, ...(!result && task.source ? { readingState: relatedDestinationState(target.documentId, task.source) } : {}) }); }
    catch (error) { leaving.current = false; action.setError(error.message || "暂时无法打开文章。"); }
  }
  function importFile(draft) {
    change({ savedDraft: draft, draft: null });
    onImport?.({ title: draft.title || "", body: draft.body || "", language: draft.sourceLanguage || "", outputLanguages: draft.outputLanguages });
  }
  const emptyMessage = current.query ? "没有匹配的任务" : current.status === "cancelled" ? "没有已撤回的任务" : current.status === "completed" ? "还没有已完成的任务" : current.status === "needs_attention" ? "没有需要处理的任务" : "队列中还没有任务";
  const navigationExpanded = view.navigationExpanded !== false;
  return <main className={"workspace-ui queue-page" + (!navigationExpanded ? " queue-nav-collapsed" : "")} onPointerDownCapture={() => { leaving.current = false; }} onWheelCapture={() => { leaving.current = false; }} onKeyDownCapture={() => { leaving.current = false; }}>
    <aside className="queue-sidebar" inert={!navigationExpanded || undefined} aria-hidden={!navigationExpanded || undefined}><QueueNavigation current={current} data={data} onNavigate={filter} /></aside>
    {navigationExpanded && <button className="queue-nav-scrim" type="button" aria-label="收起任务类型" onClick={() => change({ navigationExpanded: false })} />}
    <section className="queue-workspace" aria-labelledby="workspace-queue-title" inert={mobileNavigation && navigationExpanded || undefined}>
      <header className="queue-page-heading"><h1 id="workspace-queue-title" tabIndex={-1}>{heading}</h1><span className="workspace-count">{headingCount || 0}</span><label className="workspace-search queue-search"><MagnifyingGlass size={15} aria-hidden="true" /><input type="search" aria-label="搜索任务或 ID" placeholder="搜索任务或 ID" value={current.query} data-focus-key="queue-search" onChange={(event) => filter({ query: event.target.value })} /></label></header>
      {current.status !== "cancelled" && <nav className="queue-status-tabs" aria-label="任务状态">{statuses.map((status) => <button type="button" key={status} aria-pressed={current.status === status} className={current.status === status ? "is-selected" : ""} onClick={() => filter({ status })}>{queueStatusLabel(status)}<span>{counts[status] || 0}</span></button>)}</nav>}
      <div className="queue-feedback"><ActionError message={action.error && !view.draft ? action.error : resource.error || detail.error} onDismiss={action.error && !view.draft ? () => action.setError("") : undefined} />{(resource.error || detail.error) && <button type="button" className="workspace-text-button" onClick={() => setRefreshKey((value) => value + 1)}>重新读取</button>}</div>
      <motion.div layoutScroll ref={scrollRef} className="queue-scroll" aria-busy={resource.loading || undefined} onScroll={(event) => { if (!leaving.current && restored.current === resource.key) change({ scrollTop: event.currentTarget.scrollTop }); }}>
        <ul ref={contentRef} className="queue-task-list" aria-label="任务列表"><AnimatePresence initial={false} mode="popLayout">{tasks.map((task) => <QueueTaskRow key={task.id} task={task} layoutOrder={layoutOrder} expanded={current.selectedId === task.id || current.selectedId === task.reference} loading={detail.loading && (current.selectedId === task.id || current.selectedId === task.reference)} pending={action.pending} copiedReference={copied?.id === task.id && copied.referenceOnly} copiedTask={copied?.id === task.id && !copied.referenceOnly} onDetailsSettled={() => restoration.current?.refresh()} onToggle={toggle} onCopyReference={(item) => copy(item, true)} onCopy={copy} onEdit={edit} onCancel={(item) => updateStatus(item, "queue.cancel")} onRestore={(item) => updateStatus(item, "queue.reopen")} onOpen={openTaskDocument} onReview={onReview} />)}</AnimatePresence></ul>
        {!resource.loading && !tasks.length && !resource.error && <div className="queue-empty" role="status"><p>{emptyMessage}</p>{!current.query && current.status === "pending" && <button type="button" className="workspace-quiet-button" onClick={() => change({ draft: view.savedDraft || { type: current.type === "all" ? "conversion" : current.type, body: "" }, savedDraft: null })}><Plus size={14} />添加任务</button>}</div>}
        {data.total > data.tasks.length && <div className="queue-load-more"><button type="button" className="workspace-quiet-button" disabled={resource.loading} onClick={() => change({ limit: current.limit + 100 })}>{`显示更多（${data.tasks.length} / ${data.total}）`}</button></div>}
      </motion.div>
    </section>
    <QueueTaskDialog draft={view.draft || null} workspace={workspace} busy={action.pending} error={action.error} onChange={(patch) => { action.setError(""); change({ draft: { ...viewRef.current.draft, ...patch } }); }} onSave={saveDraft} onClose={closeDraft} onImport={onImport ? importFile : undefined} onReload={reloadDraft} />
  </main>;
}
