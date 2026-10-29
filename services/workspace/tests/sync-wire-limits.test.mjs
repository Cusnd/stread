import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWorkspace, localActor } from "../service.mjs";
import { createWorkspaceSync } from "../sync-engine.mjs";
import { createSyncTransport } from "../sync-http-client.mjs";
import { createWorkspaceSyncClient } from "../sync-client.mjs";
import { handleWorkspaceSync } from "../sync-http.mjs";
import { rowHash, SYNC_MAX_BYTES } from "../sync-schema.mjs";

const configuration = { origin: "https://sync-wire.test", token: "synthetic-wire-test-token-only" };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, replicaId, mode = "client") {
  const directory = await mkdtemp(join(tmpdir(), "reader-sync-wire-"));
  const workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  const sync = await createWorkspaceSync(workspace, { replicaId, mode });
  t.after(async () => {
    await workspace.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + "\\reader-sync-wire-") || resolve(directory).startsWith(resolve(tmpdir()) + "/reader-sync-wire-"));
    await rm(directory, { recursive: true, force: true });
  });
  return { workspace, sync, db: workspace.db };
}

// The production transport and route communicate through a real localhost HTTP
// listener. Only the fixed HTTPS test origin is remapped; no response is mocked.
// TLS and deployment authentication are covered by the cloud runtime suite.
async function wire(t, h) {
  const state = { requests: [], responses: [], transform: null, beforeResponse: null };
  const server = createServer(async (incoming, outgoing) => {
    try {
      assert.equal(incoming.headers.authorization, "Bearer " + configuration.token);
      const url = new URL(incoming.url, configuration.origin);
      state.requests.push(url.pathname + url.search);
      const request = new Request(url, { method: incoming.method, headers: incoming.headers,
        ...(["GET", "HEAD"].includes(incoming.method) ? {} : { body: Readable.toWeb(incoming), duplex: "half" }) });
      let response;
      try { response = await handleWorkspaceSync(request, { sync: h.sync, actor: localActor }); }
      catch (error) { response = new Response(JSON.stringify({ code: error.code }), { status: error.status || 500, headers: { "content-type": "application/json" } }); }
      assert.ok(response);
      if (state.transform) response = await state.transform(url, response);
      if (state.beforeResponse) await state.beforeResponse(url, response);
      if (outgoing.destroyed) { await response.body?.cancel(); return; }
      const body = Buffer.from(await response.arrayBuffer());
      state.responses.push({ path: url.pathname, status: response.status, bytes: body.length });
      // Synchronous 16-MiB fixture construction can outlive an older pooled
      // socket's idle timeout under parallel test load. Keep the wire assertion
      // about HTTP bounds independent of same-process keep-alive timer races.
      outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), "content-length": String(body.length), connection: "close" });
      await pipeline(Readable.from([body]), outgoing);
    } catch (error) {
      if (!outgoing.destroyed) {
        t.diagnostic(JSON.stringify({ wireServerFailure: incoming.url, code: error.code, message: error.message }));
        outgoing.destroy(error);
      }
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => { const closed = new Promise((done) => server.close(done)); server.closeAllConnections(); await closed; });
  const origin = `http://127.0.0.1:${server.address().port}`;
  state.fetchImpl = async (url, options) => {
    try { return await fetch(origin + new URL(url).pathname + new URL(url).search, options); }
    catch (error) {
      if (!options.signal?.aborted) t.diagnostic(JSON.stringify({ wireFetchFailure: new URL(url).pathname, code: error.cause?.code, message: error.cause?.message }));
      throw error;
    }
  };
  state.transport = (options = {}) => createSyncTransport({ ...configuration, fetchImpl: state.fetchImpl, ...options });
  return state;
}

async function align(client, transport) {
  client.sync.acceptEnrollment(await transport.enroll({ replicaId: client.sync.replicaId, requestId: "enroll:" + client.sync.replicaId }));
  let page;
  do { page = await transport.pull({ after: client.sync.cursor }); await client.sync.applyPull(page); } while (page.hasMore);
  client.sync.capture();
  assert.equal(client.sync.status().pendingBatches, 0);
}

