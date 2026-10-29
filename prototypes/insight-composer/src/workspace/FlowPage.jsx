import { ReaderSelect } from "../ReaderSelect.jsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { MotionItem, MotionSelection } from "../Motion.jsx";
import { useContextMenu } from "../ContextMenu.jsx";
import { useReducedMotionPreference } from "../useReducedMotionPreference.js";
import { useImmediateReducedMotion } from "../useImmediateReducedMotion.js";
import { motionTransition } from "../motion-system.js";
import katex from "katex";
import "katex/dist/katex.min.css";
import { ArrowCounterClockwise, ArrowDown, ArrowUp, ArrowUpRight, ArrowsOutSimple, BookmarkSimple, BookOpen, CalendarBlank, CaretRight, Check, CheckCircle, Clock, Copy, Highlighter, InsightIcon, ListChecks, MagnifyingGlass, NotePencil, Plus, Question, Trash, X } from "../icons";
import { DecorativeIcon, useInterfaceMode } from "../InterfaceMode.jsx";
import { requestJson } from "../workspace-api.js";
import { beginNavigationLoading } from "../navigation-loading.js";
import { InsightQuote } from "../InsightQuote.jsx";
import { InsightActions } from "../InsightActions.jsx";
import { InlineContent } from "../InlineContent.jsx";
import { ActionError, focusByKey, MaterialIcon, useMedia, useTask, useView, WorkspaceDialog } from "./shared.jsx";
import { readingPosition, statusNames } from "./model.js";
import { availablePlanDocuments, dateRange, dayLabel, durationLabel, groupHistory, groupHistoryPreview, historyPreviewEntries, insightTypeLabel, localDay, positionLabel } from "./flow-model.js";
import { flowResourceStore } from "./flow-resource-store.js";
import { useReaderRuntime } from "../ReaderRuntime.jsx";
import { UI_SCALE_BASE } from "../ui-scale.js";
import "./flow.css";

const sections = [{ id: "overview", label: "总览", Icon: CalendarBlank }, { id: "insights", label: "洞见", Icon: InsightIcon }, { id: "plan", label: "阅读计划", Icon: ListChecks }, { id: "history", label: "阅读历史", Icon: Clock }];
const emptyPage = { items: [], total: 0, hasMore: false };
const queryUrl = (path, query) => path + "?" + new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== ""));
const isContextMenuEvent = (event) => event.type !== "keydown" || event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");

async function requestFlowResource(url, signal) {
  const target = new URL(url, window.location.origin);
  if (/^\/api\/flow\/insights\/[^/]+$/.test(target.pathname)) {
    try { return await requestJson(url, { signal, conditional: true }); }
    catch (error) {
      // Absence from a filtered page says nothing about the selected insight.
      // Only its independent authoritative lookup can retire the selection.
      if (error.status === 404) return { insight: null, unavailable: true };
      throw error;
    }
  }
  const requested = Number(target.searchParams.get("limit"));
  if (!requested || requested <= 100) return requestJson(url, { signal, conditional: true });
  target.searchParams.set("limit", "100");
  let result = await requestJson(target.pathname + target.search, { signal, conditional: true });
  const items = [...result.items];
  while (result.hasMore && items.length < requested) {
    target.searchParams.set("offset", String(items.length));
    target.searchParams.set("limit", String(Math.min(100, requested - items.length)));
    result = await requestJson(target.pathname + target.search, { signal, conditional: true });
    if (!result.items.length) break;
    items.push(...result.items);
  }
  return { ...result, offset: 0, limit: requested, items: [...new Map(items.map((item) => [item.id, item])).values()] };
}

function useFlowResource(url, revision, refreshKey) {
  const identity = useMemo(() => flowResourceStore.identity(url), [url]);
  const [state, setState] = useState(() => ({ url, identity, data: flowResourceStore.read(url), loading: Boolean(url), error: "" }));
  const previousRequest = useRef({ started: false, settled: false, url: null });
  useEffect(() => {
    if (!url) { previousRequest.current.url = null; setState({ url, identity, data: null, loading: false, error: "" }); return; }
    let active = true;
    const data = flowResourceStore.read(url);
    const changedUrl = previousRequest.current.started && previousRequest.current.url !== url;
    const navigation = changedUrl || (!data && !previousRequest.current.settled);
    previousRequest.current = { started: true, settled: changedUrl ? false : previousRequest.current.settled, url };
    const finish = navigation ? beginNavigationLoading() : () => {};
    setState({ url, identity, data, loading: true, error: "" });
    const request = flowResourceStore.acquire(url, { version: revision, load: requestFlowResource });
    request.promise.then((next) => {
      if (active) { previousRequest.current.settled = true; setState({ url, identity, data: next, loading: false, error: "" }); }
    }).catch((error) => {
      if (active) { previousRequest.current.settled = true; setState((previous) => ({ ...previous, loading: false, error: error.message || "暂时无法读取，请重试。" })); }
    }).finally(finish);
    return () => { active = false; request.release(); finish(); };
  }, [url, revision, refreshKey]);
  const snapshot = state.url === url ? state : { url, identity, data: flowResourceStore.read(url), loading: Boolean(url), error: "" };
  return { ...snapshot, ready: Boolean(snapshot.data) && (!snapshot.loading || flowResourceStore.has(url)) };
}

function EmptyState({ children, action, compact = false }) {
  return <MotionItem as="div" className={"flow-empty" + (compact ? " flow-empty-compact" : "")} layout={false}><p>{children}</p>{action}</MotionItem>;
}

function InsightGlyph({ note, size = 15 }) {
  const Icon = note.type === "question" ? Question : note.type === "note" || note.body || note.title ? NotePencil : Highlighter;
  return <DecorativeIcon><Icon size={size} aria-hidden="true" /></DecorativeIcon>;
}

function InsightRowLeading({ note }) {
  if (note.type !== "question") return <InsightGlyph note={note} />;
  const resolved = Boolean(note.answer);
  const label = resolved ? "已解决" : "待解决";
  const Icon = resolved ? CheckCircle : Question;
  return <span className={"flow-insight-question-state" + (resolved ? " is-resolved" : "")} role="img" aria-label={label} title={label}><Icon size={16} aria-hidden="true" /></span>;
}

function InsightPreview({ note, onClick, onContextMenu, contextTargetId, showDocument = false }) {
  return <button type="button" className="flow-insight-preview" data-context-target={contextTargetId === "insight:" + note.id || undefined} onContextMenu={(event) => onContextMenu?.(event, note)} onKeyDown={(event) => onContextMenu?.(event, note)} onClick={() => onClick(note)}><InsightGlyph note={note} /><span className="flow-preview-content">{note.title && <span className="flow-preview-title">{note.title}</span>}<span className="flow-preview-copy">{note.body || note.quote || insightTypeLabel(note)}</span>{showDocument && <span className="flow-muted flow-preview-source">{note.documentTitle}</span>}</span><span className="flow-entry-arrow" aria-hidden="true"><CaretRight size={14} /></span></button>;
}

function ChartValue({ value }) {
  return <span className="flow-stat-value"><AnimatePresence initial={false} mode="popLayout"><MotionItem as="span" key={String(value)} layout={false} initial={{ opacity: 0, y: 0 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 0 }}>{value}</MotionItem></AnimatePresence></span>;
}

