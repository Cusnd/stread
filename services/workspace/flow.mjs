import { canonical, check, identifier, json, object, text, version } from "./errors.mjs";
import { applySchemaMigrations } from "./schema-migrations.mjs";
import { installReadingProjection, prepareIncomingReading } from "./reading-projection.mjs";
import { readingStatisticsRange, summarizeReadingStatisticsRows, applyReadingStatisticsSummary } from "./reading-statistics.mjs";
import { sqliteAccess, mapRead } from "./sql-commit.mjs";

const DAY = 86_400_000;
const MAX_SEGMENT = 60_000;
const MAX_REPLAY_AGE = 30 * DAY;
const FUTURE_TOLERANCE = 60_000;
const read = (value) => value ? JSON.parse(value) : null;
const iso = (value) => value === null || value === undefined ? null : new Date(value).toISOString();
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dateFormatters = new Map();

function sessionView(row, document) {
  return { id: row.id, documentId: row.document_id, documentRevision: row.document_revision,
    documentTitle: document ? read(document.metadata).title || "未命名文档" : "未命名文档", archived: Boolean(document?.archived_at),
    startedAt: iso(row.started_ms), endedAt: iso(row.ended_ms), lastActivityAt: iso(row.last_activity_ms), activeMs: row.active_ms,
    mode: row.mode, startPosition: read(row.start_position), endPosition: read(row.end_position), endReason: row.end_reason };
}

function integer(value, fallback, minimum, maximum, label) {
  const result = value === undefined ? fallback : value;
  check(Number.isSafeInteger(result) && result >= minimum && result <= maximum, "VALIDATION_FAILED", `${label}超出范围。`);
  return result;
}

function timestamp(value, label) {
  check(typeof value === "string" && value.length <= 40 && /(?:Z|[+-]\d{2}:\d{2})$/.test(value), "VALIDATION_FAILED", `${label}需要含时区的时间。`);
  const result = Date.parse(value);
  check(Number.isFinite(result), "VALIDATION_FAILED", `${label}无效。`);
  return result;
}

function zoneFormatter(timezone = "UTC") {
  text(timezone, "时区", 100, true);
  if (dateFormatters.has(timezone)) return dateFormatters.get(timezone);
  let formatter;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { check(false, "VALIDATION_FAILED", "时区无效。"); }
  if (dateFormatters.size >= 32) dateFormatters.delete(dateFormatters.keys().next().value);
  dateFormatters.set(timezone, formatter);
  return formatter;
}

function dateAt(ms, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validDate(value) {
  check(typeof value === "string" && datePattern.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, "VALIDATION_FAILED", "日期须为有效的 YYYY-MM-DD。");
  return value;
}

function shiftDate(date, days) { return new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10); }

// Search for the first instant of the local date. This handles 23/25 hour DST
// days (and zones whose offset changes at midnight), without a fixed UTC offset.
export function flowDayStart(date, timezone) {
  validDate(date);
  const formatter = zoneFormatter(timezone), base = Date.parse(date);
  let lower = base - 2 * DAY, upper = base + 2 * DAY;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (dateAt(middle, formatter) < date) lower = middle + 1; else upper = middle;
  }
  return lower;
}

function dateRange(query, now, defaultDays = 7) {
  const timezone = query.timezone || "UTC", formatter = zoneFormatter(timezone), today = dateAt(now, formatter);
  const days = integer(query.days, defaultDays, 1, 90, "统计天数");
  const endDate = validDate(query.to || today), startDate = validDate(query.from || shiftDate(endDate, 1 - days));
  const count = (Date.parse(endDate) - Date.parse(startDate)) / DAY + 1;
  check(Number.isInteger(count) && count >= 1 && count <= 366, "VALIDATION_FAILED", "日期范围须在 1 至 366 天之间。");
  return { timezone, formatter, today, startDate, endDate, start: flowDayStart(startDate, timezone), end: flowDayStart(shiftDate(endDate, 1), timezone), count };
}

function pagination(query) {
  return { offset: integer(query.offset, 0, 0, 1_000_000, "分页偏移"), limit: integer(query.limit, 30, 1, 100, "分页数量") };
}

