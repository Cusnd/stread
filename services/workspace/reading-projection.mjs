import { check } from "./errors.mjs";
import { applySchemaMigrations } from "./schema-migrations.mjs";
import { rebuildSyncedReading, validateReadingEvent, compareReadingEvents } from "./sync-reading.mjs";

// This index and its invalidation queue are local derived state, never replicated.
// Raw measured events remain in reading_activity with their original identities.
export const READING_INTERVAL_LIMIT = 60_000;
export const READING_PROJECTION_LIMITS = Object.freeze({ windowLimit: 4096, mutationLimit: 4096, operationLimit: 16384 });

const schema = `
  CREATE TABLE IF NOT EXISTS reading_event_index (
    session_id TEXT NOT NULL, sequence INTEGER NOT NULL, actor_id TEXT NOT NULL,
    counted_start INTEGER NOT NULL, ended_ms INTEGER NOT NULL, accepted_ms INTEGER NOT NULL,
    PRIMARY KEY(session_id,sequence));
  CREATE INDEX IF NOT EXISTS reading_event_index_actor_time ON reading_event_index(actor_id,counted_start,ended_ms,session_id,sequence);
  CREATE INDEX IF NOT EXISTS reading_activity_session_end ON reading_activity(session_id,ended_ms DESC);
  CREATE INDEX IF NOT EXISTS reading_activity_session_start ON reading_activity(session_id,started_ms);
  CREATE INDEX IF NOT EXISTS reading_ranges_session_time ON reading_active_ranges(session_id,start_ms,end_ms);
  CREATE INDEX IF NOT EXISTS reading_sessions_actor_document_date ON reading_sessions(actor_id,document_id,started_ms DESC,id);
  CREATE INDEX IF NOT EXISTS flow_insight_document_created ON insights(document_id,json_extract(payload,'$.createdAt'),id);
  CREATE TABLE IF NOT EXISTS reading_projection_dirty (session_id TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(session_id,sequence));
  CREATE TABLE IF NOT EXISTS reading_projection_sessions (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS reading_projection_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS reader_projection_activity_insert AFTER INSERT ON reading_activity
    BEGIN INSERT OR IGNORE INTO reading_projection_dirty VALUES(NEW.session_id,NEW.sequence); END;
  CREATE TRIGGER IF NOT EXISTS reader_projection_activity_update
    AFTER UPDATE OF session_id,sequence,started_ms,ended_ms,reported_ms,input ON reading_activity
    WHEN OLD.session_id IS NOT NEW.session_id OR OLD.sequence IS NOT NEW.sequence OR OLD.started_ms IS NOT NEW.started_ms
      OR OLD.ended_ms IS NOT NEW.ended_ms OR OLD.reported_ms IS NOT NEW.reported_ms OR OLD.input IS NOT NEW.input
    BEGIN INSERT OR IGNORE INTO reading_projection_dirty VALUES(OLD.session_id,OLD.sequence);
      INSERT OR IGNORE INTO reading_projection_dirty VALUES(NEW.session_id,NEW.sequence); END;
  CREATE TRIGGER IF NOT EXISTS reader_projection_activity_delete BEFORE DELETE ON reading_activity
    BEGIN INSERT OR IGNORE INTO reading_projection_dirty VALUES(OLD.session_id,OLD.sequence);
      DELETE FROM reading_active_ranges WHERE session_id=OLD.session_id AND sequence=OLD.sequence; END;
  CREATE TRIGGER IF NOT EXISTS reader_projection_session_update AFTER UPDATE OF actor_id,started_ms,ended_ms ON reading_sessions
    WHEN OLD.actor_id IS NOT NEW.actor_id OR OLD.started_ms IS NOT NEW.started_ms OR OLD.ended_ms IS NOT NEW.ended_ms
    BEGIN INSERT OR IGNORE INTO reading_projection_sessions VALUES(NEW.id); END;
`;

