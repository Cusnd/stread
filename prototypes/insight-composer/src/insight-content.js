// A highlight is an anchored annotation with no commentary. Its source, color,
// internal ID and N reference survive when commentary is added later.
export const isHighlightOnly = (item) => item?.type === "annotation" && !(item.body || "").trim() && !(item.title || "").trim();
export function insightFailureMessage(failure, action = "保存") {
  const retained = action === "保存" ? "草稿已保留，请重试。" : action === "删除" ? "洞见仍显示在列表中，请重试。" : "撤销记录已保留，请重试。";
  if (!failure?.message || /Failed to fetch|fetch failed|NetworkError|Load failed|Network request failed/i.test(failure.message)) return "暂时无法确认" + action + "结果。" + retained;
  return failure.message;
}
export function canSaveInsight(item) {
  if (!item) return false;
  if ((item.body || "").trim()) return true;
  return item.type === "annotation" && Boolean(item.blockId && (item.quote || item.tex || "").trim());
}
