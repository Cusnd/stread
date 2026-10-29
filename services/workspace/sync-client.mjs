import { randomUUID } from "node:crypto";
import { createSyncTransport, SyncTransportError, syncConnection } from "./sync-http-client.mjs";
import { collectSyncObjects } from "./sync-schema.mjs";
import { applySchemaMigrations } from "./schema-migrations.mjs";

const json = JSON.stringify;
const MAX_OBJECT_BYTES = 100 * 1024 * 1024;

export function syncOptions(environment = {}) {
  const origin = environment.CONTINUOUS_READER_SYNC_URL, token = environment.CONTINUOUS_READER_SYNC_TOKEN;
  if (!origin && !token) return null;
  return syncConnection({ origin, token });
}

async function objectBytes(resources, reference) {
  if (!reference.key?.startsWith("objects/sha256/")) return resources.read(reference.sha256);
  const stream = await resources.openObject(reference), chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_OBJECT_BYTES) throw new SyncTransportError("SYNC_INVALID_OBJECT", "本地同步对象超过大小限制。");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function references(batch) {
  if (!Array.isArray(batch.objects)) throw new SyncTransportError("SYNC_INVALID_RESPONSE", "同步批次缺少对象清单。");
  return [...new Map(batch.objects.map((reference) => [reference.key, reference])).values()];
}

function safeError(error) {
  const code = typeof error?.code === "string" && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : "SYNC_FAILED";
  return { code, ...(Number.isInteger(error?.status) ? { status: error.status } : {}), message: error instanceof SyncTransportError ? error.message : "同步未完成，待同步内容和冲突已保留。" };
}