function receiptRows(prefix, count = 640) {
  return Array.from({ length: count }, (_, index) => ({ request_id: prefix + ":" + String(index).padStart(4, "0"), hash: "a".repeat(64), payload: '{"text":""}', actor: "synthetic", created_at: "2026-10-23T00:00:00.000Z" }));
}
const mutation = (row) => ({ entity: "receipts", key: JSON.stringify([row.request_id]), expected: { version: 0, hash: null }, value: row });
function sizedRows(prefix, target) {
  const rows = receiptRows(prefix), padding = target - bytes(rows.map(mutation));
  assert.ok(padding >= rows.length);
  const each = Math.floor(padding / rows.length), remainder = padding % rows.length;
  for (let index = 0; index < rows.length; index++) rows[index].payload = JSON.stringify({ text: "x".repeat(each + (index < remainder ? 1 : 0)) });
  assert.equal(bytes(rows.map(mutation)), target);
  return rows;
}
function insertRows(h, rows) {
  h.db.transaction(() => {
    const insert = h.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?)");
    for (const row of rows) insert.run(row.request_id, row.hash, row.payload, row.actor, row.created_at);
  });
}
const countRows = (h, prefix) => h.db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE request_id LIKE ?").get(prefix + ":%").count;
const dataHash = (h, prefix) => digest(JSON.stringify(h.db.prepare("SELECT * FROM receipts WHERE request_id LIKE ? ORDER BY request_id").all(prefix + ":%")));
const runner = (h, transport) => createWorkspaceSyncClient(h.workspace, { ...configuration, engine: h.sync, transport });

test("an envelope over 16 MiB never freezes an unsendable outbox or removes committed dirty rows", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "device:envelope");
  const http = await wire(t, server); await align(client, http.transport());
  const rows = sizedRows("envelope", SYNC_MAX_BYTES - 32); insertRows(client, rows);
  const before = dataHash(client, "envelope"), dirty = client.sync.status().dirty, groups = client.db.prepare("SELECT COUNT(*) AS count FROM sync_dirty_groups").get().count;
  assert.ok(bytes(rows.map(mutation)) < SYNC_MAX_BYTES);
  assert.throws(() => client.sync.capture(), { code: "SYNC_BATCH_TOO_LARGE", status: 413 });
  assert.equal(client.sync.status().pendingBatches, 0);
  assert.equal(client.sync.status().dirty, dirty);
  assert.equal(client.db.prepare("SELECT COUNT(*) AS count FROM sync_dirty_groups").get().count, groups);
  assert.equal(dataHash(client, "envelope"), before);
  assert.equal(countRows(server, "envelope"), 0);
});

test("a push that fits its envelope but would create an oversized pull rolls back atomically over HTTP", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "device:pull-limit");
  const http = await wire(t, server), transport = http.transport(); await align(client, transport);
  const rows = sizedRows("pull-limit", SYNC_MAX_BYTES - 2048); insertRows(client, rows);
  const before = dataHash(client, "pull-limit"), head = server.sync.head;
  const batch = { protocolVersion: 1, replicaId: client.sync.replicaId, requestId: "request:pull-limit", initialImport: true, initialImportComplete: true, mutations: rows.map(mutation), objects: [] };
  assert.ok(bytes(batch) < SYNC_MAX_BYTES);
  const pullMutations = rows.map((row) => ({ entity: "receipts", key: JSON.stringify([row.request_id]), value: row, version: 1, hash: rowHash(row) }));
  assert.ok(bytes({ transactions: [{ sequence: 1, replicaId: batch.replicaId, requestId: batch.requestId, mutations: pullMutations }], nextCursor: 1, hasMore: false, objects: [] }) > SYNC_MAX_BYTES);
  assert.throws(() => client.sync.capture(), { code: "SYNC_BATCH_TOO_LARGE", status: 413 });
  await assert.rejects(transport.push(batch), { code: "SYNC_REMOTE_ERROR", status: 413 });
  assert.equal(server.sync.head, head);
  assert.equal(countRows(server, "pull-limit"), 0);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM sync_receipts WHERE request_id=?").get(batch.requestId).count, 0);
  assert.equal(dataHash(client, "pull-limit"), before);
  assert.equal(client.sync.status().dirty, rows.length);
  assert.equal(client.sync.status().pendingBatches, 0);

  // Synthetic pre-migration journal: the read guard must reject this legacy
  // oversized atomic group without reporting a cursor beyond it.
  server.db.prepare("INSERT INTO sync_journal(replica_id,request_id,payload,created_at) VALUES(?,?,?,?)").run("historical", "historical:too-large", server.sync.encode({ replicaId: batch.replicaId, requestId: batch.requestId, mutations: pullMutations }), "2026-10-23T00:00:00.000Z");
  const cursor = client.sync.cursor;
  await assert.rejects(transport.pull({ after: cursor }), { code: "SYNC_REMOTE_ERROR", status: 413 });
  assert.equal(client.sync.cursor, cursor);
  assert.equal(dataHash(client, "pull-limit"), before);
  assert.ok(http.responses.every((response) => response.bytes <= SYNC_MAX_BYTES));
});

