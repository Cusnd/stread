import { beginNavigationLoading } from "./navigation-loading.js";

function once(load) {
  let pending;
  return () => pending ||= load().catch((error) => { pending = null; throw error; });
}

export const loadCollection = once(() => import("./workspace/CollectionPage.jsx"));
export const loadFlow = once(() => import("./workspace/FlowPage.jsx"));
export const loadReader = once(() => import("./App.jsx"));
export const loadArticleNotes = once(() => import("./notes/ArticleNotesPage.jsx"));
export const loadDocumentPreparation = once(() => import("./html-content.js"));
export const loadImportDialog = once(() => import("./ImportDialog.jsx"));
export const loadRevisionReview = once(() => import("./RevisionReview.jsx"));
export const loadWorkspaceSettings = once(() => import("./WorkspaceSettings.jsx"));

export async function loadWithNavigation(load) {
  const finish = beginNavigationLoading();
  try { return await load(); }
  finally { finish(); }
}

// Intent preloads are silent; a visible navigation owns its own loading token.
export function preloadWorkspacePage(page) {
  const load = page === "flow" ? loadFlow : page === "collection" ? loadCollection : loadReader;
  return load().catch(() => {});
}
