import test from "node:test";
import assert from "node:assert/strict";
import { deriveCollection, indexCollection } from "../src/workspace/model.js";
import { localDay, groupHistory } from "../src/workspace/flow-model.js";

test("collection query changes reuse membership counts and search text without traversing source categories", () => {
  const document = { id: "a", title: "Article 12", kind: "论文", summary: "attention", tags: ["tag"], status: "reading", collectionIds: ["child"] };
  const workspace = { documents: [document], collections: [{ id: "parent", label: "Parent", parentId: null }, { id: "child", label: "Child", parentId: "parent" }], planIds: ["a", "a"] };
  const index = indexCollection(workspace);
  const guarded = { get collections() { throw new Error("query retraversed categories"); }, get documents() { throw new Error("query rebuilt document index"); }, get planIds() { throw new Error("query rescanned plan"); } };
  for (const query of ["a", "at", "attention", "missing", ""]) {
    const result = deriveCollection(guarded, { collectionId: "parent", query }, index);
    assert.equal(result.counts, index.counts);
    assert.deepEqual(result.counts, { all: 1, plan: 1, uncategorized: 0, archived: 0, parent: 1, child: 1 });
    assert.equal(result.rows.length, query === "missing" ? 0 : 1);
  }
});

test("new collection snapshots reflect archive, rename, category and plan edits without retaining old rows", () => {
  const a = { id: "a", title: "Before", kind: "论文", summary: "", tags: [], status: "unread", collectionIds: ["old"] };
  const workspace = { documents: [a], collections: [{ id: "old", label: "Old", parentId: null }], planIds: ["a"] };
  const before = indexCollection(workspace);
  const next = { ...workspace, documents: [{ ...a, title: "After", archivedAt: "2026-10-25" }], collections: [], planIds: [] };
  const after = indexCollection(next);
  assert.deepEqual(deriveCollection(workspace, { query: "before" }, before).rows, [a]);
  assert.equal(deriveCollection(next, { query: "after" }, after).rows.length, 0);
  assert.equal(deriveCollection(next, { collectionId: "archived", query: "after" }, after).rows[0].title, "After");
  assert.equal(deriveCollection(next, { collectionId: "old" }, after).collectionId, "all");
  assert.equal(before.counts.all, 1);
  assert.equal(after.counts.all, 0);
});

test("cyclic category records and duplicate ancestry count each document once", () => {
  const workspace = { collections: [{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }], planIds: [], documents: [{ id: "one", title: "One", kind: "", summary: "", tags: [], collectionIds: ["a", "b", "missing"] }] };
  const result = deriveCollection(workspace, { collectionId: "a" });
  assert.equal(result.rows.length, 1);
  assert.equal(result.counts.a, 1);
  assert.equal(result.counts.b, 1);
});

test("formatter reuse retains timezone separation, DST boundaries, invalid dates and cache eviction", () => {
  const value = "2026-11-01T07:30:00Z";
  const zones = ["UTC", "Asia/Shanghai", "Asia/Tokyo", "Europe/London", "Europe/Paris", "Australia/Sydney", "America/New_York", "Pacific/Honolulu", "America/Los_Angeles"];
  for (const timezone of [...zones, ...zones.toReversed()]) {
    const expected = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value)).map(({ type, value }) => [type, value]));
    assert.equal(localDay(value, timezone), `${expected.year}-${expected.month}-${expected.day}`);
  }
  assert.equal(localDay("invalid", "UTC"), "");
  const sessions = [{ id: "a", startedAt: "2026-11-01T06:59:00Z", endedAt: "2026-11-01T09:01:00Z", days: [{ date: "2026-10-31", activeMs: 100 }, { date: "2026-11-01", activeMs: 200 }], insights: [{ id: "before", createdAt: "2026-11-01T06:59:30Z" }, { id: "after", createdAt: "2026-11-01T09:00:30Z" }] }];
  assert.deepEqual(groupHistory(sessions, "America/Los_Angeles").map(({ date, entries }) => [date, entries[0].activeMs, entries[0].insights.map(({ id }) => id)]), [["2026-11-01", 200, ["after"]], ["2026-10-31", 100, ["before"]]]);
});