export const readingProjectionSchemaMigrations = [{ version: 1, name: "indexed deterministic reading projection", sql: schema },
  { version: 2, name: "Keep invalidation deduplication inside upsert triggers", sql: `
    DROP TRIGGER IF EXISTS reader_projection_activity_insert;
    DROP TRIGGER IF EXISTS reader_projection_activity_update;
    DROP TRIGGER IF EXISTS reader_projection_activity_delete;
    DROP TRIGGER IF EXISTS reader_projection_session_update;
    CREATE TRIGGER reader_projection_activity_insert AFTER INSERT ON reading_activity
      BEGIN INSERT INTO reading_projection_dirty VALUES(NEW.session_id,NEW.sequence) ON CONFLICT(session_id,sequence) DO NOTHING; END;
    CREATE TRIGGER reader_projection_activity_update
      AFTER UPDATE OF session_id,sequence,started_ms,ended_ms,reported_ms,input ON reading_activity
      WHEN OLD.session_id IS NOT NEW.session_id OR OLD.sequence IS NOT NEW.sequence OR OLD.started_ms IS NOT NEW.started_ms
        OR OLD.ended_ms IS NOT NEW.ended_ms OR OLD.reported_ms IS NOT NEW.reported_ms OR OLD.input IS NOT NEW.input
      BEGIN INSERT INTO reading_projection_dirty VALUES(OLD.session_id,OLD.sequence) ON CONFLICT(session_id,sequence) DO NOTHING;
        INSERT INTO reading_projection_dirty VALUES(NEW.session_id,NEW.sequence) ON CONFLICT(session_id,sequence) DO NOTHING; END;
    CREATE TRIGGER reader_projection_activity_delete BEFORE DELETE ON reading_activity
      BEGIN INSERT INTO reading_projection_dirty VALUES(OLD.session_id,OLD.sequence) ON CONFLICT(session_id,sequence) DO NOTHING;
        DELETE FROM reading_active_ranges WHERE session_id=OLD.session_id AND sequence=OLD.sequence; END;
    CREATE TRIGGER reader_projection_session_update AFTER UPDATE OF actor_id,started_ms,ended_ms ON reading_sessions
      WHEN OLD.actor_id IS NOT NEW.actor_id OR OLD.started_ms IS NOT NEW.started_ms OR OLD.ended_ms IS NOT NEW.ended_ms
      BEGIN INSERT INTO reading_projection_sessions VALUES(NEW.id) ON CONFLICT(id) DO NOTHING; END;
  ` }];

function budget(condition, phase, limit) {
  check(condition, "READING_PROJECTION_BUDGET", "阅读活动重叠区间过密，已保留待重试记录。", 503,
    { retryable: true, phase, limit, recovery: "Retain the sender queue. Retry the same input with an explicitly larger readingProjectionLimits budget; full repair alone does not ingest deferred input." });
}

export function installReadingProjection(db, { now = Date.now(), ...limits } = {}) {
  applySchemaMigrations(db, "reading-projection", readingProjectionSchemaMigrations);
  const version = db.prepare("SELECT value FROM reading_projection_state WHERE key='version'").get()?.value;
  check(version === undefined || version === "1", "READING_PROJECTION_VERSION", "阅读统计由其他版本生成；保留数据并停止初始化。", 409, { version });
  if (version === "1") {
    // Production writes drain within their transaction. This also recovers a
    // committed invalidation left by an interrupted raw-only maintenance write.
    const pending = db.prepare("SELECT session_id FROM reading_projection_dirty LIMIT 1").get()
      || db.prepare("SELECT id FROM reading_projection_sessions LIMIT 1").get();
    return { migrated: false, ...(pending ? { recovered: projectReadingChanges(db, { ...limits, now }) } : {}) };
  }
  // One-time backfill is intentionally explicit/unbounded. It validates every
  // existing raw event before changing derived data and commits atomically.
  const result = rebuildSyncedReading(db, { now });
  return { migrated: true, ...result };
}

