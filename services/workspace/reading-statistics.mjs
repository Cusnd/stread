import { canonical, check, hash } from './errors.mjs';
import { reconcileReadingEvents } from './sync-reading.mjs';

// Only derived date/document/actor cells live in D1. Original facts, receipts,
// immutable IDs and synchronization versions remain in the owning archive.
export const READING_STATISTICS_CONTEXT_MS = 61_000;
export const READING_STATISTICS_LIMITS = Object.freeze({ queryDays: 3660, projectionDays: 32,
  events: 100_000, sessions: 20_000, cells: 20_000, cellSessions: 10_000,
  dayBytes: 1_000_000, pages: 1000 });
const DAY = 86_400_000;
const formatters = new Map();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const bytes = value => new TextEncoder().encode(value).length;
const integer = (value, label, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  check(Number.isSafeInteger(value) && value >= min && value <= max, 'VALIDATION_FAILED', `${label}无效。`);
  return value;
};
function budget(ok, phase, limit) {
  check(ok, 'READING_STATISTICS_BUDGET', '阅读统计范围超过本次处理预算，请分段重试。', 503,
    { retryable: true, phase, limit });
}
function formatter(timezone) {
  check(typeof timezone === 'string' && timezone.length > 0 && timezone.length <= 100, 'VALIDATION_FAILED', '时区无效。');
  if (!formatters.has(timezone)) {
    let value; try { value = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { check(false, 'VALIDATION_FAILED', '时区无效。'); }
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value);
    formatters.set(timezone, value);
  }
  return formatters.get(timezone);
}
function dateAt(ms, timezone) {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function validDate(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value, 'VALIDATION_FAILED', '日期须为有效的 YYYY-MM-DD。');
  return value;
}
const shiftDate = (date, days) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);

export function readingStatisticsDayStart(date, timezone = 'UTC') {
  validDate(date); formatter(timezone);
  const base = Date.parse(date); let lower = base - 2 * DAY, upper = base + 2 * DAY;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (dateAt(middle, timezone) < date) lower = middle + 1; else upper = middle;
  }
  return lower;
}

export function readingStatisticsRange(query = {}, { now = Date.now(), maxDays = READING_STATISTICS_LIMITS.queryDays } = {}) {
  const timezone = query.timezone ?? 'UTC'; formatter(timezone);
  const count = integer(query.days ?? 30, '统计天数', 1, maxDays);
  const to = validDate(query.to ?? dateAt(now, timezone)), from = validDate(query.from ?? shiftDate(to, 1 - count));
  const days = (Date.parse(to) - Date.parse(from)) / DAY + 1;
  check(Number.isInteger(days) && days >= 1 && days <= maxDays, 'VALIDATION_FAILED', '日期范围超出允许范围。', 400, { maxDays });
  const dates = []; let start = readingStatisticsDayStart(from, timezone);
  for (let index = 0; index < days; index++) {
    const date = shiftDate(from, index), end = readingStatisticsDayStart(shiftDate(date, 1), timezone);
    dates.push({ date, start, end }); start = end;
  }
  return { timezone, from, to, start: dates[0].start, end: dates.at(-1).end, dates };
}

function uniqueRows(rows, keyOf, limit, phase) {
  check(Array.isArray(rows), 'VALIDATION_FAILED', '阅读统计输入必须为数组。');
  budget(rows.length <= limit, phase, limit);
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row), old = map.get(key);
    check(!old || canonical(old) === canonical(row), 'READING_STATISTICS_IDENTITY_CONFLICT', '相同阅读身份对应不同事实。', 409, { phase, key });
    map.set(key, row);
  }
  return [...map.values()];
}

/** Project a complete fixed-version time window, not a batch of new deltas.
 * The source must include every actor and every event starting in the range
 * [dayStart-61000,dayEnd). Ownership is settled before document/actor filters.
 */
