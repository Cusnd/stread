import { useCallback, useEffect, useId, useRef, useState } from "react";
import { motion } from "motion/react";
import { Article, BookOpen, FileText, Notebook, X } from "../icons";
import { isModalFocusTarget, useModalDialog } from "../useModalDialog.js";

import { InlineError } from "../Feedback.jsx";

export function ActionError(props) { return <InlineError {...props} className="workspace-error" />; }

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

export function WorkspaceDialog({ open, title, headingContent, children, onClose, contentKey, initialFocusKey, returnFocusKey, size = "simple", className = "" }) {
  const titleId = useId();
  const ref = useRef(null);
  const openingFocusKey = useRef(null);
  const content = useRef({ title, headingContent, children, className, size });
  if (open) content.current = { title, headingContent, children, className, size };
  const findKey = (key, root = document) => key && [...root.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === key && isModalFocusTarget(node));
  const { motionProps, dialogProps } = useModalDialog(open, {
    ref, onClose, focusKey: `${contentKey || ""}:${initialFocusKey || ""}`,
    beforeOpen: () => { openingFocusKey.current = document.activeElement?.dataset.focusKey; },
    initialFocus: () => findKey(initialFocusKey, ref.current) || ref.current.querySelector("[data-dialog-initial]") || ref.current.querySelector("[data-dialog-close]"),
    returnFocus: () => findKey(returnFocusKey) || findKey(openingFocusKey.current),
    fallbackFocus: () => findKey("collection-search") || findKey("collection-navigation-toggle"),
  });
  const shown = open ? { title, headingContent, children, className, size } : content.current;
  return <motion.dialog {...motionProps} {...dialogProps} className={"workspace-ui workspace-dialog ui-modal " + shown.className} data-modal-size={shown.size} aria-labelledby={titleId}>
    <header className="workspace-dialog-heading"><h2 id={titleId}>{shown.title}</h2>{shown.headingContent}<button className="workspace-icon-button ui-button" data-ui-button="tool" data-dialog-close aria-label="关闭面板" type="button" onClick={onClose}><X size={18} /></button></header><div className="workspace-dialog-body">{shown.children}</div>
  </motion.dialog>;
}