function mergeWindows(windows) {
  const merged = [];
  windows.sort((a, b) => a.start - b.start || a.end - b.end);
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }
  return merged;
}

// Shared interval rule for both synchronous maintenance and prepared commits.
// Prefix intervals establish the frontier; only rows inside the changed window
// can receive a different share of time. Never mutate rows from a read guard.
export function readingWindowProjection(rows, start) {
  const ordered = [...rows].sort((a, b) => compareReadingEvents({ ...a, countedStart: a.counted_start }, { ...b, countedStart: b.counted_start }));
  const result = []; let through = -Infinity;
  for (const row of ordered) {
    if (row.counted_start < start) { through = Math.max(through, row.ended_ms); continue; }
    const acceptedStart = Math.max(row.counted_start, through), accepted = Math.max(0, row.ended_ms - acceptedStart);
    through = Math.max(through, row.ended_ms);
    result.push({ row, acceptedStart, accepted });
  }
  return result;
}

// Prepare a complete incoming transaction, including new sessions and every
// late/offline event in that transaction, against guarded current records.
// This returns concrete derivative SQL only. The caller places read guards,
// raw mutations, these statements, and exact receipts in one atomic batch.
export async function prepareIncomingReading(mutations, reads, options = {}) {
  const relevant = mutations.filter(change => ["reading_sessions", "reading_activity"].includes(change.entity));
  if (!relevant.length) return { before: [], after: [], sessions: [], events: [] };
  const limits = { ...READING_PROJECTION_LIMITS, ...options };
  for (const name of ["windowLimit", "mutationLimit", "operationLimit"]) check(Number.isSafeInteger(limits[name]) && limits[name] > 0, "VALIDATION_FAILED", "阅读投影预算无效。");
  check((await reads.get("SELECT value FROM reading_projection_state WHERE key='version'"))?.value === "1",
    "READING_PROJECTION_MISSING", "阅读投影尚未完成初始化；请保留原始事实并修复派生索引。", 503, { retryable: true });
  const eventKey = (sessionId, sequence) => JSON.stringify([sessionId, sequence]);
  const incomingSessions = new Map(), incomingEvents = new Map();
  for (const change of relevant) {
    const key = Array.isArray(change.key) ? change.key : change.key ? JSON.parse(change.key) : change.entity === "reading_sessions" ? [change.value.id] : [change.value.session_id, change.value.sequence];
    if (change.entity === "reading_sessions") incomingSessions.set(key[0], change.value);
    else incomingEvents.set(eventKey(...key), { sessionId: key[0], sequence: key[1], value: change.value });
  }
  budget(incomingSessions.size + incomingEvents.size <= limits.mutationLimit, "mutations", limits.mutationLimit);
  const pendingEvents = await reads.all("SELECT * FROM reading_projection_dirty ORDER BY session_id,sequence LIMIT ?", limits.mutationLimit + 1);
  const pendingSessions = await reads.all("SELECT id FROM reading_projection_sessions ORDER BY id LIMIT ?", limits.mutationLimit + 1);
  budget(pendingEvents.length <= limits.mutationLimit && pendingSessions.length <= limits.mutationLimit, "pending", limits.mutationLimit);
  const dirty = new Map(pendingEvents.map(row => [eventKey(row.session_id, row.sequence), { sessionId: row.session_id, sequence: row.sequence }]));
  for (const [key, value] of incomingEvents) dirty.set(key, value);
  const dirtySessions = new Set([...pendingSessions.map(row => row.id), ...incomingSessions.keys()]);
  const previousSessions = new Map(), finalSessions = new Map();
  const session = async id => {
    if (!previousSessions.has(id)) previousSessions.set(id, await reads.get("SELECT * FROM reading_sessions WHERE id=?", id) || null);
    if (!finalSessions.has(id)) finalSessions.set(id, incomingSessions.has(id) ? incomingSessions.get(id) : previousSessions.get(id));
    return finalSessions.get(id);
  };
  const extrema = async id => {
    const changes = [...incomingEvents.values()].filter(event => event.sessionId === id);
    const sequences = JSON.stringify(changes.map(event => event.sequence));
    const earliest = await reads.get(`SELECT started_ms FROM reading_activity
      WHERE session_id=? AND sequence NOT IN (SELECT value FROM json_each(?)) ORDER BY started_ms LIMIT 1`, id, sequences);
    const latest = await reads.get(`SELECT ended_ms FROM reading_activity
      WHERE session_id=? AND sequence NOT IN (SELECT value FROM json_each(?)) ORDER BY ended_ms DESC LIMIT 1`, id, sequences);
    let count = earliest ? 1 : 0, first = earliest?.started_ms ?? null, last = latest?.ended_ms ?? null;
    for (const { value } of changes) if (value) { count++; first = first === null ? value.started_ms : Math.min(first, value.started_ms); last = last === null ? value.ended_ms : Math.max(last, value.ended_ms); }
    return { count, first, last };
  };
  for (const id of dirtySessions) {
    const owner = await session(id), bounds = await extrema(id);
    check(!bounds.count || owner && bounds.first >= owner.started_ms && (owner.ended_ms === null || bounds.last <= owner.ended_ms),
      "SYNC_INVALID_READING", "阅读会话范围不能排除已记录的活动。", 409);
    const indexed = await reads.get("SELECT actor_id FROM reading_event_index WHERE session_id=? ORDER BY sequence LIMIT 1", id);
    if (!owner || indexed && indexed.actor_id !== owner.actor_id) {
      const events = await reads.all("SELECT session_id,sequence FROM reading_activity WHERE session_id=? ORDER BY sequence LIMIT ?", id, limits.mutationLimit + 1);
      const indexedEvents = await reads.all("SELECT session_id,sequence FROM reading_event_index WHERE session_id=? ORDER BY sequence LIMIT ?", id, limits.mutationLimit + 1);
      budget(events.length <= limits.mutationLimit && indexedEvents.length <= limits.mutationLimit, "session-events", limits.mutationLimit);
      for (const row of [...events, ...indexedEvents]) dirty.set(eventKey(row.session_id, row.sequence), { sessionId: row.session_id, sequence: row.sequence });
    }
  }
  budget(dirty.size <= limits.mutationLimit, "mutations", limits.mutationLimit);
  const after = [], windows = new Map(), deltas = new Map(), affected = new Set(dirtySessions), nextIndexes = new Map(), acceptedEvents = new Map();
  const addWindow = (actor, start, end) => { if (!windows.has(actor)) windows.set(actor, []); windows.get(actor).push({ start, end }); };
  const delta = (id, amount) => deltas.set(id, (deltas.get(id) || 0) + amount);
  const originallyDirty = new Set(pendingEvents.map(row => eventKey(row.session_id, row.sequence)));
  for (const [key, { sessionId, sequence }] of dirty) {
    const old = await reads.get("SELECT * FROM reading_event_index WHERE session_id=? AND sequence=?", sessionId, sequence);
    const current = await reads.get("SELECT * FROM reading_activity WHERE session_id=? AND sequence=?", sessionId, sequence);
    check(!current || old || originallyDirty.has(key), "READING_PROJECTION_MISSING", "已有阅读事实缺少派生索引；请先修复，不能按零时长处理。", 503, { retryable: true, sessionId, sequence });
    const value = incomingEvents.has(key) ? incomingEvents.get(key).value : current, owner = await session(sessionId);
    const validated = value && validateReadingEvent(owner, value, options.now ?? Date.now());
    if (old) { addWindow(old.actor_id, old.counted_start, old.ended_ms); delta(sessionId, -old.accepted_ms); }
    after.push({ sql: "DELETE FROM reading_active_ranges WHERE session_id=? AND sequence=?", values: [sessionId, sequence] },
      { sql: "DELETE FROM reading_event_index WHERE session_id=? AND sequence=?", values: [sessionId, sequence] });
    if (validated) {
      const next = { session_id: sessionId, sequence, actor_id: owner.actor_id, counted_start: validated.countedStart, ended_ms: value.ended_ms, accepted_ms: 0 };
      nextIndexes.set(key, next); acceptedEvents.set(key, { sessionId, sequence, acceptedMs: 0 });
      after.push({ sql: "INSERT INTO reading_event_index VALUES(?,?,?,?,?,0)", values: [sessionId, sequence, owner.actor_id, validated.countedStart, value.ended_ms] },
        { sql: "UPDATE reading_activity SET accepted_ms=0 WHERE session_id=? AND sequence=?", values: [sessionId, sequence] });
      addWindow(owner.actor_id, validated.countedStart, value.ended_ms);
    }
    affected.add(sessionId);
  }
  let windowRows = 0;
  for (const [actor, actorWindows] of windows) for (const { start, end } of mergeWindows(actorWindows)) {
    const cap = Math.min(limits.windowLimit, limits.operationLimit - windowRows);
    budget(cap > 0, "operation", limits.operationLimit);
    const current = await reads.all(`SELECT * FROM reading_event_index WHERE actor_id=?
      AND counted_start>=? AND counted_start<? ORDER BY counted_start,ended_ms,session_id,sequence LIMIT ?`, actor, start - READING_INTERVAL_LIMIT, end, cap + 1);
    budget(current.length <= cap, cap < limits.windowLimit ? "operation" : "window", cap);
    const rows = current.filter(row => !dirty.has(eventKey(row.session_id, row.sequence)));
    for (const row of nextIndexes.values()) if (row.actor_id === actor && row.counted_start >= start - READING_INTERVAL_LIMIT && row.counted_start < end) rows.push(row);
    budget(rows.length <= cap, cap < limits.windowLimit ? "operation" : "window", cap); windowRows += Math.max(current.length, rows.length);
    for (const { row, acceptedStart, accepted } of readingWindowProjection(rows, start)) {
      if (accepted === row.accepted_ms) continue;
      after.push({ sql: "UPDATE reading_event_index SET accepted_ms=? WHERE session_id=? AND sequence=?", values: [accepted, row.session_id, row.sequence] },
        { sql: "UPDATE reading_activity SET accepted_ms=? WHERE session_id=? AND sequence=?", values: [accepted, row.session_id, row.sequence] },
        { sql: "DELETE FROM reading_active_ranges WHERE session_id=? AND sequence=?", values: [row.session_id, row.sequence] });
      if (accepted) after.push({ sql: "INSERT INTO reading_active_ranges VALUES(?,?,0,?,?,?)", values: [row.session_id, row.sequence, actor, acceptedStart, row.ended_ms] });
      delta(row.session_id, accepted - row.accepted_ms); affected.add(row.session_id);
      acceptedEvents.set(eventKey(row.session_id, row.sequence), { sessionId: row.session_id, sequence: row.sequence, acceptedMs: accepted });
    }
  }
  const sessions = [];
  for (const id of affected) {
    const owner = await session(id);
    if (!owner) continue;
    const previous = previousSessions.get(id), bounds = await extrema(id);
    check(!previous || Number.isSafeInteger(previous.active_ms) && previous.active_ms >= 0, "READING_PROJECTION_CORRUPT", "已有会话缺少有效的派生时长；请先修复。", 503, { retryable: true, sessionId: id });
    const activeMs = (previous ? previous.active_ms : 0) + (deltas.get(id) || 0);
    check(Number.isSafeInteger(activeMs) && activeMs >= 0, "READING_PROJECTION_CORRUPT", "阅读会话派生时长不一致；请保留原始事实并修复。", 503, { retryable: true, sessionId: id });
    const next = { ...owner, active_ms: activeMs, last_activity_ms: bounds.last };
    sessions.push(next);
    after.push({ sql: "UPDATE reading_sessions SET active_ms=?,last_activity_ms=? WHERE id=?", values: [activeMs, bounds.last, id] });
  }
  for (const { sessionId, sequence } of dirty.values()) after.push({ sql: "DELETE FROM reading_projection_dirty WHERE session_id=? AND sequence=?", values: [sessionId, sequence] });
  for (const id of dirtySessions) after.push({ sql: "DELETE FROM reading_projection_sessions WHERE id=?", values: [id] });
  return { before: [], after, sessions, events: [...acceptedEvents.values()] };
}

