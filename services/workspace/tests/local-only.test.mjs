import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceServer } from "../server.mjs";
import { createWorkspaceSync } from "../sync-engine.mjs";
import { localWorkspaceUrl } from "../local-endpoint.mjs";
import { startStdio } from "../stdio.mjs";

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "reader-local-only-"));
  return root;
}
async function removeDirectory(root) {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(root.includes("reader-local-only-"));
  await rm(root, { recursive: true, force: true });
}
async function listen(server) {
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  return "http://127.0.0.1:" + server.address().port;
}
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test("stale cloud settings cannot start network work, publish external URLs or enroll a fresh local store", async t => {
  environment(t, { CONTINUOUS_READER_SYNC_URL: "not-a-valid-old-url", CONTINUOUS_READER_SYNC_TOKEN: "old-sync-token",
    CONTINUOUS_READER_PREVIEW_URL: "https://cloud.invalid", CONTINUOUS_READER_PREVIEW_TOKEN: "old-preview-token",
    CONTINUOUS_READER_REMOTE_URL: "https://cloud.invalid", CONTINUOUS_READER_SYNC_SERVER: "1",
    CONTINUOUS_READER_PUBLIC_ORIGIN: "https://cloud.invalid", CONTINUOUS_READER_ALLOWED_ORIGINS: "https://cloud.invalid" });
  const root = await directory(t);
  const originalFetch = globalThis.fetch, requests = [];
  t.mock.method(globalThis, "fetch", (url, options) => {
    assert.equal(new URL(url).hostname, "127.0.0.1", "runtime must never contact cloud");
    requests.push(String(url)); return originalFetch(url, options);
  });
  const server = await createWorkspaceServer({ dataDir: root, bootstrap: false, glossaryPath: false, staticRoot: false,
    sync: { origin: "https://cloud.invalid", token: "injected-old-token" }, syncServer: true,
    onlinePreview: { origin: "https://cloud.invalid", token: "injected-old-token", fetchImpl: () => assert.fail("upload") },
    publicOrigin: "https://cloud.invalid" });
  t.after(async () => { await server.shutdown(); await removeDirectory(root); });
  const base = await listen(server);
  assert.equal(server.syncClient, null); assert.equal(server.sync, null); assert.equal(server.workspace.onlinePreview, null);
  assert.equal((await (await fetch(base + "/health")).json()).backend, "local");
  assert.deepEqual(await (await fetch(base + "/api/sync/client/status")).json(), { configured: false, mode: "local" });
  assert.deepEqual(await (await fetch(base + "/api/sync/client/conflicts")).json(), { conflicts: [] });
  assert.equal((await fetch(base + "/api/sync/client/run", { method: "POST" })).status, 410);
  assert.equal((await fetch(base + "/api/sync/manifest")).status, 404);
  assert.equal((await fetch(base + "/api/workspace", { headers: { Origin: "https://cloud.invalid" } })).status, 403);
  assert.equal(server.workspace.db.prepare("SELECT name FROM sqlite_master WHERE name='sync_state'").get(), undefined);
  assert.equal(requests.length, 6);
});

test("existing outbox, receipts and conflict versions survive restart and can be resolved entirely locally", async t => {
  const root = await directory(t), dataDir = join(root, "local");
  const remote = await createWorkspace({ dataDir: join(root, "historical-peer"), bootstrap: false, glossaryPath: false });
  const workspace = await createWorkspace({ dataDir, bootstrap: false, glossaryPath: false });
  const hub = await createWorkspaceSync(remote, { mode: "server", replicaId: "historic-peer" });
  const replica = await createWorkspaceSync(workspace, { replicaId: "historic-local" });
  remote.db.transaction(() => remote.db.prepare("INSERT INTO collections VALUES('one','Original',NULL,1)").run());
  replica.acceptEnrollment(hub.enroll(localActor, { replicaId: replica.replicaId, requestId: "enroll-original" }));
  await replica.applyPull(hub.pull({ after: replica.cursor }));
  workspace.db.transaction(() => workspace.db.prepare("UPDATE collections SET label='Kept local',version=version+1 WHERE id='one'").run());
  replica.capture();
  remote.db.transaction(() => remote.db.prepare("UPDATE collections SET label='Saved peer version',version=version+1 WHERE id='one'").run());
  await replica.applyPull(hub.pull({ after: replica.cursor }));
  const [conflict] = replica.conflicts().conflicts;
  assert.ok(conflict);
  const before = Object.fromEntries(["sync_outbox", "sync_receipts", "sync_conflict_history", "sync_reference_ranges"].map(table => [table, workspace.db.prepare("SELECT * FROM " + table).all()]));
  await workspace.close();
  const server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false });
  t.after(async () => { await server.shutdown(); await remote.close(); await removeDirectory(root); });
  const base = await listen(server);
  const loaded = await (await fetch(base + "/api/sync/client/conflicts")).json();
  assert.equal(loaded.conflicts[0].id, conflict.id); assert.equal(loaded.conflicts[0].version, conflict.version);
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(server.workspace.db.prepare("SELECT * FROM " + table).all(), rows, table);
  assert.equal(server.workspace.db.prepare("SELECT label FROM collections WHERE id='one'").get().label, "Kept local");
  const resolveConflict = expectedVersion => fetch(base + "/api/sync/client/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: conflict.id, expectedVersion, choice: "remote" }) });
  assert.equal((await resolveConflict(conflict.version - 1)).status, 409);
  assert.equal((await resolveConflict(conflict.version)).status, 200);
  assert.equal(server.workspace.db.prepare("SELECT label FROM collections WHERE id='one'").get().label, "Saved peer version");
  const history = await (await fetch(base + "/api/sync/client/conflicts")).json();
  assert.equal(history.conflicts[0].status, "resolved"); assert.equal(history.conflicts[0].local[0].value.label, "Kept local");
  assert.equal(server.syncClient, null);
});

test("stdio rejects remote origins before fetch and never follows a local endpoint redirect", async t => {
  for (const value of ["https://remote.invalid", "http://127.0.0.1.evil.invalid", "http://user:private@localhost", "http://localhost/path", "http://localhost/?token=private"]) {
    assert.throws(() => localWorkspaceUrl(value), error => !error.message.includes("private") && /本机/.test(error.message));
  }
  assert.equal(localWorkspaceUrl("http://[::1]:4177").origin, "http://[::1]:4177");
  environment(t, { WORKSPACE_URL: "https://remote.invalid" });
  await assert.rejects(startStdio(), /本机/);
  let redirected = 0;
  const target = http.createServer((_req, res) => { redirected++; res.end("unexpected"); });
  const targetBase = await listen(target);
  const redirect = http.createServer((_req, res) => { res.writeHead(307, { Location: targetBase + "/mcp" }); res.end(); });
  t.after(async () => { for (const server of [redirect, target]) { server.closeAllConnections(); await new Promise(done => server.close(done)); } });
  process.env.WORKSPACE_URL = await listen(redirect);
  await assert.rejects(startStdio());
  assert.equal(redirected, 0);
});