function ReadingChart({ summary, loading, timezone, selectedDate, onSelectDate, rangeDays }) {
  const reduced = useReducedMotionPreference();
  const days = summary?.daily || [];
  const monthly = rangeDays === 30;
  const rangeLabel = monthly ? "最近三十天" : "最近七天";
  const max = Math.max(60000, ...days.map((day) => day.activeMs));
  const today = localDay(Date.now(), timezone);
  const [hoveredDate, setHoveredDate] = useState(null);
  const [focusedDate, setFocusedDate] = useState(null);
  const [dismissedDate, setDismissedDate] = useState(null);
  const buttons = useRef(new Map());
  const activeDate = hoveredDate || focusedDate;
  const moveFocus = (event, index) => {
    if (event.key === "Escape") { setDismissedDate(activeDate); return; }
    if (["Enter", " "].includes(event.key)) { setHoveredDate(null); setFocusedDate(days[index].date); setDismissedDate(null); }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? days.length - 1 : Math.max(0, Math.min(days.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
    setHoveredDate(null); setFocusedDate(days[next].date); setDismissedDate(null);
    buttons.current.get(days[next].date)?.focus();
  };
  return <section className={"flow-week" + (monthly ? " flow-month" : "")} aria-label={rangeLabel + "阅读统计"} aria-busy={loading}>
    <dl className="flow-week-stats">
      <div><dt>有效阅读时间</dt><dd className="flow-duration-value"><ChartValue value={summary ? durationLabel(summary.totals?.activeMs) : "\u00a0"} /></dd></div>
      <div><dt>阅读文章</dt><dd><ChartValue value={summary ? summary.totals?.documentCount || 0 : "\u00a0"} /></dd></div>
      <div><dt>阅读次数</dt><dd><ChartValue value={summary ? summary.totals?.sessionCount || 0 : "\u00a0"} /></dd></div>
    </dl>
    <div className="flow-week-chart" role="group" aria-label="按日期筛选阅读记录"><AnimatePresence initial={false} mode="popLayout">{days.map((day, index) => {
      const weekday = ["日", "一", "二", "三", "四", "五", "六"][new Date(day.date + "T12:00:00Z").getUTCDay()];
      const tooltipVisible = activeDate === day.date && dismissedDate !== day.date;
      return <MotionItem as="div" key={day.date} className="flow-chart-column" onPointerEnter={() => { setHoveredDate(day.date); setFocusedDate(null); setDismissedDate(null); }} onPointerLeave={() => { setHoveredDate(null); setFocusedDate(null); }}>
        <button type="button" ref={(element) => { if (element) buttons.current.set(day.date, element); else buttons.current.delete(day.date); }} className={"flow-chart-day" + (day.date === today ? " is-today" : "") + (day.date === selectedDate ? " is-selected" : "")} aria-label={`${day.date} 星期${weekday}，${durationLabel(day.activeMs, { short: true })}，${day.sessionCount || 0} 次阅读记录`} aria-pressed={day.date === selectedDate} aria-controls="flow-overview-history" aria-describedby={tooltipVisible ? `flow-chart-tooltip-${day.date}` : undefined} onPointerDown={() => setFocusedDate(null)} onFocus={(event) => { const keyboardFocus = event.currentTarget.matches(":focus-visible"); if (keyboardFocus) setHoveredDate(null); setFocusedDate(keyboardFocus ? day.date : null); setDismissedDate(null); }} onBlur={() => setFocusedDate(null)} onKeyDown={(event) => moveFocus(event, index)} onClick={() => onSelectDate(day.date === selectedDate ? null : day.date)}>
          <span className="flow-chart-track"><motion.span initial={false} animate={{ height: day.activeMs ? `${Math.max(4, day.activeMs / max * 100)}%` : "0%" }} transition={motionTransition("layout", reduced)} style={{ minHeight: "2px" }} /></span><span className="flow-chart-date">{monthly ? index % 6 === 0 || index === days.length - 1 ? `${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8))}` : "\u00a0" : Number(day.date.slice(8))}</span>{!monthly && <span>{weekday}</span>}
        </button>
        <AnimatePresence initial={false}>{tooltipVisible && <motion.span key="tooltip" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={motionTransition("control", reduced)} id={`flow-chart-tooltip-${day.date}`} className="flow-chart-tooltip" role="tooltip"><span>{day.date} · 周{weekday}</span><strong>{durationLabel(day.activeMs, { short: true })}</strong><span>{day.sessionCount || 0} 次阅读记录</span></motion.span>}</AnimatePresence>
      </MotionItem>;
    })}</AnimatePresence></div>
  </section>;
}

function HistoryTimeline({ items, previewEntries, timezone, onRead, onInsight, onInsightContextMenu, onSessionContextMenu, contextTargetId, pending, compact = false, measurement = false, dayTotals }) {
  const days = useMemo(() => previewEntries ? groupHistoryPreview(previewEntries) : groupHistory(items, timezone), [items, previewEntries, timezone]);
  const timeFormat = useMemo(() => new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }), [timezone]);
  return <div className={"flow-timeline" + (compact ? " flow-timeline-compact" : "")}><AnimatePresence initial={false} mode="popLayout">{days.map(({ date, entries }) => <MotionItem as="section" className="flow-day" key={date}><div className="flow-day-heading"><h2>{dayLabel(date, timezone)}</h2><span className="flow-muted">{date}</span><span className="flow-day-duration">{durationLabel(dayTotals?.[date] ?? entries.reduce((sum, item) => sum + (item.activeMs || 0), 0), { short: true })}</span></div><ol><AnimatePresence initial={false} mode="popLayout">{entries.map((session) => {
    const start = positionLabel(session.startPosition), end = positionLabel(session.endPosition);
    return <MotionItem key={session.id} className="flow-session">
      <button type="button" className="flow-session-title" data-focus-key={measurement ? undefined : "flow-session-" + session.id} data-context-target={contextTargetId === "session:" + session.id || undefined} onContextMenu={(event) => onSessionContextMenu?.(event, session)} onKeyDown={(event) => onSessionContextMenu?.(event, session)} disabled={pending} onClick={() => onRead(session.documentId, { revision: session.documentRevision, readingState: { ...(session.endPosition || session.startPosition || {}), mode: (session.endPosition || session.startPosition)?.mode || session.mode } })}>
        <time className="flow-session-time" dateTime={session.startedAt}>{timeFormat.format(new Date(session.startedAt))}</time>
        <span className="flow-session-content">
          <DecorativeIcon><MaterialIcon kind="论文" size={18} /></DecorativeIcon>
          <span className="flow-session-summary">
            <span className="flow-session-name">{session.documentTitle}</span>
            <span className="flow-session-meta">{durationLabel(session.activeMs)}{start || end ? <><span aria-hidden="true"> · </span>{start && end && start !== end ? `${start} → ${end}` : end || start}</> : null}{session.mode === "translation" && <><span aria-hidden="true"> · </span>译文</>}</span>
          </span>
          <span className="flow-entry-arrow" aria-hidden="true"><CaretRight size={14} /></span>
        </span>
      </button>
      {Boolean(session.insights?.length) && <div className="flow-session-insights">
        <ul className="flow-session-insight-list" aria-label="本次阅读的洞见"><AnimatePresence initial={false} mode="popLayout">{session.insights.map((note) => <MotionItem key={note.id}><InsightPreview note={note} onClick={onInsight} onContextMenu={onInsightContextMenu} contextTargetId={contextTargetId} /></MotionItem>)}</AnimatePresence></ul>
        {session.insightCount > session.insights.length && <p className="flow-muted">本次共留下 {session.insightCount} 条洞见</p>}
      </div>}
    </MotionItem>;
  })}</AnimatePresence></ol></MotionItem>)}</AnimatePresence></div>;
}

function PanelResize({ onResize, width, minWidth, maxWidth, scale, onStart, onEnd, visible = true }) {
  const dragging = useRef(null);
  return <div role="separator" tabIndex={visible ? 0 : -1} inert={!visible} aria-hidden={!visible || undefined} className="flow-panel-resize" style={{ opacity: visible ? 1 : 0, pointerEvents: visible ? undefined : "none" }} aria-label="调整右侧面板宽度" aria-orientation="vertical" aria-valuemin={Math.round(minWidth)} aria-valuemax={Math.round(maxWidth)} aria-valuenow={Math.round(width)} onPointerDown={(event) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); onStart?.(); dragging.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId);
  }} onPointerMove={(event) => { if (dragging.current) onResize(dragging.current.width + dragging.current.x - event.clientX); }} onPointerUp={(event) => { dragging.current = null; onEnd?.(); event.currentTarget.releasePointerCapture(event.pointerId); }} onLostPointerCapture={() => { dragging.current = null; onEnd?.(); }} onKeyDown={(event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); onResize(event.key === "Home" ? minWidth : event.key === "End" ? maxWidth : width + (event.key === "ArrowLeft" ? 20 : -20) * scale);
  }}><span /></div>;
}

function AnswerMath({ tex = "" }) {
  const html = useMemo(() => ({ __html: katex.renderToString(tex, { displayMode: true, throwOnError: false, trust: false }) }), [tex]);
  return <div className="flow-answer-math" dangerouslySetInnerHTML={html} />;
}

