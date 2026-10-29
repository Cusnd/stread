import { matchesShortcut, formatShortcut, getReadingShortcuts } from "./reading-shortcuts";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useMotionPresence } from "./useMotionPresence.js";
import { ArrowUpRight, Check, Copy, X } from "./icons";
import katex from "katex";
import { InsightQuote } from "./InsightQuote";
import { InsightActions } from "./InsightActions";
import { acquirePageScrollLock } from "./page-scroll-lock.js";

export function QuestionDetail({ question, open = true, sourceLanguage, onClose, onLocate, onEdit, onDelete, onReview, readOnly, busy, editing, deleteUnavailable, error, returnFocus }) {
  const title = (question.title || "").trim();
  const dialogRef = useRef(null);
  const [copyStatus, setCopyStatus] = useState("");
  const copyTimer = useRef(null);
  const [visible, setVisible] = useState(open);
  const closing = useRef(null);
  const presence = useMotionPresence(open && visible, { kind: "surface", onExit: finishClose });
  useEffect(() => { if (open) { closing.current = null; setVisible(true); } }, [open, question.id]);

  function finishClose() {
    const complete = closing.current || onClose;
    closing.current = null;
    complete();
  }

  function requestClose(complete = onClose) {
    if (closing.current) return;
    closing.current = complete;
    setVisible(false);
  }

  useEffect(() => () => clearTimeout(copyTimer.current), []);
  async function copyReference() {
    try {
      await navigator.clipboard.writeText(question.reference);
      setCopyStatus("已复制");
    } catch {
      setCopyStatus("复制失败，可手动选择编号");
    }
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyStatus(""), 2400);
  }

  useEffect(() => {
    if (!presence.present) return;
    const dialog = dialogRef.current;
    const previous = returnFocus || document.activeElement;
    const releaseScrollLock = acquirePageScrollLock();
    if (!dialog.open) dialog.showModal();
    return () => {
      dialog.close();
      releaseScrollLock();
      const active = document.activeElement;
      if (previous?.isConnected && !previous.closest('[inert], [aria-hidden="true"]') && (dialog.contains(active) || active === document.body || active === document.documentElement)) previous.focus({ preventScroll: true });
    };
  }, [presence.present]);

  function dismissBackdrop(event) {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) requestClose();
  }

  function keepFocus(event) {
    if (matchesShortcut(event.nativeEvent, "close")) { event.preventDefault(); event.stopPropagation(); requestClose(); return; }
    if (event.key !== "Tab") return;
    const items = [...event.currentTarget.querySelectorAll("button:not(:disabled), [tabindex='0']")].filter((item) => item.getClientRects().length && !item.closest("[inert]"));
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  if (!presence.present) return null;
  return <motion.dialog {...presence.motionProps} ref={dialogRef} className="question-dialog" data-motion-surface="question" data-state={open && visible ? "open" : "closed"} inert={!open || !visible} aria-hidden={!open || !visible || undefined} aria-modal="true" aria-labelledby={title ? "question-title" : "question-identity-label"} onKeyDown={keepFocus} onCancel={(event) => { event.preventDefault(); if (getReadingShortcuts().close === "Escape") requestClose(); }} onClick={dismissBackdrop}>
    <header className="question-dialog-header">
      <div className="question-identity"><span id="question-identity-label" className="question-reference-label">问题 <button className="question-reference" onClick={copyReference} aria-label={"复制问题编号 " + question.reference} title="复制问题编号"><span className="reference-number">{question.reference}</span>{copyStatus === "已复制" ? <Check size={13} /> : <Copy size={13} />}</button></span><span className="question-status">{question.answer && <Check size={13} />}{question.answer ? "已解决" : "待回答"}</span><span className="reference-feedback" role="status">{copyStatus}</span></div>
      <div className="question-dialog-tools"><InsightActions note={question} onEdit={(note, trigger) => requestClose(() => onEdit(note, trigger))} onDelete={onDelete} onCopy={copyReference} onReview={onReview} readOnly={readOnly} busy={busy} editing={editing} deleteUnavailable={deleteUnavailable} /><button className="icon-button" aria-label="关闭问题详情" title={"关闭 · " + formatShortcut(getReadingShortcuts().close)} disabled={busy} onClick={() => requestClose()}><X size={20} /></button></div>
    </header>
    {error && <p className="question-dialog-error" role="alert">{error}</p>}
    <div className="question-dialog-scroll" tabIndex={0} aria-label="问题与回答内容">
      {title && <h2 id="question-title">{title}</h2>}
      <p className="question-body">{question.body}</p>
      <div className="question-source"><span>{question.blockId ? "关联原文" : "文档问题"}</span><InsightQuote note={question} sourceLanguage={sourceLanguage} />{question.blockId && <button onClick={() => requestClose(() => onLocate(question))}>回到原文 <ArrowUpRight size={13} /></button>}</div>
      {question.answer ? <section className="question-answer" aria-labelledby="answer-heading">
        <div className="answer-heading"><h3 id="answer-heading">回答</h3><span>{question.answer.sourceLabel}</span></div>
        {(question.answer.blocks || [{ type: "paragraph", text: question.answer.text || question.answer.body || "" }]).map((block, index) => block.type === "heading"
          ? <h4 key={index}>{block.text}</h4>
          : block.type === "math"
            ? <div key={index} className="answer-equation" tabIndex={0} role="group" aria-label="回答中的公式，可横向滚动" dangerouslySetInnerHTML={{ __html: katex.renderToString(block.tex, { displayMode: true, throwOnError: false, trust: false }) }} />
            : <p key={index}>{block.text}</p>)}
      </section> : <section className="question-unanswered"><h3>还没有回答</h3><p>回答保存后，会显示在这里。</p></section>}
    </div>
  </motion.dialog>;
}
