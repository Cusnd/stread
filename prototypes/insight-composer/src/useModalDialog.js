import { useEffect, useLayoutEffect, useRef } from "react";
import { useMotionValue, useMotionValueEvent } from "motion/react";
import { acquirePageScrollLock } from "./page-scroll-lock.js";
import { useMotionPresence } from "./useMotionPresence.js";
import "./modal.css";

// A shared interaction policy, not a business dialog. Native top-layer ownership
// handles background inertness, including settings opened over Reader dialogs.
const sessions = new WeakMap();
const origins = new WeakMap();
const controlsSelector = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]';

export function isModalFocusTarget(element) {
  return Boolean(element?.isConnected && element.getClientRects().length
    && !element.matches(":disabled") && !element.closest('[inert], [aria-hidden="true"], [hidden]')
    && (!element.closest("dialog") || element.closest("dialog").open));
}

function focusableControls(dialog) {
  return [...dialog.querySelectorAll(controlsSelector)].filter((element) => isModalFocusTarget(element)
    && element.tabIndex >= 0 && !element.matches(".reader-select-button"));
}

function topDialog(document) {
  return sessions.get(document)?.findLast((dialog) => dialog.isConnected && dialog.open);
}

function syncBackdrops(document) {
  const stack = sessions.get(document) || [];
  const active = stack.filter((dialog) => dialog.isConnected && dialog.open);
  const top = active.at(-1);
  // Nested surfaces share one backdrop, owned by the native top layer even
  // while it exits. A fully visible lower layer keeps the modal background
  // stable while its child fades in/out, without doubling tint or blur.
  const progress = Math.max(0, ...active.map((dialog) => origins.get(dialog)?.opacity || 0));
  for (const dialog of stack) {
    dialog.dataset.modalCovered = String(dialog !== top);
    dialog.style.setProperty("--modal-backdrop-progress", String(dialog === top ? progress : 0));
  }
}

const resolve = (value) => typeof value === "function" ? value()
  : value && typeof value === "object" && "current" in value ? value.current : value;

/**
 * Keep the native dialog, focus and scroll lock alive until the shared surface's
 * actual exit completes. The caller retains its content and owns business state.
 * motionProps may be spread on the dialog itself or on its inner surface.
 */
export function useModalDialog(open, {
  ref: suppliedRef, surfaceRef, onClose, initialFocus, returnFocus, fallbackFocus,
  focusKey, beforeOpen, afterClose, allowEscape = true,
} = {}) {
  const ownRef = useRef(null);
  const ref = suppliedRef || ownRef;
  const opacity = useMotionValue(0);
  const session = useRef(null);
  useMotionValueEvent(opacity, "change", (value) => {
    const owned = session.current;
    if (owned) { owned.opacity = value; syncBackdrops(owned.dialog.ownerDocument); }
  });
  const latest = useRef(null);
  latest.current = { open, onClose, initialFocus, returnFocus, fallbackFocus, beforeOpen, afterClose, allowEscape };

  function release() {
    const owned = session.current;
    if (!owned) return null;
    session.current = null;
    const { dialog, previous, releaseScroll } = owned;
    const document = dialog.ownerDocument;
    const active = document.activeElement;
    const stack = sessions.get(document) || [];
    // React may already have removed the node before passive unmount cleanup.
    // Its recorded stack position still determines whose focus is being freed.
    const wasTop = stack.at(-1) === dialog;
    // If an invoking modal is removed first, its child can still return to the
    // original page trigger after the last layer closes.
    for (const child of stack.slice(stack.indexOf(dialog) + 1)) {
      const origin = origins.get(child);
      if (origin && dialog.contains(origin.previous)) origin.previous = previous;
    }
    sessions.set(document, stack.filter((item) => item !== dialog));
    origins.delete(dialog);
    if (dialog.open) dialog.close();
    releaseScroll();
    syncBackdrops(document);

    // Closing a lower layer must not steal focus from the still-open top one.
    const top = topDialog(document);
    const candidates = wasTop
      ? [resolve(latest.current.returnFocus), previous, resolve(latest.current.fallbackFocus)]
      : [active];
    const target = candidates.find((element) => isModalFocusTarget(element) && (!top || top.contains(element)));
    if (target) target.focus({ preventScroll: true });
    else if (top && !top.contains(document.activeElement)) (focusableControls(top)[0] || top).focus({ preventScroll: true });
    return target || previous;
  }

  const presence = useMotionPresence(open, { onExit: () => {
    const previous = release();
    latest.current.afterClose?.(previous);
  } });

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!open || !presence.present || !dialog) return;
    if (!session.current) {
      latest.current.beforeOpen?.(dialog);
      const document = dialog.ownerDocument;
      const previous = resolve(latest.current.returnFocus) || document.activeElement;
      const releaseScroll = acquirePageScrollLock(document.documentElement);
      session.current = { dialog, previous, releaseScroll, opacity: opacity.get() };
      origins.set(dialog, session.current);
      sessions.set(document, [...(sessions.get(document) || []), dialog]);
      if (!dialog.open) dialog.showModal();
      syncBackdrops(document);
    }
    // Run before paint so a neutral Queue opening does not first focus a field.
    const target = resolve(latest.current.initialFocus) || dialog.querySelector("[data-modal-initial], [data-dialog-initial], [autofocus]")
      || focusableControls(dialog)[0] || dialog;
    if (isModalFocusTarget(target)) target.focus({ preventScroll: true });
  }, [open, presence.present, focusKey]);

  useLayoutEffect(() => {
    if (ref.current) syncBackdrops(ref.current.ownerDocument);
  }, [open, presence.present]);

  useEffect(() => () => { release(); }, []);

  function onKeyDown(event) {
    if (event.defaultPrevented || event.target.closest?.("dialog") !== ref.current) return;
    if (!latest.current.open) { event.preventDefault(); return; }
    if (event.key !== "Tab") return;
    const items = focusableControls(ref.current);
    if (!items.length) { event.preventDefault(); ref.current.focus({ preventScroll: true }); return; }
    const active = ref.current.ownerDocument.activeElement;
    if (event.shiftKey && (active === items[0] || !items.includes(active))) {
      event.preventDefault(); items.at(-1).focus({ preventScroll: true });
    } else if (!event.shiftKey && (active === items.at(-1) || !items.includes(active))) {
      event.preventDefault(); items[0].focus({ preventScroll: true });
    }
  }

  function onCancel(event) {
    event.preventDefault();
    if (latest.current.open && resolve(latest.current.allowEscape)) latest.current.onClose?.();
  }

  function onClick(event) {
    if (!latest.current.open || event.target !== ref.current) return;
    const surface = surfaceRef?.current || ref.current;
    const bounds = surface.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) latest.current.onClose?.();
  }

  // A native ::backdrop has its own rendering timeline. A CSS transition with
  // the same duration can still start a frame after Motion, leaving blur behind
  // the panel. Feed it the surface's actual opacity instead of a second clock.
  const motionProps = { ...presence.motionProps, style: { opacity } };

  return { ...presence, motionProps, ref, dialogProps: {
    ref, "data-state": open ? "open" : presence.present ? "closing" : "closed",
    inert: !open, "aria-hidden": !open || undefined, tabIndex: -1,
    onKeyDown, onCancel, onClick,
  } };
}