function InsightDetail({ note, document, pending, onRead, onEdit, onArchive, onReview, onCopy, copyStatus, onClose, onExpand, expanded = false }) {
  const content = useRef(null);
  useLayoutEffect(() => {
    if (expanded && content.current) content.current.closest("dialog").scrollTop = 0;
  }, [note?.id, expanded]);
  if (!note) return <EmptyState compact>选择一条洞见，查看思考与原文。</EmptyState>;
  return <article ref={content} className={"flow-insight-detail" + (expanded ? " is-expanded" : " is-preview")}>
    <header>
      <span className="flow-detail-type"><InsightGlyph note={note} />{expanded && insightTypeLabel(note)}<button type="button" className="flow-reference" onClick={() => onCopy(note)} title="复制编号">{note.reference}<Copy size={12} /></button></span>
      <div className="flow-detail-tools">
        <InsightActions note={note} busy={pending} onEdit={onEdit} onDelete={onArchive} onCopy={onCopy}
          onReview={!expanded ? (item) => onReview(item, item.review?.pending ? "remove" : "add") : undefined}
          onCompleteReview={!expanded ? (item) => onReview(item, "complete") : undefined} />
        {onClose && <button type="button" className="workspace-icon-button flow-detail-close" aria-label="关闭洞见详情" title="关闭洞见详情" onClick={onClose}><X size={14} /></button>}
      </div>
    </header>
    {copyStatus && <p className="flow-copy-status" role="status">{copyStatus}</p>}
    <div className="flow-detail-body">
      {note.title && <h2 className="flow-detail-title">{note.title}</h2>}
      {note.body && <div className="flow-detail-copy"><InlineContent text={note.body} /></div>}
      {note.type === "question" && <section className="flow-answer">
        <h3>{note.answer ? "回答" : "尚待解答"}</h3>
        {note.answer && <div className="flow-answer-content">{(note.answer.blocks || [{ type: "paragraph", text: note.answer.text || note.answer.body || "" }]).map((block, index) => block.type === "math" ? <AnswerMath key={index} tex={block.tex || ""} /> : block.type === "heading" ? <h4 key={index}>{block.text}</h4> : <p key={index}><InlineContent text={block.text || ""} /></p>)}</div>}
      </section>}
      {onExpand && <button type="button" className="flow-detail-expand" data-focus-key={"flow-detail-expand-" + note.id} aria-label="打开完整详情" onClick={onExpand}>展开详情<ArrowUpRight size={12} aria-hidden="true" /></button>}
      <section className="flow-detail-origin" aria-label="来源">
        <button type="button" className="flow-detail-source" disabled={pending} onClick={() => onRead(note.documentId, { insightId: note.id, hash: note.blockId ? "#" + encodeURIComponent(note.blockId) : "" })}>{note.documentTitle}<ArrowUpRight size={13} /></button>
        {note.blockId && <div className="flow-detail-quote"><InsightQuote note={note} sourceLanguage={document?.language || "und"} /></div>}
      </section>
      {expanded && <div className="flow-detail-actions">
        <button type="button" className="workspace-quiet-button" disabled={pending} onClick={() => onReview(note, note.review?.pending ? "complete" : "add")}>{note.review?.pending ? <Check size={14} /> : <BookmarkSimple size={14} />}{note.review?.pending ? "完成回顾" : "加入待回顾"}</button>
        {note.review?.pending && <button type="button" className="workspace-text-button" disabled={pending} onClick={() => onReview(note, "remove")}>移出待回顾</button>}
        <button type="button" className="workspace-text-button" disabled={pending} onClick={() => onEdit(note)}><NotePencil size={14} />编辑</button>
      </div>}
      {expanded && note.review?.lastReviewedAt && <p className="flow-muted flow-reviewed-at">上次回顾 {new Date(note.review.lastReviewedAt).toLocaleDateString("zh-CN")}</p>}
    </div>
  </article>;
}

