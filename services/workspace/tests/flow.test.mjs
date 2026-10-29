import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createWorkspaceServer } from "../server.mjs";
import { flowDayStart } from "../flow.mjs";
import { publishAuthoringFixture } from "./authoring-fixture.mjs";

const iso = (value) => new Date(value).toISOString();
const localActor = { workspaceId: "local", subjectId: "local", scopes: ["read", "write"] };

async function harness(t, initialNow = "2026-11-03T18:00:00.000Z") {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-flow-"));
  let server, base, clock = Date.parse(initialNow);
  const headers = { Authorization: "Bearer flow-test-token" };
  const start = async () => {
    server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false, authToken: "flow-test-token", flowNow: () => clock });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  t.after(async () => {
    await server?.shutdown();
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep));
    await rm(dataDir, { recursive: true, force: true });
  });
  await start();
  const request = async (path, body, status = 200) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
  };
  const command = (input, status = 200) => request("/api/commands", { requestId: randomUUID(), ...input }, status);
  const author = async (name) => publishAuthoringFixture({ base, headers, authoring: { format: "reader-authoring-1", key: name.replaceAll(" ", "-"), meta: { title: name, language: "en" }, blocks: [
    { key: "title", type: "heading", level: 1, text: name }, { key: "paragraph", type: "para", text: "A paragraph about thoughtful reading." },
  ] } });
  const begin = async (documentId, startedAt, extra = {}) => {
    const sessionId = randomUUID();
    const receipt = await command({ kind: "reading.session.start", sessionId, documentId, documentRevision: 1, startedAt, ...extra });
    return { sessionId, receipt };
  };
  const activity = (sessionId, sequence, start, duration, extra = {}, status = 200) => command({ kind: "reading.session.activity", sessionId, sequence, startedAt: iso(start), endedAt: iso(Date.parse(start) + duration), activeMs: duration, ...extra }, status);
  return { request, command, author, begin, activity, get base() { return base; }, get workspace() { return server.workspace; }, now: () => clock, setNow: (value) => { clock = Date.parse(value); }, restart: async () => { await server.shutdown(); await start(); } };
}

test("Flow selected insight loads independently of list filters and rejects archived records", async (t) => {
  const h = await harness(t), article = await h.author("Independent detail");
  const { insight } = await h.command({ kind: "insight.save", documentId: article.document.id, insight: { type: "note", body: "Detail survives a question-only filter", color: "sky" } });
  await h.command({ kind: "insight.review.add", documentId: article.document.id, insightId: insight.id });
  assert.equal((await h.request("/api/flow/insights?type=question")).items.length, 0);
  const path = "/api/flow/insights/" + encodeURIComponent(insight.id);
  const detail = (await h.request(path)).insight;
  assert.equal(detail.id, insight.id);
  assert.equal(detail.documentTitle, "Independent detail");
  assert.equal(detail.review.pending, true);
  const archived = await h.command({ kind: "insight.archive", documentId: article.document.id, insightId: insight.id, expectedVersion: insight.version });
  await h.request(path, undefined, 404);
  await h.command({ kind: "insight.restore", documentId: article.document.id, insightId: insight.id, expectedVersion: archived.insight.version });
  assert.equal((await h.request(path)).insight.id, insight.id);
  const document = (await h.request("/api/workspace")).documents.find((item) => item.id === article.document.id);
  await h.command({ kind: "document.archive", documentId: document.id, expectedVersion: document.version });
  await h.request(path, undefined, 404);
  assert.deepEqual((await h.request("/api/flow/insights?documentId=" + encodeURIComponent(document.id))).items, [], "ordinary Flow filtering keeps archived parents hidden");
  await h.request("/api/flow/insights/missing-insight", undefined, 404);
});

