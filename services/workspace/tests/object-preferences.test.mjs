import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createWorkspaceServer } from "../server.mjs";
import { publishAuthoringFixture } from "./authoring-fixture.mjs";

test("HTTP object preferences persist across restart, merge fields, migrate safely and enforce authorization", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-object-settings-"));
  let server, base;
  const start = async () => {
    server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false, authToken: "object-settings-test-token" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  t.after(async () => {
    await server?.shutdown();
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep));
    await rm(dataDir, { recursive: true, force: true });
  });
  await start();
  const auth = { Authorization: "Bearer object-settings-test-token" };
  const request = async (path, body, expected = 200) => {
    const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: { ...auth, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  const authoring = { format: "reader-authoring-1", key: "doc-size-test", meta: { title: "Object settings", language: "en" }, blocks: [
    { key: "title", type: "heading", level: 1, text: "Sizes" },
    { key: "table", type: "table", head: [["A", "B"]], rows: [["1", "2"]] },
    { key: "other", type: "table", head: [["C", "D"]], rows: [["3", "4"]] },
  ] };
  const { document, blockIds: ids } = await publishAuthoringFixture({ base, headers: auth, authoring });
  const path = `/api/documents/${document.id}/object-preferences`;
  const save = (objects, options = {}, expected = 200) => request("/api/commands", { kind: "object_preferences.update", documentId: document.id, documentRevision: 1, objects, requestId: randomUUID(), ...options }, expected);
  const before = await request("/api/documents/" + document.id);
  assert.deepEqual((await request(path)).objects, {});
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await fetch(base + "/api/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).status, 401);
  const receiptId = randomUUID();
  const first = await save({ [ids.table]: { widthPercent: 125, fontSize: 16 } }, { requestId: receiptId });
  await Promise.all([save({ [ids.table]: { widthPercent: 140 } }), save({ [ids.table]: { fontSize: 21 }, [ids.other]: { widthPercent: 85 } })]);
  assert.deepEqual((await request(path)).objects[ids.table], { widthPercent: 140, fontSize: 21 });
  assert.deepEqual(await save({ [ids.table]: { widthPercent: 125, fontSize: 16 } }, { requestId: receiptId }), first);
  assert.deepEqual((await request(path)).objects[ids.table], { widthPercent: 140, fontSize: 21 });
  await save({ [ids.table]: { widthPercent: 130 } }, { requestId: receiptId }, 409);
  await save({ [ids.table]: { widthPercent: null, fontSize: null } });
  await save({ [ids.table]: { widthPercent: 170, fontSize: 30 }, removed: { fontSize: 20 } }, { onlyIfAbsent: true });
  assert.deepEqual((await request(path)).objects, { [ids.table]: { widthPercent: null, fontSize: null }, [ids.other]: { widthPercent: 85, fontSize: null } });
  for (const patch of [{ fontSize: 100 }, { widthPercent: -1 }, { fontSize: "18" }, { expanded: true }, {}]) await save({ [ids.table]: patch }, {}, 400);
  await save({ [ids.title]: { fontSize: 18 } }, {}, 409);
  await save({ [ids.table]: { fontSize: 22 }, missing: { widthPercent: 120 } }, {}, 409);
  assert.deepEqual((await request(path)).objects[ids.table], { widthPercent: null, fontSize: null }, "invalid batches roll back atomically");
  const after = await request("/api/documents/" + document.id);
  assert.deepEqual(after.document, before.document); assert.deepEqual(after.insights, before.insights); assert.deepEqual(after.readingState, before.readingState);
  await server.shutdown(); await start();
  assert.deepEqual((await request(path)).objects, { [ids.table]: { widthPercent: null, fontSize: null }, [ids.other]: { widthPercent: 85, fontSize: null } });
});
