import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import "./motion-system.js";
import "./reader-select.css";

/** Keep native select semantics and events while sharing the desktop picker.
 * Chromium renders the picker in the top layer, including inside dialogs. */
export const ReaderSelect = forwardRef(function ReaderSelect({ className = "", onKeyDown, ...props }, ref) {
  const element = useRef(null);
  useImperativeHandle(ref, () => element.current, []);
  useLayoutEffect(() => {
    if (!CSS.supports("appearance", "base-select")) return;
    // React 19.2 still validates select against the older HTML content model.
    // Install only this browser-owned display slot here; React keeps ownership
    // of every option, and the browser copies the selected text into the slot.
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "reader-select-button";
    trigger.append(document.createElement("selectedcontent"));
    element.current.prepend(trigger);
    return () => trigger.remove();
  }, []);
  function onKeys(event) {
    // Let the native picker consume its first Escape before an enclosing
    // settings/dialog shortcut sees it. Do not cancel the browser's default.
    if (event.key === "Escape" && CSS.supports("selector(:open)") && event.currentTarget.matches(":open")) event.stopPropagation();
    onKeyDown?.(event);
  }
  return <select {...props} ref={element} onKeyDown={onKeys} className={"reader-select" + (className ? " " + className : "")} />;
});
