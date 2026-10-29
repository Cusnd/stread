import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGlossaryMcp } from "./mcp.mjs";

await createGlossaryMcp().connect(new StdioServerTransport());
