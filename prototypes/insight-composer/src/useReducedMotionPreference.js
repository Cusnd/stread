import { useSyncExternalStore } from "react";

let query;
function mediaQuery() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return query ||= window.matchMedia("(prefers-reduced-motion: reduce)");
}
function subscribe(listener) {
  const media = mediaQuery();
  media?.addEventListener("change", listener);
  return () => media?.removeEventListener("change", listener);
}
const snapshot = () => Boolean(mediaQuery()?.matches);
const serverSnapshot = () => false;

// Motion's current hook snapshots this setting at mount. Keep active surfaces
// responsive when the operating-system preference changes during an animation.
export function useReducedMotionPreference() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
