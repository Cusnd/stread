import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkspace, localActor } from "../../../services/workspace/service.mjs";
import { createCommandIntentClient, ensureDraftIntent } from "../src/command-intents.js";
import { createReadingCheckpointQueue } from "../src/reading-checkpoints.js";
import { createNavigationIntents } from "../src/navigation-intents.js";
import { canHandleWorkspaceSettings } from "../src/workspace-shortcuts.js";

function memoryStorage() {
  const values = new Map();
  return { get length() { return values.size; }, key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((done) => setImmediate(done));

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-integrity-test-"));
  const workspace = await createWorkspace({ dataDir, bootstrap: false, glossaryPath: false });
  t.after(async () => {
    await workspace.close();
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + "\\") || resolve(dataDir).startsWith(resolve(tmpdir()) + "/"));
    assert.ok(dataDir.includes("reader-integrity-test-"));
    await rm(dataDir, { recursive: true, force: true });
  });
  const authoring = { format: "reader-authoring-1", key: "integrity-test", meta: { title: "Integrity fixture", language: "en" },
    blocks: [{ key: "p1", type: "para", text: "A source paragraph for an isolated integrity test." }] };
  const source = await workspace.upload(localActor, Buffer.from(JSON.stringify(authoring)), { filename: "authoring.json", mediaType: "application/json" });
  const publication = await workspace.publishAuthoring(localActor, { authoringSourceId: source.sourceId, resources: {}, requestId: crypto.randomUUID() });
  const documentId = publication.document.id;
  const envelope = await workspace.query(localActor, { kind: "document", documentId });
  return { documentId, send: (command) => workspace.execute(localActor, command),
    inspect: () => workspace.query(localActor, { kind: "document", documentId }),
    state: (offsetRatio) => ({ documentId, revision: 1, blockId: envelope.document.blocks[0].id, offsetRatio, mode: "source" }) };
}

for (const [kind, field, collection, input] of [
  ["insight.save", "insight", "insights", { id: null, type: "note", body: "Original draft", color: "amber" }],
  ["change_request.save", "changeRequest", "changeRequests", { id: null, category: "instruction", body: "Original draft", revision: 1 }],
]) {
  test(`${kind}: lost response, reload and edited draft retain one identity/reference`, async (t) => {
    const h = await fixture(t), storage = memoryStorage(), requests = [];
    const original = { kind, documentId: h.documentId, [field]: { ...input, clientIntentId: "draft-1" } };
    const first = createCommandIntentClient({ storage, send: async (command) => {
      requests.push(structuredClone(command));
      await h.send(command);
      throw new TypeError("Lost response after commit");
    } });
    await assert.rejects(first.execute(original, { intentId: "draft-1" }), /Lost response/);
    const committed = (await h.inspect())[collection][0];
    const restored = createCommandIntentClient({ storage, send: async (command) => {
      requests.push(structuredClone(command)); return h.send(command);
    } });
    const edited = { ...original, [field]: { ...original[field], body: "Edited after the unknown result" } };
    const result = await restored.execute(edited, { intentId: "draft-1" });
    const saved = (await h.inspect())[collection];
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, committed.id);
    assert.equal(saved[0].reference, committed.reference);
    assert.equal(saved[0].body, edited[field].body);
    assert.equal(saved[0].version, 2);
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(requests[2][field].id, committed.id);
    assert.equal(requests[2].expectedVersion, 1);
    assert.equal(requests[0][field].clientIntentId, undefined);
    assert.deepEqual(await restored.execute(edited, { intentId: "draft-1" }), result);
    assert.equal(requests.length, 3);
    assert.equal(await restored.acknowledgeDraft("draft-1"), true);
    assert.equal(storage.length, 0);
  });
}

test("ordinary command retries also keep the exact request across a reload", async () => {
  const storage = memoryStorage(), commands = [];
  const input = { kind: "plan.add", documentId: "doc" };
  const first = createCommandIntentClient({ storage, send: async (command) => { commands.push(command); throw new TypeError("offline"); } });
  await assert.rejects(first.execute(input));
  const next = createCommandIntentClient({ storage, send: async (command) => { commands.push(command); return {}; } });
  await next.execute(input);
  assert.deepEqual(commands[1], commands[0]);
  await next.execute(input);
  assert.notEqual(commands[2].requestId, commands[1].requestId);
});

