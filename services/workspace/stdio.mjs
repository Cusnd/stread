import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localWorkspaceUrl } from "./local-endpoint.mjs";

// Electron on Windows exposes an already-ended process.stdin in its main
// process. Let the desktop entry point supply its real inherited pipe while
// keeping Node's ordinary stdin/stdout behavior for the standalone command.
export async function startStdio({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const baseUrl = localWorkspaceUrl(process.env.WORKSPACE_URL);
  const token = process.env.CONTINUOUS_READER_AUTH_TOKEN;
  const client = new Client({ name: "continuous-reader-stdio-forwarder", version: "0.2.0" }, { versionNegotiation: { mode: "auto" } });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), { requestInit: { redirect: "error", ...(token ? { headers: { Authorization: "Bearer " + token } } : {}) } });
  let server, closing;
  const onClose = () => { void close(); };
  function close() {
    if (!closing) {
      process.removeListener("SIGINT", onClose);
      process.removeListener("SIGTERM", onClose);
      stdin.removeListener("end", onClose);
      stdin.removeListener("close", onClose);
      stdin.removeListener("error", onClose);
      stdout.removeListener("close", onClose);
      stdout.removeListener("error", onClose);
      // Auto negotiation probes before Client owns the transport, so close the
      // transport explicitly as well as the negotiated client.
      closing = Promise.allSettled([server?.close(), client.close(), transport.close()]);
    }
    return closing;
  }
  // The client can close its pipe while HTTP discovery is still pending. Attach
  // teardown before connecting, so a cancelled CLI startup cannot leak that
  // request or wait for its normal network timeout.
  process.once("SIGINT", onClose);
  process.once("SIGTERM", onClose);
  stdin.once("end", onClose);
  stdin.once("close", onClose);
  stdin.once("error", onClose);
  stdout.once("close", onClose);
  stdout.once("error", onClose);
  try {
    if (stdin.readableEnded || stdin.destroyed || stdout.destroyed) { await close(); return { close }; }
    await client.connect(transport);
    if (closing) { await closing; return { close }; }
    const stdio = new StdioServerTransport(stdin, stdout);
    server = serveStdio(() => {
      const downstream = new Server(client.getServerVersion() || { name: "continuous-reader-workspace", version: "0.6.0" }, { capabilities: { tools: { listChanged: false } }, instructions: client.getInstructions() });
      downstream.setRequestHandler("tools/list", (request, ctx) => client.listTools(request.params, { signal: ctx.mcpReq.signal }));
      downstream.setRequestHandler("tools/call", async (request, ctx) => downstream.projectCallToolResult(
        await client.callTool(request.params, { signal: ctx.mcpReq.signal }), undefined,
      ));
      return downstream;
    }, { transport: stdio });
    // A closed transport (including an oversized frame or broken output pipe)
    // must also close its upstream HTTP client, after the SDK tears down stdio.
    const transportClosed = stdio.onclose;
    stdio.onclose = () => { transportClosed?.(); onClose(); };
    return { close };
  } catch (error) {
    const cancelled = Boolean(closing);
    await close();
    if (!cancelled) throw error;
    return { close };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startStdio();
