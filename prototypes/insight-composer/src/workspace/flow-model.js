import { isHighlightOnly } from "../insight-content.js";

export function durationLabel(milliseconds, { short = false } = {}) {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  if (!seconds) return short ? "0 分钟" : "尚无有效阅读时长";
  if (seconds < 60) return "不足 1 分钟";
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}` : `${minutes} 分钟`;
}

// Constructing Intl formatters dominates history grouping when every session
// and insight is converted separately. Keep a small cache of formatters only;
// dates and current-day results are always calculated from the supplied time.
const dayFormatters = new Map();
export function localDay(value, timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  let formatter = dayFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    if (dayFormatters.size >= 8) dayFormatters.delete(dayFormatters.keys().next().value);
    dayFormatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function dateRange(period, timezone, now = Date.now()) {
  const to = localDay(now, timezone);
  if (period === "all") return {};
  const day = new Date(to + "T12:00:00Z");
  day.setUTCDate(day.getUTCDate() - (period === "today" ? 0 : period === "month" ? 29 : 6));
  return { from: day.toISOString().slice(0, 10), to };
}

export function dayLabel(date, timezone, now = Date.now()) {
  if (date === localDay(now, timezone)) return "今天";
  const yesterday = new Date(localDay(now, timezone) + "T12:00:00Z");
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (date === yesterday.toISOString().slice(0, 10)) return "昨天";
  const parts = date.split("-").map(Number);
  return parts.length === 3 ? `${parts[1]} 月 ${parts[2]} 日` : "日期未记录";
}

export function groupHistory(items, timezone) {
  const groups = new Map();
  for (const item of items) {
    const parts = item.days?.length ? item.days : [{ date: localDay(item.startedAt || item.createdAt, timezone), activeMs: item.activeMs, startedAt: item.startedAt, endedAt: item.endedAt }];
    for (const part of parts) {
      const day = part.date;
      if (!groups.has(day)) groups.set(day, []);
      const insights = item.days?.length ? (item.insights || []).filter((note) => localDay(note.createdAt, timezone) === day) : item.insights;
      const sameDaySession = localDay(item.startedAt, timezone) === day && localDay(item.endedAt || item.lastActivityAt || item.startedAt, timezone) === day;
      groups.get(day).push({ ...item, ...part, id: parts.length > 1 ? `${item.id}:${day}` : item.id, insights, insightCount: item.days?.length && (!sameDaySession || parts.length > 1) ? insights.length : item.insightCount });
    }
  }
  return [...groups].sort(([left], [right]) => right.localeCompare(left)).map(([date, entries]) => ({ date, entries: entries.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt))) }));
}

export function historyPreviewEntries(items, timezone) {
  return groupHistory(items, timezone).flatMap(({ date, entries }) => entries.map((session) => ({ date, session })));
}

export function groupHistoryPreview(entries) {
  const groups = [];
  for (const { date, session } of entries) {
    let group = groups.at(-1);
    if (!group || group.date !== date) {
      group = { date, entries: [] };
      groups.push(group);
    }
    // These are already day-specific rows: retain their order and never split days again.
    group.entries.push(session);
  }
  return groups;
}

export function positionLabel(position) {
  if (!position) return "";
  const title = position.sectionTitle || position.heading || position.label;
  if (typeof title === "string" && title.trim()) return title;
  if (Number.isInteger(position.pageIndex) && position.pageIndex >= 0) return `第 ${position.pageIndex + 1} 页`;
  if (Number.isInteger(position.page) && position.page > 0) return `第 ${position.page} 页`;
  return "";
}

export function insightTypeLabel(item) {
  return item.type === "question" ? "问题" : item.type === "note" ? "笔记" : isHighlightOnly(item) ? "高亮" : "批注";
}

export function availablePlanDocuments(workspace, query = "") {
  const text = query.trim().toLocaleLowerCase();
  const planned = new Set(workspace.planIds);
  return workspace.documents.filter((item) => !item.archivedAt && !planned.has(item.id) && (!text || [item.title, ...(item.tags || [])].join(" ").toLocaleLowerCase().includes(text)));
}