test("draft durability failures and corrupt unknown records stop a new create", async () => {
  let sends = 0;
  const input = { kind: "insight.save", documentId: "doc", insight: { body: "Keep me" } };
  const broken = createCommandIntentClient({ storage: { getItem: () => null, setItem: () => { throw new Error("quota"); } }, send: async () => { sends++; } });
  await assert.rejects(broken.execute(input, { intentId: "draft" }), { code: "COMMAND_INTENT_STORAGE" });
  await assert.rejects(broken.execute(input, { intentId: "draft" }), { code: "COMMAND_INTENT_STORAGE" });
  const storage = memoryStorage();
  storage.setItem("continuous-reader:command-intents:v1:draft:draft", "{broken");
  const corrupted = createCommandIntentClient({ storage, send: async () => { sends++; } });
  await assert.rejects(corrupted.execute(input, { intentId: "draft" }), { code: "COMMAND_INTENT_STORAGE_RECORD" });
  assert.equal(sends, 0);
  assert.equal(storage.getItem("continuous-reader:command-intents:v1:draft:draft"), "{broken");
});

test("version conflicts keep the draft and never replace another writer's edit", async (t) => {
  const h = await fixture(t), storage = memoryStorage();
  const original = { kind: "insight.save", documentId: h.documentId, insight: { type: "note", body: "First", color: "amber" } };
  const client = createCommandIntentClient({ storage, send: h.send });
  const first = (await client.execute(original, { intentId: "draft" })).insight;
  await h.send({ ...original, requestId: crypto.randomUUID(), expectedVersion: first.version, insight: { ...first, body: "Other writer" } });
  await assert.rejects(client.execute({ ...original, insight: { ...original.insight, body: "Stale draft" } }, { intentId: "draft" }), (error) => error.status === 409);
  assert.equal((await h.inspect()).insights[0].body, "Other writer");
  assert.ok(storage.length > 0);
});

test("settle waits for queued draft writes and reports a failed outstanding command", async () => {
  const firstGate = deferred(), secondGate = deferred(), started = [];
  const client = createCommandIntentClient({ storage: memoryStorage(), send: async (command) => {
    started.push(command);
    if (command.insight.body === "first") await firstGate.promise;
    else await secondGate.promise;
    return { insight: { id: "saved", version: started.length } };
  } });
  const command = (body) => ({ kind: "insight.save", documentId: "doc", insight: { body } });
  const first = client.execute(command("first"), { intentId: "draft" });
  const second = client.execute(command("second"), { intentId: "draft" });
  const secondResult = second.catch((error) => error);
  let settled = false;
  const close = client.settle().then((status) => { settled = true; return status; });
  await tick();
  assert.equal(started.length, 1);
  firstGate.resolve();
  await first; await tick();
  assert.equal(started.length, 2);
  assert.equal(settled, false);
  secondGate.reject(new Error("save failed"));
  await secondResult;
  assert.equal((await close).errors[0].message, "save failed");
});

test("late checkpoint failure cannot overwrite a newer queued position", async (t) => {
  const h = await fixture(t), gate = deferred(), commands = [];
  let failFirst = true;
  const queue = createReadingCheckpointQueue({ storage: memoryStorage(), send: async (command) => {
    commands.push(structuredClone(command));
    if (failFirst) { failFirst = false; await gate.promise; }
    return h.send(command);
  } });
  queue.enqueue(h.documentId, h.state(0.2));
  const oldFlush = queue.flush(); await tick();
  queue.enqueue(h.documentId, h.state(0.8));
  const newerFlush = queue.flush();
  assert.equal(commands.length, 1);
  gate.reject(new TypeError("Old request failed before delivery"));
  assert.equal((await oldFlush).pending, 1);
  assert.equal((await newerFlush).pending, 1);
  assert.equal(queue.position(h.documentId).offsetRatio, 0.8);
  const result = await queue.flush();
  assert.equal(result.pending, 0);
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(commands[2].readingState.offsetRatio, 0.8);
  assert.equal((await h.inspect()).readingState.offsetRatio, 0.8);
});

