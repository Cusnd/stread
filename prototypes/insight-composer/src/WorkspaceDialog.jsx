import { useEffect, useLayoutEffect, useRef } from "react";
import { motion } from "motion/react";
import { X } from "./icons";
import { acquirePageScrollLock } from "./page-scroll-lock.js";
import { useMotionPresence } from "./useMotionPresence.js";

export function WorkspaceDialog({ open, onClose, title, children, wide = false, busy = false }) {
  const ref = useRef(null);
  const close = useRef(onClose);
  const releaseScroll = useRef(null);
  const previousFocus = useRef(null);
  close.current = onClose;
  const finishClose = () => {
    if (ref.current?.open) ref.current.close();
    releaseScroll.current?.();
    releaseScroll.current = null;
    if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    previousFocus.current = null;
  };
  const { present, motionProps } = useMotionPresence(open, { onExit: finishClose });
  const closing = !open && present;
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (open) {
      if (!releaseScroll.current) {
        previousFocus.current = document.activeElement;
        releaseScroll.current = acquirePageScrollLock();
      }
      if (!dialog.open) dialog.showModal();
    }
  }, [open]);
  useEffect(() => {
    const dialog = ref.current;
    const cancel = (event) => { event.preventDefault(); close.current(); };
    dialog.addEventListener("cancel", cancel);
    return () => {
      dialog.removeEventListener("cancel", cancel);
      finishClose();
    };
  }, []);
  return <motion.dialog {...motionProps} ref={ref} className={"workspace-service-dialog" + (wide ? " is-wide" : "") + (closing ? " is-closing" : "")} data-state={open ? "open" : present ? "closing" : "closed"} inert={!open} aria-label={title} onClick={(event) => {
    if (!open || event.target !== ref.current) return;
    const bounds = ref.current.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <div className="workspace-service-surface" inert={closing || undefined}>
      <header><h2>{title}</h2><button type="button" className="workspace-icon" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="workspace-service-body" aria-busy={busy}>{children}</div>
    </div>
  </motion.dialog>;
}
