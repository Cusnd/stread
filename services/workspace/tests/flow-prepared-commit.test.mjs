import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { FlowData } from "../flow.mjs";
import { LegacyFlowCommands } from "./fixtures/legacy-flow-command.mjs";
import { sqliteAccess, createReadSet, businessAssertionSchema, rowStatement } from "../sql-commit.mjs";

const base = Date.UTC(2026, 9, 24, 12), actor = { subjectId: "reader" }, iso = value => new Date(value).toISOString();
const keys = { reading_sessions: ["id"], reading_activity: ["session_id", "sequence"], insight_reviews: ["insight_id"] };
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.transaction = operation => { db.exec("BEGIN IMMEDIATE"); try { const result = operation(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE documents(id TEXT PRIMARY KEY,metadata TEXT,archived_at TEXT);
    CREATE TABLE revisions(document_id TEXT,revision INTEGER,PRIMARY KEY(document_id,revision));
    CREATE TABLE insights(id TEXT PRIMARY KEY,document_id TEXT,payload TEXT,archived_at TEXT);
    INSERT INTO documents VALUES('a','{"title":"A"}',NULL),('b','{"title":"B"}',NULL);
    INSERT INTO revisions VALUES('a',1),('b',1);
    INSERT INTO insights VALUES('note','a','{"id":"note","body":"A note","type":"note"}',NULL);
    ${businessAssertionSchema}`);
  const ports = {
    document: id => db.prepare("SELECT * FROM documents WHERE id=?").get(id),
    revisionRow: (id, revision) => db.prepare("SELECT * FROM revisions WHERE document_id=? AND revision=?").get(id, revision),
    navigation: () => ({ blocks: [{ id: "p", type: "para", text: "Source" }] }),
    insight: (id, document) => db.prepare("SELECT * FROM insights WHERE id=? AND document_id=?").get(id, document),
    meta: key => key === "plan" ? [] : 1,
  };
  const sql = sqliteAccess(db), now = () => base + 300000;
  const flow = new FlowData(db, { navigation: ports.navigation, meta: ports.meta }, { now });
  const legacy = new LegacyFlowCommands({ db, sql, ports, now });
  const snapshot = () => Object.fromEntries(["reading_sessions", "reading_activity", "reading_event_index", "reading_active_ranges", "insight_reviews", "flow_metadata"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));
  const prepare = async command => {
    const reads = createReadSet({ query: async (...args) => { await Promise.resolve(); return sql.query(...args); } });
    const before = snapshot(), prepared = await flow.prepareCommand(actor, command, reads);
    assert.deepEqual(snapshot(), before, "preparing a command performs no durable writes");
    return { prepared, reads };
  };
  const commit = ({ prepared, reads }) => {
    sql.batch([...reads.guards, ...prepared.changes.map(change => rowStatement(change.entity, keys[change.entity], change.value)), ...prepared.statements]);
    return { ...prepared.result, activityRevision: flow.revision };
  };
  return { db, flow, legacy, snapshot, prepare, commit, close: () => db.close() };
}

const start = (id, documentId = "a") => ({ kind: "reading.session.start", sessionId: id, documentId, documentRevision: 1, startedAt: iso(base), position: { blockId: "p" } });
const activity = (id, sequence, start, end) => ({ kind: "reading.session.activity", sessionId: id, sequence, startedAt: iso(base + start), endedAt: iso(base + end), activeMs: end - start });

test("prepared Flow commits preserve synchronous command results and all late overlapping facts", async t => {
  const legacy = fixture(), direct = fixture(); t.after(() => { legacy.close(); direct.close(); });
  const commands = [start("s-a"), start("s-b", "b"),
    activity("s-a", 1, 30000, 45000), activity("s-b", 1, 20000, 40000), activity("s-a", 2, 10000, 35000),
    activity("s-b", 2, 45000, 60000), activity("s-a", 3, 0, 15000), activity("s-b", 1, 20000, 40000),
    { kind: "reading.session.end", sessionId: "s-a", endedAt: iso(base + 70000), reason: "leave" },
    { kind: "insight.review.add", insightId: "note", documentId: "a" },
    { kind: "insight.review.add", insightId: "note", documentId: "a" },
    { kind: "insight.review.complete", insightId: "note", documentId: "a" }];
  for (const command of commands) {
    const expected = legacy.db.transaction(() => legacy.legacy.command(actor, command));
    const prepared = await direct.prepare(command);
    assert.equal(prepared.prepared.workspaceChange, command.kind.startsWith("insight.review."));
    assert.deepEqual(direct.commit(prepared), expected, command.kind);
    // Projection updates may change SQLite rowid ordering; compare stable keys.
    const stable = value => Object.fromEntries(Object.entries(value).map(([table, rows]) => [table, rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
    assert.deepEqual(stable(direct.snapshot()), stable(legacy.snapshot()), command.kind);
  }
  assert.equal(direct.db.prepare("SELECT COUNT(*) n FROM reading_activity").get().n, 5);
  assert.equal(direct.db.prepare("SELECT SUM(active_ms) n FROM reading_sessions").get().n, 60000);
});

test("new overlap dependencies between prepare and commit reject the entire stale write", async t => {
  const h = fixture(); t.after(h.close);
  h.commit(await h.prepare(start("a"))); h.commit(await h.prepare(start("b", "b")));
  const stale = await h.prepare(activity("a", 1, 10000, 30000));
  h.commit(await h.prepare(activity("b", 1, 0, 20000)));
  const before = h.snapshot();
  assert.throws(() => h.commit(stale), /CHECK constraint/);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM reading_activity WHERE session_id='a'").get().n, 0);
  const result = h.commit(await h.prepare(activity("a", 1, 10000, 30000)));
  assert.equal(result.acceptedMs, 10000);
});

test("prepared ownership, duplicate input and end boundaries retain their original errors", async t => {
  const h = fixture(); t.after(h.close);
  h.commit(await h.prepare(start("session")));
  h.commit(await h.prepare(activity("session", 1, 10000, 30000)));
  await assert.rejects(h.flow.authorizeCommandAsync({ subjectId: "other" }, activity("session", 2, 30000, 40000)), error => error.code === "FORBIDDEN");
  await assert.rejects(h.prepare(activity("session", 1, 10000, 31000)), error => error.code === "IDEMPOTENCY_CONFLICT");
  await assert.rejects(h.prepare({ kind: "reading.session.end", sessionId: "session", endedAt: iso(base + 20000) }), error => error.code === "VALIDATION_FAILED");
});
