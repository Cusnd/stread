import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { PassThrough } from "node:stream";
import { startStdio } from "../stdio.mjs";

test("an already-closed stdio pipe does not wait for or contact the workspace", { timeout: 5000 }, async (t) => {
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.writeHead(503); response.end(); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const oldUrl = process.env.WORKSPACE_URL;
  process.env.WORKSPACE_URL = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    if (oldUrl === undefined) delete process.env.WORKSPACE_URL; else process.env.WORKSPACE_URL = oldUrl;
    server.closeAllConnections(); await new Promise((done) => server.close(done));
  });
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.resume(); stdin.end();
  await new Promise((done) => stdin.once("end", done));
  const forwarder = await startStdio({ stdin, stdout });
  await forwarder.close();
  assert.equal(requests, 0, "no client remains to use an upstream connection");
});

test("closing stdin during upstream discovery cancels startup and releases its signal handlers", { timeout: 5000 }, async (t) => {
  let resolveStarted, resolveAborted;
  const started = new Promise((done) => { resolveStarted = done; });
  const aborted = new Promise((done) => { resolveAborted = done; });
  const server = http.createServer((_request, response) => { response.once("close", resolveAborted); resolveStarted(); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const oldUrl = process.env.WORKSPACE_URL;
  process.env.WORKSPACE_URL = "http://127.0.0.1:" + server.address().port;
  const stdin = new PassThrough(), stdout = new PassThrough();
  let forwarder;
  t.after(async () => {
    stdin.destroy(); stdout.destroy(); await forwarder?.close();
    if (oldUrl === undefined) delete process.env.WORKSPACE_URL; else process.env.WORKSPACE_URL = oldUrl;
    server.closeAllConnections(); await new Promise((done) => server.close(done));
  });
  const listeners = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
  const pending = startStdio({ stdin, stdout });
  await started;
  stdin.destroy();
  forwarder = await pending;
  await aborted;
  assert.equal(process.listenerCount("SIGINT"), listeners.SIGINT);
  assert.equal(process.listenerCount("SIGTERM"), listeners.SIGTERM);
});

test("stdio preserves upstream server identity and forwards request cancellation without breaking subsequent calls", { timeout: 10000 }, async (t) => {
  let callResponse, callId, resolveStarted, resolveCancelled;
  const started = new Promise((done) => { resolveStarted = done; });
  const cancelled = new Promise((done) => { resolveCancelled = done; });
  const send = (response, id, result) => {
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  };
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks));
    if (message.method === "server/discover") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Legacy fixture" } })); return;
    }
    if (message.method === "initialize") return send(response, message.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "upstream-test", version: "9.7.5" }, instructions: "Shared upstream instructions" });
    if (message.method === "tools/list") return send(response, message.id, { tools: [{ name: "slow", description: "A cancellable fixture", inputSchema: { type: "object" } }] });
    if (message.method === "tools/call") { callResponse = response; callId = message.id; resolveStarted(); return; }
    if (message.method === "notifications/cancelled") {
      resolveCancelled(message.params);
      if (callResponse) send(callResponse, callId, { content: [{ type: "text", text: "Cancelled fixture completed" }] });
    }
    response.writeHead(202); response.end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../stdio.mjs", import.meta.url))], env: { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string")), WORKSPACE_URL: "http://127.0.0.1:" + server.address().port }, stderr: "pipe" });
  const client = new Client({ name: "stdio-cancellation-test", version: "1" });
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  await client.connect(transport);
  assert.deepEqual(client.getServerVersion(), { name: "upstream-test", version: "9.7.5" });
  assert.equal(client.getInstructions(), "Shared upstream instructions");
  const controller = new AbortController();
  const call = client.callTool({ name: "slow", arguments: {} }, { signal: controller.signal });
  const rejected = assert.rejects(call);
  await started; controller.abort("test cancellation");
  await rejected;
  const upstreamCancellation = await cancelled;
  assert.equal(upstreamCancellation.requestId, callId);
  assert.match(upstreamCancellation.reason, /test cancellation/);
  assert.equal((await client.listTools()).tools[0].name, "slow");
});

test("modern stdio forwards cancellation to the modern HTTP request stream", { timeout: 10000 }, async (t) => {
  let resolveStarted, resolveCancelled;
  const started = new Promise((done) => { resolveStarted = done; });
  const cancelled = new Promise((done) => { resolveCancelled = done; });
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: "modern-upstream", version: "1" });
    mcp.registerTool("slow", { inputSchema: z.object({}) }, async (_input, ctx) => {
      await ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: "fixture", progress: 1 } });
      resolveStarted();
      await new Promise((done) => {
        if (ctx.mcpReq.signal.aborted) done(); else ctx.mcpReq.signal.addEventListener("abort", done, { once: true });
      });
      resolveCancelled();
      return { content: [{ type: "text", text: "cancelled" }] };
    });
    return mcp;
  });
  const server = http.createServer(toNodeHandler(handler));
  const client = new Client({ name: "modern-cancellation-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  t.after(async () => { await client.close(); await handler.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../stdio.mjs", import.meta.url))], env: { ...process.env, WORKSPACE_URL: "http://127.0.0.1:" + server.address().port }, stderr: "pipe" }));
  assert.equal(client.getProtocolEra(), "modern");
  const controller = new AbortController();
  const rejected = assert.rejects(client.callTool({ name: "slow", arguments: {} }, { signal: controller.signal }));
  await started; controller.abort("cancel modern request");
  await rejected;
  await cancelled;
  assert.equal((await client.listTools()).tools[0].name, "slow");
});
