// Route snapshots belong to the browser. We never keep a second live Reader
// (and its drafts, IDs, observers or activity tracker) alive for an exit effect.
import { MOTION_FADE } from "./motion-system.js";

let activeTransition = null;
let cleanupScope = null;
let generation = 0;
const contentAnimations = new WeakMap();

export function stopReaderContentMotion(element) {
  if (!element) return;
  contentAnimations.get(element)?.cancel();
  contentAnimations.delete(element);
}

// Native page snapshots can omit uncaptured fixed chrome while the document's
// height/scroll changes. Language changes fade only the existing article DOM.
export function animateReaderContent(element, { reduced = false, window: win = globalThis.window } = {}) {
  if (!element) return null;
  const previous = contentAnimations.get(element);
  const opacity = previous && ["running", "paused"].includes(previous.playState)
    ? Number.parseFloat(win.getComputedStyle(element).opacity) : 0.65;
  stopReaderContentMotion(element);
  if (reduced || typeof element.animate !== "function") return null;
  const animation = element.animate([{ opacity: Number.isFinite(opacity) ? opacity : 0.65 }, { opacity: 1 }], {
    duration: MOTION_FADE.duration * 1000, easing: MOTION_FADE.ease,
  });
  contentAnimations.set(element, animation);
  return animation;
}

export function commitPageMotion(commit, { document: doc = globalThis.document, window: win = globalThis.window, enabled = true, scope = "page" } = {}) {
  activeTransition?.skipTransition();
  activeTransition = null;
  cleanupScope?.();
  cleanupScope = null;
  const current = ++generation;
  let committed = false;
  const update = () => { if (!committed && current === generation) { committed = true; commit(); } };
  if (!enabled || typeof doc?.startViewTransition !== "function" || win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    update(); return null;
  }
  // Reader routes include fixed chrome in the viewport snapshot, so an
  // outgoing page cannot cover a separately rendered live TOC.
  const root = doc.documentElement;
  root?.setAttribute("data-page-motion-scope", scope);
  const cleanup = () => root?.removeAttribute("data-page-motion-scope");
  cleanupScope = cleanup;
  try {
    const transition = doc.startViewTransition(update);
    activeTransition = transition;
    // skipTransition still invokes its callback. The generation check prevents
    // an older, not-yet-captured route from committing over a newer intention.
    transition.ready?.catch(() => {});
    transition.finished?.catch(() => {}).finally(() => {
      if (activeTransition === transition) {
        activeTransition = null;
        cleanup();
        cleanupScope = null;
      }
    });
    return transition;
  } catch {
    cleanup();
    cleanupScope = null;
    update(); return null;
  }
}

export function stopPageMotion() {
  // Skipping a snapshot still schedules its update callback. An unmounted
  // workspace must invalidate that pending update before the browser runs it.
  generation += 1;
  activeTransition?.skipTransition();
  activeTransition = null;
  cleanupScope?.();
  cleanupScope = null;
}
