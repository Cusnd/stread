import test from "node:test";
import assert from "node:assert/strict";
import { queueDocumentTarget, queueDraftAfterSaveError, queueDraftFor, queueHandoff, queueListUrl, queueOutputLabel, queueSaveCommand, queueSourcePreview, queueSourceUrl, queueTaskMatches, queueTaskReveal, queueTaskTitle, queueTimeLabel, readQueuePages } from "../src/workspace/queue-model.js";

test("file conversion can be queued before an article exists and retains explicit language requirements", () => {
  const command = queueSaveCommand({ type: "conversion", sourceId: "retained-source", sourceLanguage: "en", outputLanguages: ["source"], body: " Preserve the whole source. ", title: "Paper" }, "stable-write-id");
  assert.equal(command.kind, "queue.create");
  assert.equal(command.requestId, "stable-write-id");
  assert.equal(command.task.sourceId, "retained-source");
  assert.equal(command.task.body, "Preserve the whole source.");
  assert.equal("documentId" in command.task, false);
  assert.deepEqual(command.task.outputLanguages, ["source"]);
  assert.equal(queueOutputLabel(command.task), "原文");
  assert.equal(queueOutputLabel({ sourceLanguage: "en" }), "原文 + 简体中文");
});

test("question enqueue pins the explicitly selected question and its current version", () => {
  assert.throws(() => queueSaveCommand({ type: "question", documentId: "article" }, "request"), /请选择交给 AI 的问题/);
  const command = queueSaveCommand({ type: "question", documentId: "article", insightId: "selected-question", expectedInsightVersion: 7, body: "" }, "request");
  assert.equal(command.task.insightId, "selected-question");
  assert.equal(command.task.expectedInsightVersion, 7);
  assert.equal(command.task.body, "");
  assert.throws(() => queueSaveCommand({ type: "instruction", body: "Explain the trade-off." }, "request"), /请选择关联文章/);
});

test("unknown saves replay their exact request despite later draft edits", () => {
  const pending = queueSaveCommand({ type: "conversion", sourceId: "source-1", body: "Initial request" }, "request-1");
  const retry = queueSaveCommand({ type: "conversion", sourceId: "source-2", body: "Changed request", pendingCommand: pending }, "request-2");
  assert.strictEqual(retry, pending);
  assert.equal(retry.task.sourceId, "source-1");
  assert.equal(retry.requestId, "request-1");
});

test("new-question conflicts allow reselection without losing requirements or setting the task-edit lock", () => {
  const draft = { type: "question", documentId: "article", insightId: "question", expectedInsightVersion: 7, body: "Explain the assumptions.", pendingCommand: { requestId: "old-request" } };
  const recovered = queueDraftAfterSaveError(draft, { status: 409 });
  assert.equal(recovered.conflict, false);
  assert.equal(recovered.questionConflict, true);
  assert.equal(recovered.pendingCommand, null);
  assert.equal(recovered.body, draft.body);
  const refreshed = { ...recovered, insightId: "", expectedInsightVersion: undefined, questionConflict: false };
  assert.throws(() => queueSaveCommand(refreshed, "new-request"), /请选择交给 AI 的问题/);
  const command = queueSaveCommand({ ...refreshed, insightId: "question", expectedInsightVersion: 8 }, "new-request");
  assert.equal(command.task.expectedInsightVersion, 8);
  assert.equal(command.task.body, draft.body);
  assert.equal(command.requestId, "new-request");
  assert.equal(queueDraftAfterSaveError({ ...draft, taskId: "task" }, { status: 409 }).conflict, true);
  assert.strictEqual(queueDraftAfterSaveError(draft, { status: 503 }), draft);
});

test("paginated queue reads restart when the workspace revision changes between pages", async () => {
  const offsets = [];
  const result = await readQueuePages({ limit: 200 }, async (url) => {
    const offset = Number(new URL(url, "http://localhost").searchParams.get("offset"));
    offsets.push(offset);
    const revision = offsets.length === 1 ? 1 : 2;
    return { revision, total: 101, tasks: Array.from({ length: offset ? 1 : 100 }, (_, index) => ({ id: `${revision}-${offset + index}` })), counts: { all: 101 }, allCounts: { cancelled: 4 } };
  });
  assert.deepEqual(offsets, [0, 100, 0, 100]);
  assert.equal(result.revision, 2);
  assert.equal(result.tasks.length, 101);
  assert.equal(result.tasks.every((task) => task.id.startsWith("2-")), true);
  assert.equal(result.allCounts.cancelled, 4);
});

