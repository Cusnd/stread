import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const id = process.argv[2];
if (!id) throw new Error("Usage: node scripts/read-term.mjs <saved-term-id> [mcp-url]");
const client = new Client({ name: "reader-glossary-verification", version: "0.1.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.argv[3] || "http://127.0.0.1:4176/mcp")));
  const tools = await client.listTools();
  const detail = await client.callTool({ name: "get_glossary_term", arguments: { id } });
  if (detail.isError) throw new Error(detail.content[0].text);
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), transport: "Streamable HTTP", tools: tools.tools.map(({ name, annotations }) => ({ name, annotations })), ...detail.structuredContent }, null, 2));
} finally { await client.close(); }
