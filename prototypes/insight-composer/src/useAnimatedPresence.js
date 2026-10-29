import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotionPreference } from "./useReducedMotionPreference.js";

export function useAnimatedPresence(open, exitDuration = 160) {
  const [present, setPresent] = useState(open);
  const [entered, setEntered] = useState(false);
  const reduced = useReducedMotionPreference();
  const latestOpen = useRef(open);
  latestOpen.current = open;
  useLayoutEffect(() => {
    let firstFrame = 0;
    let secondFrame = 0;
    let deadline = 0;
    if (open) {
      setPresent(true);
      if (present) {
        if (reduced) setEntered(true);
        else firstFrame = requestAnimationFrame(() => {
          secondFrame = requestAnimationFrame(() => setEntered(true));
        });
      }
    } else {
      setEntered(false);
      if (present) {
        if (reduced) setPresent(false);
        else deadline = window.setTimeout(() => setPresent(false), exitDuration + 40);
      }
    }
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      window.clearTimeout(deadline);
    };
  }, [open, present, exitDuration, reduced]);
  const remove = useCallback(() => { if (!latestOpen.current) setPresent(false); }, []);
  return { present, entered, remove };
}
