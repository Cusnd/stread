import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cancelFrame, frame, useAnimationControls } from "motion/react";
import { motionTransition } from "./motion-system.js";
import { useReducedMotionPreference } from "./useReducedMotionPreference.js";

const visible = Object.freeze({ opacity: 1, y: 0, scale: 1 });
const hidden = Object.freeze({ opacity: 0, y: 8, scale: 0.985 });

/**
 * Keep one motion element mounted until its actual exit settles. Retargeting
 * the same controls preserves its MotionValues and spring velocity. Callers
 * own focus, inert, native dialog lifetime, and the data behind the surface.
 * Spread motionProps on that element; do not add a competing CSS transition.
 */
export function useMotionPresence(open, {
  kind = "surface", openState = visible, closedState = hidden, onExit,
} = {}) {
  const controls = useAnimationControls();
  const reduced = useReducedMotionPreference();
  const [present, setPresent] = useState(open);
  const [subscriptionVersion, setSubscriptionVersion] = useState(0);
  const generation = useRef(0);
  const subscribers = useRef(new Set());
  const latest = useRef(null);
  latest.current = { open, openState, closedState, onExit };

  const subscribedControls = useMemo(() => ({
    ...controls,
    subscribe(element) {
      const unsubscribe = controls.subscribe(element);
      subscribers.current.add(element);
      // A conditionally mounted child replays its own refs/effects in StrictMode
      // without replaying this already-mounted hook. That cancels its first
      // animation, so bind each command to the child's actual subscription.
      setSubscriptionVersion((version) => version + 1);
      return () => {
        generation.current += 1;
        subscribers.current.delete(element);
        unsubscribe();
      };
    },
  }), [controls]);

  useLayoutEffect(() => {
    // A newly mounted motion element must subscribe before controls.start().
    if (open && !present) setPresent(true);
  }, [open, present]);

  useEffect(() => {
    const current = ++generation.current;
    if (!present || !subscribers.current.size) return;
    const target = open ? latest.current.openState : latest.current.closedState;
    const finish = () => {
      if (open || generation.current !== current || latest.current.open) return;
      latest.current.onExit?.();
      setPresent(false);
    };
    const start = () => {
      if (generation.current !== current || !subscribers.current.size) return;
      controls.start(target, motionTransition(kind, false)).then(finish, () => {});
    };
    if (reduced) {
      controls.stop();
      controls.set(target);
      finish();
    } else {
      // Mounting a large settings surface (and its StrictMode subscription
      // replay) must finish before the fade clock starts. Otherwise a stopped
      // first command can advance to its end before the first painted frame.
      frame.update(start);
    }
    // Do not stop on a target change: the replacement spring needs the current
    // velocity. useAnimationControls stops its values when the owner unmounts.
    return () => { generation.current += 1; cancelFrame(start); };
  }, [open, present, reduced, kind, controls, subscriptionVersion]);

  return {
    present,
    entered: open && present,
    reduced,
    motionProps: { initial: closedState, animate: subscribedControls, transition: { ...motionTransition(kind, reduced), reduceMotion: reduced } },
  };
}