test("checkpoint reload replays an unknown commit before the latest position", async (t) => {
  const h = await fixture(t), storage = memoryStorage(), commands = [];
  const first = createReadingCheckpointQueue({ storage, send: async (command) => {
    commands.push(structuredClone(command)); await h.send(command); throw new TypeError("Lost response");
  } });
  first.enqueue(h.documentId, h.state(0.2));
  await first.flush();
  first.enqueue(h.documentId, h.state(0.8));
  const restored = createReadingCheckpointQueue({ storage, send: async (command) => { commands.push(structuredClone(command)); return h.send(command); } });
  assert.equal(restored.position(h.documentId).offsetRatio, 0.8);
  assert.equal((await restored.flush()).pending, 0);
  assert.deepEqual(commands[0], commands[1]);
  assert.equal((await h.inspect()).readingState.offsetRatio, 0.8);
  assert.equal(storage.length, 0);
});

test("checkpoint lanes are independent and unsent positions coalesce", async () => {
  const gate = deferred(), sent = [];
  const queue = createReadingCheckpointQueue({ storage: memoryStorage(), send: async (command) => {
    sent.push(command);
    if (command.documentId === "slow") await gate.promise;
  } });
  queue.enqueue("slow", { offsetRatio: 0.1 });
  queue.enqueue("fast", { offsetRatio: 0.1 });
  queue.enqueue("fast", { offsetRatio: 0.8 });
  const slow = queue.flush("slow");
  assert.equal((await queue.flush("fast")).pending, 0);
  assert.equal(sent.filter((item) => item.documentId === "fast").length, 1);
  assert.equal(sent.find((item) => item.documentId === "fast").readingState.offsetRatio, 0.8);
  gate.resolve(); await slow;
});

test("a newer valid checkpoint replaces a definitively rejected position", async () => {
  const queue = createReadingCheckpointQueue({ storage: memoryStorage(), send: async (command) => {
    if (command.readingState.offsetRatio === 0.2) throw Object.assign(new Error("Invalid old block"), { status: 400 });
  } });
  queue.enqueue("doc", { offsetRatio: 0.2 });
  assert.equal((await queue.flush()).pending, 1);
  queue.enqueue("doc", { offsetRatio: 0.8 });
  assert.equal((await queue.flush()).pending, 0);
});

test("later navigation invalidates delayed opens and releases each loading owner once", async () => {
  const intents = createNavigationIntents(), gate = deferred();
  let released = 0, destination = "collection";
  const first = intents.begin(() => released++);
  const opening = (async () => { await gate.promise; if (first.current()) destination = "reader"; first.finish(); })();
  intents.invalidate(); destination = "flow";
  assert.equal(released, 1);
  gate.resolve(); await opening;
  assert.equal(destination, "flow");
  assert.equal(released, 1);
  const next = intents.begin(() => released++);
  const last = intents.begin(() => released++);
  assert.equal(next.current(), false);
  assert.equal(last.current(), true);
  next.finish(); last.finish(); last.finish();
  assert.equal(released, 3);
});

test("settings shortcut respects native dialogs, modal ownership and composition", () => {
  const event = { target: { closest: () => null } }, clear = { querySelector: () => null };
  assert.equal(canHandleWorkspaceSettings(event, null, clear), true);
  assert.equal(canHandleWorkspaceSettings(event, "settings", clear), true);
  assert.equal(canHandleWorkspaceSettings(event, null, { querySelector: () => ({ open: true }) }), false);
  assert.equal(canHandleWorkspaceSettings(event, "import", clear), false);
  assert.equal(canHandleWorkspaceSettings({ ...event, isComposing: true }, null, clear), false);
  assert.equal(canHandleWorkspaceSettings({ ...event, repeat: true }, null, clear), false);
  assert.equal(canHandleWorkspaceSettings({ target: { closest: () => ({}) } }, null, clear), false);
});

test("legacy drafts receive an identity once without rewriting their body", () => {
  const original = { body: "An existing untitled draft", title: "" };
  const identified = ensureDraftIntent(original, () => "stable");
  assert.deepEqual(identified, { ...original, clientIntentId: "stable" });
  assert.equal(ensureDraftIntent(identified, () => "changed"), identified);
  assert.equal(original.clientIntentId, undefined);
});
