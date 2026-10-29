import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createWorkspaceServer } from "../server.mjs";
import { localActor } from "../actor.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "reader-conditional-http-"));
  const authToken = "conditional-http-test-only";
  let now = Date.parse("2025-05-01T06:59:59.000Z");
  const server = await createWorkspaceServer({ dataDir: directory, bootstrap: false, glossaryPath: false, staticRoot: false, sync: false, authToken, flowNow: () => now });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port, headers = { Authorization: "Bearer " + authToken };
  t.after(async () => { await server.shutdown(); await rm(directory, { recursive: true, force: true }); });
  return { server, workspace: server.workspace, base, headers, setNow: (value) => { now = value; } };
}

test("a conditional workspace read authorizes first, skips snapshot work and invalidates after a committed change", async (t) => {
  const h = await fixture(t); let snapshots = 0; const original = h.workspace.snapshot.bind(h.workspace);
  h.workspace.snapshot = (...args) => { snapshots++; return original(...args); };
  const response = await fetch(h.base + "/api/workspace", { headers: h.headers }), tag = response.headers.get("etag");
  assert.ok(tag); assert.equal(response.status, 200); assert.equal(snapshots, 1);
  const cached = await fetch(h.base + "/api/workspace", { headers: { ...h.headers, "If-None-Match": tag } });
  assert.equal(cached.status, 304); assert.equal(await cached.text(), ""); assert.equal(snapshots, 1);
  const unauthenticated = await fetch(h.base + "/api/workspace", { headers: { "If-None-Match": tag } });
  assert.equal(unauthenticated.status, 401);
  await h.workspace.execute(localActor, { kind: "collection.create", requestId: randomUUID(), label: "Changed" });
  const changed = await fetch(h.base + "/api/workspace", { headers: { ...h.headers, "If-None-Match": tag } });
  assert.equal(changed.status, 200); assert.notEqual(changed.headers.get("etag"), tag); assert.equal(snapshots, 2);
});

test("draft validators use SQLite metadata without hydrating immutable snapshots and reflect failed updates", async (t) => {
  const h = await fixture(t), source = await h.workspace.upload(localActor, Buffer.from(JSON.stringify({ format: "reader-authoring-1", key: "etag-preview", meta: { title: "Preview", language: "en" }, blocks: [{ key: "p", type: "para", text: "Source text." }] })), { filename: "authoring.json", mediaType: "application/json" });
  const { preview } = await h.workspace.createAuthoringPreview(localActor, { authoringSourceId: source.sourceId, requestId: randomUUID() });
  const path = "/api/authoring/drafts/" + preview.draftId;
  const first = await fetch(h.base + path, { headers: h.headers }), tag = first.headers.get("etag"); assert.equal(first.status, 200); await first.arrayBuffer();
  const original = h.workspace.previewSnapshot.bind(h.workspace); let loads = 0;
  h.workspace.previewSnapshot = (...args) => { loads++; return original(...args); };
  assert.equal((await fetch(h.base + path, { headers: { ...h.headers, "If-None-Match": tag } })).status, 304); assert.equal(loads, 0);
  const draft = h.workspace.draft(preview.draftId); draft.version++; draft.lastError = { code: "SYNTHETIC", error: "New invalid draft input" };
  h.workspace.db.prepare("UPDATE authoring_drafts SET payload=? WHERE id=?").run(JSON.stringify(draft), draft.id);
  const changed = await fetch(h.base + path, { headers: { ...h.headers, "If-None-Match": tag } });
  assert.equal(changed.status, 200); assert.equal((await changed.json()).draft.lastError.code, "SYNTHETIC"); assert.equal(loads, 1);
});

test("Flow validators change at the viewer's midnight without requiring a new reading event", async (t) => {
  const h = await fixture(t), path = "/api/flow/summary?timezone=America%2FLos_Angeles";
  const first = await fetch(h.base + path, { headers: h.headers }); assert.equal(first.status, 200);
  const tag = first.headers.get("etag"); await first.arrayBuffer();
  assert.equal((await fetch(h.base + path, { headers: { ...h.headers, "If-None-Match": tag } })).status, 304);
  h.setNow(Date.parse("2025-05-01T07:00:00.000Z"));
  const next = await fetch(h.base + path, { headers: { ...h.headers, "If-None-Match": tag } }); assert.equal(next.status, 200); assert.notEqual(next.headers.get("etag"), tag);
});