function validatePosition(input, documentId, revision, document) {
  if (input === undefined || input === null) return null;
  const position = structuredClone(object(input, "阅读位置"));
  check(Buffer.byteLength(json(position)) <= 8192, "VALIDATION_FAILED", "阅读位置过大。");
  check(position.documentId === undefined || position.documentId === documentId, "VALIDATION_FAILED", "阅读位置属于其他文章。");
  check(position.revision === undefined || position.revision === revision, "VALIDATION_FAILED", "阅读位置版本不一致。");
  if (position.blockId) {
    const index = document.blocks.findIndex((block) => block.id === position.blockId);
    check(index >= 0, "ANCHOR_UNRESOLVED", "阅读位置不存在。", 409);
    const block = document.blocks[index], heading = document.blocks.slice(0, index + 1).findLast((item) => item.type === "heading");
    const preferTranslation = position.mode === "translation" || (position.mode === "bilingual" && position.translationFirst);
    const label = preferTranslation ? heading?.translations?.[position.targetLanguage]?.text || heading?.text : heading?.text;
    if (typeof label === "string" && label.trim()) position.sectionTitle = label;
    const page = block.source?.find((source) => Number.isInteger(source.page) && source.page >= 1)?.page;
    if (page) position.page = page;
  }
  if (position.offsetRatio !== undefined) check(Number.isFinite(position.offsetRatio) && position.offsetRatio >= 0 && position.offsetRatio <= 1, "VALIDATION_FAILED", "阅读偏移无效。");
  if (position.mode) check(["source", "translation", "bilingual"].includes(position.mode), "VALIDATION_FAILED", "阅读模式无效。");
  return { ...position, documentId, revision };
}

async function sessionDays(sql, sessionId, timezone, formatter, requestedRange) {
  const conditions = ["session_id=?"], values = [sessionId];
  if (requestedRange) {
    conditions.push("start_ms>=?", "start_ms<?", "end_ms>?");
    values.push(requestedRange.start - MAX_SEGMENT, requestedRange.end, requestedRange.start);
  }
  // UTC buckets discover candidate local dates without materializing every
  // heartbeat. They do not determine the returned day boundaries: those are
  // still computed in the viewer's IANA timezone, including DST/midnight jumps.
  const buckets = await sql.query(`SELECT MIN(start_ms) AS start_ms,MAX(end_ms) AS end_ms
    FROM reading_active_ranges WHERE ${conditions.join(" AND ")}
    GROUP BY CAST(start_ms / ${DAY} AS INTEGER) ORDER BY start_ms`, values);
  const dates = new Set();
  for (const bucket of buckets) {
    const start = Math.max(bucket.start_ms, requestedRange?.start ?? -Infinity), end = Math.min(bucket.end_ms, requestedRange?.end ?? Infinity);
    if (end <= start) continue;
    const last = dateAt(end - 1, formatter);
    for (let date = dateAt(start, formatter); date <= last; date = shiftDate(date, 1)) dates.add(date);
  }
  const aggregate = `SELECT SUM(MIN(end_ms,?)-MAX(start_ms,?)) AS activeMs,
    MIN(MAX(start_ms,?)) AS started_ms,MAX(MIN(end_ms,?)) AS ended_ms
    FROM reading_active_ranges WHERE session_id=? AND start_ms>=? AND start_ms<? AND end_ms>?`;
  const days = [];
  for (const date of [...dates].sort()) {
    const start = Math.max(flowDayStart(date, timezone), requestedRange?.start ?? -Infinity);
    const end = Math.min(flowDayStart(shiftDate(date, 1), timezone), requestedRange?.end ?? Infinity);
    if (end <= start) continue;
    const [row] = await sql.query(aggregate, [end, start, start, end, sessionId, start - MAX_SEGMENT, end, start]);
    if (row.activeMs > 0) days.push({ date, activeMs: row.activeMs, startedAt: iso(row.started_ms), endedAt: iso(row.ended_ms) });
  }
  return days;
}

