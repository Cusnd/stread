import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createWorkspace, localActor } from "./service.mjs";
import { createWorkspaceMcp } from "./mcp.mjs";
import { createWorkspaceMcpHttpHandler } from "./mcp-web-transport.mjs";
import { check, errorBody, fail, object, WorkspaceError } from "./errors.mjs";
import { MAX_SOURCE_BYTES, mediaTypeFor } from "./resources.mjs";
import { authorizeFileCapability, CAPABILITY_PARAMETER, createFileCapabilities, createMcpFileAccess, decorateDocumentationLinks, FileCapabilityError } from "./file-capabilities.mjs";
import { createWorkspaceSync } from "./sync-engine.mjs";
import { handleSyncObjectRequest } from "./sync-object-transfer.mjs";
import { createNodeSyncObjectStore } from "./sync-object-node.mjs";
import { handleWorkspaceApi } from "./api-router.mjs";
import { localFileResponse, nodeRequest, sendFetchResponse } from "./node-http.mjs";
import { localWorkspaceUrl } from "./local-endpoint.mjs";

const defaultStaticRoot = fileURLToPath(new URL("../../prototypes/insight-composer/dist/client/", import.meta.url));
const sessionCookie = "continuous_reader_session";
const secureEqual = (left, right) => typeof left === "string" && typeof right === "string" && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(data));
}
async function jsonBody(request, maximum = 4 * 1024 * 1024) {
  check(request.headers["content-type"]?.split(";")[0].trim().toLowerCase() === "application/json", "UNSUPPORTED_MEDIA_TYPE", "此操作需要 JSON 请求。", 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; check(size <= maximum, "REQUEST_TOO_LARGE", "请求内容超过限制。", 413); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("INVALID_JSON", "请求 JSON 无法解析。"); }
  return value;
}
function integerParameter(url, name) {
  const input = url.searchParams.get(name); if (input === null) return undefined;
  check(/^[0-9]+$/.test(input) && Number.isSafeInteger(Number(input)) && Number(input) > 0, "VALIDATION_FAILED", `${name} 必须为正整数。`); return Number(input);
}
function decode(value) { try { return decodeURIComponent(value); } catch { fail("VALIDATION_FAILED", "URL 编码无效。"); } }
function attachment(filename) { return "attachment; filename*=UTF-8''" + encodeURIComponent(filename).replaceAll("'", "%27"); }
async function sendFile(request, response, resource, { original = false } = {}) {
  const info = resource.body ? { size: resource.body.length } : await stat(resource.path), tag = resource.sha256 ? '"' + resource.sha256 + '"' : undefined;
  const headers = { "Content-Type": resource.mediaType, "Content-Length": info.size, "X-Content-Type-Options": "nosniff", "Cache-Control": request.fileCapability ? "no-store" : "private, max-age=0, must-revalidate", ...(tag ? { ETag: tag } : {}) };
  if (original) {
    headers["Content-Security-Policy"] = "sandbox; default-src 'none'; frame-ancestors 'self'";
    if (!/^image\/(png|jpeg|gif|webp)$/.test(resource.mediaType) && resource.mediaType !== "application/pdf") headers["Content-Disposition"] = attachment(resource.filename || "source");
  }
  if (tag && request.headers["if-none-match"] === tag) { delete headers["Content-Length"]; response.writeHead(304, headers); response.end(); return; }
  response.writeHead(200, headers);
  if (request.method === "HEAD") response.end(); else if (resource.body) response.end(resource.body); else await pipeline(createReadStream(resource.path), response);
}

