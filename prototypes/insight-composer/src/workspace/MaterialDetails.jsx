import { ReaderSelect } from "../ReaderSelect.jsx";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { MotionItem } from "../Motion.jsx";
import { useMotionPresence } from "../useMotionPresence.js";
import { useReducedMotionPreference } from "../useReducedMotionPreference.js";
import { useImmediateReducedMotion } from "../useImmediateReducedMotion.js";
import { motionTransition } from "../motion-system.js";
import { Archive, ArrowCounterClockwise, BookmarkSimple, BookOpen, CaretRight, ChatText, DotsThree, NotePencil, Plus } from "../icons";
import { DecorativeIcon } from "../InterfaceMode.jsx";
import "../insight-management.css";
import { documentCategories, readingPosition, statusNames } from "./model.js";
import { MaterialIcon } from "./shared.jsx";

function MaterialActions({ material, onEdit, onArchive, pending }) {
  const id = useId();
  const trigger = useRef(null), menu = useRef(null);
  const focusLast = useRef(false);
  const [open, setOpen] = useState(false);
  const present = useIsPresent();
  const disabled = pending || !present;
  function position() {
    if (!trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = menu.current.offsetWidth, height = menu.current.offsetHeight;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const right = left + (viewport?.width || innerWidth), bottom = top + (viewport?.height || innerHeight);
    Object.assign(menu.current.style, {
      left: Math.max(left + 10, Math.min(rect.right - width, right - width - 10)) + "px",
      top: Math.max(top + 10, Math.min(rect.bottom + height + 6 <= bottom - 10 ? rect.bottom + 6 : rect.top - height - 6, bottom - height - 10)) + "px",
    });
  }
  function close(restoreFocus = true) {
    menu.current?.setAttribute("inert", "");
    menu.current?.setAttribute("aria-hidden", "true");
    menu.current?.hidePopover();
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  function show(last = false) {
    if (disabled) return;
    focusLast.current = last;
    trigger.current.click();
  }
  function act(callback) {
    if (disabled) return;
    // The existing dialogs capture this trigger to restore focus on cancellation.
    close();
    callback(material);
  }
  useLayoutEffect(() => { close(false); }, [disabled, material.version]);
  useLayoutEffect(() => {
    if (!open) return;
    position();
    const items = menu.current.querySelectorAll("button:not(:disabled)");
    (focusLast.current ? items[items.length - 1] : items[0])?.focus({ preventScroll: true });
    focusLast.current = false;
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open]);
  return <div className="insight-actions workspace-material-actions">
    <button ref={trigger} type="button" className="insight-more" disabled={disabled} popoverTarget={id} aria-label={"资料操作：" + material.title} title="资料操作" aria-haspopup="menu" aria-controls={id} aria-expanded={open} data-focus-key={"material-more-" + material.id}
      onKeyDown={(event) => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); show(event.key === "ArrowUp"); } }}><DotsThree size={20} weight="bold" /></button>
    <div ref={menu} id={id} className="insight-action-menu" popover="auto" role="menu" aria-label="资料操作" inert={!open || disabled} aria-hidden={!open || disabled}
      onBeforeToggle={(event) => { const opening = event.newState === "open"; event.currentTarget.toggleAttribute("inert", !opening || disabled); event.currentTarget.setAttribute("aria-hidden", String(!opening || disabled)); if (!opening) setOpen(false); }}
      onToggle={(event) => setOpen(event.currentTarget.matches(":popover-open"))}
      onKeyDown={(event) => {
        if (event.isComposing || event.nativeEvent.isComposing) return;
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); close(); return; }
        if (event.key === "Tab") { event.preventDefault(); close(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll("button:not(:disabled)")];
        const index = items.indexOf(document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus({ preventScroll: true });
      }}>
      {onEdit && <button type="button" role="menuitem" disabled={disabled} onClick={() => act(onEdit)}><DecorativeIcon><NotePencil size={15} aria-hidden="true" /></DecorativeIcon>编辑资料</button>}
      {onArchive && <button type="button" role="menuitem" disabled={disabled} onClick={() => act(onArchive)}><DecorativeIcon><Archive size={15} aria-hidden="true" /></DecorativeIcon>归档资料</button>}
    </div>
  </div>;
}

function Synopsis({ children }) {
  const id = useId();
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const reduced = useReducedMotionPreference();
  const [dimensions, setDimensions] = useState(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const full = element.getBoundingClientRect().height;
      const collapsed = Number.parseFloat(getComputedStyle(element).lineHeight) * 5;
      setDimensions((current) => current?.full === full && current?.collapsed === collapsed ? current : { full, collapsed });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children]);
  const overflowing = dimensions && dimensions.full > dimensions.collapsed + 1;
  return <div className="workspace-synopsis-wrap"><motion.div className="workspace-synopsis-viewport" initial={false} animate={{ height: dimensions ? expanded ? dimensions.full : Math.min(dimensions.full, dimensions.collapsed) : "auto" }} transition={motionTransition("layout", reduced)}><p id={id} ref={ref} className="workspace-detail-synopsis">{children}</p></motion.div>{(overflowing || expanded) && <button type="button" className="workspace-synopsis-expand" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>{expanded ? "收起简介" : "展开简介"}</button>}</div>;
}

export function MaterialDetails(props) {
  return <div className="workspace-detail-content-motion"><AnimatePresence initial={false} mode="popLayout"><MotionItem as="div" key={props.material?.id || "empty"} layout={false}><MaterialDetailsContent {...props} /></MotionItem></AnimatePresence></div>;
}

