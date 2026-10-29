import { createHash } from "node:crypto";
import { createRequestDeadline } from "./request-deadline.mjs";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_OBJECT_BYTES = 100 * 1024 * 1024;
const PART_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const syncId = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
function historyHeaders(historyId) {
  if (historyId === undefined) return {};
  if (!syncId(historyId)) throw new SyncTransportError("SYNC_INVALID_REQUEST", "同步历史标识无效。");
  return { "X-Reader-Sync-History": historyId };
}

export class SyncTransportError extends Error {
  constructor(code, message, { status = 0, retryAfterMs = 0 } = {}) {
    super(message); this.name = "SyncTransportError";
    Object.assign(this, { code, status, retryAfterMs });
  }
}

function invalid(message = "同步服务配置无效。") {
  throw new SyncTransportError("SYNC_INVALID_CONFIGURATION", message);
}

export function syncConnection({ origin, token } = {}) {
  if (typeof origin !== "string" || typeof token !== "string" || !/^[\x21-\x7e]{16,4096}$/.test(token)) invalid();
  let url; try { url = new URL(origin); } catch { invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) invalid();
  return { origin: url.origin, token };
}

function objectDescriptor(value) {
  if (!value || !SHA256.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_OBJECT_BYTES) {
    throw new SyncTransportError("SYNC_INVALID_OBJECT", "同步对象的摘要或大小无效。");
  }
  if (value.key !== undefined && value.key !== `blobs/${value.sha256}` && value.key !== `objects/sha256/${value.sha256}`) throw new SyncTransportError("SYNC_INVALID_OBJECT", "同步对象路径无效。");
  if (value.version !== undefined && value.version !== 1) throw new SyncTransportError("SYNC_INVALID_OBJECT", "同步对象格式版本无效。");
  return value;
}
const objectPath = (value, suffix = "") => `/api/sync/objects/${value.sha256}${suffix}?kind=${value.key?.startsWith("objects/") ? "object" : "blob"}&size=${value.size}`;

function retryDelay(value) {
  if (!value) return 0;
  const number = Number(value);
  const delay = Number.isFinite(number) ? number * 1000 : Date.parse(value) - Date.now();
  // Monthly admission can legitimately remain unavailable until the next UTC
  // period. Do not turn that explicit retry horizon into a five-minute loop.
  return Number.isFinite(delay) ? Math.max(0, Math.min(31 * 86400000, delay)) : 0;
}

async function readBounded(response, maximum) {
  const declared = response.headers.get("content-length");
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => {});
    throw new SyncTransportError("SYNC_RESPONSE_TOO_LARGE", "同步响应超过大小限制。");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => {});
        throw new SyncTransportError("SYNC_RESPONSE_TOO_LARGE", "同步响应超过大小限制。");
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

