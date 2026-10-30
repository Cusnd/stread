import { motion } from "motion/react";
import { X } from "./icons";
import { useModalDialog } from "./useModalDialog.js";

export function WorkspaceDialog({ open, onClose, title, children, wide = false, busy = false }) {
  const { motionProps, dialogProps } = useModalDialog(open, { onClose });
  return <motion.dialog {...motionProps} {...dialogProps} className="workspace-service-dialog ui-modal" data-modal-size={wide ? "wide" : "simple"} aria-label={title}>
    <div className="workspace-service-surface">
      <header><h2>{title}</h2><button type="button" className="workspace-icon ui-button" data-ui-button="tool" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="workspace-service-body" aria-busy={busy}>{children}</div>
    </div>
  </motion.dialog>;
}
