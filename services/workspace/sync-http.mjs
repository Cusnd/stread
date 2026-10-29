import { check } from "./errors.mjs";
import { readJson } from "./api-router.mjs";
import { SYNC_MAX_BYTES } from "./sync-schema.mjs";

// Called only after the existing full-workspace authentication/origin checks.
// File capabilities deliberately cannot authorize any of these routes.
export async function handleWorkspaceSync(request, { sync, actor, headers = new Headers() }) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith("/api/sync/")) return null;
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...Object.fromEntries(headers), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } });
  if (path === "/api/sync/manifest" && request.method === "GET") return response(sync.manifest(actor));
  if (path === "/api/sync/enroll" && request.method === "POST") return response(sync.enroll(actor, await readJson(request, 8192)));
  if (path === "/api/sync/push" && request.method === "POST") {
    const receipt = await sync.push(actor, await readJson(request, SYNC_MAX_BYTES + 65536));
    // Conflict receipts retain both sides and can exceed the incoming batch.
    // Reuse immutable persisted chunks; never truncate a conflict or acknowledge
    // it until the receiving client has verified the entire original receipt.
    return response(Buffer.byteLength(JSON.stringify(receipt)) > SYNC_MAX_BYTES
      ? { receiptTransfer: sync.receiptTransfer(receipt.replicaId, receipt.requestId, actor) } : receipt);
  }
  if (path === "/api/sync/receipts" && request.method === "GET") {
    const after = url.searchParams.get("after") || "0";
    check(/^[0-9]+$/.test(after), "SYNC_CURSOR", "回执分页位置无效。", 400);
    return response(sync.receiptParts(url.searchParams.get("replicaId"), url.searchParams.get("requestId"), Number(after), actor));
  }
  if (path === "/api/sync/pull" && request.method === "GET") {
    const parse = (name, fallback) => { const value = url.searchParams.get(name); check(value === null || /^[0-9]+$/.test(value), "SYNC_CURSOR", "同步分页参数无效。", 400); return value === null ? fallback : Number(value); };
    const page = sync.pull({ after: parse("after", 0), limit: parse("limit", 50) }, actor);
    check(!page.transactions.some((transaction) => transaction.atomicGroups?.length > 1) || request.headers.get("X-Reader-Sync-Features")?.split(",").map((value) => value.trim()).includes("atomic-groups-v1"), "SYNC_UPGRADE_REQUIRED", "请升级同步客户端后接收合批事务。", 426);
    return response(page);
  }
  if (path === "/api/sync/status" && request.method === "GET") { sync.workspace.authorize(actor); return response(sync.status()); }
  if (path === "/api/sync/conflicts" && request.method === "GET") { sync.workspace.authorize(actor); return response(sync.conflicts()); }
  const conflict = path.match(/^\/api\/sync\/conflicts\/([^/]+)\/resolve$/);
  if (conflict && request.method === "POST") return response(await sync.resolveConflict({ ...await readJson(request, 4096), id: conflict[1] }, actor));
  return null;
}
