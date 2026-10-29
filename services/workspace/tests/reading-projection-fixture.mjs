import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { canonical } from "../errors.mjs";
import { FlowData } from "../flow.mjs";
import { projectReadingChanges } from "../reading-projection.mjs";
import { reconcileReadingEvents, rebuildSyncedReading } from "../sync-reading.mjs";

export const BASE = Date.UTC(2025, 0, 1);
export const measuredEvent = (sessionId, sequence, from, to, active = to - from) => ({
  session_id: sessionId, sequence, started_ms: BASE + from, ended_ms: BASE + to, reported_ms: active,
  accepted_ms: 0, input: canonical({ startedAt: new Date(BASE + from).toISOString(), endedAt: new Date(BASE + to).toISOString(), activeMs: active }),
});

export class ProjectionFixture {
  constructor({ path = ":memory:", initialize = true } = {}) {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
    this.resetCounts();
    this.db = {
      exec: (sql) => this.sqlite.exec(sql),
      prepare: (sql) => {
        const statement = this.sqlite.prepare(sql);
        return {
          all: (...values) => { this.counts.statements++; const rows = statement.all(...values); this.counts.returnedRows += rows.length; return rows; },
          get: (...values) => { this.counts.statements++; const row = statement.get(...values); this.counts.returnedRows += Number(!!row); return row; },
          run: (...values) => { this.counts.statements++; const result = statement.run(...values); this.counts.logicalChangedRows += Number(result.changes); return result; },
        };
      },
      transaction: (operation) => {
        this.sqlite.exec("BEGIN IMMEDIATE");
        try { const result = operation(); this.sqlite.exec("COMMIT"); return result; }
        catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
      },
    };
    this.sqlite.exec(`CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,metadata TEXT,archived_at TEXT);
      CREATE TABLE IF NOT EXISTS insights(id TEXT PRIMARY KEY,document_id TEXT,payload TEXT,archived_at TEXT);
      INSERT OR IGNORE INTO documents VALUES('document','{"title":"Synthetic document"}',NULL);`);
    if (initialize) this.flow = new FlowData(this.db, { meta: (key) => key === "plan" ? [] : 0 }, { now: () => BASE + 365 * 86400000 });
    this.resetCounts();
  }
  resetCounts() { this.counts = { statements: 0, returnedRows: 0, logicalChangedRows: 0 }; }
  session(id, actor = "reader") {
    this.db.prepare(`INSERT INTO reading_sessions(id,actor_id,document_id,document_revision,started_ms,start_input,created_at)
      VALUES(?,?,'document',1,?,'{}',?)`).run(id, actor, BASE, new Date(BASE).toISOString());
  }
  insertRaw(row) {
    this.db.prepare("INSERT INTO reading_activity VALUES(?,?,?,?,?,?,?)").run(row.session_id, row.sequence, row.started_ms, row.ended_ms, row.reported_ms, 0, row.input);
  }
  insert(row, options = {}) {
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT input FROM reading_activity WHERE session_id=? AND sequence=?").get(row.session_id, row.sequence);
      if (previous) { assert.equal(previous.input, row.input); return { duplicate: true }; }
      this.insertRaw(row);
      return projectReadingChanges(this.db, { ...options, inTransaction: true });
    });
  }
  correct(row, options = {}) {
    return this.db.transaction(() => {
      this.db.prepare("UPDATE reading_activity SET started_ms=?,ended_ms=?,reported_ms=?,input=? WHERE session_id=? AND sequence=?")
        .run(row.started_ms, row.ended_ms, row.reported_ms, row.input, row.session_id, row.sequence);
      return projectReadingChanges(this.db, { ...options, inTransaction: true });
    });
  }
  remove(row, options = {}) {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM reading_activity WHERE session_id=? AND sequence=?").run(row.session_id, row.sequence);
      return projectReadingChanges(this.db, { ...options, inTransaction: true });
    });
  }
  seed(rows) {
    this.db.transaction(() => { for (const row of rows) this.insertRaw(row); rebuildSyncedReading(this.db, { inTransaction: true }); });
    this.resetCounts();
  }
  snapshot() {
    const all = (sql) => this.sqlite.prepare(sql).all().map((row) => ({ ...row }));
    return {
      sessions: all("SELECT id,actor_id,started_ms,ended_ms,active_ms,last_activity_ms FROM reading_sessions ORDER BY id"),
      events: all("SELECT * FROM reading_activity ORDER BY session_id,sequence"),
      ranges: all("SELECT * FROM reading_active_ranges ORDER BY session_id,sequence,part"),
      index: all("SELECT * FROM reading_event_index ORDER BY session_id,sequence"),
      dirty: all("SELECT * FROM reading_projection_dirty ORDER BY session_id,sequence"),
      dirtySessions: all("SELECT * FROM reading_projection_sessions ORDER BY id"),
    };
  }
  verify() {
    const actual = this.snapshot(), oracle = reconcileReadingEvents(actual.sessions, actual.events);
    const sort = (rows) => rows.sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.sequence - b.sequence);
    assert.deepEqual(sort(actual.events.map((row) => ({ sessionId: row.session_id, sequence: row.sequence, activeMs: row.accepted_ms }))), sort(oracle.accepted));
    assert.deepEqual(sort(actual.ranges.map((row) => ({ sessionId: row.session_id, sequence: row.sequence, part: row.part, actor: row.actor_id, start: row.start_ms, end: row.end_ms }))), sort(oracle.ranges));
    for (const row of oracle.sessions) {
      const session = actual.sessions.find((item) => item.id === row.id);
      assert.equal(session.active_ms, row.activeMs); assert.equal(session.last_activity_ms, row.lastActivityMs);
    }
    assert.equal(actual.index.length, actual.events.length);
    assert.deepEqual(actual.dirty, []); assert.deepEqual(actual.dirtySessions, []);
    return { events: actual.events.length, activeMs: oracle.sessions.reduce((sum, row) => sum + row.activeMs, 0) };
  }
  close() { this.sqlite.close(); }
}
