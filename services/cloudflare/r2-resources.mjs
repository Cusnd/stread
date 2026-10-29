import { createHash, randomUUID } from "node:crypto";
import { check, hash } from "../workspace/errors.mjs";
import { MAX_SOURCE_BYTES, PDF_REGION_ALGORITHM_VERSION, mediaTypeFor } from "../workspace/resource-types.mjs";
import { fetchPdfProcessor } from "./pdf-client.mjs";
import { checkedObjectBytes, objectBytes, parseObjectBytes, validateObjectReference } from "../workspace/immutable-objects.mjs";
import { uploadStream } from "./upload-stream.mjs";

const blobKey = (sha) => { check(/^[a-f0-9]{64}$/.test(sha), "VALIDATION_FAILED", "资源摘要无效。"); return "blobs/" + sha; };
function knownLength(body, size) {
  if (typeof FixedLengthStream === "undefined") return body;
  return body.pipeThrough(new FixedLengthStream(size));
}
async function verifyStoredObject(bucket, key, sha256, size) {
  const head = await bucket.head(key);
  if (!head) return false;
  check(size === undefined || head.size === size, "OBJECT_INTEGRITY_FAILED", "远端对象大小不符。", 409);
  const checksum = head.checksums?.sha256;
  if (checksum) {
    check(Buffer.from(checksum).toString("hex") === sha256, "OBJECT_INTEGRITY_FAILED", "远端对象摘要不符。", 409);
    return true;
  }
  const object = await bucket.get(key);
  check(object, "OBJECT_MISSING", "远端对象在校验期间消失。", 409);
  const digest = createHash("sha256"); let received = 0;
  for await (const chunk of object.body) { received += chunk.byteLength; digest.update(chunk); }
  check(received === head.size && digest.digest("hex") === sha256, "OBJECT_INTEGRITY_FAILED", "远端对象完整性校验失败。", 409);
  return true;
}
export class R2Resources {
  constructor(bucket, { processor, processorToken, sourceGrant, admitPdf } = {}) {
    Object.assign(this, { bucket, processor, processorToken, sourceGrant, admitPdf });
    this.pending = new Map(); this.objectCache = new Map(); this.objectCacheBytes = 0;
  }
  coalesce(key, make) {
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = Promise.resolve().then(make).finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key); });
    this.pending.set(key, pending);
    return pending;
  }
  async initialize() {}
  async has(sha) { return verifyStoredObject(this.bucket, blobKey(sha), sha); }
  async hasObject(ref) { validateObjectReference(ref); return verifyStoredObject(this.bucket, ref.key, ref.sha256, ref.size); }
  async openObject(ref) { validateObjectReference(ref); const value = await this.bucket.get(ref.key); check(value, "OBJECT_MISSING", "内容对象尚未下载或不可用。", 404); return value.body; }
  async readObject(ref) {
    validateObjectReference(ref);
    const key = `${ref.key}:${ref.sha256}:${ref.size}`;
    let bytes = this.objectCache.get(key);
    if (bytes) {
      // An administrator can replace an R2 key outside this process. Validate
      // current checksum metadata (stream/hash fallback for old objects).
      check(await this.hasObject(ref), "OBJECT_MISSING", "内容对象已不可用。", 404);
      this.objectCache.delete(key); this.objectCache.set(key, bytes);
    }
    else bytes = await this.coalesce("object:" + key, async () => {
      const value = await checkedObjectBytes(ref, await this.openObject(ref));
      const maximum = 8 * 1024 * 1024;
      if (value.byteLength <= maximum) {
        while (this.objectCacheBytes + value.byteLength > maximum || this.objectCache.size >= 32) {
          const oldest = this.objectCache.keys().next().value;
          this.objectCacheBytes -= this.objectCache.get(oldest).byteLength; this.objectCache.delete(oldest);
        }
        this.objectCache.set(key, value); this.objectCacheBytes += value.byteLength;
      }
      return value;
    });
    // Never share mutable parsed document objects across requests.
    return parseObjectBytes(bytes);
  }
  async putObject(value) { const { bytes, ref } = objectBytes(value); return this.importObject(ref, bytes); }
  async importObject(ref, input) {
    const bytes = await checkedObjectBytes(ref, input);
    if (await this.hasObject(ref)) return ref;
    await this.bucket.put(ref.key, bytes, { sha256: ref.sha256, httpMetadata: { contentType: "application/json" } });
    check(await this.hasObject(ref), "OBJECT_MISSING", "内容对象写入后不可用。", 409);
    return ref;
  }
  descriptor(file) { return { ...file, storageKey: blobKey(file.sha256) }; }
  async object(sha) { const object = await this.bucket.get(blobKey(sha)); check(object, "RESOURCE_MISSING", "原始资源不可用。", 404); return object; }
  async open(sha) { return (await this.object(sha)).body; }
  async read(sha) { return new Uint8Array(await (await this.object(sha)).arrayBuffer()); }
  async put(input, { filename, mediaType, size } = {}) {
    check(typeof filename === "string" && filename.length > 0 && filename.length <= 240 && !/[\\/\u0000-\u001f]/.test(filename), "VALIDATION_FAILED", "文件名无效。");
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) { const bytes = new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength); size = bytes.byteLength; input = new Response(bytes).body; }
    check(input && Number.isSafeInteger(size) && size > 0 && size <= MAX_SOURCE_BYTES, "UPLOAD_TOO_LARGE", "上传需要有效 Content-Length，文件不得超过 100 MiB。", 413);
    const digest = createHash("sha256"); let received = 0;
    const checked = uploadStream(input).pipeThrough(new TransformStream({
      transform(chunk, controller) { received += chunk.byteLength; check(received <= size, "UPLOAD_SIZE_MISMATCH", "上传字节数超过声明。", 400); digest.update(chunk); controller.enqueue(chunk); },
      flush() { check(received === size, "UPLOAD_SIZE_MISMATCH", "上传字节数与声明不同。", 400); },
    }));
    const temporary = "staging/" + randomUUID();
    const uploadBody = knownLength(checked, size);
    try {
      await this.bucket.put(temporary, uploadBody);
      const sha256 = digest.digest("hex"), key = blobKey(sha256);
      if (!(await this.has(sha256))) {
        const uploaded = await this.bucket.get(temporary);
        await this.bucket.put(key, uploaded.body, { sha256, httpMetadata: { contentType: mediaType || mediaTypeFor(filename) } });
      }
      check(await this.has(sha256), "RESOURCE_MISSING", "原始资源写入后不可用。", 409);
      return { filename, mediaType: mediaType || mediaTypeFor(filename), sha256, size };
    } finally { await uploadBody.cancel().catch(() => {}); await this.bucket.delete(temporary); }
  }
  async pdf(action, file, options = {}) {
    check(this.sourceGrant, "PDF_RUNTIME_UNAVAILABLE", "PDF 处理服务尚未配置。", 503);
    const url = await this.sourceGrant(file.sha256);
    this.admitPdf?.();
    return fetchPdfProcessor(this.processor, { action, source: { url, sha256: file.sha256, size: file.size }, ...options }, { token: this.processorToken });
  }
  async cachedJson(key, make) {
    return structuredClone(await this.coalesce(key, async () => {
      const cached = await this.bucket.get(key);
      if (cached) return cached.json();
      const value = await make();
      await this.bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
      return value;
    }));
  }
  manifest(file) { return this.cachedJson(`derived/${file.sha256}/manifest-v1.json`, () => this.pdf("manifest", file)); }
  async page(file, page, width = 1200) {
    check(Number.isInteger(page) && page >= 1 && Number.isInteger(width) && width >= 300 && width <= 1800, "VALIDATION_FAILED", "原页参数无效。");
    const manifest = await this.manifest(file);
    check(page <= manifest.pages.length, "NOT_FOUND", "原页不存在。", 404);
    const storageKey = `derived/${file.sha256}/page-${page}-${width}.png`;
    return this.coalesce(storageKey, async () => {
      let object = await this.bucket.head(storageKey);
      if (!object) {
        const response = await this.pdf("render", file, { page, width });
        try { object = await this.bucket.put(storageKey, response.body, { httpMetadata: { contentType: "image/png" } }); }
        catch (error) { await response.body?.cancel(error).catch(() => {}); throw error; }
      }
      return { storageKey, size: object.size };
    });
  }
  regions(file, document) {
    const blocks = document.blocks.map(({ id, type, text, origin, source, head, rows, html, role, num, items }) => ({ id, type, text, origin, source, head, rows, html, role, num,
      ...(type === "list" ? { items: items?.map(({ id, text, source }) => ({ id, text, source })) } : {}) }));
    const key = `derived/${file.sha256}/regions-${PDF_REGION_ALGORITHM_VERSION}-${hash(JSON.stringify(blocks))}.json`;
    return this.cachedJson(key, async () => (await this.pdf("regions", file, { blocks })).regions);
  }
}
