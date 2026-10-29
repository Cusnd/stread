const labels = { documents: "资料", revisions: "正文", collections: "分类", reading: "阅读位置", object_preferences: "图表设置", insights: "洞见", change_requests: "AI 请求", glossary: "术语", proposals: "修订提案", authoring_previews: "待发布预览", authoring_drafts: "编写草稿", document_relations: "文献关联", insight_reviews: "复习", reading_sessions: "阅读记录", reading_activity: "阅读时长", metadata: "阅读安排" };
const parse = (value) => { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } };
const contents = (value, objects) => { const item = parse(value); return item?.$readerObject ? objects[item.$readerObject.key] || item : item; };
const statusLabel = (value) => ({ unread: "未读", reading: "阅读中", done: "已读", pending: "待处理", completed: "已完成", cancelled: "已撤回", applied: "已应用", rejected: "已拒绝" }[value] || "");

export function syncConflictRows(conflict) {
  const remote = new Map((conflict.remote || []).map((item) => [item.entity + "\n" + item.key, item]));
  const local = (conflict.local || []).map((item) => ({ ...item, remote: remote.get(item.entity + "\n" + item.key)?.value ?? null })).filter((item) => labels[item.entity] && JSON.stringify(item.value) !== JSON.stringify(item.remote));
  return local.length ? local : (conflict.local || []).slice(0, 1).map((item) => ({ ...item, remote: remote.get(item.entity + "\n" + item.key)?.value ?? null }));
}

export function syncRecordReferences(rows) {
  const found = new Map();
  const visit = (input) => {
    const value = parse(input);
    if (!value || typeof value !== "object") return;
    const ref = value.$readerObject;
    if (ref && /^objects\/sha256\/[a-f0-9]{64}$/.test(ref.key) && ref.key.endsWith(ref.sha256) && Number.isSafeInteger(ref.size)) { found.set(ref.key, ref); return; }
    for (const item of Object.values(value)) if (item && typeof item === "object") visit(item);
  };
  for (const row of rows) for (const record of [row.value, row.remote]) if (record) {
    for (const field of ["content", "payload", "metadata", "value"]) if (record[field] !== undefined) visit(record[field]);
  }
  return [...found.values()];
}

export function syncRecordPreview(entity, row, { documents = {}, objects = {}, positions = {} } = {}) {
  const label = labels[entity] || "关联记录";
  if (!row) return { label, title: "已移除", lines: [] };
  const payload = contents(row.payload, objects) || {}, metadata = contents(row.metadata, objects) || {};
  const documentId = row.document_id || payload.documentId;
  const documentTitle = documents[documentId]?.title || payload.documentTitle || "";
  const document = contents(row.content, objects);
  const lines = [];
  let title = payload.title || payload.term || row.label || metadata.title || document?.meta?.title || documentTitle || label;
  if (entity === "metadata") {
    const value = contents(row.value, objects);
    if (row.key === "plan") return { label: "阅读计划", title: "阅读计划", lines: Array.isArray(value) && value.length ? value.map((id, i) => `${i + 1}. ${documents[id]?.title || "资料"}`) : ["计划为空"] };
    if (row.key === "currentId") return { label: "当前阅读", title: value ? documents[value]?.title || "资料" : "尚未选择资料", lines: [] };
    return { label, title, lines: [] };
  }
  if (entity === "reading") {
    const position = payload.source || payload;
    lines.push({ source: "原文", translation: "译文", bilingual: "双语对照" }[payload.mode] || "阅读位置");
    if (Number.isInteger(position.page)) lines.push(`原文第 ${position.page} 页`);
    if (position.quote) lines.push(position.quote);
    else if (payload.blockId) {
      const blocks = positions[`${documentId}:${payload.revision}`]?.blocks || [];
      const at = blocks.findIndex((block) => block.id === payload.blockId), block = blocks[at];
      const heading = at < 0 ? null : blocks.slice(0, at + 1).findLast((entry) => entry.type === "heading");
      if (heading?.text) lines.push(heading.text);
      lines.push(block?.text || block?.caption || (block?.type === "table" ? "表格" : block?.type === "figure" ? "图片" : "已保存段落位置"));
    }
    if (Number.isFinite(payload.offsetRatio)) lines.push(`段落内 ${Math.round(payload.offsetRatio * 100)}%`);
  } else if (entity === "revisions") {
    lines.push(`正文第 ${row.revision} 版`);
    if (document?.$readerObject) lines.push("正在读取正文…");
    else {
      const blocks = document?.blocks || [];
      for (const block of blocks) {
        const text = block.text || block.caption || block.items?.map((item) => item.text).filter(Boolean).join("\n");
        if (text) lines.push(text);
      }
    }
  } else if (entity === "reading_sessions") {
    if (Number.isFinite(row.started_ms)) lines.push(new Date(row.started_ms).toLocaleString());
    lines.push(row.ended_ms ? "阅读已结束" : "阅读进行中");
  } else if (entity === "reading_activity") lines.push(`${Math.round((row.reported_ms || 0) / 1000)} 秒有效阅读`);
  else if (entity === "insight_reviews") lines.push(row.pending ? "待复习" : row.reviewed_at ? "已复习" : "未加入复习");
  else if (entity === "object_preferences") {
    if (payload.widthPercent !== null && payload.widthPercent !== undefined) lines.push(`宽度 ${payload.widthPercent}%`);
    if (payload.fontSize !== null && payload.fontSize !== undefined) lines.push(`字号 ${payload.fontSize}px`);
  } else {
    for (const value of [payload.body, payload.definition, metadata.summary, payload.quote]) if (typeof value === "string" && value) lines.push(value);
    if (payload.answer?.blocks) for (const block of payload.answer.blocks) if (block.text) lines.push(block.text);
    if (metadata.tags?.length) lines.push(metadata.tags.join(" · "));
    if (payload.aliases?.length) lines.push(payload.aliases.join(" · "));
    const status = statusLabel(payload.status || metadata.status || row.status); if (status) lines.push(status);
  }
  if (row.archived_at || payload.archivedAt) lines.push("已归档");
  if (row.deleted_at || payload.deletedAt) lines.push("已删除");
  return { label, title, lines };
}
