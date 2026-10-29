import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createWorkspaceServer } from "../server.mjs";
import { publicMcpTools } from "./mcp-input-fixture.mjs";

const revision = "2026-07-28";
const meta = { "io.modelcontextprotocol/protocolVersion": revision, "io.modelcontextprotocol/clientInfo": { name: "protocol-test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };

async function harness(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-mcp-protocol-"));
  const authToken = "protocol-test-token";
  const server = await createWorkspaceServer({ dataDir, authToken, bootstrap: false, glossaryPath: false, staticRoot: false, sync: false });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await server.shutdown();
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep + "reader-mcp-protocol-"));
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = "http://127.0.0.1:" + server.address().port;
  const connect = async (era, viaStdio = false) => {
    const client = new Client({ name: "protocol-test", version: "1" }, era === "modern" ? { versionNegotiation: { mode: { pin: revision } } } : {});
    clients.push(client);
    const transport = viaStdio
      ? new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../stdio.mjs", import.meta.url))], env: { ...process.env, WORKSPACE_URL: base, CONTINUOUS_READER_AUTH_TOKEN: authToken }, stderr: "pipe" })
      : new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + authToken } } });
    await client.connect(transport);
    return client;
  };
  const rpc = (body, headers = {}, authorized = true) => fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(authorized ? { Authorization: "Bearer " + authToken } : {}), ...headers }, body: JSON.stringify(body) });
  return { connect, rpc, base };
}

test("HTTP and desktop stdio serve the same 32 tools to modern and legacy protocol clients", { timeout: 15000 }, async (t) => {
  const h = await harness(t);
  let catalog;
  for (const viaStdio of [false, true]) for (const era of ["legacy", "modern"]) {
    const client = await h.connect(era, viaStdio);
    assert.equal(client.getProtocolEra(), era);
    assert.equal(client.getServerVersion().name, "continuous-reader-workspace");
    assert.equal(client.getServerVersion().version, "0.6.0");
    assert.match(client.getServerVersion().description, /bounded source-linked reading/);
    assert.equal(client.getServerCapabilities().tools.listChanged, false);
    assert.equal(client.getServerCapabilities().events, undefined, "SDK adoption does not claim business Events support");
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 32);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), publicMcpTools);
    const comparable = tools.map(({ name, inputSchema, annotations }) => ({ name, inputSchema, annotations }));
    if (catalog) assert.deepEqual(comparable, catalog); else catalog = comparable;
    const result = await client.callTool({ name: "query_documents", arguments: { action: "list" } });
    assert.deepEqual(result.structuredContent.documents, []);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    const invalid = await client.callTool({ name: "update_collection", arguments: { operation: { action: "create", label: "Unauthorized" }, request_id: "no-user-authorization" } });
    assert.equal(invalid.isError, true, "both eras preserve the required authorization schema");
    await client.close();
  }
});

test("discovery is authenticated, legacy remains JSON, and malformed modern claims never fall back", async (t) => {
  const h = await harness(t);
  const body = { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } };
  const headers = { "MCP-Protocol-Version": revision, "Mcp-Method": "server/discover" };
  assert.equal((await h.rpc(body, headers, false)).status, 401);
  const response = await h.rpc(body, headers);
  assert.equal(response.status, 200);
  const discovered = (await response.json()).result;
  assert.deepEqual(discovered.supportedVersions, [revision]);
  assert.deepEqual(discovered.capabilities, { tools: { listChanged: false } });
  assert.equal(discovered._meta["io.modelcontextprotocol/serverInfo"].version, "0.6.0");
  const mismatched = await h.rpc(body, { ...headers, "Mcp-Method": "tools/list" });
  assert.equal(mismatched.status, 400);
  assert.ok((await mismatched.json()).error);
  const legacy = await h.rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "old-client", version: "1" } } });
  assert.match(legacy.headers.get("content-type"), /application\/json/);
  assert.equal((await legacy.json()).result.protocolVersion, "2025-11-25");
  const cors = await fetch(h.base + "/mcp", { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:5173" } });
  assert.match(cors.headers.get("access-control-allow-headers"), /Mcp-Method/);
  assert.match(cors.headers.get("access-control-allow-headers"), /Mcp-Name/);
});
