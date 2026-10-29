import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { BASE, measuredEvent as event, ProjectionFixture } from "./reading-projection-fixture.mjs";
import { installReadingProjection, projectReadingChanges } from "../reading-projection.mjs";
import { rebuildSyncedReading } from "../sync-reading.mjs";
import { createReadingActivityTracker } from "../../../prototypes/insight-composer/src/reading-activity.js";
import { flowDayStart } from "../flow.mjs";

let seed = 104729;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const shuffle = (input) => { const rows = [...input]; for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; } return rows; };

test("incremental projection matches the full oracle after every late insert, correction, deletion and duplicate", () => {
  for (let trial = 0; trial < 16; trial++) {
    const h = new ProjectionFixture();
    const owners = ["A", "a", "b", "other"];
    owners.forEach((id, index) => h.session(id, index === 3 ? "another-reader" : "reader"));
    const rows = Array.from({ length: 80 }, (_, index) => {
      const start = Math.floor(random() * 240000) + (trial % 2 ? 86370000 : 0), duration = 1 + Math.floor(random() * 60000);
      return event(owners[index % owners.length], Math.floor(index / owners.length) + 1, start, start + duration + (index % 7 === 0 ? 10 : 0), duration);
    });
    for (const row of shuffle(rows)) { h.insert(row); h.verify(); }
    for (const row of rows) { h.resetCounts(); assert.equal(h.insert(row).duplicate, true); assert.equal(h.counts.logicalChangedRows, 0); }
    for (const row of shuffle(rows).slice(0, 20)) {
      const start = Math.floor(random() * 240000), duration = 1 + Math.floor(random() * 60000);
      h.correct(event(row.session_id, row.sequence, start, start + duration)); h.verify();
    }
    for (const row of shuffle(rows).slice(0, 20)) { h.remove(row); h.verify(); }
    h.close();
  }
});

test("same-start ownership, covering intervals, long chains and actor reassignment converge", () => {
  const h = new ProjectionFixture(); h.session("a"); h.session("B"); h.session("other", "other");
  const rows = [event("a", 1, 0, 60000), event("B", 1, 0, 60000), event("a", 2, 30000, 90000), event("B", 2, 60000, 120000), event("a", 3, 61000, 121000)];
  for (const row of rows.toReversed()) { h.insert(row); h.verify(); }
  assert.equal(h.sqlite.prepare("SELECT accepted_ms FROM reading_activity WHERE session_id='B' AND sequence=1").get().accepted_ms, 60000, "binary ID ordering is independent of host locale");
  h.db.transaction(() => { h.db.prepare("UPDATE reading_sessions SET actor_id='other' WHERE id='B'").run(); projectReadingChanges(h.db, { inTransaction: true }); });
  h.verify();
  h.correct(event("a", 1, 86390000, 86410000)); h.verify();
  h.remove(rows[1]); h.verify();
  h.close();
});

test("bounded dense projection rolls back the raw transaction and keeps its durable sender queue", () => {
  const h = new ProjectionFixture(); h.session("a");
  for (let sequence = 1; sequence <= 8; sequence++) h.insert(event("a", sequence, 0, 15000));
  h.db.exec("CREATE TABLE sender_outbox(id TEXT PRIMARY KEY,payload TEXT); INSERT INTO sender_outbox VALUES('pending','raw-event');");
  const before = h.snapshot();
  assert.throws(() => h.db.transaction(() => {
    h.insertRaw(event("a", 9, 0, 15000));
    projectReadingChanges(h.db, { inTransaction: true, windowLimit: 8 });
    h.db.prepare("DELETE FROM sender_outbox WHERE id='pending'").run();
  }), { code: "READING_PROJECTION_BUDGET", status: 503 });
  assert.deepEqual(h.snapshot(), before); assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM sender_outbox").get().n, 1);
  h.insert(event("a", 9, 0, 15000), { windowLimit: 9 }); h.verify();
  h.close();
});

