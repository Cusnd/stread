import { useSyncExternalStore } from "react";
import { getServerSnapshot, getSnapshot, subscribe } from "./navigation-loading.js";
import "./navigation-loading.css";

/** Mount inside the positioned workspace header; this never changes its size. */
export function NavigationLoadingLine({ className = "" }) {
  const loading = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (!loading.visible) return null;
  return <div
    className={"navigation-loading-line" + (className ? " " + className : "")}
    data-phase={loading.phase}
    role="progressbar"
    aria-label="正在加载"
    aria-hidden={!loading.busy || undefined}
  ><span aria-hidden="true" /></div>;
}
