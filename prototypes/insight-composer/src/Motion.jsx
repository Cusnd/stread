import { forwardRef, useRef } from "react";
import { motion, MotionConfig, useIsPresent } from "motion/react";
import { motionTransition } from "./motion-system.js";
import { useReducedMotionPreference } from "./useReducedMotionPreference.js";
import { useMotionPresence } from "./useMotionPresence.js";
import { useImmediateReducedMotion } from "./useImmediateReducedMotion.js";
import "./motion.css";

export function ContinuousMotion({ children }) {
  return <MotionConfig reducedMotion="user" transition={motionTransition("surface")}>{children}</MotionConfig>;
}

/** Keep business IDs as React keys. The list remains semantic and exiting rows
 * immediately stop receiving input while neighbouring rows make room. */
export const MotionItem = forwardRef(function MotionItem({ as = "li", children, style, layout = "position", transition, initial, animate, exit, ...props }, ref) {
  const reduced = useReducedMotionPreference();
  const present = useIsPresent();
  const motionRef = useImmediateReducedMotion(reduced, ref);
  const Element = motion[as];
  return <Element {...props} ref={motionRef} layout={reduced ? false : layout}
    data-motion-item="" data-motion-present={present ? "true" : "false"}
    inert={!present || props.inert || undefined} aria-hidden={!present || props["aria-hidden"] || undefined}
    initial={initial ?? { opacity: 0, y: reduced ? 0 : 6 }}
    animate={animate ?? { opacity: 1, y: 0 }}
    exit={exit ?? { opacity: 0, y: reduced ? 0 : -4 }}
    transition={transition ?? motionTransition("layout", reduced)}
    style={{ ...style, ...(!present ? { pointerEvents: "none" } : {}) }}>
    {children}
  </Element>;
});

export function MotionSelection({ layoutId, className = "motion-selection", style, transition, ...props }) {
  const reduced = useReducedMotionPreference();
  const motionRef = useImmediateReducedMotion(reduced);
  return <motion.span {...props} ref={motionRef} aria-hidden="true" layoutId={reduced ? undefined : layoutId}
    className={className} transition={transition ?? motionTransition("control", reduced)}
    style={{ ...style, pointerEvents: "none" }} />;
}

// A fixed toast keeps its CSS centring transform. Animate the individual
// translate property rather than overwriting translateX(-50%).
export function MotionNotice({ children, className, ...props }) {
  const reduced = useReducedMotionPreference();
  const present = useIsPresent();
  const motionRef = useImmediateReducedMotion(reduced);
  return <motion.div {...props} ref={motionRef} className={className} data-motion-notice=""
    inert={!present || undefined} aria-hidden={!present || undefined}
    initial={{ opacity: 0, translate: reduced ? "0 0" : "0 8px" }}
    animate={{ opacity: 1, translate: "0 0" }}
    exit={{ opacity: 0, translate: reduced ? "0 0" : "0 6px" }}
    transition={motionTransition("content", reduced)}>{children}</motion.div>;
}

const feedbackOpen = Object.freeze({ height: "auto", opacity: 1, y: 0 });
const feedbackClosed = Object.freeze({ height: 0, opacity: 0, y: -3 });

/** Local success/error/empty-state messages occupy and release their own space. */
export function MotionFeedback({ show, children, className = "", ...props }) {
  const lastContent = useRef(children);
  if (show) lastContent.current = children;
  const { present, motionProps } = useMotionPresence(show, { kind: "content", openState: feedbackOpen, closedState: feedbackClosed });
  return present ? <motion.div {...props} {...motionProps} className={"motion-feedback " + className}
    inert={!show || undefined} aria-hidden={!show || undefined} style={{ overflow: "hidden" }}>{lastContent.current}</motion.div> : null;
}