test("the actual Reader persistent queue keeps projection 503 input through tracker recreation", async () => {
  const values = new Map();
  const storage = { get length() { return values.size; }, key: (i) => [...values.keys()][i], getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  let wall = BASE, mono = 0, serial = 0;
  const delivered = [];
  const options = { storage, windowTarget: null, documentTarget: null, wallNow: () => wall, monotonicNow: () => mono,
    createId: () => "queued-" + (++serial), setInterval: () => 1, clearInterval: () => {} };
  const tracker = createReadingActivityTracker({ ...options, sendCommand: async (command) => {
    if (command.kind === "reading.session.activity") throw Object.assign(new Error("dense"), { code: "READING_PROJECTION_BUDGET", status: 503 });
  } });
  tracker.start({ documentId: "document", documentRevision: 1 }); await tracker.flush();
  wall += 15000; mono += 15000; tracker.end("leave"); await tracker.flush();
  const saved = [...values.values()]; assert.equal(saved.length, 2); assert.equal(tracker.getStatus().error.code, "READING_PROJECTION_BUDGET");
  tracker.dispose(); await tracker.flush(); assert.deepEqual([...values.values()], saved);
  const reopened = createReadingActivityTracker({ ...options, sendCommand: async (command) => delivered.push(command) });
  await reopened.flush(); assert.equal(storage.length, 0);
  assert.deepEqual(delivered, saved.map((text) => JSON.parse(text).command)); reopened.dispose();
});

test("invalid corrections and narrowed session bounds leave original raw and derived state unchanged", () => {
  const h = new ProjectionFixture(); h.session("a"); const row = event("a", 1, 0, 15000); h.insert(row); const before = h.snapshot();
  for (const invalid of [{ ...row, input: "{}" }, event("a", 1, 0, 70000), event("a", 1, -1, 15000)]) {
    assert.throws(() => h.correct(invalid), { code: "SYNC_INVALID_READING" }); assert.deepEqual(h.snapshot(), before);
  }
  assert.throws(() => h.db.transaction(() => { h.db.prepare("UPDATE reading_sessions SET ended_ms=? WHERE id='a'").run(BASE + 10000); projectReadingChanges(h.db, { inTransaction: true }); }), { code: "SYNC_INVALID_READING" });
  assert.deepEqual(h.snapshot(), before); h.close();
});

test("one-time migration preserves raw inputs and explicit repair restores every derived structure", () => {
  const h = new ProjectionFixture(); h.session("a"); h.session("b");
  const rows = [event("a", 1, 0, 15000), event("b", 1, 5000, 20000)]; h.seed(rows);
  const raw = h.snapshot().events.map(({ accepted_ms, ...row }) => row);
  h.db.prepare("DELETE FROM reading_projection_state").run();
  h.db.prepare("UPDATE reading_activity SET accepted_ms=123").run();
  h.db.prepare("UPDATE reading_sessions SET active_ms=456").run();
  assert.equal(installReadingProjection(h.db).migrated, true); h.verify();
  assert.deepEqual(h.snapshot().events.map(({ accepted_ms, ...row }) => row), raw);
  assert.equal(installReadingProjection(h.db).migrated, false);
  h.db.prepare("DELETE FROM reading_event_index").run();
  rebuildSyncedReading(h.db); h.verify();
  h.insertRaw(event("a", 2, 30000, 45000));
  assert.ok(installReadingProjection(h.db).recovered, "committed maintenance invalidations recover before serving reads"); h.verify();
  h.db.prepare("UPDATE reading_projection_state SET value='2' WHERE key='version'").run();
  const preserved = h.snapshot();
  assert.throws(() => installReadingProjection(h.db), { code: "READING_PROJECTION_VERSION" }); assert.deepEqual(h.snapshot(), preserved);
  h.close();
});

test("SQL day aggregation equals independent interval splitting across DST, fractional zones and session gaps", async () => {
  const h = new ProjectionFixture(); h.session("a"); h.session("b");
  const starts = ["2025-03-08T23:59:50Z", "2025-03-09T07:59:50Z", "2025-03-09T09:59:50Z", "2025-03-09T10:59:50Z", "2025-11-02T08:59:50Z", "2025-11-02T09:59:50Z"];
  starts.forEach((start, i) => { const offset = Date.parse(start) - BASE; h.insert(event(i % 2 ? "a" : "b", i + 1, offset, offset + 20000)); });
  const ranges = h.snapshot().ranges;
  for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kathmandu", "Australia/Lord_Howe"]) {
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    const dateAt = (ms) => { const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(({ type, value }) => [type, value])); return `${parts.year}-${parts.month}-${parts.day}`; };
    const nextDate = (date) => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
    const split = (items) => {
      const byDay = new Map();
      for (const row of items) {
        for (let at = row.start_ms; at < row.end_ms;) {
          const date = dateAt(at), end = Math.min(row.end_ms, flowDayStart(nextDate(date), zone));
          const day = byDay.get(date) || { date, activeMs: 0, startedAt: new Date(at).toISOString(), endedAt: new Date(end).toISOString() };
          day.activeMs += end - at;
          day.startedAt = day.startedAt < new Date(at).toISOString() ? day.startedAt : new Date(at).toISOString();
          day.endedAt = day.endedAt > new Date(end).toISOString() ? day.endedAt : new Date(end).toISOString();
          byDay.set(date, day); at = end;
        }
      }
      return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    };
    const history = await h.flow.history({ subjectId: "reader" }, { timezone: zone });
    for (const item of history.items) assert.deepEqual(item.days, split(ranges.filter((row) => row.session_id === item.id)));
    const summary = await h.flow.summary({ subjectId: "reader" }, { timezone: zone, from: "2025-03-08", to: "2025-03-10" });
    const expected = split(ranges);
    for (const day of summary.daily) assert.equal(day.activeMs, expected.find((row) => row.date === day.date)?.activeMs || 0);
  }
  h.close();
});

test("SQLite process crash before commit rolls back; committed work survives lost acknowledgement and replay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "reading-project-crash-")), path = join(directory, "reading.sqlite");
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  let h = new ProjectionFixture({ path }); h.session("a"); h.insert(event("a", 1, 0, 15000)); const before = h.snapshot(); h.close();
  const fixtureUrl = new URL("./reading-projection-fixture.mjs", import.meta.url).href;
  const projectionUrl = new URL("../reading-projection.mjs", import.meta.url).href;
  for (const commit of [false, true]) {
    const source = `import {ProjectionFixture, measuredEvent} from ${JSON.stringify(fixtureUrl)};
      import {projectReadingChanges} from ${JSON.stringify(projectionUrl)};
      const h=new ProjectionFixture({path:process.argv[1]}); h.sqlite.exec('BEGIN IMMEDIATE');
      h.insertRaw(measuredEvent('a',2,15000,30000)); projectReadingChanges(h.db,{inTransaction:true});
      ${commit ? "h.sqlite.exec('COMMIT');" : ""} process.exit(19);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, path], { encoding: "utf8" });
    assert.equal(result.status, 19, result.stderr);
    h = new ProjectionFixture({ path }); h.verify();
    if (!commit) assert.deepEqual(h.snapshot(), before);
    else { assert.equal(h.verify().activeMs, 30000); h.resetCounts(); assert.equal(h.insert(event("a", 2, 15000, 30000)).duplicate, true); assert.equal(h.counts.logicalChangedRows, 0); }
    h.close();
  }
});