export async function createWorkspaceServer(options = {}) {
  const workspace = options.workspace || await createWorkspace(options);
  workspace.localOnly = true;
  // Old environment variables and adapter options cannot reactivate cloud work.
  // Retain saved replication evidence; instantiate its local conflict handler
  // only when an existing profile actually has conflicts to inspect or resolve.
  workspace.onlinePreview = null;
  let conflictHistory;
  const localConflicts = async () => {
    if (!workspace.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_conflicts'").get()
      || !workspace.db.prepare("SELECT id FROM sync_conflicts LIMIT 1").get()) return null;
    return conflictHistory ||= createWorkspaceSync(workspace, { mode: "client" });
  };
  const syncObjects = createNodeSyncObjectStore(workspace.resources);
  const authToken = options.authToken ?? process.env.CONTINUOUS_READER_AUTH_TOKEN ?? "";
  const extraOrigins = options.allowedOrigins || (process.env.CONTINUOUS_READER_ALLOWED_ORIGINS || "").split(",").filter(Boolean);
  const localOrigins = extraOrigins.flatMap((origin) => { try { return [localWorkspaceUrl(origin).origin]; } catch { return []; } });
  const allowedOrigins = new Set(["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:4173", "http://localhost:4173", ...localOrigins]);
  const staticRoot = options.staticRoot === false ? false : resolve(options.staticRoot || process.env.CONTINUOUS_READER_STATIC_ROOT || defaultStaticRoot);
  const sessions = new Map();
  const fileCapabilities = options.fileCapabilities || await createFileCapabilities(options.fileCapabilityOptions);
  const mcpHttp = createWorkspaceMcpHttpHandler(({ requestInfo }) => {
    const baseUrl = new URL(requestInfo.url).origin;
    return createWorkspaceMcp(workspace, localActor, { baseUrl,
      fileAccess: createMcpFileAccess({ capabilities: fileCapabilities, baseUrl }) });
  });
  const serveMcp = toNodeHandler(mcpHttp);
  const authenticate = async (request, url) => {
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!authToken) return localActor;
    if (bearer && secureEqual(bearer, authToken)) return localActor;
    const cookie = request.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(sessionCookie + "="))?.slice(sessionCookie.length + 1);
    const session = cookie && sessions.get(cookie);
    if (session && session > Date.now()) return localActor;
    if (cookie) sessions.delete(cookie);
    if (url.searchParams.has(CAPABILITY_PARAMETER)) {
      request.fileCapability = await authorizeFileCapability(fileCapabilities, url, request.method, workspace, localActor);
      return localActor;
    }
    fail("UNAUTHORIZED", "此工作台需要登录。", 401);
  };
  const server = http.createServer(async (request, response) => {
    // Capability URLs must not become a Referer on document or external links.
    response.setHeader("Referrer-Policy", "no-referrer");
    try {
      const host = request.headers.host || "";
      check(/^(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/.test(host), "FORBIDDEN_HOST", "不允许的服务主机。", 403);
      const origin = request.headers.origin, ownOrigin = "http://" + host;
      check(!origin || origin === ownOrigin || allowedOrigins.has(origin), "FORBIDDEN_ORIGIN", "不允许的请求来源。", 403);
      if (origin) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Access-Control-Allow-Credentials", "true"); response.setHeader("Vary", "Origin"); }
      response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Idempotency-Key, X-Content-Sha256, X-Reader-Sync-Features, If-None-Match");
      response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, ETag");
      if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
      const url = new URL(request.url, ownOrigin), pathname = url.pathname;
      if (pathname === "/health" && request.method === "GET") return sendJson(response, 200, { ok: true, service: "continuous-reader-workspace", authentication: Boolean(authToken), backend: "local" });
      if (pathname === "/api/session" && request.method === "POST") {
        const input = object(await jsonBody(request, 4096));
        check(authToken && secureEqual(input.token, authToken), "UNAUTHORIZED", "工作台访问令牌无效。", 401);
        const session = randomBytes(32).toString("base64url"); sessions.set(session, Date.now() + 8 * 60 * 60 * 1000);
        const secure = request.socket.encrypted;
        response.setHeader("Set-Cookie", `${sessionCookie}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? "; Secure" : ""}`);
        return sendJson(response, 200, { ok: true });
      }
      const actor = pathname.startsWith("/api/") || pathname === "/mcp" || url.searchParams.has(CAPABILITY_PARAMETER) ? await authenticate(request, url) : undefined;
      if (pathname.startsWith("/api/sync/client/")) {
        if (pathname === "/api/sync/client/status" && request.method === "GET") return sendJson(response, 200, { configured: false, mode: "local" });
        if (pathname.startsWith("/api/sync/client/objects/") && ["GET", "HEAD"].includes(request.method)) {
          const objectUrl = new URL(url); objectUrl.pathname = objectUrl.pathname.replace("/api/sync/client/objects/", "/api/sync/objects/");
          const result = await handleSyncObjectRequest(new Request(objectUrl, { method: request.method }), { store: syncObjects });
          if (result) { response.writeHead(result.status, Object.fromEntries(result.headers)); if (result.body) await pipeline(Readable.fromWeb(result.body), response); else response.end(); return; }
        }
        if (pathname === "/api/sync/client/run" && request.method === "POST") fail("LOCAL_ONLY", "资料保存在本机，云端同步已停用。", 410);
        if (pathname === "/api/sync/client/conflicts" && request.method === "GET") return sendJson(response, 200, (await localConflicts())?.conflicts({ includeResolved: true }) || { conflicts: [] });
        if (pathname === "/api/sync/client/resolve" && request.method === "POST") {
          const history = await localConflicts();
          check(history, "NOT_FOUND", "没有可处理的历史冲突。", 404);
          return sendJson(response, 200, await history.resolveConflict(await jsonBody(request, 8192), actor));
        }
      }
      if (pathname === "/mcp") {
        check(request.method === "POST", "METHOD_NOT_ALLOWED", "无会话 MCP 端点接受 POST 请求。", 405);
        const input = await jsonBody(request);
        await serveMcp(request, response, input); return;
      }
      if (pathname.startsWith("/api/")) {
        const result = await handleWorkspaceApi(nodeRequest(request, url), { workspace, actor, fileResponse: localFileResponse,
          ...(request.fileCapability ? { documentationResponse: (resource) => decorateDocumentationLinks(resource, {
            capabilities: fileCapabilities, baseUrl: ownOrigin, parent: request.fileCapability,
          }) } : {}),
        });
        if (result) {
          await sendFetchResponse(response, result); return;
        }
      }
      if (pathname.startsWith("/api/") || pathname === "/mcp") fail("NOT_FOUND", "没有找到此接口。", 404);
      if (staticRoot && ["GET", "HEAD"].includes(request.method)) {
        const decoded = decode(pathname); check(!/[\\\u0000]/.test(decoded), "FORBIDDEN", "文件路径无效。", 403);
        const path = resolve(staticRoot, "." + decoded), relativePath = relative(staticRoot, path);
        check(!relativePath.startsWith(".." + sep) && relativePath !== ".." && !isAbsolute(relativePath), "FORBIDDEN", "文件路径无效。", 403);
        let target = await stat(path).then((info) => info.isFile() ? path : null).catch(() => null);
        if (!target && (!extname(pathname) || pathname === "/")) target = resolve(staticRoot, "index.html");
        if (target) {
          const actual = await realpath(target), base = await realpath(staticRoot), within = relative(base, actual);
          check(!within.startsWith(".." + sep) && within !== ".." && !isAbsolute(within), "FORBIDDEN", "文件路径无效。", 403);
          const mediaType = ({ ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".css": "text/css; charset=utf-8", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf" })[extname(target)] || mediaTypeFor(target);
          return await sendFile(request, response, { path: actual, mediaType });
        }
      }
      fail("NOT_FOUND", "没有找到此页面。", 404);
    } catch (error) {
      if (!response.headersSent) sendJson(response, error instanceof WorkspaceError || error instanceof FileCapabilityError ? error.status : error.code === "ENOENT" ? 404 : 500, error instanceof FileCapabilityError ? { error: error.message, code: error.code } : error.code === "ENOENT" ? { error: "页面尚未构建。", code: "NOT_FOUND" } : errorBody(error));
      else if (!response.destroyed) response.end();
    }
  });
  server.workspace = workspace;
  server.syncClient = null;
  server.sync = null;
  server.shutdown = async () => { await mcpHttp.close(); if (server.listening) await new Promise((resolveClose) => server.close(resolveClose)); await workspace.close(); };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.WORKSPACE_HOST || "127.0.0.1", port = Number(process.env.WORKSPACE_PORT || 4177);
  check(["127.0.0.1", "localhost", "::1"].includes(host), "LOCAL_ONLY", "工作台只接受本机监听地址。", 400);
  const server = await createWorkspaceServer();
  server.listen(port, host, () => console.log(`Workspace API, MCP and app: http://${host}:${port}`));
  const stop = () => { void server.shutdown().then(() => process.exit(0)); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
