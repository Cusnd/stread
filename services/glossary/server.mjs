import http from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { GlossaryStore, StoreError } from "./store.mjs";
import { createGlossaryMcp } from "./mcp.mjs";

const origins = new Set(["http://127.0.0.1:4173", "http://localhost:4173"]);
function json(res, status, body) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
async function body(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new StoreError("需要 JSON 请求。", 415);
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 32768) throw new StoreError("内容过长。", 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new StoreError("请求内容无效。", 400); }
}
export function createHttpServer(store = new GlossaryStore()) {
  return http.createServer(async (req, res) => {
    try {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) return json(res, 403, { error: "Host not allowed" });
      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) return json(res, 403, { error: "Origin not allowed" });
      if (origin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, MCP-Protocol-Version, Mcp-Session-Id");
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/health") return json(res, 200, { ok: true, service: "stread-glossary" });
      if (url.pathname === "/mcp") {
        if (req.method !== "POST") return json(res, 405, { error: "This stateless MCP endpoint accepts POST." });
        const payload = await body(req);
        const mcp = createGlossaryMcp(store);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => { void transport.close(); void mcp.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, payload);
        return;
      }
      if (url.pathname === "/api/glossary") {
        if (req.method === "GET") {
          const query = url.searchParams.get("query") || "";
          if (query.length > 200) throw new StoreError("检索词过长。");
          return json(res, 200, await store.list({ query, limit: 1000 }));
        }
        if (req.method === "POST") return json(res, 201, await store.create(await body(req)));
      }
      const match = url.pathname.match(/^\/api\/glossary\/([0-9a-f-]{36})(\/restore)?$/i);
      if (match) {
        const id = match[1];
        if (req.method === "GET" && !match[2]) return json(res, 200, { entry: await store.get(id) });
        if (req.method === "PATCH" && !match[2]) return json(res, 200, await store.update(id, await body(req)));
        if (req.method === "DELETE" && !match[2]) return json(res, 200, await store.remove(id, (await body(req)).expectedRevision));
        if (req.method === "POST" && match[2]) return json(res, 200, await store.restore(id, (await body(req)).expectedRevision));
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : "术语表暂时无法保存，请重试。" });
      else res.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.GLOSSARY_PORT || 4176);
  createHttpServer().listen(port, "127.0.0.1", () => console.log(`Glossary API and MCP: http://127.0.0.1:${port}`));
}
