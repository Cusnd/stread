export const statusNames = { unread: "未读", reading: "在读", done: "已读" };
export const sortNames = { original: "默认顺序", title: "标题名称", status: "阅读状态" };

export function collectionPath(collections, id) {
  const byId = new Map(collections.map((item) => [item.id, item]));
  const path = [];
  const seen = new Set();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = byId.get(current.parentId);
  }
  return path;
}

export function collectionLabel(collections, id) {
  return collectionPath(collections, id).map((item) => item.label).join(" / ");
}

export function documentCategories(document, collections) {
  const ids = document.collectionIds || [];
  const leaves = ids.filter((id) => !ids.some((other) => other !== id && collectionPath(collections, other).some((item) => item.id === id)));
  return leaves.map((id) => collectionLabel(collections, id)).filter(Boolean);
}

export function activeDocuments(workspace) {
  return workspace.documents.filter((item) => !item.archivedAt);
}

export function belongsToCollection(document, collectionId, collections, planIds) {
  if (collectionId === "archived") return Boolean(document.archivedAt);
  if (document.archivedAt) return false;
  if (collectionId === "all") return true;
  if (collectionId === "plan") return planIds.includes(document.id);
  if (collectionId === "uncategorized") return !document.collectionIds?.length;
  return document.collectionIds?.some((id) => collectionPath(collections, id).some((parent) => parent.id === collectionId)) || false;
}

const collectionTitleOrder = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const specialCollections = new Set(["all", "plan", "uncategorized", "archived"]);

// Build memberships once per workspace snapshot, not once per category and
// document on every query, selection or scroll update.
export function indexCollection(workspace) {
  const categories = new Map(workspace.collections.map((item) => [item.id, item]));
  const ancestors = new Map();
  for (const category of workspace.collections) {
    const ids = new Set();
    let current = category;
    while (current && !ids.has(current.id)) {
      ids.add(current.id);
      current = categories.get(current.parentId);
    }
    ancestors.set(category.id, ids);
  }
  const planOrder = new Map();
  workspace.planIds.forEach((id, index) => { if (!planOrder.has(id)) planOrder.set(id, index); });
  const counts = Object.fromEntries(["all", "plan", "uncategorized", "archived", ...categories.keys()].map((id) => [id, 0]));
  const entries = workspace.documents.map((document) => {
    const memberships = new Set();
    if (document.archivedAt) memberships.add("archived");
    else {
      memberships.add("all");
      if (planOrder.has(document.id)) memberships.add("plan");
      if (!document.collectionIds?.length) memberships.add("uncategorized");
      for (const id of document.collectionIds || []) for (const ancestor of ancestors.get(id) || []) if (!specialCollections.has(ancestor)) memberships.add(ancestor);
    }
    for (const id of memberships) counts[id] += 1;
    return { document, memberships, searchText: [document.title, document.kind, document.summary, ...(document.tags || [])].join(" ").toLocaleLowerCase() };
  });
  return { categories, entries, counts, planOrder };
}

export function deriveCollection(workspace, view = {}, index = indexCollection(workspace)) {
  const requested = view.collectionId || "all";
  const collectionId = ["all", "plan", "uncategorized", "archived"].includes(requested) || index.categories.has(requested) ? requested : "all";
  const query = (view.query || "").trim().toLocaleLowerCase();
  const tags = view.tags || [];
  const status = view.status || "all";
  const rows = index.entries.filter(({ document: item, memberships, searchText }) => memberships.has(collectionId)
    && (status === "all" || item.status === status)
    && tags.every((tag) => item.tags.includes(tag))
    && (!query || searchText.includes(query))).map(({ document }) => document);
  if (view.sort === "title") rows.sort((a, b) => collectionTitleOrder.compare(a.title, b.title));
  else if (view.sort === "status") {
    const rank = { reading: 0, unread: 1, done: 2 };
    rows.sort((a, b) => rank[a.status] - rank[b.status]);
  } else if (collectionId === "plan") rows.sort((a, b) => index.planOrder.get(a.id) - index.planOrder.get(b.id));
  const selected = rows.find((item) => item.id === view.selectedId) || rows[0] || null;
  const title = { all: "全部资料", plan: "阅读计划", uncategorized: "未分类", archived: "已归档" }[collectionId] || index.categories.get(collectionId)?.label;
  return { collectionId, rows, selected, counts: index.counts, title, filtered: Boolean(query || status !== "all" || tags.length) };
}

export function canRemoveCollection(workspace, collectionId) {
  return !workspace.collections.some((item) => item.parentId === collectionId)
    && !workspace.documents.some((item) => item.collectionIds.includes(collectionId));
}

export function availableParents(collections, collectionId) {
  return collections.filter((item) => !collectionPath(collections, item.id).some((ancestor) => ancestor.id === collectionId));
}

export function parseTags(value) {
  return [...new Set(value.split(/[,，;；\n]/).map((tag) => tag.trim()).filter(Boolean))];
}

export function readingPosition(document) {
  if (document.status === "done") return "已读完";
  if (document.readingState?.blockId) return "已保存阅读位置";
  return document.status === "reading" ? "从开头阅读" : "尚未开始";
}
