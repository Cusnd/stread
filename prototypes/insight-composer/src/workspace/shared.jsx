import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { Article, BookOpen, FileText, Notebook, WarningCircle, X } from "../icons";
import { acquirePageScrollLock } from "../page-scroll-lock.js";
import { useMotionPresence } from "../useMotionPresence.js";
import { useReducedMotionPreference } from "../useReducedMotionPreference.js";
import { motionTransition } from "../motion-system.js";

export function MaterialIcon({ kind, ...props }) {
  const Icon = { 论文: FileText, 书籍: BookOpen, 讲义: Notebook, 文章: Article, 文档: FileText }[kind] || FileText;
  return <Icon size={16} aria-hidden="true" {...props} />;
}

export function focusByKey(key, fallback) {
  const nodes = [...document.querySelectorAll("[data-focus-key]")];
  const visible = (node) => node && node.isConnected && !node.disabled && node.getClientRects().length && !node.closest("[inert]");
  const target = nodes.find((node) => node.dataset.focusKey === key && visible(node)) || nodes.find((node) => node.dataset.focusKey === fallback && visible(node));
  target?.focus({ preventScroll: true });
  return Boolean(target);
}

export function useView(view, setView) {
  const current = useRef(view || {});
  current.current = view || {};
  return useCallback((patch) => {
    const next = { ...current.current, ...patch };
    current.current = next;
    setView(next);
  }, [setView]);
}

export function useTask(busy) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const run = async (action) => {
    if (running.current || busy) return { ok: false };
    running.current = true;
    setPending(true);
    setError("");
    try { return { ok: true, value: await action() }; }
    catch (failure) { setError(failure?.message || "操作未保存，请重试。"); return { ok: false }; }
    finally { running.current = false; setPending(false); }
  };
  return { pending: pending || Boolean(busy), error, setError, run };
}

function ErrorMessage({ message, onDismiss }) {
  const reduced = useReducedMotionPreference();
  const present = useIsPresent();
  return <motion.div className="workspace-error" role="alert" inert={!present || undefined} aria-hidden={!present || undefined}
    initial={{ opacity: 0, y: reduced ? 0 : -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -4 }} transition={motionTransition("content", reduced)}
    ><WarningCircle size={17} aria-hidden="true" /><span>{message}</span>{onDismiss && <button type="button" className="workspace-icon-button" onClick={onDismiss} aria-label="关闭错误提示"><X size={15} /></button>}</motion.div>;
}

export function ActionError({ message, onDismiss }) {
  return <AnimatePresence initial={false}>{message && <ErrorMessage key="error" message={message} onDismiss={onDismiss} />}</AnimatePresence>;
}

export function useMedia(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function WorkspaceDialog({ open, title, children, onClose, contentKey, initialFocusKey, returnFocusKey, className = "" }) {
  const titleId = useId();
  const ref = useRef(null);
  const restore = useRef(null);
  const latestReturnFocusKey = useRef(returnFocusKey);
  latestReturnFocusKey.current = returnFocusKey;
  const releaseScroll = useRef(null);
  const content = useRef({ title, children, className });
  if (open) content.current = { title, children, className };
  const restoreFocus = () => {
    const saved = restore.current;
    releaseScroll.current?.(); releaseScroll.current = null;
    if (!saved) return;
    if (latestReturnFocusKey.current && focusByKey(latestReturnFocusKey.current)) { /* The invoking item may have been archived while this dialog was open. */ }
    else if (saved?.element?.isConnected && saved.element.getClientRects().length && !saved.element.disabled) saved.element.focus({ preventScroll: true });
    else focusByKey(saved?.key, "collection-search") || focusByKey("collection-navigation-toggle");
    restore.current = null;
  };
  const { present, motionProps } = useMotionPresence(open, { onExit: () => {
    if (ref.current?.open) ref.current.close();
    restoreFocus();
  } });
  const phase = open ? "open" : present ? "closing" : "closed";
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (open) {
      if (!restore.current) restore.current = { element: document.activeElement, key: document.activeElement?.dataset.focusKey };
      if (!releaseScroll.current) releaseScroll.current = acquirePageScrollLock();
      if (!dialog.open) {
        dialog.showModal();
      }
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const dialog = ref.current;
      const target = initialFocusKey && [...dialog.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === initialFocusKey && !node.disabled);
      (target || dialog.querySelector("[data-dialog-initial]") || dialog.querySelector("button"))?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, contentKey, initialFocusKey]);
  useEffect(() => () => { if (ref.current?.open) ref.current.close(); restoreFocus(); }, []);
  const trap = (event) => {
    if (phase === "closing") { event.preventDefault(); return; }
    if (event.key !== "Tab") return;
    const controls = [...ref.current.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')].filter((node) => node.getClientRects().length && !node.closest("[inert]"));
    if (!controls.length) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  };
  const shown = open ? { title, children, className } : content.current;
  return <motion.dialog {...motionProps} ref={ref} className={"workspace-ui workspace-dialog " + shown.className} data-state={phase} inert={!open} aria-labelledby={titleId} onKeyDown={trap} onCancel={(event) => { event.preventDefault(); if (open) onClose(); }} onClick={(event) => {
    if (!open || event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}><header className="workspace-dialog-heading"><h2 id={titleId}>{shown.title}</h2><button className="workspace-icon-button" aria-label="关闭面板" type="button" onClick={onClose}><X size={18} /></button></header><div className="workspace-dialog-body">{shown.children}</div></motion.dialog>;
}
