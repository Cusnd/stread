export const isChangeRequest = (draft) => draft?.intent === "change-request";
export const canSaveChangeRequest = (draft) => isChangeRequest(draft) && Boolean(draft.body?.trim()) && draft.body.trim().length <= 20000;
export function changeRequestWrite(draft, documentId, revision) {
  const sourceKeys = ["blockId", "variant", "field", "nodeId", "itemId", "row", "column", "start", "end", "quote", "prefix", "suffix", "sourceType", "equationNumber"];
  const source = Object.fromEntries(sourceKeys.filter((key) => draft[key] !== undefined).map((key) => [key, draft[key]]));
  return { ...(draft.id ? { id: draft.id } : {}), documentId, revision: draft.revision || revision, category: draft.type, body: draft.body.trim(), ...(source.blockId ? { source } : {}) };
}
