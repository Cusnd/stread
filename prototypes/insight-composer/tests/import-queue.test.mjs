import test from "node:test";
import assert from "node:assert/strict";
import { conversionRequest } from "../src/conversion-request.js";
import { definiteImportRejection, importQueueCommand, PENDING_IMPORT_KEY, readPendingImport, savePendingImport } from "../src/import-queue.js";

const source = { sourceId: "file-original", filename: "A full paper.pdf", size: 1200 };
function storage(initial) {
  const values = new Map(initial ? [[PENDING_IMPORT_KEY, JSON.stringify(initial)]] : []);
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test("legacy uploaded originals are retained without silently creating tasks", () => {
  const saved = readPendingImport(storage({ source, title: "Paper", language: "en" }));
  assert.equal(saved.source.sourceId, source.sourceId);
  assert.equal(saved.queueCommand, undefined);
  const command = importQueueCommand(saved, { title: saved.title, language: saved.language, requestId: "first" });
  assert.equal(command.task.sourceId, source.sourceId);
  assert.equal(command.task.sourceLanguage, "en");
  assert.equal(command.kind, "queue.create");
});

test("an uncertain enqueue retry survives reload with exactly the same intent and requirements", () => {
  const command = importQueueCommand({ source }, { title: "Paper", language: "en", body: "Keep figures", requestId: "stable-attempt" });
  const data = storage();
  savePendingImport(data, { source, title: "Changed after submission", body: "Different", language: "zh-CN", queueCommand: command });
  const restored = readPendingImport(data);
  assert.equal(restored.title, "Paper");
  assert.equal(restored.body, "Keep figures");
  assert.equal(restored.language, "en");
  assert.deepEqual(importQueueCommand(restored, { title: "Other", body: "Other", requestId: "new" }), command);
  assert.equal(definiteImportRejection(new Error("network response lost")), false);
  assert.equal(definiteImportRejection({ status: 503 }), false);
  assert.equal(definiteImportRejection({ status: 429 }), false);
  assert.equal(definiteImportRejection({ status: 422 }), true);
});

test("corrupt pending data and storage failure cannot discard retained originals or replay unrelated commands", () => {
  assert.equal(readPendingImport(storage({ source: { ...source, size: -1 } })), null);
  const data = storage({ source, queueCommand: { kind: "document.archive", requestId: "invalid", task: {} } });
  assert.equal(readPendingImport(data).queueCommand, undefined);
  assert.equal(savePendingImport(undefined, { source }), false);
  assert.equal(readPendingImport(undefined), null);
});

test("conversion handoff carries the exact task version binding and preserves independent review instructions", () => {
  const task = { id: "task-uuid", reference: "#T00024", version: 7, body: "Include the appendices" };
  const request = conversionRequest(source, { title: "Paper", language: "en", task });
  assert.match(request, /#T00024/);
  assert.match(request, /"stread.queue":\{"taskId":"task-uuid","taskVersion":7\}/);
  assert.match(request, /source_id: file-original/);
  assert.match(request, /Include the appendices/);
  assert.match(request, /独立 Agent/);
  assert.match(request, /最新候选/);
  assert.doesNotMatch(conversionRequest(source), /stread.queue/);
});

test("explicit source-only output survives import retry and controls the Agent handoff", () => {
  const command = importQueueCommand({ source }, { language: "en", outputLanguages: ["source"], requestId: "source-only" });
  const restored = readPendingImport(storage({ source, outputLanguages: ["source", "zh-CN"], queueCommand: command }));
  assert.deepEqual(restored.outputLanguages, ["source"]);
  assert.deepEqual(importQueueCommand(restored, { requestId: "different" }), command);
  const handoff = conversionRequest(source, { language: "en", task: { id: "task", reference: "#T00001", version: 1, outputLanguages: ["source"] } });
  assert.match(handoff, /输出要求：仅完整原文/);
  assert.match(conversionRequest(source), /输出要求：完整原文 \+ 完整简体中文/);
});
