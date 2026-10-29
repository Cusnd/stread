const documentFields = ["title", "kind", "summary", "collectionIds", "tagsText", "status"];
const collectionFields = ["label", "parentId"];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const copy = (value) => Array.isArray(value) ? [...value] : value;

export function documentDraftFor(material) {
  const fields = { title: material.title, kind: material.kind, summary: material.summary || "", collectionIds: [...material.collectionIds], tagsText: material.tags.join("，"), status: material.status };
  return { documentId: material.id, expectedVersion: material.version, ...fields, base: { ...fields, collectionIds: [...fields.collectionIds] } };
}

export function collectionDraftFor(collection) {
  const fields = { label: collection?.label || "", parentId: collection?.parentId || null };
  return { id: collection?.id || null, expectedVersion: collection?.version, ...fields, base: { ...fields } };
}

function rebase(draft, latest, fields) {
  const next = { ...latest };
  const conflicts = [];
  for (const field of fields) {
    // Old saved drafts may predate base snapshots. Preserve their input rather
    // than guessing which fields the user has edited.
    const edited = !draft.base || !same(draft[field], draft.base[field]);
    if (!edited) continue;
    next[field] = copy(draft[field]);
    if ((!draft.base || !same(latest[field], draft.base[field])) && !same(draft[field], latest[field])) conflicts.push({ field, latest: copy(latest[field]), retained: copy(draft[field]) });
  }
  return { draft: next, conflicts };
}

export const rebaseDocumentDraft = (draft, material) => rebase(draft, documentDraftFor(material), documentFields);
export const rebaseCollectionDraft = (draft, collection) => rebase(draft, collectionDraftFor(collection), collectionFields);

export function cancelledEditDrafts(kind) {
  return kind === "edit-document" ? { documentDraft: null } : kind === "edit-collection" ? { collectionDraft: null } : {};
}
