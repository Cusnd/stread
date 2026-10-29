import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { MotionItem } from "./Motion.jsx";
import { motionTransition } from "./motion-system.js";
import { useMotionPresence } from "./useMotionPresence.js";
import { ArrowUpRight, BookOpen, LinkBreak, LinkSimple, X } from "./icons";
import { InlineContent } from "./InlineContent";
import { citationCandidateDetails, externalReferenceUrl, incomingCitationSources } from "./citation-relations.js";
import "./citation-relations.css";

export function ReferencePreview({ preview, documentId, onOpenDocument, onLocate, onCommand, readOnly }) {
  const { open, panelRef, close, keepOpen, leave, pin } = preview;
  const retained = useRef(null);
  if (open && preview.relation) retained.current = { open, relation: preview.relation, position: preview.position };
  const visible = Boolean(open && preview.relation);
  const presence = useMotionPresence(visible, { kind: "surface", openState: { opacity: 1, y: 0, scale: 1 }, closedState: { opacity: 0, y: 4, scale: .985 } });
  const relation = retained.current?.relation;
  const position = retained.current?.position;
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const operation = useRef(0);
  useEffect(() => { operation.current += 1; setBusy(false); setError(""); }, [relation?.id]);
  if (!presence.present || !relation) return null;
  const external = externalReferenceUrl(relation);
  const targets = relation.targetDocuments || [], candidates = relation.candidates || [];
  async function change(kind, targetDocumentId) {
    if (!onCommand || busy) return;
    const current = ++operation.current;
    setBusy(true); setError(""); pin();
    try { await onCommand({ kind, documentId, relationId: relation.id, expectedVersion: relation.version, authorized: true, ...(targetDocumentId ? { targetDocumentId } : {}) }); }
    catch (failure) { if (current === operation.current) setError(failure.message || "关联尚未保存，请重试。"); }
    finally { if (current === operation.current) setBusy(false); }
  }
  async function openDocument(target) {
    if (!onOpenDocument || busy) return;
    const current = ++operation.current;
    setBusy(true); setError(""); pin();
    try { await onOpenDocument({ documentId: target.id || target.documentId }); if (current === operation.current) close(); }
    catch (failure) { if (current === operation.current) setError(failure.message || "暂时无法打开关联文章。"); }
    finally { if (current === operation.current) setBusy(false); }
  }
  return createPortal(<motion.section {...presence.motionProps} layout={presence.reduced ? false : "position"} transition={motionTransition("layout", presence.reduced)} ref={panelRef} role="dialog" aria-modal="false" aria-label="参考文献预览" tabIndex={-1} className="reference-preview" data-motion-surface="reference" data-pinned={retained.current.open.pinned || undefined} inert={!visible} aria-hidden={!visible || undefined} style={position}
    onPointerEnter={keepOpen} onPointerLeave={leave} onPointerDown={pin} onFocus={keepOpen} onBlur={leave} onKeyDown={(event) => event.stopPropagation()}>
    <AnimatePresence initial={false} mode="popLayout"><MotionItem as="div" key={relation.id} className="reference-preview-content" layout={false}>
    <header><span>参考文献{relation.label ? " " + relation.label : ""}</span><button type="button" className="reference-close" aria-label="关闭参考文献预览" onClick={() => close(true)}><X size={16} /></button></header>
    <div className="reference-preview-body"><p className="reference-text"><InlineContent text={relation.raw || relation.title || ""} /></p>
      {targets.length > 0 ? <div className="reference-targets">{targets.map((target) => <button type="button" disabled={busy || !onOpenDocument} key={target.id || target.documentId} className="reference-open" onClick={() => openDocument(target)}><BookOpen size={17} /><span>{target.title}</span><ArrowUpRight size={16} /></button>)}</div>
        : <p className="reference-state">{relation.status === "stale" ? "引用内容已更新，需重新核对" : relation.status === "dismissed" ? "已解除关联" : candidates.length ? "找到可能对应的文章" : "尚未导入资料库"}</p>}
      {targets.length === 0 && !["dismissed", "stale"].includes(relation.status) && candidates.length > 0 && <ul className="reference-candidates">{candidates.map((target) => {
        const details = citationCandidateDetails(target);
        return <li key={target.id || target.documentId}><div><span>{target.title}</span>{details.metadata && <small className="reference-candidate-meta">{details.metadata}</small>}{details.differences.map((difference) => <small className="reference-candidate-difference" key={difference}>{difference}</small>)}</div><button type="button" disabled={readOnly || busy || !onCommand} onClick={() => change("relation.link", target.id || target.documentId)}><LinkSimple size={14} />关联</button></li>;
      })}</ul>}
      {error && <p className="reference-error" role="alert">{error}</p>}
    </div>
    <footer><button type="button" onClick={() => { close(); onLocate?.(relation.source); }}>在本文定位</button>{external && <a href={external} target="_blank" rel="noreferrer noopener">原始来源<ArrowUpRight size={13} /></a>}
      {!readOnly && onCommand && targets.length > 0 && <button type="button" disabled={busy} className="reference-unlink" onClick={() => change("relation.dismiss")}><LinkBreak size={13} />解除关联</button>}
      {!readOnly && onCommand && ["dismissed", "stale"].includes(relation.status) && <button type="button" disabled={busy} onClick={() => change("relation.reset")}>重新识别</button>}
    </footer>
    </MotionItem></AnimatePresence>
  </motion.section>, document.body);
}

export function CitationBacklinks({ relations, onOpenDocument }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function openDocument(target) {
    if (busy || !onOpenDocument) return;
    setBusy(true); setError("");
    try { await onOpenDocument(target); }
    catch (failure) { setError(failure.message || "暂时无法打开引用来源。"); }
    finally { setBusy(false); }
  }
  if (relations?.error) return <p className="citation-relations-error" role="status">文章关联暂时无法加载：{relations.error}</p>;
  const incoming = relations?.incoming || [];
  if (!incoming.length) return null;
  const documentCount = new Set(incoming.map((item) => item.documentId)).size;
  return <details className="citation-backlinks"><summary>被 {documentCount} 篇资料引用</summary><ul>{incoming.map((relation) => {
    const sources = incomingCitationSources(relation);
    return <li key={relation.id + ":" + relation.documentId}><span className="citation-backlink-title">{relation.title}</span><div>{sources.length ? sources.map((source, index) => <button type="button" disabled={busy || !onOpenDocument} key={[source.blockId, source.nodeId, source.itemId, index].join(":")} onClick={() => openDocument({ documentId: relation.documentId, source })}>{sources.length > 1 ? "引用位置 " + (index + 1) : "查看引用"}<ArrowUpRight size={13} /></button>) : <button type="button" disabled={busy || !onOpenDocument} onClick={() => openDocument({ documentId: relation.documentId })}>打开文章<ArrowUpRight size={13} /></button>}</div></li>;
  })}</ul>{error && <p className="reference-error" role="alert">{error}</p>}</details>;
}
