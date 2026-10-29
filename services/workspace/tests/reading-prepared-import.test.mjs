import test from "node:test";
import assert from "node:assert/strict";
import { BASE, measuredEvent as event, ProjectionFixture } from "./reading-projection-fixture.mjs";
import { prepareIncomingReading } from "../reading-projection.mjs";
import { sqliteAccess, createReadSet, businessAssertionSchema, rowStatement } from "../sql-commit.mjs";

const sessionRow = (id, actor = "reader") => ({ id, actor_id: actor, document_id: "document", document_revision: 1, started_ms: BASE, ended_ms: null, last_activity_ms: null, active_ms: 0, mode: "source", start_position: null, end_position: null, end_reason: null, start_input: "{}", end_input: null, created_at: new Date(BASE).toISOString() });
const changeEvent = value => ({ entity: "reading_activity", key: JSON.stringify([value.session_id, value.sequence]), value });
const changeSession = value => ({ entity: "reading_sessions", key: JSON.stringify([value.id]), value });
function harness(t) {
  const h = new ProjectionFixture(), sql = sqliteAccess(h.db); t.after(() => h.close());
  h.db.exec(businessAssertionSchema);
  const prepare = async (mutations, options = {}) => {
    const reads = createReadSet({ query: async (...args) => { await Promise.resolve(); return sql.query(...args); } }), before = h.snapshot();
    const projection = await prepareIncomingReading(mutations, reads, { now: BASE + 365 * 86400000, ...options });
    assert.deepEqual(h.snapshot(), before, "preparation leaves raw and derived records untouched");
    return { projection, reads, mutations };
  };
  const commit = ({ projection, reads, mutations }) => {
    const ordered = [...mutations].sort((a, b) => {
      const rank = value => value.value === null ? value.entity === "reading_activity" ? 0 : 1 : value.entity === "reading_sessions" ? 2 : 3;
      return rank(a) - rank(b);
    });
    sql.batch([...reads.guards, ...projection.before, ...ordered.map(change => rowStatement(change.entity, change.entity === "reading_sessions" ? ["id"] : ["session_id", "sequence"], change.value, JSON.parse(change.key))), ...projection.after]);
  };
  return { h, prepare, commit };
}

test("one prepared transaction reconciles new sessions, many late overlapping events, corrections and actor moves", async t => {
  const { h, prepare, commit } = harness(t);
  const first = [changeSession(sessionRow("a")), changeSession(sessionRow("B")), changeSession(sessionRow("other", "second")),
    changeEvent(event("a", 1, 30000, 60000)), changeEvent(event("B", 1, 0, 60000)), changeEvent(event("a", 2, 10000, 40000)), changeEvent(event("other", 1, 0, 60000))];
  commit(await prepare(first)); h.verify();
  const row = h.db.prepare("SELECT * FROM reading_sessions WHERE id='B'").get();
  commit(await prepare([changeSession({ ...row, actor_id: "second", ended_ms: BASE + 120000 }), changeEvent(event("B", 2, 60000, 120000)), changeEvent(event("a", 1, 20000, 70000))])); h.verify();
  commit(await prepare([{ ...changeEvent(event("B", 1, 0, 60000)), value: null }, changeEvent(event("a", 3, 0, 60000)), changeEvent(event("a", 4, 60000, 120000))])); h.verify();
  const closed = h.db.prepare("SELECT * FROM reading_sessions WHERE id='a'").get();
  commit(await prepare([changeSession({ ...closed, ended_ms: BASE + 120000 }), changeEvent(event("a", 5, 50000, 110000))])); h.verify();
  const before = h.snapshot();
  await assert.rejects(prepare([changeSession({ ...closed, ended_ms: BASE + 50000 })]), error => error.code === "SYNC_INVALID_READING");
  assert.deepEqual(h.snapshot(), before);
});

test("batched random late arrivals agree with the full independent oracle after each transaction", async t => {
  const { h, prepare, commit } = harness(t);
  commit(await prepare([changeSession(sessionRow("a")), changeSession(sessionRow("b")), changeSession(sessionRow("c"))]));
  let seed = 72913;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const rows = Array.from({ length: 120 }, (_, index) => { const start = Math.floor(random() * 240000), duration = 1 + Math.floor(random() * 60000); return event(["a", "b", "c"][index % 3], Math.floor(index / 3) + 1, start, start + duration); });
  for (let at = 0; at < rows.length; at += 9) { commit(await prepare(rows.slice(at, at + 9).map(changeEvent))); h.verify(); }
  for (let at = 0; at < 30; at += 5) {
    commit(await prepare(rows.slice(at, at + 5).map((row, index) => index % 2 ? { ...changeEvent(row), value: null } : changeEvent(event(row.session_id, row.sequence, 500000, 530000))))); h.verify();
  }
});

test("pending raw maintenance is repaired atomically and absent projection state is never treated as zero", async t => {
  const { h, prepare, commit } = harness(t); h.session("a"); h.session("b"); h.insert(event("a", 1, 0, 30000));
  h.insertRaw(event("b", 1, 10000, 40000));
  h.db.prepare("UPDATE reading_sessions SET actor_id='other' WHERE id='a'").run();
  assert.equal(h.snapshot().dirty.length, 1); assert.equal(h.snapshot().dirtySessions.length, 1);
  commit(await prepare([changeEvent(event("b", 2, 30000, 60000))])); h.verify();
  h.db.prepare("DELETE FROM reading_event_index WHERE session_id='b' AND sequence=1").run();
  const before = h.snapshot();
  await assert.rejects(prepare([changeEvent(event("b", 1, 10000, 40000))]), error => error.code === "READING_PROJECTION_MISSING");
  assert.deepEqual(h.snapshot(), before);
  h.db.prepare("DELETE FROM reading_projection_state").run();
  await assert.rejects(prepare([changeEvent(event("b", 3, 60000, 90000))]), error => error.code === "READING_PROJECTION_MISSING");
});

test("bounded windows and concurrent new overlaps reject stale commits without changing raw facts", async t => {
  const { h, prepare, commit } = harness(t); h.session("a"); h.session("b");
  h.seed(Array.from({ length: 8000 }, (_, index) => event("a", index + 1, index * 120000, index * 120000 + 15000)));
  h.resetCounts();
  const late = await prepare([changeEvent(event("b", 1, 1000, 16000)), changeEvent(event("b", 2, 16000, 31000))]);
  assert.ok(h.counts.returnedRows < 30, JSON.stringify(h.counts));
  assert.ok(!late.reads.observed.some(read => /SELECT \* FROM reading_activity(?:\s|$)/.test(read.sql) && !/WHERE/.test(read.sql)), "normal imports do not scan all raw facts");
  commit(await prepare([changeEvent(event("b", 3, 0, 15000))]));
  const before = h.snapshot(); assert.throws(() => commit(late), /CHECK constraint/); assert.deepEqual(h.snapshot(), before);
  commit(await prepare([changeEvent(event("b", 1, 1000, 16000)), changeEvent(event("b", 2, 16000, 31000))])); h.verify();
  await assert.rejects(prepare([changeEvent(event("b", 4, 0, 15000)), changeEvent(event("b", 5, 0, 15000))], { windowLimit: 2 }), error => error.code === "READING_PROJECTION_BUDGET");
  h.verify();
});
