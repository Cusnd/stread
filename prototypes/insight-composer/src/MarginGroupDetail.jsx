import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MotionItem } from "./Motion.jsx";
import { ArrowUpRight, CheckCircle, ChatText, NotePencil, Question, X } from "./icons";
import { InsightActions } from "./InsightActions";
import { InsightQuote } from "./InsightQuote";
import { useReaderRuntime } from "./ReaderRuntime";
import { formatShortcut, matchesShortcut } from "./reading-shortcuts";
import { useModalDialog } from "./useModalDialog.js";
import "./margin-group-detail.css";

const EMPTY_NOTES = Object.freeze([]);
const kindFor = (note) => note.type === "question"
  ? { label: "问题", Icon: note.answer ? CheckCircle : Question, status: note.answer ? "已解决" : "待回答" }
  : note.type === "note" ? { label: "笔记", Icon: NotePencil } : { label: "批注", Icon: ChatText };

/** The margin groups presentation only: every action receives the original note. */
export function MarginGroupDetail({ open, notes = EMPTY_NOTES, groupId, selectedNoteId, returnFocus, sourceLanguage, colorFor,
  onClose, onLocate, onEdit, onDelete, onReview, onCopy, onOpenQuestion, readOnly = false, busy = false,
  editingId, deleteUnavailable = false, error }) {
  const runtime = useReaderRuntime();
  const shortcuts = useSyncExternalStore(runtime.shortcuts.subscribe, runtime.shortcuts.getSnapshot);
  const titleId = useId();
  const dialogRef = useRef(null);
  const scrollRef = useRef(null);
  const closeRef = useRef(null);
  const initialized = useRef(null);
  const closing = useRef(null);
  const pendingDeleteFocus = useRef(null);
  const copyTimer = useRef(null);
  const mounted = useRef(true);
  const latest = useRef(null);
  const [visible, setVisible] = useState(open);
  const [copyStatus, setCopyStatus] = useState(null);
  const [actionError, setActionError] = useState("");
  latest.current = { open, onClose, returnFocus, busy, groupId };

  function finishClose(trigger) {
    const action = closing.current?.after;
    closing.current = null;
    initialized.current = null;
    // The shared lifecycle releases the native layer before the next action.
    if (latest.current.open) latest.current.onClose?.();
    action?.(trigger);
  }

  const presence = useModalDialog(open && visible, {
    ref: dialogRef, onClose: () => requestClose(), initialFocus: closeRef,
    returnFocus: () => latest.current.returnFocus,
    fallbackFocus: () => dialogRef.current?.closest(".reader-app")?.querySelector(".article"),
    afterClose: finishClose, allowEscape: () => shortcuts.close === "Escape",
  });

  function requestClose(after = null, force = false) {
    if (closing.current || !latest.current.open || (!force && latest.current.busy)) return;
    closing.current = { after };
    dialogRef.current?.setAttribute("inert", "");
    dialogRef.current?.setAttribute("aria-hidden", "true");
    setVisible(false);
  }

  useEffect(() => {
    if (!open) { initialized.current = null; return; }
    closing.current = null;
    pendingDeleteFocus.current = null;
    setActionError("");
    setCopyStatus(null);
    setVisible(true);
  }, [open, groupId, selectedNoteId]);

  useLayoutEffect(() => {
    if (!presence.present || !open || !visible || !scrollRef.current) return;
    const key = JSON.stringify([groupId, selectedNoteId || null]);
    if (initialized.current === key) return;
    initialized.current = key;
    const target = selectedNoteId && [...scrollRef.current.querySelectorAll("[data-group-detail-note-id]")]
      .find((element) => element.dataset.groupDetailNoteId === selectedNoteId);
    const scroll = scrollRef.current;
    scroll.scrollTop = target ? Math.max(0, target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 12) : 0;
    closeRef.current?.focus({ preventScroll: true });
  }, [presence.present, open, visible, groupId, selectedNoteId]);

  useLayoutEffect(() => {
    if (!open || !visible) return;
    if (!notes.length) { requestClose(null, true); return; }
    const pending = pendingDeleteFocus.current;
    if (!pending || notes.some((note) => note.id === pending.deletedId)) return;
    pendingDeleteFocus.current = null;
    const nextId = notes.some((note) => note.id === pending.nextId) ? pending.nextId : notes[0]?.id;
    const next = [...(scrollRef.current?.querySelectorAll("[data-group-detail-note-id]") || [])]
      .find((element) => element.dataset.groupDetailNoteId === nextId);
    (next?.querySelector(".insight-more") || next || closeRef.current)?.focus({ preventScroll: true });
  }, [notes, open, visible]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(copyTimer.current); };
  }, []);

  async function archiveNote(note) {
    if (!onDelete || busy || readOnly || editingId === note.id) return;
    const index = notes.findIndex((item) => item.id === note.id);
    pendingDeleteFocus.current = { deletedId: note.id, nextId: notes[index + 1]?.id || notes[index - 1]?.id };
    setActionError("");
    try {
      const result = await onDelete(note);
      if (result === false) pendingDeleteFocus.current = null;
    } catch (failure) {
      pendingDeleteFocus.current = null;
      if (mounted.current) setActionError(failure?.message || "删除尚未完成，请重试。");
    }
  }

  async function copyReference(note) {
    if (!onCopy) return;
    const currentGroup = groupId;
    let result;
    try { result = await onCopy(note); } catch { result = false; }
    if (!mounted.current || currentGroup !== latest.current.groupId || !latest.current.open) return;
    // Older callers do not return a receipt; never infer clipboard success.
    if (result !== true && result !== false) return;
    setCopyStatus({ id: note.id, text: result ? "已复制" : "复制失败，可手动选择编号" });
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyStatus(null), 2400);
  }

  function handleKeys(event) {
    if (event.defaultPrevented || event.isComposing || event.nativeEvent.isComposing) return;
    if (matchesShortcut(event.nativeEvent, "close", shortcuts)) {
      event.preventDefault(); event.stopPropagation(); requestClose(); return;
    }
    presence.dialogProps.onKeyDown(event);
  }

  if (!presence.present) return null;
  const kinds = new Set(notes.map((note) => kindFor(note).label));
  const groupLabel = kinds.size === 1 ? kinds.values().next().value : "洞见";
  return <motion.dialog {...presence.motionProps} {...presence.dialogProps} className="margin-group-dialog ui-modal" data-motion-surface="margin-group-detail"
    aria-labelledby={titleId} onKeyDown={handleKeys}>
    <header className="margin-group-dialog-header">
      <h2 id={titleId}>本段{groupLabel}<span>{notes.length}</span></h2>
      <button ref={closeRef} className="icon-button ui-button" data-ui-button="tool" aria-label="关闭段落批注" title={"关闭" + (shortcuts.close ? " · " + formatShortcut(shortcuts.close) : "")}
        disabled={busy} onClick={() => requestClose()}><X size={18} /></button>
    </header>
    {(error || actionError) && <p className="margin-group-dialog-error" role="alert">{error || actionError}</p>}
    <div ref={scrollRef} className="margin-group-dialog-scroll" tabIndex={0} aria-label="本段完整洞见" aria-busy={busy || undefined}>
      <AnimatePresence initial={false} mode="popLayout">
        {notes.map((note) => {
          const Kind = kindFor(note);
          return <MotionItem as="section" key={note.id} layout="position" className={"margin-group-detail-note" + (selectedNoteId === note.id ? " is-selected" : "")}
            tabIndex={-1} data-group-detail-note-id={note.id} aria-label={Kind.label + " " + (note.reference || "")}
            style={{ "--note-color": colorFor?.(note.color)?.value || "var(--line)" }}>
            <div className="margin-group-detail-note-header">
              <span className="margin-group-detail-color" aria-hidden="true" />
              {note.type === "question" && <span className="margin-group-detail-status" title={Kind.status} aria-label={Kind.status}><Kind.Icon size={15} /></span>}
              <span className="insight-identity"><span>{Kind.label}</span><button className="insight-reference" aria-label={"复制" + Kind.label + "编号 " + note.reference} title="复制编号" onClick={() => copyReference(note)}><span className="reference-number">{note.reference}</span></button></span>
              <InsightActions note={note} onEdit={onEdit ? (item) => requestClose((trigger) => onEdit(item, trigger)) : undefined} onDelete={archiveNote}
                onCopy={copyReference} onReview={onReview} readOnly={readOnly || !onEdit} busy={busy} editing={editingId === note.id} deleteUnavailable={deleteUnavailable || !onDelete} />
            </div>
            {copyStatus?.id === note.id && <span className="margin-group-copy-status" role="status">{copyStatus.text}</span>}
            {note.title && <h3>{note.title}</h3>}
            {note.body && <p className="margin-group-detail-body">{note.body}</p>}
            <div className="margin-group-detail-source"><InsightQuote note={note} sourceLanguage={sourceLanguage}
              onLocate={onLocate ? () => requestClose((trigger) => onLocate(note, trigger)) : undefined} /></div>
            {note.type === "question" && onOpenQuestion && <div className="margin-group-detail-actions">
              <button onClick={() => requestClose((trigger) => onOpenQuestion(note, trigger))}>查看完整问题与回答 <ArrowUpRight size={13} /></button>
            </div>}
          </MotionItem>;
        })}
      </AnimatePresence>
    </div>
  </motion.dialog>;
}
