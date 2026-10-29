import test from "node:test";
import assert from "node:assert/strict";
import { canonical } from "../errors.mjs";
import { reconcileReadingEvents } from "../sync-reading.mjs";
const base = Date.UTC(2025, 0, 1);
const session = (id, actor = "reader") => ({ id, actor_id: actor, started_ms: base, ended_ms: null });
const event = (id, sequence, from, to, active = to - from) => ({ session_id: id, sequence, started_ms: base + from, ended_ms: base + to, reported_ms: active, accepted_ms: active, input: canonical({ startedAt: new Date(base + from).toISOString(), endedAt: new Date(base + to).toISOString(), activeMs: active }) });

test("offline reading overlap converges regardless of arrival order without creating time", () => {
  const sessions = [session("a"), session("b"), session("other", "another-reader")];
  const events = [event("a", 1, 0, 15000), event("b", 1, 5000, 20000), event("a", 2, 30000, 40000), event("b", 2, 10000, 18000), event("other", 1, 0, 15000)];
  const first = reconcileReadingEvents(sessions, events);
  assert.deepEqual(reconcileReadingEvents(sessions, events.toReversed()), first);
  assert.equal(first.sessions.find((row) => row.id === "a").activeMs, 25000);
  assert.equal(first.sessions.find((row) => row.id === "b").activeMs, 5000);
  assert.equal(first.sessions.find((row) => row.id === "other").activeMs, 15000);
  assert.ok(first.ranges.every((row) => row.start >= base && row.end <= base + 40000));
});
test("long-offline valid events retain their historical dates and measured rounding", () => {
  const result = reconcileReadingEvents([session("a")], [event("a", 1, 0, 15010, 15000)]);
  assert.equal(result.ranges[0].start, base + 10);
  assert.equal(result.sessions[0].activeMs, 15000);
});
test("invalid events cannot alter derived reading statistics", () => {
  const valid = event("a", 1, 0, 15000);
  for (const changed of [{ ...valid, reported_ms: 50000 }, { ...valid, input: "{}" }, { ...valid, session_id: "missing" }]) {
    assert.throws(() => reconcileReadingEvents([session("a")], [changed]), { code: "SYNC_INVALID_READING" });
  }
  assert.throws(() => reconcileReadingEvents([{ ...session("a"), ended_ms: base + 10000 }], [valid]), { code: "SYNC_INVALID_READING" });
  assert.deepEqual(reconcileReadingEvents([session("a")], []).sessions, [{ id: "a", activeMs: 0, lastActivityMs: null }]);
});