function PlanButton({ material, planned, pending, onPlan }) {
  const reduced = useReducedMotionPreference();
  const buttonRef = useImmediateReducedMotion(reduced);
  const addRef = useImmediateReducedMotion(reduced);
  const addedRef = useImmediateReducedMotion(reduced);
  return <motion.button ref={buttonRef} type="button" className="workspace-detail-plan"
    aria-disabled={pending || undefined} aria-pressed={planned} aria-label={planned ? "已加入阅读计划" : "加入阅读计划"}
    data-focus-key={"detail-plan-" + material.id} onClick={() => { if (!pending) onPlan(material); }}
    whileTap={pending || reduced ? undefined : { scale: 0.98 }} transition={motionTransition("control", reduced)}>
    <span className="workspace-plan-labels" aria-hidden="true">
      <motion.span ref={addRef} initial={false} animate={{ opacity: planned ? 0 : 1, y: planned && !reduced ? -3 : 0 }} transition={motionTransition("control", reduced)}><Plus size={14} />加入阅读计划</motion.span>
      <motion.span ref={addedRef} initial={false} animate={{ opacity: planned ? 1 : 0, y: !planned && !reduced ? 3 : 0 }} transition={motionTransition("control", reduced)}><BookmarkSimple size={14} />已加入阅读计划</motion.span>
    </span>
  </motion.button>;
}

const diagnosticsOpen = Object.freeze({ height: "auto", opacity: 1 });
const diagnosticsClosed = Object.freeze({ height: 0, opacity: 0 });

function DocumentDiagnostics({ items }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const { present, reduced, motionProps } = useMotionPresence(expanded, {
    kind: "content", openState: diagnosticsOpen, closedState: diagnosticsClosed,
  });
  const arrowRef = useImmediateReducedMotion(reduced);
  return <section className="workspace-diagnostics">
    <button type="button" className="workspace-diagnostics-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>
      <motion.span ref={arrowRef} className="workspace-diagnostics-arrow" aria-hidden="true" initial={false} animate={{ rotate: expanded ? 90 : 0 }} transition={motionTransition("content", reduced)}><CaretRight size={11} /></motion.span>
      {items.length} 条文档提示
    </button>
    {/* The detail parent's initial={false} also suppresses nested initial styles. */}
    <motion.div {...motionProps} id={id} className="workspace-diagnostics-body" style={{ height: 0, opacity: 0 }} hidden={!present} inert={!expanded || undefined} aria-hidden={!expanded || undefined}>
      <ul>{items.map((item, index) => <li key={item.code + ":" + index}>{item.message}</li>)}</ul>
    </motion.div>
  </section>;
}

function MaterialDetailsContent({ material, workspace, onRead, onPlan, onStatus, onEdit, onArchive, onRestore, pending }) {
  if (!material) return <p className="workspace-detail-empty">选择一份资料，查看阅读信息。</p>;
  const planned = workspace.planIds.includes(material.id);
  const categories = documentCategories(material, workspace.collections);
  return <div className="workspace-material-detail">
    <div className="workspace-detail-meta"><div className="workspace-document-kind"><MaterialIcon kind={material.kind} /><span>{material.kind}</span>{material.archivedAt && <span className="workspace-archived-label">已归档</span>}{material.insightCount > 0 && <><span aria-hidden="true">·</span><span className="workspace-detail-insight-count">{material.insightCount} 条洞见</span></>}</div>{!material.archivedAt && (onEdit || onArchive) && <MaterialActions material={material} onEdit={onEdit} onArchive={onArchive} pending={pending} />}</div>
    <h2>{material.title}</h2><Synopsis key={material.id}>{material.summary || "尚未添加简介。"}</Synopsis>
    <div className="workspace-reading-location"><span>阅读位置</span><span>{readingPosition(material)}</span></div>
    {material.archivedAt ? <button type="button" className="workspace-primary-button workspace-read-button" disabled={pending} onClick={() => onRestore(material)} data-focus-key={"restore-" + material.id}><ArrowCounterClockwise size={16} />恢复资料</button> : <><button type="button" className="workspace-primary-button workspace-read-button" aria-disabled={pending || undefined} onClick={() => { if (!pending) onRead(material, material.status === "done"); }} data-focus-key={"read-" + material.id}><BookOpen size={16} />{material.status === "reading" ? "继续阅读" : material.status === "done" ? "重新阅读" : "开始阅读"}</button><PlanButton material={material} planned={planned} pending={pending} onPlan={onPlan} /></>}
    {!material.archivedAt && <label className="workspace-status-field"><span>阅读状态</span><ReaderSelect aria-label={material.title + "的阅读状态"} value={material.status} disabled={pending} onChange={(event) => onStatus(material, event.target.value)}>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</ReaderSelect></label>}
    <div className="workspace-detail-block"><p className="workspace-detail-label">所属分类</p><div className="workspace-category-paths">{categories.length ? categories.map((path) => <p key={path}>{path}</p>) : <p>未分类</p>}</div>{material.tags.length > 0 && <div className="workspace-tag-list">{material.tags.map((tag) => <span className="workspace-tag" key={tag}>{tag}</span>)}</div>}</div>
    {material.question && <div className="workspace-detail-question"><p className="workspace-detail-label"><ChatText size={14} />阅读问题</p><p>{material.question}</p></div>}
    {material.diagnostics?.length > 0 && <DocumentDiagnostics items={material.diagnostics} />}
  </div>;
}
