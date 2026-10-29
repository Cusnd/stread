// Delivery metadata is outside the saved idempotent receipt. Retrying can renew
// a short-lived URL without changing the frozen candidate or its local receipt.
export async function withOnlinePreview(workspace, actor, value) {
  if (!workspace.onlinePreview || !value?.preview?.id) return value;
  return { ...value, onlinePreview: await workspace.onlinePreview.publishFromWorkspace(workspace, actor, value.preview.id) };
}