test("Flow reuses plan order and does not turn old checkpoints into reading history or duration", async (t) => {
  const h = await harness(t), first = await h.author("First article"), second = await h.author("Second article");
  await h.command({ kind: "plan.add", documentId: second.document.id });
  await h.command({ kind: "plan.add", documentId: first.document.id });
  await h.command({ kind: "reading.open", documentId: first.document.id });
  await h.command({ kind: "reading.checkpoint", documentId: first.document.id, readingState: { revision: 1, blockId: first.blockIds.paragraph, offsetRatio: 0.4, mode: "source" } });
  let summary = await h.request("/api/flow/summary?timezone=America%2FLos_Angeles&days=7");
  assert.deepEqual(summary.upcoming.map((item) => item.id), [second.document.id, first.document.id]);
  assert.equal(summary.upcoming[1].readingState.blockId, first.blockIds.paragraph);
  assert.equal(summary.totals.activeMs, 0); assert.equal(summary.totals.sessionCount, 0);
  assert.equal(summary.daily.length, 7); assert.equal(summary.trackingStartedAt, iso(h.now()));
  assert.deepEqual((await h.request("/api/flow/history")).items, []);
  await h.command({ kind: "plan.move", documentId: first.document.id, direction: -1, expectedPlanVersion: summary.planVersion });
  summary = await h.request("/api/flow/summary");
  assert.deepEqual(summary.upcoming.map((item) => item.id), [first.document.id, second.document.id]);
  const snapshot = await h.request("/api/workspace");
  assert.equal(snapshot.sessions, undefined); assert.equal(snapshot.insights, undefined);
  assert.equal((await fetch(h.base + "/api/flow/summary")).status, 401);
});

test("manual review membership is independent of answers/content versions and survives archival restoration", async (t) => {
  const h = await harness(t), one = await h.author("Question article"), two = await h.author("Other article");
  const question = (await h.command({ kind: "insight.save", documentId: one.document.id, insight: { type: "question", body: "Why does this work?", color: "sky", blockId: one.blockIds.paragraph } })).insight;
  const note = (await h.command({ kind: "insight.save", documentId: two.document.id, insight: { type: "note", body: "An independent note", color: "green" } })).insight;
  const originalDocument = (await h.request(`/api/documents/${one.document.id}`)).document;
  const add = await h.command({ kind: "insight.review.add", documentId: one.document.id, insightId: question.id });
  assert.equal(add.review.pending, true); assert.equal(add.insight.version, question.version); assert.equal(add.insight.answer, undefined);
  assert.equal((await h.request(`/api/documents/${one.document.id}`)).insights[0].review.pending, true);
  await h.command({ kind: "insight.review.add", documentId: one.document.id, insightId: question.id });
  let page = await h.request("/api/flow/insights?review=pending");
  assert.equal(page.total, 1); assert.equal(page.items[0].documentTitle, "Question article"); assert.equal(page.items[0].reference, question.reference);
  const saved = await h.command({ kind: "insight.save", documentId: one.document.id, expectedVersion: question.version, insight: { ...page.items[0], body: "Edited question", review: { pending: false }, documentTitle: "Spoof title" } });
  assert.equal(saved.insight.review, undefined); assert.equal(saved.insight.documentTitle, undefined);
  assert.equal((await h.request("/api/flow/insights?review=pending")).items[0].review.pending, true);
  await h.command({ kind: "insight.answer", documentId: one.document.id, insightId: question.id, expectedVersion: saved.insight.version, authorized: true, answer: { blocks: [{ type: "paragraph", text: "The relationship follows from the premise." }] } });
  assert.equal((await h.request("/api/flow/insights?question=unresolved")).total, 0);
  assert.equal((await h.request("/api/flow/insights?question=resolved&review=pending")).total, 1, "answering does not consume manual review membership");
  const completed = await h.command({ kind: "insight.review.complete", documentId: one.document.id, insightId: question.id });
  assert.equal(completed.review.pending, false); assert.equal(completed.review.lastReviewedAt, iso(h.now()));
  assert.ok(completed.insight.answer); assert.equal(completed.insight.version, saved.insight.version + 1);
  await h.command({ kind: "insight.review.add", documentId: two.document.id, insightId: note.id });
  const archived = await h.command({ kind: "insight.archive", documentId: two.document.id, insightId: note.id, expectedVersion: note.version });
  assert.equal((await h.request("/api/flow/insights?review=pending")).total, 0);
  await h.command({ kind: "insight.restore", documentId: two.document.id, insightId: note.id, expectedVersion: archived.insight.version });
  page = await h.request("/api/flow/insights?review=pending");
  assert.equal(page.items[0].id, note.id); assert.equal(page.items[0].reference, note.reference); assert.equal(page.items[0].review.pending, true);
  const documentRow = (await h.request("/api/workspace")).documents.find((item) => item.id === two.document.id);
  await h.command({ kind: "document.archive", documentId: two.document.id, expectedVersion: documentRow.version });
  assert.equal((await h.request("/api/flow/insights?review=pending")).total, 0);
  const archivedDoc = (await h.request("/api/workspace?includeArchived=1")).documents.find((item) => item.id === two.document.id);
  await h.command({ kind: "document.restore", documentId: two.document.id, expectedVersion: archivedDoc.version });
  assert.equal((await h.request("/api/flow/insights?review=pending")).total, 1);
  assert.equal((await h.request("/api/flow/insights?limit=1&offset=0")).hasMore, true);
  assert.equal((await h.request("/api/flow/insights?query=independent&type=note")).items[0].id, note.id);
  assert.equal((await h.request("/api/flow/insights?query=%25%27")).total, 0);
  assert.deepEqual((await h.request(`/api/documents/${one.document.id}`)).document, originalDocument);
});

