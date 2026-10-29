import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSyncTransport, syncConnection } from "../sync-http-client.mjs";

const token = "sync-test-token-not-a-real-credential";
const configuration = { origin: "https://reader.example", token };
const json = (value, options) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...options });
const object = (value = "A complete offline object") => {
  const bytes = Buffer.from(value);
  return { bytes, descriptor: { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length } };
};

test("sync transport accepts an HTTPS origin and keeps authority in headers only", async () => {
  assert.deepEqual(syncConnection({ ...configuration, origin: configuration.origin + "/" }), configuration);
  for (const origin of ["http://reader.example", "https://user:password@reader.example", "https://reader.example/api", "https://reader.example/?token=secret", "https://reader.example/#state", "bad"]) {
    assert.throws(() => syncConnection({ ...configuration, origin }), (error) => error.code === "SYNC_INVALID_CONFIGURATION" && !error.message.includes(origin));
  }
  for (const invalidToken of ["short", "a\rb".repeat(10), " ".repeat(16), undefined]) assert.throws(() => syncConnection({ ...configuration, token: invalidToken }));
  const calls = [], transport = createSyncTransport({ ...configuration, fetchImpl: async (url, options) => { calls.push({ url, options }); return json({ changes: [], cursor: 7 }); } });
  assert.deepEqual(await transport.pull({ after: 7, limit: 20 }), { changes: [], cursor: 7 });
  assert.equal(calls[0].url, configuration.origin + "/api/sync/pull?after=7&limit=20");
  assert.equal(calls[0].options.headers.Authorization, "Bearer " + token);
  assert.equal(calls[0].options.credentials, "omit"); assert.equal(calls[0].options.redirect, "error");
  assert.equal(Object.hasOwn(transport, "token"), false);
  await transport.push({ operations: [{ id: "operation-1" }] });
  assert.equal(calls[1].options.method, "POST"); assert.equal(calls[1].options.body, '{"operations":[{"id":"operation-1"}]}');
  assert.throws(() => transport.pull({ after: -1 })); assert.throws(() => transport.pull({ limit: 101 }));
});

test("immutable transfer verifies each upload and download before acknowledging bytes", async () => {
  const value = object(), calls = [];
  const transport = createSyncTransport({ ...configuration, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return options.method === "PUT" ? new Response(null, { status: 204 }) : new Response(value.bytes, { headers: { "content-length": String(value.bytes.length) } });
  } });
  assert.deepEqual(await transport.uploadObject(value.descriptor, value.bytes), value.descriptor);
  assert.equal(calls[0].url, configuration.origin + "/api/sync/objects/" + value.descriptor.sha256 + "?kind=blob&size=" + value.descriptor.size);
  assert.equal(calls[0].options.headers["Content-Type"], "application/octet-stream");
  assert.deepEqual(await transport.downloadObject(value.descriptor), value.bytes);
  await assert.rejects(transport.uploadObject(value.descriptor, Buffer.from("wrong")), { code: "SYNC_OBJECT_MISMATCH" });
  assert.equal(calls.length, 2, "bad local bytes never reach the remote service");
  const wrong = createSyncTransport({ ...configuration, fetchImpl: async () => new Response(Buffer.alloc(value.bytes.length)) });
  await assert.rejects(wrong.downloadObject(value.descriptor), { code: "SYNC_OBJECT_MISMATCH" });
  await assert.rejects(wrong.downloadObject({ sha256: "../escape", size: 1 }), { code: "SYNC_INVALID_OBJECT" });
});

