import { createHash } from "node:crypto";
import { check } from "./errors.mjs";

export const SYNC_PART_BYTES = 8 * 1024 * 1024;
export const SYNC_MAX_BYTES = 100 * 1024 * 1024;
export const syncObjectKey = (ref) => ref.kind === "object" ? `objects/sha256/${ref.sha256}` : `blobs/${ref.sha256}`;
export function syncObjectReference(url, sha256) {
  const kind = url.searchParams.get("kind"), size = Number(url.searchParams.get("size"));
  check(["object", "blob"].includes(kind) && /^[a-f0-9]{64}$/.test(sha256) && Number.isSafeInteger(size) && size > 0 && size <= SYNC_MAX_BYTES, "SYNC_INVALID_OBJECT", "同步对象引用无效。", 400);
  return { kind, sha256, size, version: 1, key: syncObjectKey({ kind, sha256 }) };
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
async function boundedBytes(request, expected) {
  check(Number(request.headers.get("content-length")) === expected, "SYNC_OBJECT_SIZE", "上传大小与对象引用不符。", 400);
  const chunks = []; let size = 0;
  for await (const chunk of request.body || []) { size += chunk.byteLength; check(size <= expected, "SYNC_OBJECT_SIZE", "上传超过声明大小。", 413); chunks.push(chunk); }
  check(size === expected, "SYNC_OBJECT_SIZE", "上传尚未完整。", 400);
  return Buffer.concat(chunks, size);
}
export function checkedSyncStream(input, ref) {
  let size = 0; const hash = createHash("sha256");
  return input.pipeThrough(new TransformStream({
    transform(chunk, controller) { size += chunk.byteLength; check(size <= ref.size, "SYNC_OBJECT_SIZE", "同步对象超过声明大小。", 409); hash.update(chunk); controller.enqueue(chunk); },
    flush() { check(size === ref.size && hash.digest("hex") === ref.sha256, "SYNC_OBJECT_INTEGRITY", "同步对象校验失败。", 409); },
  }));
}
export async function handleSyncObjectRequest(request, { store }) {
  const url = new URL(request.url), match = url.pathname.match(/^\/api\/sync\/objects\/([a-f0-9]{64})(?:\/(parts\/([1-9][0-9]*)|complete))?$/);
  if (!match) return null;
  const ref = syncObjectReference(url, match[1]), suffix = match[2];
  if (!suffix && ["HEAD", "GET"].includes(request.method)) {
    const found = await store.head(ref); check(found?.size === ref.size, "SYNC_OBJECT_MISSING", "同步对象尚未传输。", 404);
    if (request.method === "HEAD") return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    const body = await store.get(ref); check(body, "SYNC_OBJECT_MISSING", "同步对象尚未传输。", 404);
    return new Response(body, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(ref.size), "Content-Disposition": "attachment", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } });
  }
  if (!suffix && request.method === "PUT") {
    check(ref.size <= SYNC_PART_BYTES, "SYNC_USE_MULTIPART", "大对象需要分块传输。", 413);
    const bytes = await boundedBytes(request, ref.size);
    check(createHash("sha256").update(bytes).digest("hex") === ref.sha256, "SYNC_OBJECT_INTEGRITY", "同步对象校验失败。", 409);
    await store.put(ref, new Response(bytes).body);
    return json(ref, 201);
  }
  const count = Math.ceil(ref.size / SYNC_PART_BYTES);
  if (suffix?.startsWith("parts/") && request.method === "PUT") {
    const part = Number(match[3]), sha256 = request.headers.get("x-content-sha256");
    check(Number.isSafeInteger(part) && part <= count && /^[a-f0-9]{64}$/.test(sha256 || ""), "SYNC_INVALID_PART", "同步分块编号或摘要无效。", 400);
    const size = part === count ? ref.size - (count - 1) * SYNC_PART_BYTES : SYNC_PART_BYTES;
    const bytes = await boundedBytes(request, size);
    check(createHash("sha256").update(bytes).digest("hex") === sha256, "SYNC_OBJECT_INTEGRITY", "同步分块校验失败。", 409);
    await store.stagePart(ref, part, sha256, bytes);
    return json({ part, sha256, size }, 201);
  }
  if (suffix === "complete" && request.method === "POST") {
    const length = Number(request.headers.get("content-length"));
    check(!length || length <= 4096, "REQUEST_TOO_LARGE", "分块清单过大。", 413);
    let size = 0; const chunks = [];
    for await (const chunk of request.body || []) { size += chunk.byteLength; check(size <= 4096, "REQUEST_TOO_LARGE", "分块清单过大。", 413); chunks.push(chunk); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    check(Array.isArray(value?.parts) && value.parts.length === count && value.parts.every((sha) => /^[a-f0-9]{64}$/.test(sha)), "SYNC_INVALID_PART", "分块清单无效。", 400);
    // The final immutable hash is the idempotency key; no duplicate business
    // entity is created when a device retries after losing this response.
    if ((await store.head(ref))?.size === ref.size) {
      // A crash after publishing but before cleanup must converge on retry too.
      await store.cleanParts(ref, value.parts);
      return json(ref);
    }
    let current = 0, reader;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            if (!reader) {
              if (current === count) { controller.close(); return; }
              const body = await store.openPart(ref, current + 1, value.parts[current]);
              check(body, "SYNC_PART_MISSING", "同步分块尚未完整。", 409);
              reader = body.getReader(); current++;
            }
            const chunk = await reader.read();
            if (chunk.done) { reader.releaseLock(); reader = null; continue; }
            controller.enqueue(chunk.value); return;
          }
        } catch (error) { controller.error(error); }
      },
      cancel(reason) { return reader?.cancel(reason); },
    });
    await store.put(ref, stream);
    await store.cleanParts(ref, value.parts);
    return json(ref, 201);
  }
  check(false, "METHOD_NOT_ALLOWED", "此对象接口不支持该方法。", 405);
}
