// Collection/Flow may own native modal dialogs independently of the workspace's
// application-level overlay. Do not open a second settings surface behind the
// browser's modal top layer, and do not intercept shortcut recording.
export function canHandleWorkspaceSettings(event, overlay, documentTarget = globalThis.document) {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.target?.closest?.("[data-shortcut-recorder]")) return false;
  if (overlay && overlay !== "settings") return false;
  if (documentTarget?.querySelector?.("dialog[open]")) return false;
  if (overlay !== "settings" && event.target?.closest?.('[role="dialog"][aria-modal="true"]')) return false;
  return true;
}