export const flowSchemaMigrations = [{ version: 1, name: "reading sessions and insight reviews", sql: `
      CREATE TABLE IF NOT EXISTS flow_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS insight_reviews (
        insight_id TEXT PRIMARY KEY REFERENCES insights(id), pending INTEGER NOT NULL,
        added_at TEXT NOT NULL, reviewed_at TEXT, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS insight_reviews_pending ON insight_reviews(pending, added_at);
      CREATE TABLE IF NOT EXISTS reading_sessions (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id),
        document_revision INTEGER NOT NULL, started_ms INTEGER NOT NULL, ended_ms INTEGER,
        last_activity_ms INTEGER, active_ms INTEGER NOT NULL DEFAULT 0, mode TEXT,
        start_position TEXT, end_position TEXT, end_reason TEXT, start_input TEXT NOT NULL,
        end_input TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reading_sessions_actor_date ON reading_sessions(actor_id, started_ms DESC, id);
      CREATE TABLE IF NOT EXISTS reading_activity (
        session_id TEXT NOT NULL REFERENCES reading_sessions(id), sequence INTEGER NOT NULL,
        started_ms INTEGER NOT NULL, ended_ms INTEGER NOT NULL, reported_ms INTEGER NOT NULL,
        accepted_ms INTEGER NOT NULL, input TEXT NOT NULL, PRIMARY KEY(session_id, sequence));
      CREATE TABLE IF NOT EXISTS reading_active_ranges (
        session_id TEXT NOT NULL, sequence INTEGER NOT NULL, part INTEGER NOT NULL,
        actor_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
        PRIMARY KEY(session_id, sequence, part),
        FOREIGN KEY(session_id, sequence) REFERENCES reading_activity(session_id, sequence));
      CREATE INDEX IF NOT EXISTS reading_active_ranges_actor_time ON reading_active_ranges(actor_id, end_ms, start_ms);
    ` }];

export class FlowData {
  constructor(db, ports, { now = Date.now, readingProjectionLimits = {}, sql, initialize = true } = {}) {
    this.db = db; this.ports = ports; this.now = now;
    this.sql = sql || sqliteAccess(db);
    this.projectionLimits = readingProjectionLimits;
    if (!initialize) return;
    applySchemaMigrations(db, "flow", flowSchemaMigrations);
    db.prepare("INSERT OR IGNORE INTO flow_metadata VALUES('revision','0')").run();
    db.prepare("INSERT OR IGNORE INTO flow_metadata VALUES('trackingStartedAt',?)").run(iso(now()));
    installReadingProjection(db, { ...this.projectionLimits, now: now() });
  }

