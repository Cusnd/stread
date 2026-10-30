// One motion vocabulary for the desktop workspace. Spatial changes are driven
// by springs so a changed target keeps its current position and velocity.
// Opacity is not a physical distance and uses a short, bounded linear fade.
export const MOTION_SPRINGS = Object.freeze({
  control: Object.freeze({ stiffness: 600, damping: 45, mass: 0.7 }),
  content: Object.freeze({ stiffness: 500, damping: 45, mass: 0.8 }),
  disclosure: Object.freeze({ stiffness: 180, damping: 28, mass: 1 }),
  surface: Object.freeze({ stiffness: 420, damping: 42, mass: 1 }),
  panel: Object.freeze({ stiffness: 360, damping: 38, mass: 1 }),
  layout: Object.freeze({ stiffness: 300, damping: 35, mass: 1 }),
});

export const MOTION_FADE = Object.freeze({ type: "tween", duration: 0.14, ease: "linear" });

// Select pickers, menus and the image viewer consume the same fade policy as
// Motion. Native modal backdrops consume the surface MotionValue directly.
// Keep the duration here; CSS adapters only reference these tokens.
export function installMotionCssTokens(root = globalThis.document?.documentElement) {
  root?.style.setProperty("--motion-fade-duration", `${MOTION_FADE.duration * 1000}ms`);
  root?.style.setProperty("--motion-fade-ease", MOTION_FADE.ease);
}
installMotionCssTokens();

export function motionTransition(kind = "surface", reduced = false) {
  if (reduced) return { type: "tween", duration: 0, reduceMotion: true, opacity: { type: "tween", duration: 0 } };
  return {
    type: "spring", ...(MOTION_SPRINGS[kind] || MOTION_SPRINGS.surface),
    // A subpixel remainder is visually settled. Avoid holding a native modal's
    // input lock for a long, already invisible spring tail.
    restDelta: 0.25, restSpeed: 4,
    reduceMotion: false,
    opacity: kind === "disclosure" ? { ...MOTION_FADE, duration: 0.2 } : MOTION_FADE,
  };
}

export function motionDistance(value, reduced = false) { return reduced ? 0 : value; }