test("reading activity deduplicates retries, overlapping windows and out-of-order intervals without changing workspace revision", async (t) => {
  const h = await harness(t), one = await h.author("Timed article"), two = await h.author("Other window");
  const initialRevision = (await h.request("/api/workspace")).revision;
  const start = "2026-11-03T17:00:00.000Z", base = Date.parse(start);
  const a = await h.begin(one.document.id, start, { position: { blockId: one.blockIds.paragraph, offsetRatio: 0.2 }, mode: "bilingual" });
  const requestId = randomUUID();
  const first = await h.activity(a.sessionId, 1, start, 15000, { requestId });
  assert.equal(first.acceptedMs, 15000);
  assert.deepEqual(await h.activity(a.sessionId, 1, start, 15000, { requestId }), first);
  assert.equal((await h.activity(a.sessionId, 1, start, 15000)).acceptedMs, 15000);
  await h.activity(a.sessionId, 1, start, 14000, {}, 409);
  const b = await h.begin(two.document.id, iso(base + 10000));
  assert.equal((await h.activity(b.sessionId, 1, iso(base + 10000), 15000)).acceptedMs, 10000);
  assert.equal((await h.activity(a.sessionId, 3, iso(base + 30000), 15000)).acceptedMs, 15000);
  await h.command({ kind: "reading.session.end", sessionId: a.sessionId, endedAt: iso(base + 60000), reason: "leave", position: { blockId: one.blockIds.paragraph, offsetRatio: 0.9 } });
  assert.equal((await h.activity(a.sessionId, 2, iso(base + 15000), 15000)).acceptedMs, 5000, "late offline interval after end only fills the uncovered gap");
  await h.activity(a.sessionId, 4, iso(base + 60000), 1000, {}, 400);
  assert.equal((await h.request("/api/workspace")).revision, initialRevision, "heartbeats and sessions do not reload document bodies");
  let summary = await h.request("/api/flow/summary?timezone=UTC");
  assert.equal(summary.totals.activeMs, 45000); assert.equal(summary.totals.sessionCount, 2); assert.equal(summary.totals.documentCount, 2);
  const history = await h.request(`/api/flow/history?documentId=${one.document.id}&limit=1`);
  assert.equal(history.total, 1); assert.equal(history.items[0].activeMs, 35000); assert.equal(history.items[0].endPosition.offsetRatio, 0.9);
  assert.equal(history.items[0].startPosition.sectionTitle, "Timed article");
  assert.equal(history.items[0].endPosition.sectionTitle, "Timed article");
  const sessionActivity = { kind: "reading.session.activity", sessionId: a.sessionId, sequence: 1, startedAt: start, endedAt: iso(base + 15000), activeMs: 15000, requestId };
  const otherActor = { ...localActor, subjectId: "other-user" };
  await assert.rejects(h.workspace.execute(otherActor, sessionActivity), { code: "FORBIDDEN" });
  const startReceipt = { kind: "reading.session.start", sessionId: a.sessionId, documentId: one.document.id, documentRevision: 1, startedAt: start, position: { blockId: one.blockIds.paragraph, offsetRatio: 0.2 }, mode: "bilingual", requestId: a.receipt.requestId };
  await assert.rejects(h.workspace.execute(otherActor, startReceipt), { code: "FORBIDDEN" });
  assert.equal((await h.workspace.query(otherActor, { kind: "flow.summary" })).totals.activeMs, 0);
  h.setNow("2026-11-04T18:00:00.000Z");
  summary = await h.request("/api/flow/summary"); assert.equal(summary.totals.activeMs, 45000, "an unclosed session adds no background time");
  await h.restart();
  summary = await h.request("/api/flow/summary"); assert.equal(summary.totals.activeMs, 45000, "restart preserves intervals and never resumes a clock");
  assert.equal((await h.activity(a.sessionId, 1, start, 15000)).session.activeMs, 35000);
});