// Run inside the same transaction as raw event/session mutations and their sync
// receipt. Failure rolls all of them back; callers must not acknowledge a queue
// item until this succeeds. Raw DELETE/UPDATE is for guarded sync corrections,
// not a new user-facing history deletion operation.
export function projectReadingChanges(db, options = {}) {
  const limits = { ...READING_PROJECTION_LIMITS, ...options };
  for (const name of ["windowLimit", "mutationLimit", "operationLimit"]) {
    check(Number.isSafeInteger(limits[name]) && limits[name] > 0, "VALIDATION_FAILED", "阅读投影预算无效。");
  }
  const apply = () => {
    const stats = { changedEvents: 0, affectedSessions: 0, windowRows: 0, windows: 0, changedRanges: 0 };
    const dirtySessions = db.prepare("SELECT id FROM reading_projection_sessions ORDER BY id LIMIT ?").all(limits.mutationLimit + 1);
    budget(dirtySessions.length <= limits.mutationLimit, "sessions", limits.mutationLimit);
    for (const { id } of dirtySessions) {
      const owner = db.prepare("SELECT * FROM reading_sessions WHERE id=?").get(id);
      if (!owner) continue;
      const first = db.prepare("SELECT started_ms FROM reading_activity WHERE session_id=? ORDER BY started_ms LIMIT 1").get(id);
      const last = db.prepare("SELECT ended_ms FROM reading_activity WHERE session_id=? ORDER BY ended_ms DESC LIMIT 1").get(id);
      check(!first || first.started_ms >= owner.started_ms && (owner.ended_ms === null || last.ended_ms <= owner.ended_ms),
        "SYNC_INVALID_READING", "阅读会话范围不能排除已记录的活动。", 409);
      // Session closing/position updates do not revisit its entire history.
      const oldActor = db.prepare("SELECT actor_id FROM reading_event_index WHERE session_id=? LIMIT 1").get(id);
      if (oldActor && oldActor.actor_id !== owner.actor_id) {
        const events = db.prepare("SELECT session_id,sequence FROM reading_activity WHERE session_id=? LIMIT ?").all(id, limits.mutationLimit + 1);
        budget(events.length <= limits.mutationLimit, "session-events", limits.mutationLimit);
        const enqueue = db.prepare("INSERT OR IGNORE INTO reading_projection_dirty VALUES(?,?)");
        for (const row of events) enqueue.run(row.session_id, row.sequence);
      }
    }
    const dirty = db.prepare("SELECT * FROM reading_projection_dirty ORDER BY session_id,sequence LIMIT ?").all(limits.mutationLimit + 1);
    budget(dirty.length <= limits.mutationLimit, "mutations", limits.mutationLimit);
    const windows = new Map(), deltas = new Map(), affected = new Set();
    const addWindow = (actor, start, end) => { if (!windows.has(actor)) windows.set(actor, []); windows.get(actor).push({ start, end }); };
    const delta = (id, amount) => { deltas.set(id, (deltas.get(id) || 0) + amount); };
    for (const key of dirty) {
      const old = db.prepare("SELECT * FROM reading_event_index WHERE session_id=? AND sequence=?").get(key.session_id, key.sequence);
      const row = db.prepare("SELECT * FROM reading_activity WHERE session_id=? AND sequence=?").get(key.session_id, key.sequence);
      const owner = row && db.prepare("SELECT * FROM reading_sessions WHERE id=?").get(key.session_id);
      const validated = row && validateReadingEvent(owner, row, options.now ?? Date.now());
      if (old) { addWindow(old.actor_id, old.counted_start, old.ended_ms); delta(old.session_id, -old.accepted_ms); }
      db.prepare("DELETE FROM reading_active_ranges WHERE session_id=? AND sequence=?").run(key.session_id, key.sequence);
      db.prepare("DELETE FROM reading_event_index WHERE session_id=? AND sequence=?").run(key.session_id, key.sequence);
      if (validated) {
        db.prepare("INSERT INTO reading_event_index VALUES(?,?,?,?,?,0)").run(row.session_id, row.sequence, owner.actor_id, validated.countedStart, row.ended_ms);
        db.prepare("UPDATE reading_activity SET accepted_ms=0 WHERE session_id=? AND sequence=? AND accepted_ms<>0").run(row.session_id, row.sequence);
        addWindow(owner.actor_id, validated.countedStart, row.ended_ms);
      }
      affected.add(key.session_id); stats.changedEvents++;
    }
    for (const [actor, actorWindows] of windows) {
      for (const { start, end } of mergeWindows(actorWindows)) {
        const cap = Math.min(limits.windowLimit, limits.operationLimit - stats.windowRows);
        budget(cap > 0, "operation", limits.operationLimit);
        // Every counted interval is <= 60 seconds. Earlier intervals that can
        // affect this window therefore start at most 60 seconds before it.
        // Prefix rows establish the frontier but are never rewritten. Events
        // starting at/after end see the same preceding union in either state.
        const rows = db.prepare(`SELECT * FROM reading_event_index WHERE actor_id=?
          AND counted_start>=? AND counted_start<? LIMIT ?`).all(actor, start - READING_INTERVAL_LIMIT, end, cap + 1);
        budget(rows.length <= cap, cap < limits.windowLimit ? "operation" : "window", cap);
        stats.windowRows += rows.length; stats.windows++;
        for (const { row, acceptedStart, accepted } of readingWindowProjection(rows, start)) {
          if (accepted === row.accepted_ms) continue;
          db.prepare("UPDATE reading_event_index SET accepted_ms=? WHERE session_id=? AND sequence=?").run(accepted, row.session_id, row.sequence);
          db.prepare("UPDATE reading_activity SET accepted_ms=? WHERE session_id=? AND sequence=?").run(accepted, row.session_id, row.sequence);
          db.prepare("DELETE FROM reading_active_ranges WHERE session_id=? AND sequence=?").run(row.session_id, row.sequence);
          if (accepted) db.prepare("INSERT INTO reading_active_ranges VALUES(?,?,0,?,?,?)").run(row.session_id, row.sequence, actor, acceptedStart, row.ended_ms);
          delta(row.session_id, accepted - row.accepted_ms); affected.add(row.session_id); stats.changedRanges++;
        }
      }
    }
    for (const id of affected) {
      const last = db.prepare("SELECT ended_ms FROM reading_activity WHERE session_id=? ORDER BY ended_ms DESC LIMIT 1").get(id)?.ended_ms ?? null;
      db.prepare("UPDATE reading_sessions SET active_ms=active_ms+?,last_activity_ms=? WHERE id=?").run(deltas.get(id) || 0, last, id);
    }
    for (const key of dirty) db.prepare("DELETE FROM reading_projection_dirty WHERE session_id=? AND sequence=?").run(key.session_id, key.sequence);
    for (const { id } of dirtySessions) db.prepare("DELETE FROM reading_projection_sessions WHERE id=?").run(id);
    stats.affectedSessions = affected.size;
    return stats;
  };
  return options.inTransaction ? apply() : db.transaction(apply);
}
