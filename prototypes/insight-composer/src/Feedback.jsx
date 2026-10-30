import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { MotionFeedback, MotionItem } from "./Motion.jsx";
import { WarningCircle, X } from "./icons.jsx";
import "./feedback.css";

/** Errors stay beside the action and keep their last content throughout exit. */
export function InlineError({ message, onDismiss, className = "" }) {
  return <MotionFeedback show={Boolean(message)} className={"ui-feedback-presence " + className} role="alert" aria-atomic="true">
    <div className="ui-feedback ui-feedback-error"><WarningCircle size={17} aria-hidden="true" />
      <span>{message}</span>{onDismiss && <button type="button" className="ui-button" data-ui-button="tool" data-ui-size="compact" onClick={onDismiss} aria-label="关闭错误提示"><X size={15} /></button>}
    </div>
  </MotionFeedback>;
}

/** forwardRef lets an enclosing popLayout presence release the old empty row. */
export const EmptyState = forwardRef(function EmptyState({ children, action, compact = false, className = "", ...props }, ref) {
  return <MotionItem as="div" layout={false} role="status" {...props} ref={ref} className={"ui-empty " + (compact ? "is-compact " : "") + className}>
    <p>{children}</p>{action && <div className="ui-empty-action">{action}</div>}
  </MotionItem>;
});

export function CopyFeedback({ message, className = "" }) {
  return <MotionFeedback show={Boolean(message)} className={"ui-copy-feedback " + className} role="status" aria-atomic="true"><span>{message}</span></MotionFeedback>;
}

/** One success boundary and lifetime for copy labels and nearby copy messages.
 * The latest request owns feedback, even when clipboard promises settle out of order. */
export function useClipboardFeedback() {
  const [feedback, setFeedback] = useState(null);
  const timer = useRef(null);
  const sequence = useRef(0);
  const clear = useCallback(() => {
    sequence.current += 1;
    clearTimeout(timer.current);
    setFeedback(null);
  }, []);
  useEffect(() => () => { sequence.current += 1; clearTimeout(timer.current); }, []);
  const copy = useCallback(async (text, { key = null, successMessage = "已复制", failureMessage = "复制失败，可直接选中编号复制。" } = {}) => {
    const current = ++sequence.current;
    clearTimeout(timer.current);
    setFeedback(null);
    let result;
    try { await navigator.clipboard.writeText(text); result = { key, ok: true, message: successMessage }; }
    catch { result = { key, ok: false, message: failureMessage }; }
    if (current !== sequence.current) return { ...result, current: false };
    setFeedback(result);
    // A failure remains available until another attempt or explicit clearing.
    if (result.ok) timer.current = setTimeout(() => setFeedback(null), 2400);
    return { ...result, current: true };
  }, []);
  return { feedback, copy, clear };
}