test("a near-16-MiB atomic transaction completes HTTP push, replay and pull with bounded responses", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "device:near-limit"), observer = await fixture(t, "device:observer");
  const http = await wire(t, server), transport = http.transport(); await align(client, transport); await align(observer, transport);
  const rows = sizedRows("near-limit", SYNC_MAX_BYTES - 65536); insertRows(client, rows); client.sync.capture();
  const batch = client.sync.pending().batches[0], before = dataHash(client, "near-limit");
  assert.ok(bytes(batch) > SYNC_MAX_BYTES - 65536 && bytes(batch) < SYNC_MAX_BYTES);
  const accepted = await transport.push(batch); assert.equal(accepted.accepted, true); client.sync.acknowledge(accepted);
  const head = server.sync.head, replay = await transport.push(batch);
  assert.equal(digest(JSON.stringify(replay)), digest(JSON.stringify(accepted)));
  assert.equal(server.sync.head, head);
  const page = await transport.pull({ after: observer.sync.cursor });
  assert.equal(page.transactions.length, 1); assert.equal(page.hasMore, false);
  assert.ok(bytes(page) > SYNC_MAX_BYTES - 65536 && bytes(page) <= SYNC_MAX_BYTES);
  await observer.sync.applyPull(page);
  assert.equal(observer.sync.cursor, head);
  assert.equal(dataHash(observer, "near-limit"), before);
  assert.equal(dataHash(server, "near-limit"), before);
  assert.equal(client.sync.status().pendingBatches, 0);
  assert.ok(http.responses.every((response) => response.bytes <= SYNC_MAX_BYTES));
});

