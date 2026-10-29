import { canonical, check } from "./errors.mjs";

// IDs are compared by UTF-16 code units, not the host's ICU/default locale.
// The same raw events therefore have the same owner on every deployment.
const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const compareReadingEvents = (a, b) => a.countedStart - b.countedStart || a.ended_ms - b.ended_ms || compareId(a.session_id, b.session_id) || a.sequence - b.sequence;

export function validateReadingEvent(session, event, now = Date.now()) {
  check(session, "SYNC_INVALID_READING", "阅读活动缺少对应会话。", 409);
  const { started_ms: start, ended_ms: end, reported_ms: active } = event;
  check(typeof session.actor_id === "string" && session.actor_id.length > 0
    && [start, end, active, event.sequence, session.started_ms].every(Number.isSafeInteger)
    && event.sequence > 0 && active > 0 && active <= 60000 && end > start
    && end - start <= 61000 && Math.abs(end - start - active) <= 1000
    && start >= session.started_ms && end <= now + 60000
    && (session.ended_ms === null || Number.isSafeInteger(session.ended_ms) && end <= session.ended_ms),
  "SYNC_INVALID_READING", "阅读活动区间与已记录会话不一致。", 409);
  const expected = canonical({ startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), activeMs: active });
  check(event.input === expected, "SYNC_INVALID_READING", "阅读活动原始输入与区间不一致。", 409);
  return { ...event, actor: session.actor_id, countedStart: Math.max(start, end - active) };
}

// Replicate original measured events, never device-local accepted totals. A
// deterministic order gives each millisecond to one session of the same actor.
// Old events remain valid: they were recorded locally, not replayed as new time.
export function reconcileReadingEvents(sessions, events, now = Date.now()) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const totals = new Map(sessions.map((session) => [session.id, { activeMs: 0, lastActivityMs: null }]));
  const rows = events.map((event) => validateReadingEvent(byId.get(event.session_id), event, now))
    .sort((a, b) => compareId(a.actor, b.actor) || compareReadingEvents(a, b));
  const ranges = [], accepted = [], through = new Map();
  for (const row of rows) {
    const start = Math.max(row.countedStart, through.get(row.actor) ?? -Infinity);
    const activeMs = Math.max(0, row.ended_ms - start), total = totals.get(row.session_id);
    through.set(row.actor, Math.max(row.ended_ms, through.get(row.actor) ?? -Infinity));
    total.activeMs += activeMs;
    total.lastActivityMs = Math.max(total.lastActivityMs ?? 0, row.ended_ms);
    accepted.push({ sessionId: row.session_id, sequence: row.sequence, activeMs });
    if (activeMs) ranges.push({ sessionId: row.session_id, sequence: row.sequence, part: 0, actor: row.actor, start, end: row.ended_ms });
  }
  return { ranges, accepted, sessions: [...totals].map(([id, value]) => ({ id, ...value })) };
}

export function rebuildSyncedReading(db, options = {}) {
  const apply = () => {
    // Explicit repair/migration oracle only. Read and write under one snapshot.
    const result = reconcileReadingEvents(db.prepare("SELECT * FROM reading_sessions").all(), db.prepare("SELECT * FROM reading_activity").all(), options.now ?? Date.now());
    db.prepare("DELETE FROM reading_active_ranges").run();
    const insert = db.prepare("INSERT INTO reading_active_ranges VALUES(?,?,?,?,?,?)");
    for (const row of result.ranges) insert.run(row.sessionId, row.sequence, row.part, row.actor, row.start, row.end);
    const activity = db.prepare("UPDATE reading_activity SET accepted_ms=? WHERE session_id=? AND sequence=?");
    for (const row of result.accepted) activity.run(row.activeMs, row.sessionId, row.sequence);
    const session = db.prepare("UPDATE reading_sessions SET active_ms=?,last_activity_ms=? WHERE id=?");
    for (const row of result.sessions) session.run(row.activeMs, row.lastActivityMs, row.id);
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reading_event_index'").get()) {
      db.prepare("DELETE FROM reading_event_index").run();
      db.prepare(`INSERT INTO reading_event_index(session_id,sequence,actor_id,counted_start,ended_ms,accepted_ms)
        SELECT a.session_id,a.sequence,s.actor_id,MAX(a.started_ms,a.ended_ms-a.reported_ms),a.ended_ms,a.accepted_ms
        FROM reading_activity a JOIN reading_sessions s ON s.id=a.session_id`).run();
      db.prepare("DELETE FROM reading_projection_dirty").run();
      db.prepare("DELETE FROM reading_projection_sessions").run();
      db.prepare("INSERT INTO reading_projection_state VALUES('version','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    }
    return { sessions: result.sessions.length, activities: result.accepted.length, activeMs: result.sessions.reduce((sum, row) => sum + row.activeMs, 0) };
  };
  return options.inTransaction ? apply() : db.transaction(apply);
}
