import { hash } from "./errors.mjs";

// This is an HTTP representation validator, not a new document revision or a
// publication hash. Authorization is completed before even a 304 is returned.
export async function representationTag(workspace, actor, url) {
  const path = url.pathname;
  const draft = path.match(/^\/api\/authoring\/drafts\/([^/]+)$/);
  const preview = path.match(/^\/api\/authoring\/previews\/([^/]+)$/);
  const flow = /^\/api\/flow\/(summary|history|insights(?:\/[^/]+)?)$/.test(path);
  if (!["/api/workspace", "/api/proposals"].includes(path) && !draft && !preview && !flow) return null;
  await workspace.authorize(actor);
  const query = new URLSearchParams(url.search); query.delete("access"); query.sort();
  let state;
  if (draft) {
    const current = await workspace.draft(decodeURIComponent(draft[1]));
    const row = await workspace.previewRow(current.currentPreviewId);
    state = [current, row.payload, row.published_document_id];
  } else if (preview) {
    const row = await workspace.previewRow(decodeURIComponent(preview[1]));
    state = [row.payload, row.published_document_id];
  } else if (flow) {
    // Relative date queries change at midnight in the viewer's own timezone,
    // even if no activity or document changed. The query still validates zones.
    let day;
    try { day = new Intl.DateTimeFormat("en-CA", { timeZone: query.get("timezone") || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(workspace.flow.now()); }
    catch { return null; }
    state = [await workspace.meta("revision"), await workspace.flow.getRevision(), day];
  } else state = await workspace.meta("revision");
  return 'W/"' + hash(JSON.stringify([path, query.toString(), state])) + '"';
}

export function matchesRepresentation(header, tag) {
  if (!header || !tag) return false;
  return header.split(",").some((part) => part.trim() === tag || part.trim() === "*");
}