test("size limits cover declared and streamed bodies and reject oversized outgoing batches", async () => {
  const value = object(); let cancelled = false;
  const declared = createSyncTransport({ ...configuration, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": String(value.descriptor.size + 1) } }) });
  await assert.rejects(declared.downloadObject(value.descriptor), { code: "SYNC_RESPONSE_TOO_LARGE" }); assert.equal(cancelled, true);
  const streamed = createSyncTransport({ ...configuration, fetchImpl: async () => new Response(Buffer.alloc(value.descriptor.size + 1)) });
  await assert.rejects(streamed.downloadObject(value.descriptor), { code: "SYNC_RESPONSE_TOO_LARGE" });
  assert.throws(() => streamed.push({ large: "x".repeat(16 * 1024 * 1024) }), { code: "SYNC_REQUEST_TOO_LARGE" });
});

test("objects larger than 8 MiB upload verified parts before one idempotent completion", async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 3, 97), sha256 = createHash("sha256").update(bytes).digest("hex");
  const descriptor = { key: `objects/sha256/${sha256}`, sha256, size: bytes.length, version: 1 }, calls = [];
  const transport = createSyncTransport({ ...configuration, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return url.includes("/complete?") ? json(descriptor) : new Response(null, { status: 204 });
  } });
  assert.deepEqual(await transport.uploadObject(descriptor, bytes), descriptor);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.includes("/parts/1?kind=object&size=" + bytes.length));
  assert.ok(calls[1].url.includes("/parts/2?kind=object&size=" + bytes.length));
  assert.equal(calls[0].options.body.byteLength, 8 * 1024 * 1024); assert.equal(calls[1].options.body.byteLength, 3);
  for (const { options } of calls.slice(0, 2)) {
    assert.equal(options.headers["Content-Length"], String(options.body.byteLength));
    assert.equal(options.headers["X-Content-Sha256"], createHash("sha256").update(options.body).digest("hex"));
  }
  assert.deepEqual(JSON.parse(calls[2].options.body).parts, calls.slice(0, 2).map(({ options }) => options.headers["X-Content-Sha256"]));
});

test("redirect and upstream failures are redacted and expose only safe retry metadata", async () => {
  const transport = createSyncTransport({ ...configuration, fetchImpl: async () => { throw new Error("Redirect failed: " + token); } });
  await assert.rejects(transport.pull(), (error) => error.code === "SYNC_OFFLINE" && !String(error).includes(token));
  const unauthenticated = createSyncTransport({ ...configuration, fetchImpl: async () => new Response(token, { status: 401 }) });
  await assert.rejects(unauthenticated.pull(), (error) => error.code === "SYNC_UNAUTHORIZED" && error.status === 401 && !String(error).includes(token));
  const throttled = createSyncTransport({ ...configuration, fetchImpl: async () => new Response("busy " + token, { status: 429, headers: { "retry-after": "999" } }) });
  await assert.rejects(throttled.pull(), (error) => error.code === "SYNC_RATE_LIMITED" && error.retryAfterMs === 999000 && !String(error).includes(token));
  const invalid = createSyncTransport({ ...configuration, fetchImpl: async () => new Response("<html>" + token, { headers: { "content-type": "text/html" } }) });
  await assert.rejects(invalid.pull(), (error) => error.code === "SYNC_INVALID_RESPONSE" && !String(error).includes(token));
});

test("history identity scopes subsequent requests and a restore-race rejection stays actionable", async () => {
  const calls = [], historyId = "history-stable", transport = createSyncTransport({ ...configuration, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return json({ replicaId: "device", historyId, cursor: 7 });
  } });
  await transport.pull({ after: 7, historyId });
  await transport.push({ replicaId: "device", requestId: "frozen", mutations: [] }, { historyId });
  await transport.acknowledgeApplied({ replicaId: "device", historyId, cursor: 7 });
  for (const call of calls) assert.equal(call.options.headers["X-Reader-Sync-History"], historyId);
  assert.deepEqual(JSON.parse(calls[2].options.body), { replicaId: "device", historyId, cursor: 7 });
  const restored = createSyncTransport({ ...configuration, fetchImpl: async () => new Response("untrusted detail " + token, { status: 409, headers: { "X-Reader-Sync-Error": "SYNC_HISTORY_CHANGED" } }) });
  await assert.rejects(restored.push({ requestId: "frozen" }, { historyId }), (error) => error.code === "SYNC_HISTORY_CHANGED" && !error.message.includes(token));
});

test("cancellation and timeout finish without altering the durable queue", async (t) => {
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const controller = new AbortController(), transport = createSyncTransport({ ...configuration, fetchImpl });
  const pending = transport.pull({ signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { code: "SYNC_CANCELLED" });
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  await assert.rejects(createSyncTransport({ ...configuration, fetchImpl, timeoutMs: 5 }).pull(), { code: "SYNC_TIMEOUT" });
});
