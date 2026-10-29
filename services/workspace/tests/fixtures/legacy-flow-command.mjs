// Frozen pre-refactor synchronous writes, retained only as an independent test oracle.
// No production import may depend on this fixture. The initializer is FlowData in
// the test harness; these original writes run against a separate SQLite database.
import { canonical, check, identifier, json, object, text, version } from "../../errors.mjs";
import { projectReadingChanges } from "../../reading-projection.mjs";
import { mapRead } from "../../sql-commit.mjs";

const DAY = 86_400_000;
const MAX_SEGMENT = 60_000;
const MAX_REPLAY_AGE = 30 * DAY;
const FUTURE_TOLERANCE = 60_000;
const read = (value) => value ? JSON.parse(value) : null;
const iso = (value) => value === null || value === undefined ? null : new Date(value).toISOString();
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


export class LegacyFlowCommands {
  constructor({db,sql,ports,now,projectionLimits={}}) {
    Object.assign(this,{db,sql,ports,now,projectionLimits});
  }
  get revision() { return Number(this.db.prepare("SELECT value FROM flow_metadata WHERE key='revision'").get().value); }
  touch() { this.db.prepare("UPDATE flow_metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run(); }
  subject(actor) { return text(actor.subjectId || "local", "用户标识", 160, true); }
  session(id, actor) {
    const row = this.db.prepare("SELECT * FROM reading_sessions WHERE id=?").get(identifier(id, "阅读会话"));
    check(row, "NOT_FOUND", "阅读会话不存在。", 404);
    check(row.actor_id === this.subject(actor), "FORBIDDEN", "不能更改其他用户的阅读会话。", 403);
    return row;
  }
  authorizeCommand(actor, command) {
    if (command.kind === "reading.session.start") {
      const row = this.db.prepare("SELECT actor_id FROM reading_sessions WHERE id=?").get(identifier(command.sessionId, "阅读会话"));
      check(!row || row.actor_id === this.subject(actor), "FORBIDDEN", "阅读会话属于其他用户。", 403);
    } else this.session(command.sessionId, actor);
  }
  checkClock(ms, label) { check(ms >= this.now() - MAX_REPLAY_AGE && ms <= this.now() + FUTURE_TOLERANCE, "VALIDATION_FAILED", `${label}须在最近 30 天内，且不能在未来。`); }
  sessionView(row) {
    const document = this.db.prepare("SELECT metadata,archived_at FROM documents WHERE id=?").get(row.document_id);
    return sessionView(row, document);
  }
  command(actor, command) {
    if (command.kind.startsWith("insight.review.")) return this.review(command);
    if (command.kind === "reading.session.start") return this.start(actor, command);
    if (command.kind === "reading.session.activity") return this.activity(actor, command);
    if (command.kind === "reading.session.end") return this.end(actor, command);
    check(false, "VALIDATION_FAILED", "不支持的 Flow 操作。");
  }
  review(command) {
    const insight = this.ports.insight(command.insightId, command.documentId);
    check(!insight.archived_at && !this.ports.document(command.documentId).archived_at, "NOT_FOUND", "洞见或资料已归档。", 404);
    check(["insight.review.add", "insight.review.remove", "insight.review.complete"].includes(command.kind), "VALIDATION_FAILED", "回看操作无效。");
    const previous = this.db.prepare("SELECT * FROM insight_reviews WHERE insight_id=?").get(insight.id);
    const now = iso(this.now()), adding = command.kind.endsWith(".add"), completing = command.kind.endsWith(".complete");
    if (adding ? !previous?.pending : previous?.pending) {
      this.db.prepare(`INSERT INTO insight_reviews VALUES(?,?,?,?,?) ON CONFLICT(insight_id) DO UPDATE SET
        pending=excluded.pending,added_at=excluded.added_at,reviewed_at=excluded.reviewed_at,updated_at=excluded.updated_at`).run(
        insight.id, adding ? 1 : 0, adding ? now : previous.added_at, completing ? now : previous?.reviewed_at || null, now);
      this.touch();
    }
    const review = this.reviewFor(insight.id);
    return { insightId: insight.id, review, insight: { ...read(insight.payload), review }, activityRevision: this.revision };
  }
  reviewView(row) { return { pending: Boolean(row?.pending), addedAt: row?.added_at || null, lastReviewedAt: row?.reviewed_at || null }; }
  reviewFor(insightId) { return mapRead(this.sql.query("SELECT * FROM insight_reviews WHERE insight_id=?", [insightId]), rows => this.reviewView(rows[0])); }
  start(actor, command) {
    const id = identifier(command.sessionId, "阅读会话"), subject = this.subject(actor);
    const started = timestamp(command.startedAt, "开始时间");
    const existing = this.db.prepare("SELECT * FROM reading_sessions WHERE id=?").get(id);
    const revision = version(command.documentRevision, "文档版本");
    const mode = command.mode || command.position?.mode || "source";
    check(["source", "translation", "bilingual"].includes(mode), "VALIDATION_FAILED", "阅读模式无效。");
    const position = validatePosition(command.position, command.documentId, revision, command.position == null ? null : this.ports.navigation(command.documentId, revision));
    const input = canonical({ documentId: command.documentId, documentRevision: revision, startedAt: iso(started), mode, position });
    if (existing) {
      check(existing.actor_id === subject, "FORBIDDEN", "阅读会话属于其他用户。", 403);
      check(existing.start_input === input, "IDEMPOTENCY_CONFLICT", "阅读会话编号已用于其他会话。", 409);
      return { session: this.sessionView(existing), activityRevision: this.revision };
    }
    check(!this.ports.document(command.documentId).archived_at, "NOT_FOUND", "资料已归档。", 404);
    this.ports.revisionRow(command.documentId, revision); this.checkClock(started, "开始时间");
    this.db.prepare(`INSERT INTO reading_sessions(id,actor_id,document_id,document_revision,started_ms,mode,start_position,start_input,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, subject, command.documentId, revision, started, mode, position ? json(position) : null, input, iso(this.now()));
    this.touch();
    return { session: this.sessionView(this.session(id, actor)), activityRevision: this.revision };
  }
  activity(actor, command) {
    const session = this.session(command.sessionId, actor), sequence = version(command.sequence, "活动序号");
    const start = timestamp(command.startedAt, "区间开始时间"), end = timestamp(command.endedAt, "区间结束时间");
    const activeMs = integer(command.activeMs, undefined, 1, MAX_SEGMENT, "有效阅读时间");
    check(end > start && end - start <= MAX_SEGMENT + 1000 && Math.abs(end - start - activeMs) <= 1000, "VALIDATION_FAILED", "阅读时间与区间不一致。");
    const input = canonical({ startedAt: iso(start), endedAt: iso(end), activeMs });
    const previous = this.db.prepare("SELECT * FROM reading_activity WHERE session_id=? AND sequence=?").get(session.id, sequence);
    if (previous) {
      check(previous.input === input, "IDEMPOTENCY_CONFLICT", "活动序号已用于不同区间。", 409);
      return { session: this.sessionView(session), acceptedMs: previous.accepted_ms, activityRevision: this.revision };
    }
    this.checkClock(start, "活动时间"); this.checkClock(end, "活动时间");
    check(start >= session.started_ms && (session.ended_ms === null || end <= session.ended_ms), "VALIDATION_FAILED", "活动超出阅读会话范围。");
    this.db.prepare("INSERT INTO reading_activity VALUES(?,?,?,?,?,?,?)").run(session.id, sequence, start, end, activeMs, 0, input);
    projectReadingChanges(this.db, { ...this.projectionLimits, inTransaction: true, now: this.now() });
    const acceptedMs = this.db.prepare("SELECT accepted_ms FROM reading_activity WHERE session_id=? AND sequence=?").get(session.id, sequence).accepted_ms;
    this.touch();
    return { session: this.sessionView(this.session(session.id, actor)), acceptedMs, activityRevision: this.revision };
  }
  end(actor, command) {
    const session = this.session(command.sessionId, actor), end = timestamp(command.endedAt, "结束时间");
    const reason = command.reason || "leave"; text(reason, "结束原因", 80, true);
    const position = validatePosition(command.position, session.document_id, session.document_revision, command.position == null ? null : this.ports.navigation(session.document_id, session.document_revision));
    const input = canonical({ endedAt: iso(end), position, reason });
    if (session.end_input) {
      check(session.end_input === input, "IDEMPOTENCY_CONFLICT", "阅读会话已经结束。", 409);
      return { session: this.sessionView(session), activityRevision: this.revision };
    }
    this.checkClock(end, "结束时间");
    check(end >= session.started_ms && end >= (session.last_activity_ms || 0), "VALIDATION_FAILED", "结束时间早于已记录的阅读。");
    this.db.prepare("UPDATE reading_sessions SET ended_ms=?,end_position=?,end_reason=?,end_input=? WHERE id=?").run(end, position ? json(position) : null, reason, input, session.id);
    projectReadingChanges(this.db, { ...this.projectionLimits, inTransaction: true, now: this.now() });
    this.touch();
    return { session: this.sessionView(this.session(session.id, actor)), activityRevision: this.revision };
  }

}
