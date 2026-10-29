import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createNodeSyncObjectStore } from "../sync-object-node.mjs";
import { handleSyncObjectRequest, SYNC_PART_BYTES } from "../sync-object-transfer.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "reader-sync-objects-"));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const store = createNodeSyncObjectStore({ root });
  const call = (path, method = "GET", bytes, headers = {}) => handleSyncObjectRequest(new Request("https://reader.test" + path, { method, ...(bytes !== undefined ? { body: bytes } : {}), headers: { ...(bytes !== undefined ? { "content-length": String(Buffer.byteLength(bytes)) } : {}), ...headers } }), { store });
  return { store, call, root };
}
test("immutable sync objects verify bytes before publishing and cannot alias content hashes", async (t) => {
  const { call } = await harness(t), bytes = Buffer.from('{"value":"persisted"}'), path = `/api/sync/objects/${hash(bytes)}?kind=object&size=${bytes.length}`;
  await assert.rejects(call(path, "HEAD"), { code: "SYNC_OBJECT_MISSING" });
  assert.equal((await call(path, "PUT", bytes)).status, 201);
  assert.equal((await call(path, "HEAD")).status, 204);
  assert.equal(await (await call(path)).text(), bytes.toString());
  const wrong = Buffer.from(bytes); wrong[0] = 0;
  await assert.rejects(call(path, "PUT", wrong), { code: "SYNC_OBJECT_INTEGRITY" });
  assert.equal(await (await call(path)).text(), bytes.toString());
});

test("an existing same-length corrupted object cannot acknowledge a successful upload or completion", async (t) => {
  const { call, root } = await harness(t), bytes = Buffer.from("immutable object bytes"), sha = hash(bytes), path = `/api/sync/objects/${sha}?kind=blob&size=${bytes.length}`;
  await call(path, "PUT", bytes);
  await writeFile(join(root, "blobs", sha), Buffer.alloc(bytes.length, 0));
  await assert.rejects(call(path, "HEAD"), { code: "SYNC_OBJECT_INTEGRITY" });
  await assert.rejects(call(path, "PUT", bytes), { code: "SYNC_OBJECT_INTEGRITY" });
  await assert.rejects(call(`/api/sync/objects/${sha}/complete?kind=blob&size=${bytes.length}`, "POST", JSON.stringify({ parts: [sha] })), { code: "SYNC_OBJECT_INTEGRITY" });
});
test("multipart resumes byte-exactly, rejects missing pieces and replays completion safely", async (t) => {
  const { call } = await harness(t), bytes = Buffer.alloc(SYNC_PART_BYTES + 17, 42), sha = hash(bytes), base = `/api/sync/objects/${sha}`, query = `?kind=blob&size=${bytes.length}`;
  const parts = [bytes.subarray(0, SYNC_PART_BYTES), bytes.subarray(SYNC_PART_BYTES)], hashes = parts.map(hash);
  await assert.rejects(call(base + query, "PUT", bytes), { code: "SYNC_USE_MULTIPART" });
  await call(base + "/parts/1" + query, "PUT", parts[0], { "X-Content-Sha256": hashes[0] });
  const input = JSON.stringify({ parts: hashes });
  await assert.rejects(call(base + "/complete" + query, "POST", input), /同步分块尚未完整/);
  await assert.rejects(call(base + query, "HEAD"), { code: "SYNC_OBJECT_MISSING" });
  await call(base + "/parts/2" + query, "PUT", parts[1], { "X-Content-Sha256": hashes[1] });
  assert.equal((await call(base + "/complete" + query, "POST", input)).status, 201);
  assert.equal((await call(base + "/complete" + query, "POST", input)).status, 200);
  assert.equal(hash(Buffer.from(await (await call(base + query)).arrayBuffer())), sha);
});
