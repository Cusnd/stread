import test from "node:test";
import assert from "node:assert/strict";
import { availablePlanDocuments, dateRange, durationLabel, groupHistory, groupHistoryPreview, historyPreviewEntries, localDay, positionLabel } from "./flow-model.js";

test("reading duration has no invented full minute or rounding up", () => {
  assert.equal(durationLabel(0), "尚无有效阅读时长");
  assert.equal(durationLabel(59999), "不足 1 分钟");
  assert.equal(durationLabel(3599999), "59 分钟");
  assert.equal(durationLabel(3720000), "1 小时 2 分钟");
});

test("history groups and inclusive range use the user's local day across UTC midnight", () => {
  const now = Date.parse("2026-10-23T02:00:00Z");
  assert.equal(localDay(now, "America/Los_Angeles"), "2026-10-22");
  assert.deepEqual(dateRange("week", "America/Los_Angeles", now), { from: "2026-10-16", to: "2026-10-22" });
  assert.deepEqual(dateRange("month", "America/Los_Angeles", now), { from: "2026-09-23", to: "2026-10-22" });
  const groups = groupHistory([{ id: "a", startedAt: "2026-10-23T02:00:00Z" }, { id: "b", startedAt: "2026-10-22T23:00:00Z" }, { id: "c", startedAt: "2026-10-22T06:00:00Z" }], "America/Los_Angeles");
  assert.deepEqual(groups.map(({ date, entries }) => [date, entries.map((item) => item.id)]), [["2026-10-22", ["a", "b"]], ["2026-10-21", ["c"]]]);
});

test("source positions expose verified labels and page numbers, never internal identifiers", () => {
  assert.equal(positionLabel({ blockId: "paragraph-id123", scrollY: 9876 }), "");
  assert.equal(positionLabel({ blockId: "paragraph-id123", sectionTitle: "3. Attention" }), "3. Attention");
  assert.equal(positionLabel({ pageIndex: 0 }), "第 1 页");
});

test("cross-midnight sessions use backend accepted interval day splits instead of charging all time to their start day", () => {
  const groups = groupHistory([{ id: "session", startedAt: "2026-10-23T06:59:00Z", activeMs: 120000, days: [{ date: "2026-10-22", activeMs: 60000, startedAt: "2026-10-23T06:59:00Z" }, { date: "2026-10-23", activeMs: 60000, startedAt: "2026-10-23T07:00:00Z" }], insights: [{ id: "note", createdAt: "2026-10-23T07:00:30Z" }] }], "America/Los_Angeles");
  assert.deepEqual(groups.map(({ date, entries }) => [date, entries[0].activeMs, entries[0].insights.length]), [["2026-10-23", 60000, 1], ["2026-10-22", 60000, 0]]);
});

test("fitted history prefixes count rendered day rows and retain cross-midnight durations and insights", () => {
  const items = [
    ...Array.from({ length: 4 }, (_, index) => ({ id: "day-" + index, startedAt: `2026-10-23T07:${10 + index}:00Z`, activeMs: 30000, insights: [], insightCount: 0 })),
    { id: "midnight", startedAt: "2026-10-23T06:59:30Z", endedAt: "2026-10-23T07:01:30Z", activeMs: 120000, insightCount: 2,
      days: [
        { date: "2026-10-22", activeMs: 30000, startedAt: "2026-10-23T06:59:30Z", endedAt: "2026-10-23T07:00:00Z" },
        { date: "2026-10-23", activeMs: 90000, startedAt: "2026-10-23T07:00:00Z", endedAt: "2026-10-23T07:01:30Z" },
      ], insights: [{ id: "before", createdAt: "2026-10-23T06:59:45Z" }, { id: "after", createdAt: "2026-10-23T07:00:30Z" }],
    },
  ];
  const before = JSON.stringify(items);
  const rows = historyPreviewEntries(items, "America/Los_Angeles");
  assert.equal(items.length, 5);
  assert.equal(rows.length, 6);
  for (const maximum of [0, 1, 2, 5, 6, 10]) {
    const prefix = rows.slice(0, maximum);
    const rendered = groupHistoryPreview(prefix).flatMap(({ entries }) => entries);
    assert.equal(rendered.length, Math.min(maximum, rows.length));
    rendered.forEach((session, index) => assert.equal(session, prefix[index].session));
  }
  const preview = groupHistoryPreview(rows.slice(0, 5));
  assert.deepEqual(preview.map(({ date, entries }) => [date, entries.length, entries.reduce((sum, session) => sum + session.activeMs, 0)]), [["2026-10-23", 5, 210000]]);
  assert.deepEqual(preview[0].entries.at(-1).insights.map((note) => note.id), ["after"]);
  assert.equal(preview[0].entries.at(-1).insightCount, 1);
  const full = groupHistoryPreview(rows);
  assert.deepEqual(full.map(({ date, entries }) => [date, entries.reduce((sum, session) => sum + session.activeMs, 0)]), [["2026-10-23", 210000], ["2026-10-22", 30000]]);
  assert.equal(full[1].entries[0].id, "midnight:2026-10-22");
  assert.deepEqual(full[1].entries[0].insights.map((note) => note.id), ["before"]);
  assert.equal(full[1].entries[0].insightCount, 1);
  assert.equal(JSON.stringify(items), before);
});

test("plan picker excludes archived and already planned material while searching titles and tags", () => {
  const workspace = { planIds: ["planned"], documents: [{ id: "planned", title: "Attention" }, { id: "archived", title: "Attention", archivedAt: "date" }, { id: "new", title: "Transformer", tags: ["attention"] }] };
  assert.deepEqual(availablePlanDocuments(workspace, "Attention").map((item) => item.id), ["new"]);
});

test("a single-day selection of a cross-midnight session excludes insights from other days", () => {
  const groups = groupHistory([{ id: "session", startedAt: "2026-10-23T06:59:00Z", endedAt: "2026-10-23T07:01:00Z", insightCount: 2, days: [{ date: "2026-10-23", activeMs: 60000, startedAt: "2026-10-23T07:00:00Z" }], insights: [{ id: "before", createdAt: "2026-10-23T06:59:30Z" }, { id: "after", createdAt: "2026-10-23T07:00:30Z" }] }], "America/Los_Angeles");
  assert.deepEqual(groups.map(({ date, entries }) => [date, entries[0].activeMs, entries[0].insights.map((note) => note.id), entries[0].insightCount]), [["2026-10-23", 60000, ["after"], 1]]);
});