function ReadingPlanList({ plan, pending, read, mutate, planVersion, onContextMenu, contextTargetId }) {
  return <>
    {plan.length > 0 && <div className="workspace-list-heading flow-plan-columns" aria-hidden="true"><span>#</span><span>文章</span><span>阅读状态</span><span>操作</span></div>}
    <ol className="flow-plan-list" aria-label="阅读计划顺序"><AnimatePresence initial={false} mode="popLayout">
      {plan.map((document, index) => <MotionItem key={document.id} data-context-target={contextTargetId === "plan:" + document.id || undefined} onContextMenu={(event) => onContextMenu(event, document, index)} onKeyDown={(event) => onContextMenu(event, document, index)}>
        <span className="flow-plan-index">{index + 1}</span>
        <div className="flow-plan-copy">
          <button type="button" className="workspace-document-title flow-plan-title" data-focus-key={"flow-plan-" + document.id} disabled={pending} onClick={() => read(document.id)}>{document.title}</button>
          <p className="workspace-document-row-meta">{readingPosition(document)}{document.insightCount > 0 && <><span aria-hidden="true"> · </span>{document.insightCount} 条洞见</>}</p>
        </div>
        <span className="flow-plan-status">{statusNames[document.status]}</span>
        <div className="flow-plan-actions">
          <button type="button" className={index === 0 ? "flow-read-button" : "workspace-quiet-button"} disabled={pending} onClick={() => read(document.id)}>{document.status === "unread" ? "开始阅读" : "继续阅读"}</button>
          <div>
            <button type="button" className="workspace-icon-button" aria-label={"上移 " + document.title} title="上移" disabled={pending || index === 0} onClick={() => mutate({ kind: "plan.move", documentId: document.id, direction: -1, expectedPlanVersion: planVersion })}><ArrowUp size={14} /></button>
            <button type="button" className="workspace-icon-button" aria-label={"下移 " + document.title} title="下移" disabled={pending || index === plan.length - 1} onClick={() => mutate({ kind: "plan.move", documentId: document.id, direction: 1, expectedPlanVersion: planVersion })}><ArrowDown size={14} /></button>
            <button type="button" className="workspace-icon-button" aria-label={"从计划移除 " + document.title} title="移出计划" disabled={pending} onClick={() => mutate({ kind: "plan.remove", documentId: document.id })}><X size={14} /></button>
          </div>
        </div>
      </MotionItem>)}
    </AnimatePresence></ol>
  </>;
}

export function FlowPage({ workspace, view = {}, setView, onViewChange, command, openDocument, onEditInsight, busy = false }) {
  const reduced = useReducedMotionPreference();
  const [resizing, setResizing] = useState(false);
  const { mode } = useInterfaceMode();
  const runtime = useReaderRuntime();
  const { percent } = useSyncExternalStore(runtime.uiScale.subscribe, runtime.uiScale.getSnapshot);
  const scale = percent / UI_SCALE_BASE;
  const condensedLayout = useMedia(`(max-width: ${1100 * scale}px)`);
  const change = useView(view, setView || onViewChange);
  const section = sections.some((entry) => entry.id === view.section) ? view.section : "overview";
  const insightShortcut = view.insightReview === "pending" || view.insightQuestion === "unresolved";
  const task = useTask(busy);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerInitialPlanIds, setPickerInitialPlanIds] = useState(workspace.planIds);
  const [copyStatus, setCopyStatus] = useState("");
  const [selectedSnapshot, setSelectedSnapshot] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailReturnFocusKey, setDetailReturnFocusKey] = useState(null);
  const [planFocusRequest, setPlanFocusRequest] = useState(null);
  const contextTargetVersion = useRef(null);
  const detailOpenRef = useRef(detailOpen);
  detailOpenRef.current = detailOpen;
  const copyTimer = useRef(null);
  const scroll = useRef(null);
  const rail = useRef(null);
  const planPreviewScroll = useRef(null);
  const reviewPreviewScroll = useRef(null);
  const restoredScroll = useRef({ section: null, done: false });
  const restoredOverviewPreviews = useRef({ plan: false, review: false });
  const restoredDetail = useRef({ id: null, done: false });
  const layout = useRef(null);
  const layoutMotionRef = useImmediateReducedMotion(reduced);
  const navigationMotionRef = useImmediateReducedMotion(reduced);
  const panelLayoutMotionRef = useImmediateReducedMotion(reduced, layout);
  const railMotionRef = useImmediateReducedMotion(reduced, rail);
  const filterToolsMotionRef = useImmediateReducedMotion(reduced);
  const questionFilterMotionRef = useImmediateReducedMotion(reduced);
  const [layoutWidth, setLayoutWidth] = useState(window.innerWidth - 180);
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const revision = workspace.revision;
  const range = dateRange(view.historyPeriod || "week", timezone);
  const overviewDays = view.overviewDays === 30 ? 30 : 7;
  const overviewRange = dateRange(overviewDays === 30 ? "month" : "week", timezone);
  const summary = useFlowResource(queryUrl("/api/flow/summary", { timezone, days: overviewDays }), revision, refreshKey);
  const overviewDate = typeof view.overviewDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(view.overviewDate) && view.overviewDate >= overviewRange.from && view.overviewDate <= overviewRange.to ? view.overviewDate : null;
  const insightQuery = view.insightQuery || "";
  const insightUrl = queryUrl("/api/flow/insights", { offset: 0, limit: section === "insights" ? view.insightLimit || 30 : 12, type: section === "insights" ? view.insightType || "all" : "all", review: section === "insights" ? view.insightReview || "all" : "all", question: section === "insights" ? view.insightQuestion || "all" : "all", documentId: section === "insights" ? view.insightDocumentId || "" : "", query: section === "insights" ? insightQuery : "" });
  const insights = useFlowResource(section === "overview" || section === "insights" ? insightUrl : null, revision, refreshKey);
  const selectedId = view.selectedInsightId || null;
  const selectedDetail = useFlowResource(section === "insights" && selectedId ? "/api/flow/insights/" + encodeURIComponent(selectedId) : null, revision, refreshKey);
  const reviews = useFlowResource(section === "overview" ? queryUrl("/api/flow/insights", { offset: 0, limit: 5, review: "pending" }) : null, revision, refreshKey);
  const history = useFlowResource(section === "overview" || section === "history" ? queryUrl("/api/flow/history", { offset: 0, limit: section === "history" ? view.historyLimit || 30 : view.overviewHistoryLimit || 12, timezone, ...(section === "history" ? range : overviewDate ? { from: overviewDate, to: overviewDate } : overviewRange) }) : null, revision, refreshKey);
  const insightPage = insights.data || emptyPage;
  const historyPage = history.data || emptyPage;
  const overviewEntries = useMemo(() => section === "overview" ? historyPreviewEntries(historyPage.items, timezone) : [], [section, historyPage.items, timezone]);
  const overviewPreviewEntries = useMemo(() => overviewEntries.slice(0, 10), [overviewEntries]);
  const overviewDayTotals = useMemo(() => Object.fromEntries((summary.data?.daily || []).map((day) => [day.date, day.activeMs])), [summary.data?.daily]);
  const plan = useMemo(() => {
    const byId = new Map(workspace.documents.filter((document) => !document.archivedAt).map((document) => [document.id, document]));
    return workspace.planIds.map((id) => byId.get(id)).filter(Boolean);
  }, [workspace.documents, workspace.planIds]);
  // Keep this opening's rows in place; the live plan confirms each added state.
  const candidates = useMemo(() => availablePlanDocuments({ documents: workspace.documents, planIds: pickerInitialPlanIds }, pickerQuery), [workspace.documents, pickerInitialPlanIds, pickerQuery]);
  const openPlanPicker = () => { setPickerInitialPlanIds([...workspace.planIds]); setPickerOpen(true); };
  const selected = selectedDetail.data?.unavailable ? null : selectedDetail.data?.insight || insightPage.items.find((note) => note.id === selectedId) || (selectedSnapshot?.id === selectedId ? selectedSnapshot : null);
  const railVisible = section === "overview" || section === "insights" && Boolean(selectedId);
  const minWidth = 260 * scale;
  const maxWidth = Math.max(minWidth, Math.min((section === "overview" ? 480 : 600) * scale, layoutWidth * (section === "overview" ? .44 : .49)));
  const railWidth = Math.max(minWidth, Math.min(maxWidth, (view.panelWidth || (section === "overview" ? 364 : window.innerWidth / scale <= 1100 ? 286 : 306)) * scale));
  const activeError = task.error || selectedDetail.error || summary.error || insights.error || history.error || reviews.error;
  const loading = (section === "overview" && !summary.data && summary.loading) || (section === "insights" && !insights.data && insights.loading) || (section === "history" && !history.data && history.loading);
  const contextMenu = useContextMenu({ disabled: task.pending || pickerOpen || detailOpen, contextKey: JSON.stringify([section, insightUrl, overviewDate, overviewDays, view.historyPeriod]) });
  const menuTargetVersion = (kind, target) => {
    if (!target) return null;
    const document = workspace.documents.find((item) => item.id === (kind === "plan" ? target.id : target.documentId));
    if (kind === "plan") return JSON.stringify([target.id, document?.version, document?.archivedAt, workspace.planVersion, workspace.planIds.includes(target.id)]);
    if (kind === "insight") return JSON.stringify([target.id, target.version, target.review?.pending, document?.archivedAt]);
    return JSON.stringify([target.id, document?.version, document?.archivedAt, workspace.planIds.includes(target.documentId), target.documentRevision, target.endPosition || target.startPosition, target.mode]);
  };
  const contextTargetKind = contextMenu.targetId?.split(":", 1)[0];
  const contextTargetId = contextMenu.targetId?.slice((contextTargetKind?.length || 0) + 1);
  const contextTarget = !contextMenu.targetId ? null : contextTargetKind === "plan" ? plan.find((item) => item.id === contextTargetId) : contextTargetKind === "session" ? groupHistory(historyPage.items, timezone).flatMap((day) => day.entries).find((item) => item.id === contextTargetId) : [...insightPage.items, ...(reviews.data?.items || []), ...historyPage.items.flatMap((item) => item.insights || [])].find((item) => item.id === contextTargetId);
  const currentContextVersion = menuTargetVersion(contextTargetKind, contextTarget);
  useEffect(() => {
    if (contextMenu.targetId && currentContextVersion !== contextTargetVersion.current) contextMenu.close("changed");
  }, [contextMenu.targetId, currentContextVersion, contextMenu.close]);
  useLayoutEffect(() => {
    if (!planFocusRequest || task.pending) return;
    setPlanFocusRequest(null);
    if (section !== planFocusRequest.section || pickerOpen || detailOpen) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement && active !== planFocusRequest.origin) return;
    const prefix = section === "overview" ? "flow-plan-preview-" : "flow-plan-";
    for (const id of planFocusRequest.ids) if (focusByKey(prefix + id)) return;
    focusByKey(section === "overview" ? "flow-plan-all" : "flow-plan-add", "flow-content-heading");
  }, [planFocusRequest, task.pending, section, pickerOpen, detailOpen, workspace.planVersion]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setLayoutWidth(entry.contentRect.width));
    if (layout.current) observer.observe(layout.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  useEffect(() => {
    let lastRefresh = 0;
    const refreshVisible = () => {
      if (document.visibilityState === "hidden" || Date.now() - lastRefresh < 750) return;
      lastRefresh = Date.now();
      setRefreshKey((value) => value + 1);
    };
    const timer = window.setInterval(refreshVisible, 20000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("continuous-reader:activity-synced", refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("continuous-reader:activity-synced", refreshVisible);
    };
  }, []);
  const scrollReady = section === "plan" || section === "insights" && insights.ready || section === "history" && history.ready || section === "overview" && history.ready && (Boolean(overviewDate) || historyPage.items.length > 0 || insights.ready);
  useLayoutEffect(() => {
    if (layout.current) layout.current.scrollTop = 0;
    if (restoredScroll.current.section !== section) restoredScroll.current = { section, done: false };
    if (!restoredScroll.current.done && scrollReady && scroll.current) {
      scroll.current.scrollTop = view[section + "ScrollTop"] || 0;
      restoredScroll.current.done = true;
    }
  }, [section, scrollReady, view]);
  useLayoutEffect(() => {
    if (section !== "overview") { restoredOverviewPreviews.current = { plan: false, review: false }; return; }
    if (!restoredOverviewPreviews.current.plan && planPreviewScroll.current) {
      planPreviewScroll.current.scrollTop = view.overviewPlanScrollTop || 0;
      restoredOverviewPreviews.current.plan = true;
    }
    if (!restoredOverviewPreviews.current.review && reviews.ready && reviewPreviewScroll.current) {
      reviewPreviewScroll.current.scrollTop = view.overviewReviewScrollTop || 0;
      restoredOverviewPreviews.current.review = true;
    }
  }, [section, reviews.ready, view.overviewPlanScrollTop, view.overviewReviewScrollTop]);
  useLayoutEffect(() => {
    if (section !== "insights") { restoredDetail.current.done = false; return; }
    if (restoredDetail.current.id !== selectedId) restoredDetail.current = { id: selectedId, done: false };
    if (!restoredDetail.current.done && selected && rail.current) {
      rail.current.scrollTop = view.insightDetailScrollTop || 0;
      restoredDetail.current.done = true;
    }
  }, [section, selectedId, selected, view.insightDetailScrollTop]);
  useEffect(() => { if (selected && selected !== selectedSnapshot) setSelectedSnapshot(selected); }, [selected]);
  const navigate = (next, patch = {}) => { setDetailOpen(false); task.setError(""); change({ section: next, ...patch }); };
  const rememberScroll = (event) => { if (event.target === event.currentTarget && restoredScroll.current.section === section && restoredScroll.current.done) change({ [section + "ScrollTop"]: event.currentTarget.scrollTop }); };
  const rememberOverviewPreviewScroll = (event, kind) => {
    if (event.target === event.currentTarget && section === "overview" && restoredOverviewPreviews.current[kind]) change({ [kind === "plan" ? "overviewPlanScrollTop" : "overviewReviewScrollTop"]: event.currentTarget.scrollTop });
  };
  const selectOverviewDate = (date) => { if (scroll.current) scroll.current.scrollTop = 0; change({ overviewDate: date, overviewHistoryLimit: 12, overviewScrollTop: 0 }); };
  const selectOverviewRange = (days) => { if (scroll.current) scroll.current.scrollTop = 0; change({ overviewDays: days, overviewDate: null, overviewHistoryLimit: 12, overviewScrollTop: 0 }); };
  const selectHistoryPeriod = (period) => { if (scroll.current) scroll.current.scrollTop = 0; change({ historyPeriod: period, historyLimit: 30, historyScrollTop: 0 }); };
  const restoreInsightFocus = (id) => requestAnimationFrame(() => {
    if (!layout.current?.querySelector(".flow-scroll-insights")) return;
    if (!id || !focusByKey("flow-insight-" + id)) layout.current.querySelector("#workspace-flow-title")?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (!selectedId || selectedDetail.loading || selectedDetail.error || !selectedDetail.data?.unavailable) return;
    const next = insightPage.items.find((note) => note.id !== selectedId);
    setDetailReturnFocusKey(next ? "flow-insight-" + next.id : "flow-content-heading");
    setDetailOpen(false);
    setSelectedSnapshot(null);
    change({ selectedInsightId: null, insightDetailScrollTop: 0 });
    if (!detailOpenRef.current) restoreInsightFocus(next?.id);
  }, [selectedId, selectedDetail.data, selectedDetail.loading, selectedDetail.error, change]);
  const closeInsight = () => { const id = selected?.id; setDetailOpen(false); change({ selectedInsightId: null }); restoreInsightFocus(id); };
  const showInsight = (note) => { setSelectedSnapshot(note); navigate("insights", { selectedInsightId: note.id, ...(selectedId !== note.id ? { insightDetailScrollTop: 0 } : {}) }); };
  const expandInsight = (note, returnFocusKey = "flow-insight-" + note.id) => {
    showInsight(note);
    setDetailReturnFocusKey(returnFocusKey);
    setDetailOpen(true);
  };
  const read = (id, options) => task.run(() => openDocument(id, options));
  const edit = (note) => task.run(() => onEditInsight ? onEditInsight(note) : openDocument(note.documentId, { insightId: note.id, editInsightId: note.id }));
  const mutate = async (input) => { const result = await task.run(() => command(input)); if (result.ok) setRefreshKey((value) => value + 1); return result; };
  const mutatePlan = async (input) => {
    const origin = document.activeElement;
    const index = plan.findIndex((item) => item.id === input.documentId);
    const neighbours = [plan[index + 1]?.id, plan[index - 1]?.id].filter(Boolean);
    const result = await mutate(input);
    // Pending disables the invoking button, which can send focus to the body.
    // Restore after React has enabled the settled list, never after menu exit.
    setPlanFocusRequest({ section, origin, ids: input.kind === "plan.remove" && result.ok ? neighbours : [input.documentId, ...neighbours] });
    return result;
  };
  const review = async (note, action) => {
    const result = await mutate({ kind: "insight.review." + action, insightId: note.id, documentId: note.documentId });
    if (result.ok) setSelectedSnapshot((current) => current?.id === note.id ? { ...current, ...(result.value.insight || {}), review: result.value.review || result.value.insight?.review || current.review } : current);
  };
  const copy = async (note) => { try { await navigator.clipboard.writeText(note.reference); setCopyStatus("已复制 " + note.reference); } catch { setCopyStatus("复制失败，可直接选中编号复制。"); } clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopyStatus(""), 2400); };
  const archive = async (note) => {
    const index = insightPage.items.findIndex((item) => item.id === note.id);
    const next = insightPage.items[index + 1] || insightPage.items[index - 1];
    const result = await mutate({ kind: "insight.archive", documentId: note.documentId, insightId: note.id, expectedVersion: note.version });
    if (result.ok) {
      const removedSelection = selectedId === note.id;
      if (removedSelection) { setDetailReturnFocusKey(next ? "flow-insight-" + next.id : "flow-content-heading"); setDetailOpen(false); setSelectedSnapshot(null); }
      change({ ...(removedSelection ? { selectedInsightId: null, insightDetailScrollTop: 0 } : {}), undoNoticeDismissed: false, archivedInsights: [...(view.archivedInsights || []).filter((item) => item.id !== note.id), result.value.insight] });
      if (!detailOpenRef.current) restoreInsightFocus(next?.id);
    }
  };
  const undo = async (note) => { const result = await mutate({ kind: "insight.restore", documentId: note.documentId, insightId: note.id, expectedVersion: note.version }); if (result.ok) change({ archivedInsights: (view.archivedInsights || []).filter((item) => item.id !== note.id) }); };
  const filters = (patch) => { if (scroll.current) scroll.current.scrollTop = 0; change({ ...patch, insightLimit: 30, insightsScrollTop: 0 }); };
  const openInsightMenu = (event, note) => {
    if (!isContextMenuEvent(event)) return;
    contextTargetVersion.current = menuTargetVersion("insight", note);
    const returnFocusKey = section === "insights" ? "flow-insight-" + note.id : "flow-content-heading";
    contextMenu.open(event, {
      id: "insight:" + note.id,
      trigger: event.currentTarget,
      items: [
        { id: "detail", label: "查看完整内容", icon: ArrowsOutSimple, onSelect: () => expandInsight(note, returnFocusKey) },
        { id: "source", label: "定位原文", icon: ArrowUpRight, onSelect: () => read(note.documentId, { insightId: note.id, hash: note.blockId ? "#" + encodeURIComponent(note.blockId) : "" }) },
        { id: "edit", label: "编辑洞见…", icon: NotePencil, separatorBefore: true, onSelect: () => edit(note) },
        { id: "copy", label: "复制编号", icon: Copy, disabled: !note.reference, onSelect: () => copy(note) },
        { id: "review", label: note.review?.pending ? "完成回顾" : "加入待回顾", icon: note.review?.pending ? Check : BookmarkSimple, separatorBefore: true, onSelect: () => review(note, note.review?.pending ? "complete" : "add") },
        ...(note.review?.pending ? [{ id: "remove-review", label: "移出待回顾", icon: BookmarkSimple, onSelect: () => review(note, "remove") }] : []),
        { id: "delete", label: "删除洞见", icon: Trash, danger: true, separatorBefore: true, onSelect: () => archive(note) },
      ],
    });
  };
  const openPlanMenu = (event, document, index) => {
    if (!isContextMenuEvent(event)) return;
    contextTargetVersion.current = menuTargetVersion("plan", document);
    contextMenu.open(event, {
      id: "plan:" + document.id,
      trigger: event.target.closest("button") || event.currentTarget.querySelector("button"),
      items: [
        { id: "read", label: document.status === "unread" ? "开始阅读" : "继续阅读", icon: BookOpen, onSelect: () => read(document.id) },
        { id: "up", label: "上移", icon: ArrowUp, separatorBefore: true, disabled: index === 0, onSelect: () => mutatePlan({ kind: "plan.move", documentId: document.id, direction: -1, expectedPlanVersion: workspace.planVersion }) },
        { id: "down", label: "下移", icon: ArrowDown, disabled: index === plan.length - 1, onSelect: () => mutatePlan({ kind: "plan.move", documentId: document.id, direction: 1, expectedPlanVersion: workspace.planVersion }) },
        { id: "remove", label: "移出阅读计划", icon: BookmarkSimple, separatorBefore: true, onSelect: () => mutatePlan({ kind: "plan.remove", documentId: document.id }) },
      ],
    });
  };
  const openSessionMenu = (event, session) => {
    if (!isContextMenuEvent(event)) return;
    contextTargetVersion.current = menuTargetVersion("session", session);
    contextMenu.open(event, {
      id: "session:" + session.id,
      trigger: event.currentTarget,
      items: [
        { id: "read", label: "从此处阅读", icon: BookOpen, onSelect: () => read(session.documentId, { revision: session.documentRevision, readingState: { ...(session.endPosition || session.startPosition || {}), mode: (session.endPosition || session.startPosition)?.mode || session.mode } }) },
        { id: "plan", label: workspace.planIds.includes(session.documentId) ? "移出阅读计划" : "加入阅读计划", icon: BookmarkSimple, onSelect: () => mutate({ kind: workspace.planIds.includes(session.documentId) ? "plan.remove" : "plan.add", documentId: session.documentId }) },
      ],
    });
  };
  const search = <label className="workspace-search flow-search"><MagnifyingGlass size={14} /><input type="search" aria-label="搜索洞见" placeholder="搜索标题、内容或编号" value={insightQuery} onChange={(event) => filters({ insightQuery: event.target.value })} /></label>;
  const detailProps = { note: selected, document: workspace.documents.find((item) => item.id === selected?.documentId), pending: task.pending || selectedDetail.loading || Boolean(selectedDetail.error), onRead: read, onEdit: edit, onArchive: archive, onReview: review, onCopy: copy, copyStatus };
  const detail = selected ? <InsightDetail {...detailProps} onClose={closeInsight} onExpand={() => { setDetailReturnFocusKey(null); setDetailOpen(true); }} /> : <div className="flow-loading-space" aria-busy={selectedDetail.loading}><button type="button" className="workspace-icon-button" aria-label="关闭洞见详情" onClick={closeInsight}><X size={16} /></button></div>;
  const undoRecovery = Boolean(view.archivedInsights?.length) && view.undoNoticeDismissed && <button type="button" className="workspace-icon-button" title="撤销删除" aria-label={"恢复已删除洞见，共 " + view.archivedInsights.length + " 条"} onClick={() => change({ undoNoticeDismissed: false })}><ArrowCounterClockwise size={16} /></button>;
  const upcoming = <section className="flow-upcoming">
    <header className="flow-section-heading"><h2>接下来</h2><button type="button" className="workspace-text-button" aria-label="查看全部阅读计划" data-focus-key="flow-plan-all" onClick={() => navigate("plan")}>查看全部<CaretRight size={12} /></button></header>
    <motion.div layoutScroll className="flow-plan-preview-scroll" ref={planPreviewScroll} role="region" tabIndex={0} aria-label="接下来的阅读计划" onScroll={(event) => rememberOverviewPreviewScroll(event, "plan")}>
      {plan.length ? <ol><AnimatePresence initial={false} mode="popLayout">{plan.slice(0, 3).map((document, index) => <MotionItem key={document.id} data-context-target={contextMenu.targetId === "plan:" + document.id || undefined} onContextMenu={(event) => openPlanMenu(event, document, index)} onKeyDown={(event) => openPlanMenu(event, document, index)}><span className="flow-plan-number">{index + 1}</span><div><button type="button" className="workspace-document-title flow-upcoming-title" data-focus-key={"flow-plan-preview-" + document.id} disabled={task.pending} onClick={() => read(document.id)}>{document.title}</button></div></MotionItem>)}</AnimatePresence></ol> : <EmptyState compact action={<button type="button" className="workspace-quiet-button" onClick={openPlanPicker}><Plus size={14} />添加阅读计划</button>}>阅读计划为空。</EmptyState>}
    </motion.div>
  </section>;
  return <LayoutGroup id="flow"><motion.main ref={layoutMotionRef} initial={false} animate={{ gridTemplateColumns: `${view.navigationExpanded === false ? 0 : 184 * scale}px minmax(0, 1fr)` }} transition={motionTransition("layout", reduced)} className={"workspace-ui workspace-page flow-page" + (condensedLayout ? " flow-condensed-layout" : "") + (view.navigationExpanded === false ? " flow-nav-collapsed" : "")} data-interface-mode={mode}>
    <motion.aside ref={navigationMotionRef} layoutScroll initial={false} animate={{ opacity: view.navigationExpanded === false ? 0 : 1 }} transition={motionTransition("content", reduced)} className="flow-nav" inert={view.navigationExpanded === false} aria-hidden={view.navigationExpanded === false || undefined}><nav className="workspace-category-navigation" aria-label="Flow"><div className="flow-nav-main">{sections.map(({ id, label, Icon }) => <button key={id} type="button" className={"workspace-nav-item" + (section === id && (id !== "insights" || !insightShortcut) ? " workspace-selected" : "")} aria-current={section === id ? "page" : undefined} data-focus-key={"flow-section-" + id} onClick={() => navigate(id, id === "insights" && insightShortcut ? { insightReview: "all", insightQuestion: "all", insightType: "all", insightLimit: 30, insightsScrollTop: 0 } : {})}>{section === id && (id !== "insights" || !insightShortcut) && <MotionSelection layoutId="flow-navigation" className="workspace-selection-layer workspace-nav-selection" />}<DecorativeIcon><Icon size={15} aria-hidden="true" /></DecorativeIcon><span>{label}</span>{id === "insights" && summary.data?.totals?.insightCount > 0 && <span className="flow-nav-count">{summary.data.totals.insightCount}</span>}</button>)}</div><div className="flow-nav-shortcuts"><button type="button" className={"workspace-nav-item" + (section === "insights" && view.insightReview === "pending" ? " workspace-selected" : "")} onClick={() => navigate("insights", { insightReview: "pending", insightQuestion: "all", insightType: "all", insightQuery: "", insightDocumentId: "" })}>{section === "insights" && view.insightReview === "pending" && <MotionSelection layoutId="flow-navigation" className="workspace-selection-layer workspace-nav-selection" />}<DecorativeIcon><BookmarkSimple size={15} aria-hidden="true" /></DecorativeIcon><span>待回顾</span>{summary.data?.totals?.reviewCount > 0 && <span className="flow-nav-count">{summary.data.totals.reviewCount}</span>}</button><button type="button" className={"workspace-nav-item" + (section === "insights" && view.insightQuestion === "unresolved" && view.insightReview !== "pending" ? " workspace-selected" : "")} onClick={() => navigate("insights", { insightQuestion: "unresolved", insightReview: "all", insightType: "question", insightQuery: "", insightDocumentId: "" })}>{section === "insights" && view.insightQuestion === "unresolved" && view.insightReview !== "pending" && <MotionSelection layoutId="flow-navigation" className="workspace-selection-layer workspace-nav-selection" />}<DecorativeIcon><Question size={15} aria-hidden="true" /></DecorativeIcon><span>待解决</span>{summary.data?.totals?.unresolvedQuestionCount > 0 && <span className="flow-nav-count">{summary.data.totals.unresolvedQuestionCount}</span>}</button></div></nav></motion.aside>
    <motion.div initial={false} animate={{ gridTemplateColumns: `minmax(0, 1fr) ${railVisible ? 16 : 0}px ${railVisible ? railWidth : 0}px` }} transition={resizing ? { duration: 0 } : motionTransition("layout", reduced)} className={"flow-workspace" + (railVisible ? " flow-has-rail" : "") + (section === "overview" ? " flow-overview-workspace" : "")} ref={panelLayoutMotionRef} style={{ "--flow-rail-width": railWidth + "px" }} data-resizing={resizing || undefined}>
      {section === "overview" && <>
        <header className="workspace-catalog-heading flow-page-heading flow-overview-heading">
          <h1 id="workspace-flow-title" data-focus-key="flow-content-heading" tabIndex={-1}>总览</h1>{undoRecovery}
          <div className="flow-periods" role="group" aria-label="阅读统计时间范围">
            {[{ days: 7, label: "近 7 天" }, { days: 30, label: "近 30 天" }].map(({ days, label }) => <button type="button" key={days} aria-pressed={overviewDays === days} className={overviewDays === days ? "is-active" : ""} onClick={() => selectOverviewRange(days)}>{overviewDays === days && <MotionSelection layoutId="overview-range" className="workspace-selection-layer" />}{label}</button>)}
          </div>
        </header>
        <ReadingChart summary={summary.data} loading={summary.loading} timezone={timezone} selectedDate={overviewDate} onSelectDate={selectOverviewDate} rangeDays={overviewDays} />
      </>}
      <section className={"workspace-catalog flow-main" + (section === "insights" ? " flow-insights-main" : "")} aria-labelledby="workspace-flow-title">
      {activeError && <div className="flow-error"><ActionError message={activeError} onDismiss={task.error ? () => task.setError("") : undefined} /><button type="button" className="workspace-text-button" onClick={() => { task.setError(""); setRefreshKey((value) => value + 1); }}>重新加载</button></div>}
      <AnimatePresence initial={false}>{Boolean(view.archivedInsights?.length) && !view.undoNoticeDismissed && <MotionItem as="div" key="insight-undo" className="flow-undo" role="status"><span>已删除 {view.archivedInsights.length} 条洞见</span><button type="button" disabled={task.pending} onClick={() => undo(view.archivedInsights.at(-1))}><ArrowCounterClockwise size={13} />撤销最近一次</button><button type="button" className="workspace-icon-button" aria-label="关闭删除提示" onClick={() => change({ undoNoticeDismissed: true })}><X size={13} /></button></MotionItem>}</AnimatePresence>
      {section !== "overview" && <header className="workspace-catalog-heading flow-page-heading">
        <div><h1 id="workspace-flow-title" data-focus-key="flow-content-heading" tabIndex={-1}>{sections.find((entry) => entry.id === section).label}</h1>
          {section === "insights" && insights.data && <span className="flow-muted">{insightPage.total} 条</span>}
          {section === "plan" && <span className="flow-muted">{plan.length} 篇</span>}
          {section === "history" && history.data && <span className="flow-muted">{historyPage.total} 次阅读</span>}
        </div>

        {undoRecovery}{section === "plan" && <button type="button" className="flow-read-button flow-plan-add-button" data-focus-key="flow-plan-add" onClick={openPlanPicker}><Plus size={15} />添加文章</button>}

      </header>}
        {section === "history" && <div className="workspace-filterbar flow-periods" role="group" aria-label="历史时间范围">
          {[{ id: "today", label: "今天" }, { id: "week", label: "近 7 天" }, { id: "month", label: "近 30 天" }, { id: "all", label: "全部" }].map((period) => <button type="button" key={period.id} aria-pressed={(view.historyPeriod || "week") === period.id} className={(view.historyPeriod || "week") === period.id ? "is-active" : ""} onClick={() => selectHistoryPeriod(period.id)}>{(view.historyPeriod || "week") === period.id && <MotionSelection layoutId="history-period" className="workspace-selection-layer" />}{period.label}</button>)}
        </div>}
      {section === "insights" && <div className="workspace-filterbar flow-filters">
        <div className="flow-type-filters" role="group" aria-label="洞见类型">{[{ id: "all", label: "全部" }, { id: "annotation", label: "批注与高亮" }, { id: "note", label: "笔记" }, { id: "question", label: "问题" }].map((type) => <button type="button" key={type.id} aria-pressed={(view.insightType || "all") === type.id} className={(view.insightType || "all") === type.id ? "is-active" : ""} onClick={() => filters({ insightType: type.id, insightQuestion: "all" })}>{(view.insightType || "all") === type.id && <MotionSelection layoutId="insight-type" className="workspace-selection-layer" />}{type.label}</button>)}</div>
        <motion.div ref={filterToolsMotionRef} className="flow-filter-tools" initial={false}
          animate={{ "--flow-question-progress": view.insightType === "question" ? 1 : 0 }} transition={motionTransition("control", reduced)}>
          {search}
          <div className="flow-filter-options">
            <ReaderSelect className="flow-document-filter" aria-label="按文章筛选洞见" value={view.insightDocumentId || ""} onChange={(event) => filters({ insightDocumentId: event.target.value })}><option value="">全部文章</option>{workspace.documents.filter((item) => !item.archivedAt).map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</ReaderSelect>
            <motion.div ref={questionFilterMotionRef} className="flow-question-filter-slot" initial={false}
              animate={{ opacity: view.insightType === "question" ? 1 : 0 }} transition={motionTransition("control", reduced)}
              inert={view.insightType !== "question"} aria-hidden={view.insightType !== "question" || undefined}>
              <ReaderSelect className="flow-question-filter" aria-label="问题状态" disabled={view.insightType !== "question"} value={view.insightQuestion || "all"} onChange={(event) => filters({ insightQuestion: event.target.value })}><option value="all">全部问题</option><option value="unresolved">待解决</option><option value="resolved">已解决</option></ReaderSelect>
            </motion.div>
            <button type="button" aria-pressed={view.insightReview === "pending"} className={"flow-review-filter" + (view.insightReview === "pending" ? " is-active" : "")} onClick={() => filters({ insightReview: view.insightReview === "pending" ? "all" : "pending" })}><BookmarkSimple size={13} />待回顾</button>
          </div>
        </motion.div>
      </div>}
      <motion.div layoutScroll className={"workspace-list-scroll flow-scroll flow-scroll-" + section} ref={scroll} onScroll={rememberScroll} role={section === "overview" ? "region" : undefined} tabIndex={section === "overview" ? 0 : undefined} aria-label={section === "overview" ? "阅读记录" : undefined} aria-busy={loading}><AnimatePresence initial={false} mode="popLayout"><MotionItem as="div" key={section} className="flow-section-content" layout={false}>
          {section === "overview" && <>
            <section id="flow-overview-history" aria-label={overviewDate ? `${overviewDate} 阅读记录` : "最近阅读记录"} aria-busy={history.loading}>
              <header className="flow-section-heading">
                <h2>阅读记录</h2>
                <div className="flow-history-filter">{overviewDate && <><span className="flow-muted" role="status">{history.data ? `${historyPage.total} 次` : "\u00a0"}</span><button type="button" className="workspace-text-button" onClick={() => { const activeDay = layout.current?.querySelector(`[aria-controls="flow-overview-history"][aria-pressed="true"]`); selectOverviewDate(null); activeDay?.focus({ preventScroll: true }); }}>全部日期<X size={12} /></button></>}<button type="button" className="workspace-text-button" aria-label="查看全部阅读记录" onClick={() => navigate("history", { historyPeriod: overviewDays === 30 ? "month" : "week", historyLimit: 30, historyScrollTop: 0 })}>查看全部<CaretRight size={12} /></button></div>
              </header>
              {!history.data ? <div className="flow-loading-space" aria-hidden="true" /> : historyPage.items.length ? <HistoryTimeline previewEntries={overviewPreviewEntries} timezone={timezone} onRead={read} onInsight={showInsight} onInsightContextMenu={openInsightMenu} onSessionContextMenu={openSessionMenu} contextTargetId={contextMenu.targetId} pending={task.pending} compact dayTotals={overviewDayTotals} /> : overviewDate ? <EmptyState compact>这一天还没有阅读记录。</EmptyState> : <><EmptyState compact>这段时间还没有阅读记录。</EmptyState>{insightPage.items.length > 0 && <section className="flow-recent-insights"><header className="flow-section-heading"><h2>最近的洞见</h2><button type="button" className="workspace-text-button" onClick={() => navigate("insights")}>查看全部<CaretRight size={13} /></button></header><AnimatePresence initial={false} mode="popLayout">{insightPage.items.slice(0, 5).map((note) => <MotionItem as="div" key={note.id}><InsightPreview note={note} onClick={showInsight} onContextMenu={openInsightMenu} contextTargetId={contextMenu.targetId} showDocument /></MotionItem>)}</AnimatePresence></section>}</>}
            </section>
          </>}
          {section === "insights" && <>{!insights.data ? <div className="flow-loading-space" aria-hidden="true" /> : !insightPage.items.length ? <EmptyState action={<button type="button" className="workspace-text-button" onClick={() => filters({ insightQuery: "", insightType: "all", insightReview: "all", insightQuestion: "all", insightDocumentId: "" })}>清除筛选</button>}>{view.insightReview === "pending" ? "暂无待回顾洞见。" : "没有符合条件的洞见。"}</EmptyState> : null}<ul className="flow-insight-list" aria-label="洞见列表"><AnimatePresence initial={false} mode="popLayout">{insightPage.items.map((note) => <MotionItem key={note.id} layout={!resizing && "position"}>
            <button type="button" className={"workspace-document-row flow-insight-row" + (note.title ? " has-title" : "") + (selected?.id === note.id ? " workspace-selected" : "")} title={note.title || note.body || note.quote || "高亮"} aria-pressed={selected?.id === note.id} data-focus-key={"flow-insight-" + note.id} data-context-target={contextMenu.targetId === "insight:" + note.id || undefined} onContextMenu={(event) => openInsightMenu(event, note)} onKeyDown={(event) => openInsightMenu(event, note)} onDoubleClick={() => expandInsight(note)} onClick={() => { setSelectedSnapshot(note); change({ selectedInsightId: note.id, ...(selectedId !== note.id ? { insightDetailScrollTop: 0 } : {}) }); }}>{selected?.id === note.id && <MotionSelection layoutId="flow-selected-insight" className="workspace-selection-layer" />}
              <InsightRowLeading note={note} />
              <span className="workspace-document-row-copy">
                <span className="flow-insight-row-heading">
                  {note.title && <span className="workspace-document-title flow-insight-row-title">{note.title}</span>}
                  {note.review?.pending && <BookmarkSimple className="flow-insight-review-mark" size={13} aria-label="待回顾" />}
                </span>
                <span className="flow-insight-row-excerpt">{note.body || note.quote || "高亮"}</span>
                <span className="workspace-document-row-meta flow-insight-row-source">
                  <span className="flow-insight-row-document">{note.documentTitle}</span>
                  <span className="flow-insight-row-identity">{insightTypeLabel(note)}</span>
                  {note.createdAt && <time dateTime={note.createdAt}>{new Date(note.createdAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</time>}
                </span>
              </span>
            </button>
          </MotionItem>)}</AnimatePresence></ul>{insightPage.hasMore && <button type="button" className="flow-load-more" disabled={insights.loading} onClick={() => change({ insightLimit: (view.insightLimit || 30) + 30 })}>加载更多洞见</button>}</>}
          {section === "plan" && <><ReadingPlanList plan={plan} pending={task.pending} read={read} mutate={mutatePlan} planVersion={workspace.planVersion} onContextMenu={openPlanMenu} contextTargetId={contextMenu.targetId} />{!plan.length && <EmptyState action={<button type="button" className="flow-read-button" onClick={openPlanPicker}><Plus size={14} />添加文章</button>}>阅读计划为空。</EmptyState>}</>}
          {section === "history" && <>{!history.data ? <div className="flow-loading-space" aria-hidden="true" /> : !historyPage.items.length ? <EmptyState>{view.historyPeriod === "all" ? "阅读历史从启用计时后开始记录。" : "这段时间还没有阅读记录。"}</EmptyState> : <HistoryTimeline items={historyPage.items} timezone={timezone} onRead={read} onInsight={showInsight} onInsightContextMenu={openInsightMenu} onSessionContextMenu={openSessionMenu} contextTargetId={contextMenu.targetId} pending={task.pending} />}{historyPage.hasMore && <button type="button" className="flow-load-more" disabled={history.loading} onClick={() => change({ historyLimit: (view.historyLimit || 30) + 30 })}>加载更多阅读记录</button>}{summary.data?.trackingStartedAt && <p className="flow-tracking-note">开始记录于 {new Date(summary.data.trackingStartedAt).toLocaleDateString("zh-CN")} · 仅统计有效阅读时间</p>}</>}
        </MotionItem></AnimatePresence></motion.div>
      </section>
        <PanelResize visible={railVisible} onStart={() => setResizing(true)} onEnd={() => setResizing(false)} width={railWidth} minWidth={minWidth} maxWidth={maxWidth} scale={scale} onResize={(width) => change({ panelWidth: Math.max(minWidth, Math.min(maxWidth, width)) / scale })} /><motion.aside layoutScroll initial={false} animate={{ opacity: railVisible ? 1 : 0, paddingLeft: railVisible ? (section === "overview" ? 16 : condensedLayout ? 20 : 24) * scale : 0, paddingRight: railVisible ? (condensedLayout ? 20 : 24) * scale : 0 }} transition={motionTransition("panel", reduced)} inert={!railVisible} aria-hidden={!railVisible || undefined} className={"flow-rail" + (section === "insights" ? " flow-insight-rail" : "")} ref={railMotionRef} onScroll={(event) => { if (section === "insights" && event.target === event.currentTarget && restoredDetail.current.done) change({ insightDetailScrollTop: event.currentTarget.scrollTop }); }} aria-label={section === "overview" ? "阅读安排与待回顾" : "洞见详情"}><AnimatePresence initial={false} mode="popLayout">{railVisible && <MotionItem as="div" key={section === "overview" ? "overview-rail" : "insight-rail"} className="flow-rail-content" layout={false}>{section === "insights" ? <><div className="flow-detail-content-motion"><AnimatePresence initial={false} mode="popLayout"><MotionItem as="div" key={selected?.id || "loading"} layout={false}>{detail}</MotionItem></AnimatePresence></div></> : <>{upcoming}<section className="flow-review-queue" aria-busy={reviews.loading}><header className="flow-section-heading"><h2>待回顾</h2><button type="button" className="workspace-text-button" aria-label="全部待回顾" onClick={() => navigate("insights", { insightReview: "pending", insightType: "all", insightQuestion: "all", insightQuery: "", insightDocumentId: "" })}>查看全部<CaretRight size={12} /></button></header><motion.div layoutScroll className="flow-review-preview-scroll" ref={reviewPreviewScroll} role="region" tabIndex={0} aria-label="待回顾洞见" onScroll={(event) => rememberOverviewPreviewScroll(event, "review")}>{!reviews.data ? <div className="flow-loading-space flow-loading-space-compact" aria-hidden="true" /> : reviews.data.items.length ? <AnimatePresence initial={false} mode="popLayout">{reviews.data.items.slice(0, 5).map((note) => <MotionItem as="div" key={note.id}><InsightPreview note={note} onClick={showInsight} onContextMenu={openInsightMenu} contextTargetId={contextMenu.targetId} showDocument /></MotionItem>)}</AnimatePresence> : <EmptyState compact>暂无待回顾洞见。</EmptyState>}</motion.div></section></>}</MotionItem>}</AnimatePresence></motion.aside>
    </motion.div>
    <WorkspaceDialog open={detailOpen && section === "insights" && Boolean(selected)} title="洞见详情" contentKey={selected?.id} returnFocusKey={detailReturnFocusKey} className="flow-insight-dialog" onClose={() => setDetailOpen(false)}>
      <ActionError message={task.error} onDismiss={() => task.setError("")} />
      <InsightDetail {...detailProps} expanded />
    </WorkspaceDialog>
    <WorkspaceDialog open={pickerOpen} title="添加到阅读计划" onClose={() => setPickerOpen(false)} className="flow-plan-picker">
      <label className="workspace-search flow-picker-search"><MagnifyingGlass size={14} /><input type="search" autoFocus data-dialog-initial aria-label="搜索可添加的文章" placeholder="搜索 Collection" value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} /></label>
      <ActionError message={task.error} />
      <ul><AnimatePresence initial={false} mode="popLayout">{candidates.map((document) => {
        const added = workspace.planIds.includes(document.id);
        return <MotionItem key={document.id}>
          <MaterialIcon kind={document.kind} /><span>{document.title}</span>
          <button type="button" className="workspace-quiet-button" aria-disabled={added || task.pending || undefined} aria-label={added ? document.title + " 已在阅读计划中" : "添加 " + document.title + " 到阅读计划"} onClick={() => {
            if (!added && !task.pending) mutate({ kind: "plan.add", documentId: document.id });
          }}>{added ? <Check size={14} /> : <Plus size={14} />}{added ? "已添加" : "添加"}</button>
        </MotionItem>;
      })}</AnimatePresence></ul>
      {!candidates.length && <EmptyState compact>{pickerQuery ? "没有找到可添加的文章。" : "Collection 中的文章都已在阅读计划里。"}</EmptyState>}
    </WorkspaceDialog>
    {contextMenu.element}
  </motion.main></LayoutGroup>;
}