test("history only includes accepted activity and filters gaps by actual recorded intervals", async (t) => {
  const h = await harness(t), { document } = await h.author("History activity boundaries");
  const startedAt = "2026-11-01T10:00:00.000Z", first = await h.begin(document.id, startedAt);
  assert.equal((await h.request("/api/flow/history")).total, 0, "a queued start alone is not a reading-history item");
  assert.equal((await h.request("/api/flow/summary")).totals.sessionCount, 0);
  await h.activity(first.sessionId, 1, startedAt, 60000);
  let history = await h.request("/api/flow/history");
  assert.equal(history.total, 1); assert.equal(history.items[0].id, first.sessionId);
  assert.equal(history.items[0].activeMs, 60000);
  const overlap = await h.begin(document.id, startedAt);
  const overlapWins = overlap.sessionId < first.sessionId;
  assert.equal((await h.activity(overlap.sessionId, 1, startedAt, 60000)).acceptedMs, overlapWins ? 60000 : 0);
  assert.equal((await h.request("/api/flow/history")).total, 1, "a wholly deduplicated window has no accepted activity");
  assert.equal((await h.request("/api/flow/history")).items[0].id, overlapWins ? overlap.sessionId : first.sessionId, "equal intervals use deterministic session identity ownership");
  await h.command({ kind: "reading.session.end", sessionId: first.sessionId, endedAt: "2026-11-03T17:00:00.000Z", reason: "delayed-close" });
  assert.equal((await h.request("/api/flow/history?timezone=UTC&from=2026-11-01&to=2026-11-01")).total, 1);
  for (const date of ["2026-11-02", "2026-11-03"]) {
    const page = await h.request(`/api/flow/history?timezone=UTC&from=${date}&to=${date}&limit=1`);
    assert.equal(page.total, 0); assert.deepEqual(page.items, []); assert.equal(page.hasMore, false, "session wall-clock span does not fill a day with no recorded activity");
  }
  await h.activity(overlap.sessionId, 2, "2026-11-03T16:00:00.000Z", 15000);
  history = await h.request("/api/flow/history?timezone=UTC&from=2026-11-03&to=2026-11-03");
  assert.equal(history.total, 1); assert.equal(history.items[0].id, overlap.sessionId, "the hidden zero-activity row is retained and appears after its first accepted interval");
});

test("timezone aggregation splits local midnight and handles both DST transitions", async (t) => {
  const zone = "America/Los_Angeles";
  assert.equal(flowDayStart("2026-03-09", zone) - flowDayStart("2026-03-08", zone), 23 * 60 * 60 * 1000);
  assert.equal(flowDayStart("2026-11-02", zone) - flowDayStart("2026-11-01", zone), 25 * 60 * 60 * 1000);
  const h = await harness(t), { document } = await h.author("DST reading");
  const midnight = "2026-11-01T06:59:50.000Z", fall = "2026-11-01T08:59:50.000Z";
  const a = await h.begin(document.id, midnight); await h.activity(a.sessionId, 1, midnight, 20000);
  const b = await h.begin(document.id, fall); await h.activity(b.sessionId, 1, fall, 20000);
  let summary = await h.request(`/api/flow/summary?timezone=${encodeURIComponent(zone)}&from=2026-10-31&to=2026-11-01`);
  assert.deepEqual(summary.daily.map(({ date, activeMs }) => ({ date, activeMs })), [{ date: "2026-10-31", activeMs: 10000 }, { date: "2026-11-01", activeMs: 30000 }]);
  assert.equal(summary.totals.activeMs, 40000);
  assert.equal((await h.request(`/api/flow/history?timezone=${encodeURIComponent(zone)}&from=2026-11-01&to=2026-11-01`)).total, 2);
  const midnightHistory = await h.request(`/api/flow/history?timezone=${encodeURIComponent(zone)}`);
  assert.deepEqual(midnightHistory.items.find((item) => item.id === a.sessionId).days.map(({ date, activeMs }) => ({ date, activeMs })), [{ date: "2026-10-31", activeMs: 10000 }, { date: "2026-11-01", activeMs: 10000 }]);
  const selectedDayHistory = await h.request(`/api/flow/history?timezone=${encodeURIComponent(zone)}&from=2026-11-01&to=2026-11-01`);
  assert.deepEqual(selectedDayHistory.items.find((item) => item.id === a.sessionId).days.map(({ date, activeMs }) => ({ date, activeMs })), [{ date: "2026-11-01", activeMs: 10000 }]);
  h.setNow("2026-03-09T18:00:00.000Z");
  const spring = "2026-03-08T09:59:50.000Z", c = await h.begin(document.id, spring); await h.activity(c.sessionId, 1, spring, 20000);
  summary = await h.request(`/api/flow/summary?timezone=${encodeURIComponent(zone)}&from=2026-03-08&to=2026-03-08`);
  assert.equal(summary.daily[0].activeMs, 20000); assert.equal(summary.totals.sessionCount, 1);
});