test("queue pagination retries are bounded and do not hide unrelated read errors", async () => {
  let calls = 0;
  await assert.rejects(readQueuePages({ limit: 200 }, async () => ({ revision: ++calls, total: 101, tasks: Array.from({ length: 100 }, (_, id) => ({ id })) })), /队列正在更新/);
  assert.equal(calls, 6);
  calls = 0;
  const result = await readQueuePages({}, async () => {
    if (!calls++) throw Object.assign(new Error("Changed"), { code: "LIST_CHANGED" });
    return { revision: 3, total: 1, tasks: [{ id: "stable" }] };
  });
  assert.equal(calls, 2);
  assert.equal(result.tasks[0].id, "stable");
  calls = 0;
  await assert.rejects(readQueuePages({}, async () => { calls++; throw new Error("Offline"); }), /Offline/);
  assert.equal(calls, 1);
});

test("editing preserves task identity, expected version and linked targets", () => {
  const task = { id: "task-uuid", reference: "#T00024", version: 4, type: "translation", title: "", body: "Old wording", documentId: "article", source: { blockId: "paragraph" } };
  const draft = queueDraftFor(task), command = queueSaveCommand({ ...draft, body: "New wording", documentId: "different-article" }, "edit-request");
  assert.equal(command.kind, "queue.update");
  assert.equal(command.taskId, "task-uuid");
  assert.equal(command.expectedVersion, 4);
  assert.equal(command.patch.body, "New wording");
  assert.equal("documentId" in command.patch, false);
  assert.equal(draft.reference, "#T00024");
});

test("reference selection respects active filters without confusing task identity with row order", () => {
  const task = { id: "id", reference: "#T00024", type: "conversion", status: "completed", sourceFilename: "Paper.pdf", body: "Convert the source" };
  assert.equal(queueTaskMatches(task, { type: "all", status: "all", query: "#T00024" }), true);
  assert.equal(queueTaskMatches(task, { type: "all", status: "all", query: "24" }), true);
  assert.equal(queueTaskMatches(task, { type: "all", status: "pending", query: "#T00024" }), false);
  assert.equal(new URL(queueListUrl({ type: "conversion", status: "completed", query: " #T00024 " }), "http://localhost").searchParams.get("query"), "#T00024");
});

test("deep links reveal completed or cancelled tasks without resetting an already visible selection", () => {
  const task = { id: "task-id", reference: "#T00024", type: "conversion", status: "completed", title: "Paper" };
  assert.deepEqual(queueTaskReveal(task, { selectedId: task.id, type: "question", status: "pending", query: "other" }), { type: "conversion", status: "completed", query: "", scrollTop: 0 });
  assert.deepEqual(queueTaskReveal({ ...task, status: "cancelled" }, { selectedId: task.reference }), { type: "conversion", status: "cancelled", query: "", scrollTop: 0 });
  assert.equal(queueTaskReveal(task, { selectedId: task.id, type: "all", status: "all", query: "Paper", scrollTop: 300 }), null);
  assert.equal(queueTaskReveal(task, { selectedId: "another-task" }), null);
  assert.equal(queueTaskReveal(task, { selectedId: null }), null);
});

test("source previews use retained file identity and precise reading anchors remain available", () => {
  const task = { type: "conversion", sourceId: "source/id", sourceFilename: "Paper.pdf" };
  assert.equal(queueTaskTitle(task), "Paper.pdf");
  assert.equal(queueSourceUrl(task), "/api/sources/source%2Fid/original");
  assert.equal(queueSourcePreview(task), "/api/sources/source%2Fid/pages/1.png?width=600");
  assert.equal(queueSourcePreview({ ...task, sourceFilename: "paper.md" }), null);
  assert.deepEqual(queueDocumentTarget({ documentId: "article", source: { blockId: "table cell" } }), { documentId: "article", options: { hash: "#table%20cell" } });
  assert.deepEqual(queueDocumentTarget({ result: { kind: "answer", documentId: "article", insightId: "question" } }, true), { documentId: "article", options: { insightId: "question" } });
});

test("handoff preserves the task version and conversion publication binding", () => {
  const task = { id: "task-uuid", reference: "#T00024", version: 3, type: "conversion", body: "Keep all figures.", title: "Paper", sourceId: "source-uuid", sourceFilename: "Paper.pdf", sourceLanguage: "en", outputLanguages: ["source", "zh-CN"] };
  const copied = queueHandoff(task);
  assert.match(copied, /#T00024/);
  assert.match(copied, /task_version: 3/);
  assert.match(copied, /"stread.queue":\{"taskId":"task-uuid","taskVersion":3\}/);
  assert.match(copied, /Keep all figures/);
  assert.match(copied, /source_id: source-uuid/);
});

test("dates display the task creation time rather than claiming recent execution", () => {
  const now = new Date("2026-10-29T12:00:00Z");
  assert.equal(queueTimeLabel("2026-10-29T09:42:00Z", now, "UTC"), "今天 09:42");
  assert.equal(queueTimeLabel("invalid", now, "UTC"), "");
});