export function projectReadingStatistics(input) {
  const limits = { ...READING_STATISTICS_LIMITS, ...input.limits };
  const range = readingStatisticsRange(input, { now: input.now, maxDays: limits.projectionDays });
  const coverage = input.coverage;
  check(coverage?.complete === true && Number.isSafeInteger(coverage.fromMs) && Number.isSafeInteger(coverage.toMs)
    && coverage.fromMs <= range.start - READING_STATISTICS_CONTEXT_MS && coverage.toMs >= range.end,
  'READING_STATISTICS_SOURCE_INCOMPLETE', '阅读统计需要完整的固定版本时间区间及重叠上下文。', 409);
  integer(coverage.sourceRevision, '来源版本');
  const sessions = uniqueRows(input.sessions, row => row.id, limits.sessions, 'sessions');
  for (const row of sessions) check(typeof row.id === 'string' && row.id.length > 0 && typeof row.document_id === 'string'
    && row.document_id.length > 0 && typeof row.actor_id === 'string' && row.actor_id.length > 0,
  'SYNC_INVALID_READING', '阅读会话身份无效。', 409);
  const bySession = new Map(sessions.map(row => [row.id, row]));
  const events = uniqueRows(input.events, row => canonical([row.session_id, row.sequence]), limits.events, 'events');
  for (const row of events) check(row.started_ms >= coverage.fromMs && row.started_ms < coverage.toMs,
    'READING_STATISTICS_SOURCE_INCOMPLETE', '阅读事实不属于声明的来源区间。', 409);
  const result = reconcileReadingEvents(sessions, events, input.now ?? Date.now());
  const cells = new Map();
  for (const interval of result.ranges) {
    if (interval.end <= range.start || interval.start >= range.end) continue;
    const session = bySession.get(interval.sessionId);
    for (const day of range.dates) {
      const start = Math.max(interval.start, day.start), end = Math.min(interval.end, day.end);
      if (end <= start) continue;
      const key = canonical([day.date, session.actor_id, session.document_id]);
      let cell = cells.get(key);
      if (!cell) {
        cell = { date: day.date, actorId: session.actor_id, documentId: session.document_id,
          activeMs: 0, sessionIds: new Set(), firstMs: start, lastMs: end };
        cells.set(key, cell); budget(cells.size <= limits.cells, 'cells', limits.cells);
      }
      cell.activeMs += end - start; cell.sessionIds.add(session.id);
      cell.firstMs = Math.min(cell.firstMs, start); cell.lastMs = Math.max(cell.lastMs, end);
      budget(cell.sessionIds.size <= limits.cellSessions, 'cell-sessions', limits.cellSessions);
    }
  }
  const rows = [...cells.values()].map(cell => ({ ...cell, sessionIds: [...cell.sessionIds].sort(compare) }))
    .sort((a, b) => compare(a.date, b.date) || compare(a.actorId, b.actorId) || compare(a.documentId, b.documentId));
  for (const day of range.dates) budget(bytes(JSON.stringify(rows.filter(row => row.date === day.date))) <= limits.dayBytes, 'day-bytes', limits.dayBytes);
  const projection = { version: 1, timezone: range.timezone, from: range.from, to: range.to,
    sourceRevision: coverage.sourceRevision, days: range.dates, cells: rows,
    source: { events: events.length, sessions: sessions.length, fromMs: coverage.fromMs, toMs: coverage.toMs } };
  return { ...projection, sha256: hash(canonical(projection)) };
}

function ids(value, name) {
  if (value === undefined) return null;
  check(Array.isArray(value) && value.length <= 1000 && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 200),
    'VALIDATION_FAILED', `${name}筛选无效。`);
  return new Set(value);
}
function filters(query, documents) {
  let documentIds = ids(query.documentIds, '文章'), actorIds = ids(query.actorIds, '读者');
  const tags = ids(query.tags, '标签'), collections = ids(query.collectionIds ?? query.collections, '文集');
  for (const mode of [query.tagMode, query.collectionMode]) check(mode === undefined || ['any', 'all'].includes(mode), 'VALIDATION_FAILED', '筛选组合方式无效。');
  if (tags || collections) {
    check(Array.isArray(documents), 'READING_STATISTICS_DOCUMENTS_REQUIRED', '标签或文集筛选需要当前文章目录。', 409);
    const selected = new Set();
    const match = (wanted, actual, mode) => !wanted || (mode === 'all' ? [...wanted].every(value => actual.includes(value)) : [...wanted].some(value => actual.includes(value)));
    for (const document of documents) {
      let metadata = document.metadata ?? document;
      if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { check(false, 'READING_STATISTICS_DOCUMENTS_REQUIRED', '当前文章元数据无效。', 409); } }
      if ((!documentIds || documentIds.has(document.id)) && match(tags, metadata.tags ?? [], query.tagMode ?? 'any')
        && match(collections, metadata.collectionIds ?? [], query.collectionMode ?? 'any')) selected.add(document.id);
    }
    documentIds = selected;
  }
  return { documentIds, actorIds };
}