test("rolling 30-day summary and matching history include day 30 but exclude day 31", async (t) => {
  const h = await harness(t), { document } = await h.author("Thirty day reading");
  const timezone = "America/Los_Angeles";
  const sessions = [];
  // The fixture clock is November 3. October 4 is day 31 locally, even though
  // its UTC instant is October 5; October 5 midnight is the inclusive boundary.
  for (const [startedAt, duration] of [["2026-10-05T06:00:00.000Z", 60000], ["2026-10-05T07:00:00.000Z", 60000], ["2026-11-03T17:00:00.000Z", 30000]]) {
    const session = await h.begin(document.id, startedAt);
    await h.activity(session.sessionId, 1, startedAt, duration);
    sessions.push(session.sessionId);
  }
  const summary = await h.request(`/api/flow/summary?timezone=${encodeURIComponent(timezone)}&days=30`);
  assert.deepEqual(summary.range, { startDate: "2026-10-05", endDate: "2026-11-03" });
  assert.equal(summary.daily.length, 30);
  assert.deepEqual(summary.daily[0], { date: "2026-10-05", activeMs: 60000, sessionCount: 1 });
  assert.deepEqual(summary.daily.at(-1), { date: "2026-11-03", activeMs: 30000, sessionCount: 1 });
  assert.equal(summary.totals.activeMs, 90000); assert.equal(summary.totals.sessionCount, 2);
  assert.equal(summary.daily.reduce((total, day) => total + day.activeMs, 0), summary.totals.activeMs);
  const history = await h.request(`/api/flow/history?timezone=${encodeURIComponent(timezone)}&from=${summary.range.startDate}&to=${summary.range.endDate}`);
  assert.equal(history.total, 2);
  assert.deepEqual(new Set(history.items.map((item) => item.id)), new Set(sessions.slice(1)));
  const seven = await h.request(`/api/flow/summary?timezone=${encodeURIComponent(timezone)}&days=7`);
  assert.equal(seven.daily.length, 7); assert.equal(seven.totals.activeMs, 30000);
});

test("Flow rejects malformed ranges, oversized intervals and invalid session identities", async (t) => {
  const h = await harness(t), { document, blockIds } = await h.author("Validation article");
  for (const path of ["/api/flow/summary?timezone=not-a-zone", "/api/flow/summary?days=0", "/api/flow/summary?days=91", "/api/flow/summary?from=2026-02-30", "/api/flow/summary?from=2020-01-01&to=2026-11-03", "/api/flow/insights?limit=101", "/api/flow/insights?offset=-1", "/api/flow/insights?type=wrong", "/api/flow/history?limit=1.5"]) await h.request(path, undefined, 400);
  const start = "2026-11-03T17:00:00.000Z", { sessionId } = await h.begin(document.id, start);
  await h.activity(sessionId, 1, start, 60001, {}, 400);
  await h.activity(sessionId, 1, start, 1000, { activeMs: 9000 }, 400);
  await h.activity(sessionId, 0, start, 1000, {}, 400);
  await h.activity(sessionId, 1, "2026-11-03T16:59:59.000Z", 1000, {}, 400);
  await h.command({ kind: "reading.session.start", sessionId: randomUUID(), documentId: document.id, documentRevision: 1, startedAt: "2026-01-01T00:00:00Z" }, 400);
  await h.command({ kind: "reading.session.start", sessionId: randomUUID(), documentId: document.id, documentRevision: 1, startedAt: "2026-11-04T00:00:00Z" }, 400);
  await h.command({ kind: "reading.session.start", sessionId: randomUUID(), documentId: document.id, documentRevision: 1, startedAt: start, position: { blockId: "missing" } }, 409);
  await h.command({ kind: "reading.session.start", sessionId, documentId: document.id, documentRevision: 1, startedAt: start, mode: "translation" }, 409);
  await h.command({ kind: "reading.session.end", sessionId, endedAt: start, position: { blockId: blockIds.paragraph }, reason: "close" });
  await h.command({ kind: "reading.session.end", sessionId, endedAt: "2026-11-03T17:00:01.000Z", reason: "close" }, 409);
  assert.equal((await h.request("/api/flow/summary")).totals.activeMs, 0);
});