test("oversized conflict receipts survive tampering, cancellation, budget failure and restart before exact replay", async (t) => {
  const server = await fixture(t, "server", "server"), client = await fixture(t, "device:conflict");
  const http = await wire(t, server); await align(client, http.transport());
  const rows = receiptRows("conflict", 384); insertRows(server, rows);
  await client.sync.applyPull(await http.transport().pull({ after: client.sync.cursor }));
  for (const [h, side] of [[client, "local"], [server, "remote"]]) h.db.transaction(() => {
    const update = h.db.prepare("UPDATE receipts SET payload=? WHERE request_id=?");
    for (const row of rows) update.run(JSON.stringify({ side, text: "x".repeat(16384) + "原文🙂" + row.request_id }), row.request_id);
  });
  client.sync.capture();
  const batch = client.sync.pending().batches[0], localHash = dataHash(client, "conflict"), remoteHash = dataHash(server, "conflict"), cursor = client.sync.cursor;
  assert.ok(bytes(batch) < SYNC_MAX_BYTES);
  const unchanged = () => {
    assert.equal(client.sync.cursor, cursor);
    assert.equal(client.sync.status().pendingBatches, 1);
    assert.equal(client.sync.status().conflicts, 0);
    assert.equal(client.sync.pending().batches[0].requestId, batch.requestId);
    assert.equal(dataHash(client, "conflict"), localHash);
    assert.equal(dataHash(server, "conflict"), remoteHash);
  };

  // Alter one real HTTP page without changing its declared receipt hash.
  http.transform = async (url, response) => {
    if (url.pathname !== "/api/sync/receipts" || url.searchParams.get("after") !== "0") return response;
    const page = await response.json(); page.chunks[0] = "!" + page.chunks[0].slice(1);
    return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } });
  };
  const tampered = await runner(client, http.transport());
  await assert.rejects(tampered.runOnce(), { code: "SYNC_INVALID_RESPONSE" }); await tampered.stop(); unchanged();
  http.transform = null;
  const transfer = server.sync.receiptTransfer(batch.replicaId, batch.requestId), head = server.sync.head;
  assert.ok(transfer.length > SYNC_MAX_BYTES && transfer.parts > 64);

  // Stop a real sync cycle while its second receipt page is pending on the wire.
  const waiting = deferred(), release = deferred();
  http.beforeResponse = async (url) => {
    if (url.pathname === "/api/sync/receipts" && Number(url.searchParams.get("after")) > 0) { waiting.resolve(); await release.promise; }
  };
  const cancelled = await runner(client, http.transport()), active = cancelled.runOnce();
  const rejected = assert.rejects(active, { code: "SYNC_CANCELLED" });
  await waiting.promise; const stopping = cancelled.stop(); release.resolve(); await rejected; await stopping;
  http.beforeResponse = null; unchanged();

  const limited = await runner(client, http.transport({ maxReceiptBytes: SYNC_MAX_BYTES }));
  const pagesBefore = http.requests.filter((path) => path.startsWith("/api/sync/receipts?")).length;
  await assert.rejects(limited.runOnce(), { code: "SYNC_RESPONSE_TOO_LARGE" }); await limited.stop(); unchanged();
  assert.equal(http.requests.filter((path) => path.startsWith("/api/sync/receipts?")).length, pagesBefore);
  assert.equal(server.sync.head, head);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM sync_receipts WHERE replica_id=? AND request_id=?").get(batch.replicaId, batch.requestId).count, 1);

  // Reopen the engine against its durable database, then reconstruct and verify
  // every chunk before the client may convert its outbox into a visible conflict.
  server.sync = await createWorkspaceSync(server.workspace, { replicaId: "server", mode: "server" });
  const receipt = await http.transport().push(batch);
  assert.equal(receipt.accepted, false); assert.equal(receipt.states.length, rows.length); assert.equal(receipt.conflicts.length, rows.length);
  assert.ok(bytes(receipt) > SYNC_MAX_BYTES);
  assert.equal(digest(JSON.stringify(receipt)), transfer.sha256);
  for (const state of receipt.states) assert.equal(JSON.parse(state.value.payload).side, "remote");
  for (const conflict of receipt.conflicts) {
    assert.equal(JSON.parse(conflict.actual.value.payload).side, "remote");
    assert.equal(JSON.parse(conflict.localValue.payload).side, "local");
    assert.ok(JSON.parse(conflict.localValue.payload).text.includes("原文🙂"));
  }
  unchanged();
  client.sync.acknowledge(receipt);
  const conflict = client.sync.conflicts().conflicts[0];
  assert.equal(conflict.local.length, rows.length); assert.equal(conflict.remote.length, rows.length);
  assert.equal(client.sync.status().pendingBatches, 0); assert.equal(client.sync.status().conflicts, 1);
  assert.equal(dataHash(client, "conflict"), localHash); assert.equal(dataHash(server, "conflict"), remoteHash);
  assert.equal(server.sync.head, head);
  const replay = await http.transport().push(batch);
  assert.equal(digest(JSON.stringify(replay)), transfer.sha256);
  assert.ok(http.responses.every((response) => response.bytes <= SYNC_MAX_BYTES));
  assert.ok(http.requests.some((path) => path.includes("replicaId=device%3Aconflict")));
});
