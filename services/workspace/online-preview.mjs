import { canonical, check, hash, WorkspaceError } from "./errors.mjs";
import { verifyPreviewSnapshot, previewDescriptor } from "./authoring-preview.mjs";
import { createSyncTransport, syncConnection, SyncTransportError } from "./sync-http-client.mjs";
import { createRequestDeadline } from "./request-deadline.mjs";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const objectRef = (bytes) => {
  const sha256 = hash(bytes);
  return { key: `objects/sha256/${sha256}`, sha256, size: bytes.length, version: 1, kind: "object" };
};

export function onlinePreviewOptions(environment = {}) {
  const origin = environment.CONTINUOUS_READER_PREVIEW_URL || environment.CONTINUOUS_READER_SYNC_URL;
  const token = environment.CONTINUOUS_READER_PREVIEW_TOKEN || environment.CONTINUOUS_READER_SYNC_TOKEN;
  return origin || token ? syncConnection({ origin, token }) : null;
}

/** Upload the existing Reader file. The cloud never compiles an authoring input. */
export function createOnlinePreviewClient({ origin, token, resources, fetchImpl = fetch, transport, timeoutMs = 60000 } = {}) {
  const connection = syncConnection({ origin, token });
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000, "SYNC_INVALID_CONFIGURATION", "在线预览超时配置无效。");
  transport ??= createSyncTransport({ ...connection, fetchImpl, timeoutMs });
  const active = new Map();
  async function upload(reference, bytes, signal) {
    if (!await transport.hasObject(reference, { signal })) await transport.uploadObject(reference, bytes, { signal });
    return reference;
  }
  async function uploadJson(value, signal) {
    // Canonical bytes agree with the exact hashes already in the reviewed manifest.
    const bytes = Buffer.from(canonical(value));
    return upload(objectRef(bytes), bytes, signal);
  }
  async function publish(snapshot, { draft, signal } = {}) {
    verifyPreviewSnapshot(snapshot);
    const key = snapshot.hash + ":" + (draft?.version || 0);
    if (active.has(key)) return active.get(key);
    const work = (async () => {
      const uploaded = new Set();
      for (const file of [...Object.values(snapshot.resourceMap), snapshot.authoringFile]) {
        const key = `blobs/${file.sha256}`;
        if (uploaded.has(key)) continue;
        uploaded.add(key);
        const reference = { key, sha256: file.sha256, size: file.size, version: 1, kind: "blob" };
        if (!await transport.hasObject(reference, { signal })) await transport.uploadObject(reference, await resources.read(file.sha256), { signal });
      }
      const document = await uploadJson(snapshot.validated.document, signal);
      check(document.sha256 === snapshot.manifest.documentHash, "PREVIEW_HASH_MISMATCH", "在线预览文件与审核版本不一致。", 409);
      const resourceMap = await uploadJson(snapshot.resourceMap, signal);
      const artifacts = { document, authoring: { key: `blobs/${snapshot.authoringFile.sha256}`, sha256: snapshot.authoringFile.sha256, size: snapshot.authoringFile.size, version: 1, kind: "blob" } };
      for (const [kind, value] of Object.entries({ identity: snapshot.compiled.identity, index: snapshot.validated.index,
        report: { compiler: snapshot.compiled.report, validation: snapshot.validation, ...(snapshot.revisionTarget ? { revisionTarget: snapshot.revisionTarget } : {}) }, manifest: snapshot.manifest })) artifacts[kind] = await uploadJson(value, signal);
      const descriptor = { version: 1, preview: previewDescriptor(snapshot), manifest: snapshot.manifest, document, resourceMap, artifacts,
        ...(draft ? { draft: { id: draft.id, version: draft.version, currentPreviewId: draft.currentPreviewId, lastError: draft.lastError || null, updatedAt: draft.updatedAt } } : {}) };
      const body = JSON.stringify(descriptor);
      check(Buffer.byteLength(body) <= MAX_RESPONSE_BYTES, "PREVIEW_DESCRIPTOR_TOO_LARGE", "在线预览索引超过传输限制。", 413);
      const deadline = createRequestDeadline(timeoutMs, signal);
      try {
        const response = await fetchImpl(connection.origin + "/api/previews", { method: "POST", redirect: "error", credentials: "omit", signal: deadline.signal,
          headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", Accept: "application/json" }, body });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new SyncTransportError(response.status === 401 || response.status === 403 ? "SYNC_UNAUTHORIZED" : "ONLINE_PREVIEW_FAILED", "在线预览尚未登记，本地候选已保留。", { status: response.status });
        }
        let size = 0; const chunks = [];
        for await (const chunk of response.body || []) { size += chunk.byteLength; check(size <= MAX_RESPONSE_BYTES, "PREVIEW_RESPONSE_TOO_LARGE", "在线预览响应超过限制。", 502); chunks.push(Buffer.from(chunk)); }
        let result; try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { check(false, "PREVIEW_INVALID_RESPONSE", "在线预览响应无效。", 502); }
        check(result?.previewId === snapshot.id && result?.hash === snapshot.hash && typeof result.snapshotUrl === "string" && result.snapshotUrl.length > 0, "PREVIEW_HASH_MISMATCH", "在线预览回执与候选版本不一致。", 409);
        const delivery = { status: "ready", previewId: snapshot.id, hash: snapshot.hash };
        for (const name of ["snapshotUrl", "previewUrl", "documentUrl", "checkUrl"]) if (result[name]) {
          check(typeof result[name] === "string" && result[name].length <= 4096, "PREVIEW_INVALID_RESPONSE", "在线预览地址无效。", 502);
          let url; try { url = new URL(result[name]); } catch { check(false, "PREVIEW_INVALID_RESPONSE", "在线预览地址无效。", 502); }
          check(url.origin === connection.origin && !url.username && !url.password, "PREVIEW_INVALID_RESPONSE", "在线预览地址不属于配置的服务。", 502);
          check(name === "snapshotUrl" ? url.pathname === "/" && url.searchParams.get("preview") === snapshot.id
            : name === "previewUrl" ? url.pathname === "/" && url.searchParams.get("draft") === snapshot.draftId
            : name === "documentUrl" ? url.pathname === `/api/authoring/previews/${snapshot.id}`
            : url.pathname === `/api/previews/${snapshot.id}/check`, "PREVIEW_INVALID_RESPONSE", "在线预览地址与候选版本不一致。", 502);
          delivery[name] = url.href;
        }
        if (typeof result.accessExpiresAt === "string" && result.accessExpiresAt.length <= 40 && Number.isFinite(Date.parse(result.accessExpiresAt))) delivery.accessExpiresAt = result.accessExpiresAt;
        return delivery;
      } catch (error) {
        if (error instanceof SyncTransportError || error instanceof WorkspaceError) throw error;
        throw new SyncTransportError(signal?.aborted ? "SYNC_CANCELLED" : deadline.timedOut ? "SYNC_TIMEOUT" : "SYNC_OFFLINE", "在线预览尚未上传完成，本地候选已保留。");
      } finally { deadline.dispose(); }
    })();
    active.set(key, work);
    try { return await work; } finally { active.delete(key); }
  }
  return { origin: connection.origin, publish,
    async publishFromWorkspace(workspace, actor, previewId) {
      workspace.authorize(actor);
      const snapshot = await workspace.previewSnapshot(previewId);
      const draft = await workspace.draft(snapshot.draftId);
      try { return await publish(snapshot, { draft: draft.currentPreviewId === snapshot.id ? draft : undefined }); }
      catch (error) { return { status: "pending", previewId: snapshot.id, hash: snapshot.hash,
        error: { code: /^[A-Z_]{1,64}$/.test(error.code || "") ? error.code : "ONLINE_PREVIEW_FAILED", message: "在线预览尚未完成，本地候选已保留；再次检查预览可重试。" } }; }
    },
  };
}