function groupRows(rows, groupBy, dates) {
  const groups = new Map(), totalSessions = new Set(), totalDocuments = new Set(); let activeMs = 0;
  if (groupBy.length === 1 && groupBy[0] === 'day') for (const { date } of dates) groups.set(canonical([date]), { date, activeMs: 0, sessions: new Set(), documents: new Set() });
  for (const row of rows) {
    const dimensions = { day: row.date, document: row.document_id, actor: row.actor_id };
    const key = canonical(groupBy.map(name => dimensions[name]));
    let target = groups.get(key);
    if (!target) {
      target = { ...Object.fromEntries(groupBy.map(name => [name === 'day' ? 'date' : name + 'Id', dimensions[name]])), activeMs: 0, sessions: new Set(), documents: new Set() };
      groups.set(key, target);
    }
    const sessionIds = JSON.parse(row.session_ids_json);
    check(Array.isArray(sessionIds), 'READING_STATISTICS_INTEGRITY', '统计会话集合损坏。', 409);
    for (const id of sessionIds) { const sessionKey = canonical([row.actor_id, id]); target.sessions.add(sessionKey); totalSessions.add(sessionKey); }
    target.activeMs += row.active_ms; target.documents.add(row.document_id);
    activeMs += row.active_ms; totalDocuments.add(row.document_id);
  }
  return { totals: { activeMs, sessionCount: totalSessions.size, documentCount: totalDocuments.size },
    groups: [...groups.entries()].sort(([a], [b]) => compare(a, b)).map(([, { sessions, documents, ...row }]) => ({ ...row, sessionCount: sessions.size, documentCount: documents.size })) };
}


export { bytes, budget, integer, filters as readingStatisticsFilters, groupRows as groupReadingStatisticsRows };

// Shared output adapter for local accepted-range SQL and cloud aggregate cells.
// The caller supplies rows after global overlap attribution, never raw deltas.
export function summarizeReadingStatisticsRows(rows, query, { documents, now = Date.now(), range } = {}) {
  range ??= readingStatisticsRange(query, { now });
  const groupBy = query.groupBy ?? ['day'];
  check(Array.isArray(groupBy) && groupBy.length <= 3 && new Set(groupBy).size === groupBy.length
    && groupBy.every(value => ['day', 'document', 'actor'].includes(value)), 'VALIDATION_FAILED', '统计分组无效。');
  const selected = filters(query, documents);
  const filtered = rows.filter(row => (!selected.documentIds || selected.documentIds.has(row.document_id)) && (!selected.actorIds || selected.actorIds.has(row.actor_id)));
  const aggregate = groupRows(filtered, groupBy, range.dates);
  return { status: 'complete', timezone: range.timezone, range: { startDate: range.from, endDate: range.to }, groupBy,
    ...aggregate, daily: groupBy.length === 1 && groupBy[0] === 'day' ? aggregate.groups : groupRows(filtered, ['day'], range.dates).groups, measuredOnly: true };
}

// Preserve the existing Flow overview fields while replacing only measured
// reading fields. A caller using an empty workspace for nonreading fields must
// supply today's statistics when today lies outside the requested date range.
export function applyReadingStatisticsSummary(base, statistics, { todayStatistics, now = Date.now() } = {}) {
  if (statistics.status !== 'complete') return { ...base, ...statistics, totals: null, today: null, daily: [], groups: [] };
  const today = statistics.daily?.find(row => row.date === dateAt(now, statistics.timezone)) ?? todayStatistics?.totals;
  return { ...base, ...statistics, totals: { ...base.totals, ...statistics.totals },
    today: today ? { activeMs: today.activeMs, sessionCount: today.sessionCount } : null,
    daily: statistics.daily.map(({ date, activeMs, sessionCount }) => ({ date, activeMs, sessionCount })) };
}
