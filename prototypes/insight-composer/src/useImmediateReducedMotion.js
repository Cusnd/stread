import { useCallback, useLayoutEffect, useRef } from "react";
import { cancelFrame, visualElementStore } from "motion/react";

// A new zero-duration transition only affects future animations. Finish the
// current values on this element as well, preserving their completion promises
// so AnimatePresence can release an exit that was already under way.
export function finishElementMotion(element) {
  const visual = element && visualElementStore.get(element);
  if (!visual) return;
  visual.values.forEach((value) => value.animation?.complete());
  const projection = visual.projection;
  if (projection?.currentAnimation || projection?.pendingAnimation) {
    if (projection.pendingAnimation) {
      cancelFrame(projection.pendingAnimation);
      projection.pendingAnimation = undefined;
    }
    projection.mixTargetDelta?.(1000);
    projection.finishAnimation();
    projection.scheduleRender();
  }
}

/** Scope interruption to one existing Motion element; never replace its DOM. */
export function useImmediateReducedMotion(reduced, forwardedRef) {
  const element = useRef(null);
  const ref = useCallback((node) => {
    element.current = node;
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);
  useLayoutEffect(() => {
    if (reduced) finishElementMotion(element.current);
  }, [reduced]);
  return ref;
}