/** A single authenticated attempt. Durable queues own retries and acknowledgements. */
export function createSyncTransport({ origin, token, fetchImpl = fetch, timeoutMs = 60000, maxReceiptBytes = 128 * 1024 * 1024 } = {}) {
  const connection = syncConnection({ origin, token });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) invalid();
  if (!Number.isSafeInteger(maxReceiptBytes) || maxReceiptBytes < MAX_JSON_BYTES) invalid();

  async function request(path, { method = "GET", body, signal, maximum = MAX_JSON_BYTES, binary = false, headers = {} } = {}) {
    const deadline = createRequestDeadline(timeoutMs, signal);
    try {
      const response = await fetchImpl(connection.origin + path, {
        method, redirect: "error", credentials: "omit", signal: deadline.signal,
        headers: { Authorization: `Bearer ${connection.token}`, "X-Reader-Sync-Features": "atomic-groups-v1,history-archive-v1,state-snapshot-v1", Accept: binary ? "application/octet-stream" : "application/json", ...(body === undefined ? {} : { "Content-Type": binary ? "application/octet-stream" : "application/json", "Content-Length": String(Buffer.byteLength(body)) }), ...headers },
        ...(body === undefined ? {} : { body }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const code = response.status === 409 && response.headers.get("X-Reader-Sync-Error") === "SYNC_HISTORY_CHANGED" ? "SYNC_HISTORY_CHANGED" : response.status === 401 || response.status === 403 ? "SYNC_UNAUTHORIZED" : response.status === 404 ? "SYNC_NOT_FOUND" : response.status === 409 ? "SYNC_CONFLICT" : response.status === 426 ? "SYNC_UPGRADE_REQUIRED" : response.status === 429 ? "SYNC_RATE_LIMITED" : "SYNC_REMOTE_ERROR";
        throw new SyncTransportError(code, code === "SYNC_HISTORY_CHANGED" ? "远端同步历史已改变；本地资料和待同步内容已保留。" : code === "SYNC_UNAUTHORIZED" ? "同步凭据无效或没有工作台权限。" : code === "SYNC_UPGRADE_REQUIRED" ? "请升级同步客户端和服务；本地内容及待同步队列已保留。" : "同步服务暂时无法完成此请求。", { status: response.status, retryAfterMs: retryDelay(response.headers.get("retry-after")) });
      }
      if (response.status === 204 || method === "HEAD") return undefined;
      const bytes = await readBounded(response, maximum);
      if (binary) return bytes;
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) throw new SyncTransportError("SYNC_INVALID_RESPONSE", "同步服务没有返回有效 JSON。");
      let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new SyncTransportError("SYNC_INVALID_RESPONSE", "同步服务没有返回有效 JSON。"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyncTransportError("SYNC_INVALID_RESPONSE", "同步响应格式无效。");
      return value;
    } catch (error) {
      if (error instanceof SyncTransportError) throw error;
      if (signal?.aborted) throw new SyncTransportError("SYNC_CANCELLED", "同步已停止。");
      if (deadline.timedOut) throw new SyncTransportError("SYNC_TIMEOUT", "同步请求超时，待同步内容已保留。");
      // Fetch errors can include URLs, credentials, proxy details or upstream text.
      throw new SyncTransportError("SYNC_OFFLINE", "暂时无法连接同步服务，待同步内容已保留。");
    } finally { deadline.dispose(); }
  }

  return {
    origin: connection.origin,
    manifest({ signal } = {}) { return request("/api/sync/manifest", { signal }); },
    enroll({ replicaId, requestId }, { signal, historyId } = {}) {
      return request("/api/sync/enroll", { method: "POST", body: JSON.stringify({ replicaId, requestId }), signal, headers: historyHeaders(historyId) });
    },
    pull({ after = 0, limit = 100, signal, historyId } = {}) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SyncTransportError("SYNC_INVALID_REQUEST", "同步游标或批次大小无效。");
      return request(`/api/sync/pull?after=${after}&limit=${limit}`, { signal, headers: historyHeaders(historyId) });
    },
    acknowledgeApplied({ replicaId, historyId, cursor }, { signal } = {}) {
      if (!syncId(replicaId) || !syncId(historyId) || !Number.isSafeInteger(cursor) || cursor < 0) throw new SyncTransportError("SYNC_INVALID_REQUEST", "同步应用确认无效。");
      return request("/api/sync/ack", { method: "POST", body: JSON.stringify({ replicaId, historyId, cursor }), signal, headers: historyHeaders(historyId) });
    },
    snapshotDescriptor(reference, { signal, historyId } = {}) {
      if (!syncId(reference?.snapshotId) || !SHA256.test(reference.sha256) || !Number.isSafeInteger(reference.size) || reference.size < 1 || reference.size > MAX_JSON_BYTES) throw new SyncTransportError("SYNC_INVALID_REQUEST", "同步快照引用无效。");
      return request(`/api/sync/snapshots/${encodeURIComponent(reference.snapshotId)}`, { signal, binary: true, maximum: reference.size, headers: historyHeaders(historyId) });
    },
    snapshotChunk(snapshotId, reference, { signal, historyId } = {}) {
      if (!syncId(snapshotId) || !Number.isSafeInteger(reference?.index) || reference.index < 0 || !SHA256.test(reference.sha256) || !Number.isSafeInteger(reference.size) || reference.size < 1 || reference.size > MAX_JSON_BYTES) throw new SyncTransportError("SYNC_INVALID_REQUEST", "同步快照分块引用无效。");
      return request(`/api/sync/snapshots/${encodeURIComponent(snapshotId)}/chunks/${reference.index}`, { signal, binary: true, maximum: reference.size, headers: historyHeaders(historyId) });
    },
    async hasObject(descriptor, { signal } = {}) {
      objectDescriptor(descriptor);
      try { await request(objectPath(descriptor), { method: "HEAD", signal, binary: true }); return true; }
      catch (error) { if (error.code === "SYNC_NOT_FOUND") return false; throw error; }
    },
    push(batch, { signal, historyId } = {}) {
      let body; try { body = JSON.stringify(batch); } catch { throw new SyncTransportError("SYNC_INVALID_REQUEST", "同步操作不能序列化。"); }
      if (!body || Buffer.byteLength(body) > MAX_JSON_BYTES) throw new SyncTransportError("SYNC_REQUEST_TOO_LARGE", "单批同步操作超过大小限制。");
      return request("/api/sync/push", { method: "POST", body, signal, headers: historyHeaders(historyId) }).then(async (receipt) => {
        const ref = receipt.receiptTransfer;
        if (!ref) return receipt;
        const invalidReceipt = () => { throw new SyncTransportError("SYNC_INVALID_RESPONSE", "同步回执分块或摘要无效，待同步内容已保留。"); };
        if (ref.replicaId !== batch.replicaId || ref.requestId !== batch.requestId || !SHA256.test(ref.sha256) || !Number.isSafeInteger(ref.length) || ref.length < 1 || !Number.isSafeInteger(ref.parts) || ref.parts < 1 || ref.parts > ref.length) invalidReceipt();
        if (ref.length > maxReceiptBytes) throw new SyncTransportError("SYNC_RESPONSE_TOO_LARGE", "完整同步回执超过内存预算；内容已保留，可提高 maxReceiptBytes 后重试。");
        const chunks = []; let after = 0, bytes = 0, characters = 0;
        while (after < ref.parts) {
          const page = await request(`/api/sync/receipts?replicaId=${encodeURIComponent(ref.replicaId)}&requestId=${encodeURIComponent(ref.requestId)}&after=${after}`, { signal, headers: historyHeaders(historyId) });
          if (page.replicaId !== ref.replicaId || page.requestId !== ref.requestId || page.sha256 !== ref.sha256 || page.length !== ref.length || page.parts !== ref.parts || page.after !== after || !Array.isArray(page.chunks) || !page.chunks.length || page.chunks.length > 64 || page.nextPart !== after + page.chunks.length || page.nextPart > ref.parts || page.chunks.some((chunk) => typeof chunk !== "string" || chunk.length > 16000)) invalidReceipt();
          for (const chunk of page.chunks) { bytes += Buffer.byteLength(chunk); characters += chunk.length; chunks.push(chunk); }
          if (bytes > maxReceiptBytes || characters > ref.length) throw new SyncTransportError("SYNC_RESPONSE_TOO_LARGE", "完整同步回执超过内存预算，待同步内容已保留。");
          after = page.nextPart;
        }
        const serialized = chunks.join("");
        if (characters !== ref.length || createHash("sha256").update(serialized).digest("hex") !== ref.sha256) invalidReceipt();
        let complete; try { complete = JSON.parse(serialized); } catch { invalidReceipt(); }
        if (!complete || complete.replicaId !== ref.replicaId || complete.requestId !== ref.requestId || typeof complete.accepted !== "boolean") invalidReceipt();
        return complete;
      });
    },
    async uploadObject(descriptor, input, { signal } = {}) {
      const { sha256, size } = objectDescriptor(descriptor);
      if (!(input instanceof Uint8Array) || input.byteLength !== size || createHash("sha256").update(input).digest("hex") !== sha256) throw new SyncTransportError("SYNC_OBJECT_MISMATCH", "本地同步对象与摘要不一致。");
      if (input.byteLength <= PART_BYTES) await request(objectPath(descriptor), { method: "PUT", body: input, signal, binary: true });
      else {
        const parts = [];
        for (let offset = 0; offset < input.byteLength; offset += PART_BYTES) {
          const part = input.subarray(offset, Math.min(offset + PART_BYTES, input.byteLength));
          const partHash = createHash("sha256").update(part).digest("hex"); parts.push(partHash);
          await request(objectPath(descriptor, `/parts/${parts.length}`), { method: "PUT", body: part, signal, binary: true, headers: { "X-Content-Sha256": partHash } });
        }
        await request(objectPath(descriptor, "/complete"), { method: "POST", body: JSON.stringify({ parts }), signal });
      }
      return { ...descriptor, sha256, size };
    },
    async downloadObject(descriptor, { signal } = {}) {
      const { sha256, size } = objectDescriptor(descriptor);
      const bytes = await request(objectPath(descriptor), { signal, binary: true, maximum: size });
      if (!bytes || bytes.byteLength !== size || createHash("sha256").update(bytes).digest("hex") !== sha256) throw new SyncTransportError("SYNC_OBJECT_MISMATCH", "远端同步对象与摘要不一致。");
      return bytes;
    },
  };
}