/** The workspace stays writable while this optional, restartable worker is offline. */
export async function createWorkspaceSyncClient(workspace, {
  origin, token, engine, transport, intervalMs = 60000, batchingWindowMs = 60000, maxBatches = 100,
  now = () => Date.now(), random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout, keepAlive = false,
} = {}) {
  const connection = syncConnection({ origin, token });
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || !Number.isSafeInteger(batchingWindowMs) || batchingWindowMs < 100 || batchingWindowMs > 300000 || !Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000) throw new SyncTransportError("SYNC_INVALID_CONFIGURATION", "同步间隔或批次上限无效。");
  // Tests and lightweight injected transports may supply a raw DatabaseSync.
  // Production adapters always own an explicit synchronous transaction method.
  const migrationDb = workspace.db.transaction ? workspace.db : { prepare: workspace.db.prepare.bind(workspace.db), exec: workspace.db.exec.bind(workspace.db), transaction(operation) {
    workspace.db.exec("BEGIN IMMEDIATE"); try { const value = operation(); workspace.db.exec("COMMIT"); return value; } catch (error) { workspace.db.exec("ROLLBACK"); throw error; }
  } };
  applySchemaMigrations(migrationDb, "replication-client", [{ version: 1, name: "persistent-connection-and-retry-state", sql: "CREATE TABLE IF NOT EXISTS sync_client_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);" }]);
  const get = (key) => { const row = workspace.db.prepare("SELECT value FROM sync_client_state WHERE key=?").get(key); return row ? JSON.parse(row.value) : undefined; };
  const set = (key, value) => {
    const write = () => workspace.db.prepare("INSERT INTO sync_client_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value IS NOT excluded.value").run(key, json(value));
    // Some synchronous adapters wrap each run() in a transaction. Connection
    // bookkeeping is replication work: it must not look like a new user commit
    // and postpone capture forever while a genuinely empty replica enrolls.
    return typeof engine?.transact === "function" ? engine.transact(write) : write();
  };
  const previousOrigin = get("origin");
  if (previousOrigin && previousOrigin !== connection.origin) throw new SyncTransportError("SYNC_WORKSPACE_MISMATCH", "此本地资料库已绑定其他同步服务，请使用独立资料库连接新服务。");
  set("origin", connection.origin);
  engine ??= await (await import("./sync-engine.mjs")).createWorkspaceSync(workspace, { mode: "client" });
  transport ??= createSyncTransport(connection);
  let running = false, stopped = false, timer, active, controller, failures = 0, pullPending = false, snapshotPending = false;
  let commitGeneration = 0, localFlushAt, receiveAt, sendDrainPending = false, urgentPending = false;
  let blocked = get("blockedReason") || null, retryNotBefore = get("retryNotBefore") || 0;
  let lastAttemptAt = get("lastAttemptAt") || null, lastSuccessAt = get("lastSuccessAt") || null, nextAttemptAt = null;

  const status = () => ({ ...engine.status(), configured: true, origin: connection.origin, running: Boolean(active), lastAttemptAt, lastSuccessAt, lastError: get("lastError") || null, nextAttemptAt, blockedReason: blocked });

  async function upload(batch, signal) {
    for (const reference of references(batch)) {
      if (!await transport.hasObject(reference, { signal })) await transport.uploadObject(reference, await objectBytes(workspace.resources, reference), { signal });
    }
  }

  async function download(batch, signal) {
    for (const reference of references(batch)) {
      const object = reference.key?.startsWith("objects/sha256/");
      if (await (object ? workspace.resources.hasObject(reference) : workspace.resources.has(reference.sha256))) continue;
      const bytes = await transport.downloadObject(reference, { signal });
      if (object) await workspace.resources.importObject(reference, bytes);
      else {
        const saved = await workspace.resources.put(bytes, { filename: reference.sha256, mediaType: "application/octet-stream" });
        if (saved.sha256 !== reference.sha256 || saved.size !== reference.size) throw new SyncTransportError("SYNC_OBJECT_MISMATCH", "下载内容与同步对象摘要不一致。");
      }
    }
  }

  async function cycle(signal, generation, send) {
    lastAttemptAt = new Date(now()).toISOString(); nextAttemptAt = null;
    snapshotPending = false;
    // Untouched bootstrap metadata is not an in-flight user command. Avoid
    // freezing it before a genuinely new device can accept a complete baseline.
    if (send && !engine.canInstallSnapshot?.()) await engine.capture();
    const manifest = await transport.manifest({ signal });
    if (manifest.protocolVersion !== 1 || typeof manifest.workspaceId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(manifest.workspaceId) || !Number.isSafeInteger(manifest.head) || manifest.head < 0) throw new SyncTransportError("SYNC_INVALID_RESPONSE", "同步服务的工作台身份或协议版本无效。");
    const remoteIdentity = get("workspaceId");
    if (remoteIdentity && manifest.workspaceId !== remoteIdentity) throw new SyncTransportError("SYNC_WORKSPACE_MISMATCH", "远端工作台身份已改变；本地资料保持原样，未继续上传。");
    set("workspaceId", manifest.workspaceId);
    const previousHistory = get("historyId") || engine.status().historyId, historyId = manifest.historyId;
    if (historyId !== undefined && (typeof historyId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(historyId))) throw new SyncTransportError("SYNC_INVALID_RESPONSE", "同步历史标识无效。");
    if (previousHistory && historyId !== previousHistory) throw new SyncTransportError("SYNC_HISTORY_CHANGED", "远端同步历史已改变；本地资料和待同步内容已保留。");
    if (Array.isArray(manifest.features) && manifest.features.includes("history-archive-v1") && !historyId) throw new SyncTransportError("SYNC_INVALID_RESPONSE", "同步服务缺少历史标识。");
    if (historyId) { engine.bindHistory?.(historyId); set("historyId", historyId); }
    const current = engine.status();
    if (current.cursor > manifest.head) throw new SyncTransportError("SYNC_CURSOR_AHEAD", "本机同步游标超出远端历史；请检查远端恢复情况，资料已保留。");
    if (!current.enrolled) {
      const requestId = get("enrollmentRequestId") || randomUUID(); set("enrollmentRequestId", requestId);
      const enrollment = await transport.enroll({ replicaId: current.replicaId, requestId }, { signal, historyId });
      await engine.acceptEnrollment(enrollment);
    }
    let restored = false;
    if (manifest.snapshot && Array.isArray(manifest.features) && manifest.features.includes("state-snapshot-v1") && engine.canInstallSnapshot?.()) {
      const result = await engine.restoreSnapshot({ reference: manifest.snapshot, historyId, head: manifest.head, transport, download, signal, maxChunks: maxBatches });
      snapshotPending = Boolean(result.pending); restored = Boolean(result.installed);
      if (snapshotPending) return status();
    }
    let sent = 0, remoteHead = manifest.head;
    while (send && sent < maxBatches) {
      if (signal.aborted) throw new SyncTransportError("SYNC_CANCELLED", "同步已停止。");
      // A slow request must not turn every new local write into another upload
      // in the same cycle. An already frozen batch keeps its request identity;
      // later dirty state waits for its own bounded batching window.
      if (commitGeneration === generation) await engine.capture();
      else if (sent) break;
      const { batches } = await engine.pending({ limit: 1 });
      if (!batches?.length) break;
      const batch = batches[0];
      if (batch.atomicGroups?.length > 1 && !(Array.isArray(manifest.features) && manifest.features.includes("atomic-groups-v1"))) throw new SyncTransportError("SYNC_UPGRADE_REQUIRED", "同步服务需要升级后才能接收合批事务；本地内容已保留。");
      await upload(batch, signal);
      const receipt = await transport.push(batch, { signal, historyId });
      if (receipt.replicaId !== batch.replicaId || receipt.requestId !== batch.requestId || typeof receipt.accepted !== "boolean") throw new SyncTransportError("SYNC_INVALID_RESPONSE", "同步确认与待同步操作不匹配。");
      await download({ objects: receipt.objects || collectSyncObjects(receipt.states) }, signal);
      await engine.acknowledge(receipt); sent += 1;
      if (Number.isSafeInteger(receipt.sequence)) remoteHead = Math.max(remoteHead, receipt.sequence);
    }
    if (send && commitGeneration === generation) await engine.capture();
    let received = 0, changed = restored;
    // A stable journal head is sufficient to avoid an empty pull. Pushing does
    // not advance the receiving cursor: our acknowledged journal entries still
    // pass through the same ordered pull path as every other device's writes.
    while (received < maxBatches && engine.status().cursor < remoteHead) {
      if (signal.aborted) throw new SyncTransportError("SYNC_CANCELLED", "同步已停止。");
      const after = engine.status().cursor;
      const batch = await transport.pull({ after, limit: 100, signal, historyId });
      if (!Number.isSafeInteger(batch.nextCursor) || batch.nextCursor < after || typeof batch.hasMore !== "boolean" || !Array.isArray(batch.transactions) || (batch.hasMore && batch.nextCursor === after)) throw new SyncTransportError("SYNC_INVALID_RESPONSE", "同步变更游标无效。");
      await download(batch, signal); await engine.applyPull(batch); received += 1;
      changed ||= batch.transactions.length > 0;
      if (!batch.hasMore) break;
      remoteHead = Math.max(remoteHead, batch.nextCursor + 1);
    }
    const settled = engine.status();
    pullPending = settled.cursor < remoteHead;
    if (historyId && Array.isArray(manifest.features) && manifest.features.includes("history-archive-v1") && settled.cursor > (get("appliedAckCursor") || 0)) {
      if (typeof transport.acknowledgeApplied !== "function") throw new SyncTransportError("SYNC_UPGRADE_REQUIRED", "同步客户端需要升级后才能确认归档历史；本地内容已保留。");
      const confirmation = await transport.acknowledgeApplied({ replicaId: settled.replicaId, historyId, cursor: settled.cursor }, { signal });
      if (confirmation?.replicaId !== settled.replicaId || confirmation?.historyId !== historyId || !Number.isSafeInteger(confirmation?.cursor) || confirmation.cursor < settled.cursor) throw new SyncTransportError("SYNC_INVALID_RESPONSE", "同步应用确认与本机历史或游标不匹配。");
      set("appliedAckCursor", settled.cursor);
    }
    if (!pullPending && !(settled.pending || settled.pendingCount || settled.dirty || settled.conflicts || settled.conflictCount)) {
      const previousSuccess = lastSuccessAt; lastSuccessAt = new Date(now()).toISOString();
      // Operational probes stay in memory; durable progress is written only at
      // a real transfer/recovery boundary, not on every idle timer tick.
      if (!previousSuccess || sent || changed || failures) { set("lastSuccessAt", lastSuccessAt); set("lastAttemptAt", lastAttemptAt); }
    }
    set("lastError", null); set("blockedReason", null); set("retryNotBefore", 0);
    blocked = null; retryNotBefore = 0; failures = 0;
    return status();
  }

  function perform(automatic) {
    if (active) { if (!automatic) urgentPending = true; return active; }
    if (stopped) return Promise.reject(new SyncTransportError("SYNC_CANCELLED", "同步已停止。"));
    if (timer !== undefined) clearTimer(timer); timer = undefined; nextAttemptAt = null;
    if (!automatic) { blocked = null; retryNotBefore = 0; set("blockedReason", null); set("retryNotBefore", 0); }
    const generation = commitGeneration, urgent = !automatic || urgentPending || failures > 0;
    const send = urgent || sendDrainPending || (localFlushAt !== undefined && localFlushAt <= now());
    const receiving = urgent || pullPending || snapshotPending || receiveAt === undefined || receiveAt <= now();
    // Receiving may discover a changed remote head, but cannot freeze or send
    // local work before that work's independent fixed deadline.
    if (send) localFlushAt = undefined;
    sendDrainPending = false; urgentPending = false;
    controller = new AbortController();
    active = cycle(controller.signal, generation, send).then(value => {
      // A send can opportunistically receive its own journal without moving
      // the independent periodic receive deadline further into the future.
      if (receiving) receiveAt = now() + intervalMs;
      return value;
    }).catch((error) => {
      if (error.code !== "SYNC_CANCELLED") {
        failures += 1; set("lastError", safeError(error)); set("lastAttemptAt", lastAttemptAt);
        if (["SYNC_UNAUTHORIZED", "SYNC_WORKSPACE_MISMATCH", "SYNC_CURSOR_AHEAD", "SYNC_INVALID_CONFIGURATION", "SYNC_UPGRADE_REQUIRED", "SYNC_HISTORY_CHANGED", "SYNC_SNAPSHOT_INVALID"].includes(error.code)) { blocked = error.code; set("blockedReason", blocked); }
        retryNotBefore = Math.max(retryNotBefore, now() + (Number(error.retryAfterMs) || 0)); set("retryNotBefore", retryNotBefore);
      }
      throw error;
    }).finally(() => {
      active = undefined; controller = undefined;
      const state = engine.status();
      const backlog = !(state.conflicts || state.conflictCount) && (state.pendingBatches || state.pendingCount || state.pending || state.dirty);
      if (!backlog) localFlushAt = undefined;
      sendDrainPending = Boolean(send && backlog && localFlushAt === undefined);
      scheduleNext();
    });
    return active;
  }
  const runOnce = ({ resume = false } = {}) => {
    if (!resume) return perform(false);
    if (stopped) return perform(true);
    // A restored connection is an automatic retry, so it cannot override an
    // identity/authentication pause or a server-provided retry horizon.
    if (blocked) return Promise.resolve(status());
    urgentPending = true;
    if (retryNotBefore > now()) {
      if (!active) schedule(retryNotBefore - now());
      return Promise.resolve(status());
    }
    return perform(true);
  };

  function scheduleNext() {
    const retryDelay = Math.round(Math.min(300000, intervalMs * 2 ** Math.min(Math.max(0, failures - 1), 8)) * (0.9 + random() * 0.2));
    const due = urgentPending || sendDrainPending || pullPending || snapshotPending ? now() : Math.min(receiveAt ?? now(), localFlushAt ?? Infinity);
    schedule(Math.max(failures ? retryDelay : due - now(), retryNotBefore - now()));
  }

  function schedule(delay) {
    if (!running || stopped || blocked) return;
    if (timer !== undefined) clearTimer(timer);
    delay = Math.max(0, Math.min(delay, 2147483647));
    nextAttemptAt = new Date(now() + delay).toISOString();
    timer = setTimer(async () => {
      timer = undefined;
      if (retryNotBefore > now()) { schedule(retryNotBefore - now()); return; }
      try { await perform(true); } catch { /* Status and durable work retain the failure. */ }
    }, delay);
    if (!keepAlive) timer?.unref?.();
  }
  const unsubscribe = engine.onLocalCommit?.(() => {
    commitGeneration += 1;
    if (!running || stopped || blocked || failures) return;
    // Local writes and their dirty markers are already durable. This is a
    // fixed deadline from the first write, not a trailing debounce: continued
    // scrolling and 15-second activity records cannot postpone it forever.
    if (localFlushAt === undefined) localFlushAt = now() + batchingWindowMs;
    if (!active) scheduleNext();
  });

  return {
    engine, status, runOnce,
    start() { if (running || stopped) return; running = true; urgentPending = true; schedule(Math.max(0, retryNotBefore - now())); },
    async stop() {
      stopped = true; running = false; if (timer !== undefined) clearTimer(timer); timer = undefined;
      unsubscribe?.(); controller?.abort(); await active?.catch(() => {}); nextAttemptAt = null;
      // Persist any final local writes even if network work was cancelled.
      if (!engine.canInstallSnapshot?.()) await engine.capture();
    },
    conflicts() { return engine.conflicts(); },
    async resolveConflict(input) { const result = await engine.resolveConflict(input); if (running) { urgentPending = true; if (!active) schedule(Math.max(0, retryNotBefore - now())); } return result; },
  };
}