  get revision() { return Number(this.db.prepare("SELECT value FROM flow_metadata WHERE key='revision'").get().value); }
  async getRevision() { return Number((await this.sql.query("SELECT value FROM flow_metadata WHERE key='revision'"))[0].value); }
  async requireReadingProjection(expectedRevision) {
    const [state] = await this.sql.query(`SELECT
      (SELECT value FROM reading_projection_state WHERE key='version') AS version,
      (SELECT value FROM flow_metadata WHERE key='revision') AS revision,
      EXISTS(SELECT 1 FROM reading_projection_dirty LIMIT 1) AS dirty_events,
      EXISTS(SELECT 1 FROM reading_projection_sessions LIMIT 1) AS dirty_sessions`);
    check(state?.version === '1' && !state.dirty_events && !state.dirty_sessions && state.revision !== null,
      "READING_PROJECTION_PENDING", "阅读统计派生状态尚未就绪，请稍后重试；原始记录已保留。", 503, { retryable: true });
    const revision = Number(state.revision);
    check(expectedRevision === undefined || revision === expectedRevision, "READING_PROJECTION_PENDING", "查询期间阅读统计已改变，请重试。", 503, { retryable: true });
    return revision;
  }
  subject(actor) { return text(actor.subjectId || "local", "用户标识", 160, true); }
  checkClock(ms, label) { check(ms >= this.now() - MAX_REPLAY_AGE && ms <= this.now() + FUTURE_TOLERANCE, "VALIDATION_FAILED", `${label}须在最近 30 天内，且不能在未来。`); }
  sessionView(row) {
    const document = this.db.prepare("SELECT metadata,archived_at FROM documents WHERE id=?").get(row.document_id);
    return sessionView(row, document);
  }
  async authorizeCommandAsync(actor, command, reads) {
    const id = identifier(command.sessionId, "阅读会话");
    const row = reads ? await reads.get("SELECT * FROM reading_sessions WHERE id=?", id)
      : (await this.sql.query("SELECT * FROM reading_sessions WHERE id=?", [id]))[0];
    if (command.kind === "reading.session.start") {
      check(!row || row.actor_id === this.subject(actor), "FORBIDDEN", "阅读会话属于其他用户。", 403);
    } else {
      check(row, "NOT_FOUND", "阅读会话不存在。", 404);
      check(row.actor_id === this.subject(actor), "FORBIDDEN", "不能更改其他用户的阅读会话。", 403);
    }
    return row;
  }
  // Prepare only the concrete rows/derived SQL needed by this command. The
  // caller commits these with its receipt, replication record and read guards.
  // No SQL is simulated and no partial business state is written here.
  async prepareCommand(actor, command, reads) {
    const prepared = { changes: [], statements: [], result: {}, touchActivity: false,
      workspaceChange: !command.kind.startsWith("reading.session.") };
    const finish = (result, changed = false) => {
      prepared.result = result; prepared.touchActivity = changed;
      if (changed) prepared.statements.push({ sql: "UPDATE flow_metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'", values: [] });
      // The enclosing commit fills activityRevision from its final DB value.
      prepared.result.activityRevision = 0;
      return prepared;
    };
    const document = async id => {
      const row = await reads.get("SELECT * FROM documents WHERE id=?", identifier(id, "文档 ID"));
      check(row, "NOT_FOUND", "没有找到这份文档。", 404); return row;
    };
    const position = async (input, id, revision) => {
      if (input == null) return null;
      const saved = await reads.get("SELECT document_id,revision FROM revisions WHERE document_id=? AND revision=?", id, revision);
      check(saved, "NOT_FOUND", "没有找到这个正文版本。", 404);
      return validatePosition(input, id, revision, await this.ports.navigation(id, revision));
    };
    if (command.kind.startsWith("insight.review.")) {
      const insight = await reads.get("SELECT * FROM insights WHERE id=? AND document_id=?", identifier(command.insightId, "洞见 ID"), identifier(command.documentId));
      check(insight, "NOT_FOUND", "洞见不存在。", 404);
      check(!insight.archived_at && !(await document(command.documentId)).archived_at, "NOT_FOUND", "洞见或资料已归档。", 404);
      check(["insight.review.add", "insight.review.remove", "insight.review.complete"].includes(command.kind), "VALIDATION_FAILED", "回看操作无效。");
      const previous = await reads.get("SELECT * FROM insight_reviews WHERE insight_id=?", insight.id);
      const now = iso(this.now()), adding = command.kind.endsWith(".add"), completing = command.kind.endsWith(".complete");
      const changed = adding ? !previous?.pending : Boolean(previous?.pending);
      const row = changed ? { insight_id: insight.id, pending: adding ? 1 : 0, added_at: adding ? now : previous.added_at,
        reviewed_at: completing ? now : previous?.reviewed_at || null, updated_at: now } : previous;
      if (changed) prepared.changes.push({ entity: "insight_reviews", value: row });
      const review = this.reviewView(row);
      return finish({ insightId: insight.id, review, insight: { ...read(insight.payload), review } }, changed);
    }
    if (command.kind === "reading.session.start") {
      const id = identifier(command.sessionId, "阅读会话"), subject = this.subject(actor), started = timestamp(command.startedAt, "开始时间");
      const existing = await this.authorizeCommandAsync(actor, command, reads);
      const revision = version(command.documentRevision, "文档版本"), mode = command.mode || command.position?.mode || "source";
      check(["source", "translation", "bilingual"].includes(mode), "VALIDATION_FAILED", "阅读模式无效。");
      const value = await position(command.position, command.documentId, revision);
      const input = canonical({ documentId: command.documentId, documentRevision: revision, startedAt: iso(started), mode, position: value });
      const row = await document(command.documentId);
      if (existing) {
        check(existing.start_input === input, "IDEMPOTENCY_CONFLICT", "阅读会话编号已用于其他会话。", 409);
        return finish({ session: sessionView(existing, row) });
      }
      check(!row.archived_at, "NOT_FOUND", "资料已归档。", 404);
      check(await reads.get("SELECT document_id,revision FROM revisions WHERE document_id=? AND revision=?", command.documentId, revision), "NOT_FOUND", "没有找到这个正文版本。", 404);
      this.checkClock(started, "开始时间");
      const next = { id, actor_id: subject, document_id: command.documentId, document_revision: revision, started_ms: started,
        ended_ms: null, last_activity_ms: null, active_ms: 0, mode, start_position: value ? json(value) : null,
        end_position: null, end_reason: null, start_input: input, end_input: null, created_at: iso(this.now()) };
      prepared.changes.push({ entity: "reading_sessions", value: next });
      const projection = await prepareIncomingReading(prepared.changes, reads, { ...this.projectionLimits, now: this.now() });
      prepared.statements.push(...projection.after);
      return finish({ session: sessionView(projection.sessions.find(item => item.id === id) || next, row) }, true);
    }
    check(["reading.session.activity", "reading.session.end"].includes(command.kind), "VALIDATION_FAILED", "不支持的 Flow 操作。");
    const session = await this.authorizeCommandAsync(actor, command, reads), row = await document(session.document_id);
    if (command.kind === "reading.session.activity") {
      const sequence = version(command.sequence, "活动序号"), start = timestamp(command.startedAt, "区间开始时间"), end = timestamp(command.endedAt, "区间结束时间");
      const activeMs = integer(command.activeMs, undefined, 1, MAX_SEGMENT, "有效阅读时间");
      check(end > start && end - start <= MAX_SEGMENT + 1000 && Math.abs(end - start - activeMs) <= 1000, "VALIDATION_FAILED", "阅读时间与区间不一致。");
      const input = canonical({ startedAt: iso(start), endedAt: iso(end), activeMs });
      const previous = await reads.get("SELECT * FROM reading_activity WHERE session_id=? AND sequence=?", session.id, sequence);
      if (previous) {
        check(previous.input === input, "IDEMPOTENCY_CONFLICT", "活动序号已用于不同区间。", 409);
        return finish({ session: sessionView(session, row), acceptedMs: previous.accepted_ms });
      }
      this.checkClock(start, "活动时间"); this.checkClock(end, "活动时间");
      check(start >= session.started_ms && (session.ended_ms === null || end <= session.ended_ms), "VALIDATION_FAILED", "活动超出阅读会话范围。");
      const event = { session_id: session.id, sequence, started_ms: start, ended_ms: end, reported_ms: activeMs, accepted_ms: 0, input };
      const projected = await this.prepareActivityProjection(session, event, reads);
      prepared.changes.push({ entity: "reading_activity", value: { ...event, accepted_ms: projected.acceptedMs } });
      prepared.statements.push(...projected.statements);
      return finish({ session: sessionView(projected.session, row), acceptedMs: projected.acceptedMs }, true);
    }
    const end = timestamp(command.endedAt, "结束时间"), reason = command.reason || "leave";
    text(reason, "结束原因", 80, true);
    const value = await position(command.position, session.document_id, session.document_revision);
    const input = canonical({ endedAt: iso(end), position: value, reason });
    if (session.end_input) {
      check(session.end_input === input, "IDEMPOTENCY_CONFLICT", "阅读会话已经结束。", 409);
      return finish({ session: sessionView(session, row) });
    }
    this.checkClock(end, "结束时间");
    check(end >= session.started_ms && end >= (session.last_activity_ms || 0), "VALIDATION_FAILED", "结束时间早于已记录的阅读。");
    const first = await reads.get("SELECT started_ms FROM reading_activity WHERE session_id=? ORDER BY started_ms LIMIT 1", session.id);
    const last = await reads.get("SELECT ended_ms FROM reading_activity WHERE session_id=? ORDER BY ended_ms DESC LIMIT 1", session.id);
    check(!first || first.started_ms >= session.started_ms && last.ended_ms <= end, "SYNC_INVALID_READING", "阅读会话范围不能排除已记录的活动。", 409);
    const next = { ...session, ended_ms: end, end_position: value ? json(value) : null, end_reason: reason, end_input: input };
    prepared.changes.push({ entity: "reading_sessions", value: next });
    const projection = await prepareIncomingReading(prepared.changes, reads, { ...this.projectionLimits, now: this.now() });
    prepared.statements.push(...projection.after);
    return finish({ session: sessionView(projection.sessions.find(item => item.id === session.id) || next, row) }, true);
  }
  async prepareActivityProjection(session, event, reads) {
    const projection = await prepareIncomingReading([{ entity: "reading_activity", value: event }], reads, { ...this.projectionLimits, now: this.now() });
    return { statements: projection.after, acceptedMs: projection.events.find(item => item.sessionId === session.id && item.sequence === event.sequence).acceptedMs,
      session: projection.sessions.find(item => item.id === session.id) };
  }
  reviewView(row) { return { pending: Boolean(row?.pending), addedAt: row?.added_at || null, lastReviewedAt: row?.reviewed_at || null }; }
  reviewFor(insightId) { return mapRead(this.sql.query("SELECT * FROM insight_reviews WHERE insight_id=?", [insightId]), rows => this.reviewView(rows[0])); }
  insightWhere(query) {
    const clauses = [], values = [], state = query.state || "active";
    check(["active", "archived", "all"].includes(state), "VALIDATION_FAILED", "洞见归档状态无效。");
    if (state !== "all") clauses.push(`i.archived_at IS ${state === "archived" ? "NOT " : ""}NULL`);
    // The ordinary Flow feed stays active-only even when its saved filter names
    // an archived document. MCP document-scoped reads opt in to retained data.
    if (state === "active" && !query.includeArchivedDocuments) clauses.push("d.archived_at IS NULL");
    const type = query.type || "all", review = query.review || "all", question = query.question || "all";
    check(["all", "annotation", "question", "note"].includes(type), "VALIDATION_FAILED", "洞见类型无效。");
    check(["all", "pending"].includes(review) && ["all", "unresolved", "resolved"].includes(question), "VALIDATION_FAILED", "洞见筛选无效。");
    if (type !== "all") { clauses.push("json_extract(i.payload,'$.type')=?"); values.push(type); }
    if (review === "pending") clauses.push("r.pending=1");
    if (question !== "all") clauses.push("json_extract(i.payload,'$.type')='question'", `json_extract(i.payload,'$.answer') IS ${question === "resolved" ? "NOT " : ""}NULL`);
    if (query.documentId) { clauses.push("i.document_id=?"); values.push(identifier(query.documentId)); }
    if (query.query) {
      const queryText = text(query.query, "检索词", 500).trim();
      clauses.push("(instr(lower(COALESCE(json_extract(i.payload,'$.title'),'')),lower(?))>0 OR instr(lower(COALESCE(json_extract(i.payload,'$.body'),'')),lower(?))>0 OR instr(lower(COALESCE(json_extract(i.payload,'$.quote'),'')),lower(?))>0 OR instr(lower(COALESCE(json_extract(d.metadata,'$.title'),'')),lower(?))>0 OR instr(lower(COALESCE(json_extract(i.payload,'$.reference'),'')),lower(?))>0)");
      values.push(queryText, queryText, queryText, queryText, queryText);
    }
    return { where: clauses.join(" AND ") || "1=1", values };
  }
  insightView(row) {
    return { ...read(row.payload), documentTitle: read(row.metadata).title || "未命名文档", review: this.reviewView(row) };
  }
  async insight(query) {
    const id = identifier(query.insightId, "洞见 ID");
    const [row] = await this.sql.query(`SELECT i.payload,d.metadata,r.pending,r.added_at,r.reviewed_at
      FROM insights i JOIN documents d ON d.id=i.document_id LEFT JOIN insight_reviews r ON r.insight_id=i.id
      WHERE i.id=? AND i.archived_at IS NULL AND d.archived_at IS NULL`, [id]);
    check(row, "NOT_FOUND", "洞见不存在或已归档。", 404);
    return { insight: this.insightView(row), activityRevision: await this.getRevision() };
  }
  async insights(query) {
    const { offset, limit } = pagination(query), { where, values } = this.insightWhere(query);
    const joins = "FROM insights i JOIN documents d ON d.id=i.document_id LEFT JOIN insight_reviews r ON r.insight_id=i.id";
    const total = (await this.sql.query(`SELECT COUNT(*) AS count ${joins} WHERE ${where}`, values))[0].count;
    const order = query.review === "pending" ? "r.added_at DESC,i.id" : "json_extract(i.payload,'$.createdAt') DESC,i.id";
    const rows = await this.sql.query(`SELECT i.payload,d.metadata,r.pending,r.added_at,r.reviewed_at ${joins} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...values, limit, offset]);
    return { items: rows.map((row) => this.insightView(row)), total, offset, limit, hasMore: offset + rows.length < total, activityRevision: await this.getRevision() };
  }
  async history(actor, query) {
    const activityRevision = await this.requireReadingProjection();
    const { offset, limit } = pagination(query), subject = this.subject(actor), conditions = ["s.actor_id=?", "s.active_ms>0"], values = [subject];
    const timezone = query.timezone || "UTC", formatter = zoneFormatter(timezone);
    let requestedRange;
    if (query.documentId) { conditions.push("s.document_id=?"); values.push(identifier(query.documentId)); }
    if (query.from || query.to) {
      const range = dateRange(query, this.now(), 90); requestedRange = range;
      conditions.push("EXISTS (SELECT 1 FROM reading_active_ranges accepted WHERE accepted.session_id=s.id AND accepted.start_ms>=? AND accepted.start_ms<? AND accepted.end_ms>?)"); values.push(range.start - MAX_SEGMENT, range.end, range.start);
    }
    const where = conditions.join(" AND ");
    const total = (await this.sql.query(`SELECT COUNT(*) AS count FROM reading_sessions s WHERE ${where}`, values))[0].count;
    const rows = await this.sql.query(`SELECT s.* FROM reading_sessions s WHERE ${where} ORDER BY s.started_ms DESC,s.id LIMIT ? OFFSET ?`, [...values, limit, offset]);
    const items = await Promise.all(rows.map(async (row) => {
      const last = iso(row.ended_ms ?? row.last_activity_ms ?? row.started_ms);
      const args = [row.document_id, iso(row.started_ms), last];
      const insightClause = "i.document_id=? AND i.archived_at IS NULL AND json_extract(i.payload,'$.createdAt')>=? AND json_extract(i.payload,'$.createdAt')<=?";
      const insightCount = (await this.sql.query(`SELECT COUNT(*) AS count FROM insights i WHERE ${insightClause}`, args))[0].count;
      const insights = (await this.sql.query(`SELECT i.payload,d.metadata,r.pending,r.added_at,r.reviewed_at FROM insights i JOIN documents d ON d.id=i.document_id LEFT JOIN insight_reviews r ON r.insight_id=i.id WHERE ${insightClause} ORDER BY json_extract(i.payload,'$.createdAt'),i.id LIMIT 12`, args)).map((item) => this.insightView(item));
      const [document] = await this.sql.query("SELECT metadata,archived_at FROM documents WHERE id=?", [row.document_id]);
      return { ...sessionView(row, document), insightCount, insights, days: await sessionDays(this.sql, row.id, timezone, formatter, requestedRange) };
    }));
    await this.requireReadingProjection(activityRevision);
    return { items, total, offset, limit, hasMore: offset + items.length < total, activityRevision };
  }
  async statistics(actor, query) {
    const revision = await this.requireReadingProjection();
    const subject = this.subject(actor);
    check(query.actorIds === undefined || Array.isArray(query.actorIds) && query.actorIds.every(id => id === subject),
      "FORBIDDEN", "不能读取其他用户的阅读统计。", 403);
    const requested = { ...query, actorIds: query.actorIds ?? [subject] };
    const legacyRange = dateRange(query, this.now());
    const range = readingStatisticsRange({ from: legacyRange.startDate, to: legacyRange.endDate, timezone: legacyRange.timezone });
    const documents = await this.sql.query("SELECT id,metadata FROM documents"), rows = [];
    // Existing globally reconciled accepted ranges preserve cross-document and
    // cross-device ownership. Return one row/session/day, never raw heartbeats.
    const statement = `SELECT ? AS date,r.actor_id,s.document_id,
      SUM(MIN(r.end_ms,?)-MAX(r.start_ms,?)) AS active_ms,json_array(r.session_id) AS session_ids_json
      FROM reading_active_ranges r JOIN reading_sessions s ON s.id=r.session_id
      WHERE r.actor_id=? AND r.end_ms>? AND r.end_ms<? AND r.start_ms<?
      GROUP BY r.actor_id,s.document_id,r.session_id LIMIT ?`;
    for (const day of range.dates) {
      rows.push(...await this.sql.query(statement, [day.date, day.end, day.start, subject, day.start, day.end + MAX_SEGMENT, day.end, 20001 - rows.length]));
      check(rows.length <= 20000, "READING_STATISTICS_BUDGET", "阅读统计范围过大，请按较短日期区间查询。", 503, { retryable: true, phase: "local-cells", limit: 20000 });
    }
    await this.requireReadingProjection(revision);
    return { ...summarizeReadingStatisticsRows(rows, requested, { documents, now: this.now(), range }),
      sourceRevision: { minimum: revision, maximum: revision } };
  }
  async summary(actor, query) {
    const advanced = ["groupBy", "documentIds", "actorIds", "tags", "collectionIds", "collections", "tagMode", "collectionMode"].some(key => query[key] !== undefined);
    if (!advanced) return this.summaryDefault(actor, query);
    const base = await this.summaryDefault(actor, query), statistics = await this.statistics(actor, query);
    const today = dateAt(this.now(), zoneFormatter(query.timezone || "UTC"));
    const todayStatistics = statistics.daily.some(day => day.date === today) ? undefined
      : await this.statistics(actor, { ...query, from: today, to: today });
    return applyReadingStatisticsSummary(base, statistics, { todayStatistics, now: this.now() });
  }
  async summaryDefault(actor, query) {
    const activityRevision = await this.requireReadingProjection();
    const range = dateRange(query, this.now()), subject = this.subject(actor);
    // Aggregate inside SQLite: a 30-day chart returns 30 rows, not every 15s
    // heartbeat. Both time bounds are indexable; querying an old day must not
    // scan the actor's entire later history. Accepted pieces are <= 60s long.
    const aggregate = `SELECT COALESCE(SUM(MIN(r.end_ms,?)-MAX(r.start_ms,?)),0) AS activeMs,
      COUNT(DISTINCT r.session_id) AS sessionCount,COUNT(DISTINCT s.document_id) AS documentCount
      FROM reading_active_ranges r JOIN reading_sessions s ON s.id=r.session_id
      WHERE r.actor_id=? AND r.end_ms>? AND r.end_ms<? AND r.start_ms<?`;
    const totalsAt = async (start, end) => (await this.sql.query(aggregate, [end, start, subject, start, end + MAX_SEGMENT, end]))[0];
    const daily = [];
    let dayStart = range.start;
    for (let index = 0; index < range.count; index++) {
      const date = shiftDate(range.startDate, index), dayEnd = flowDayStart(shiftDate(date, 1), range.timezone);
      const { activeMs, sessionCount } = await totalsAt(dayStart, dayEnd);
      daily.push({ date, activeMs, sessionCount }); dayStart = dayEnd;
    }
    const totals = await totalsAt(range.start, range.end);
    const [insightCounts] = await this.sql.query(`SELECT COUNT(*) AS insightCount,
      SUM(CASE WHEN json_extract(i.payload,'$.type')='question' AND json_extract(i.payload,'$.answer') IS NULL THEN 1 ELSE 0 END) AS unresolvedQuestionCount,
      SUM(CASE WHEN r.pending=1 THEN 1 ELSE 0 END) AS reviewCount
      FROM insights i JOIN documents d ON d.id=i.document_id LEFT JOIN insight_reviews r ON r.insight_id=i.id WHERE i.archived_at IS NULL AND d.archived_at IS NULL`);
    const upcoming = (await Promise.all((await this.ports.meta("plan")).map(async (id) => {
      const [row] = await this.sql.query("SELECT * FROM documents WHERE id=? AND archived_at IS NULL", [id]);
      if (!row) return [];
      const metadata = read(row.metadata), count = (await this.sql.query("SELECT COUNT(*) AS count FROM insights WHERE document_id=? AND archived_at IS NULL", [id]))[0].count;
      return [{ id, title: metadata.title || "未命名文档", kind: metadata.kind || "文档", status: metadata.status || "unread", tags: metadata.tags || [], collectionIds: metadata.collectionIds || [], version: row.version, revision: row.current_revision, readingState: read((await this.sql.query("SELECT payload FROM reading WHERE document_id=?", [id]))[0]?.payload), insightCount: count }];
    }))).flat();
    let today = daily.find((day) => day.date === range.today);
    if (!today) {
      const start = flowDayStart(range.today, range.timezone), end = flowDayStart(shiftDate(range.today, 1), range.timezone);
      today = await totalsAt(start, end);
    }
    const result = { activityRevision, trackingStartedAt: (await this.sql.query("SELECT value FROM flow_metadata WHERE key='trackingStartedAt'"))[0].value,
      timezone: range.timezone, range: { startDate: range.startDate, endDate: range.endDate },
      totals: { ...totals, insightCount: insightCounts.insightCount, unresolvedQuestionCount: insightCounts.unresolvedQuestionCount || 0, reviewCount: insightCounts.reviewCount || 0 },
      today: { activeMs: today.activeMs, sessionCount: today.sessionCount }, daily, upcoming, planVersion: await this.ports.meta("planVersion") };
    await this.requireReadingProjection(activityRevision);
    return result;
  }
  query(actor, query) {
    if (query.kind === "flow.summary") return this.summary(actor, query);
    if (query.kind === "flow.insights") return this.insights(query);
    if (query.kind === "flow.insight") return this.insight(query);
    if (query.kind === "flow.history") return this.history(actor, query);
    check(false, "VALIDATION_FAILED", "不支持的 Flow 查询。");
  }
}
