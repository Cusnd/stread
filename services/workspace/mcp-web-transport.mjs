import { createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

// Both deployments share the same modern entry. Keep JSON responses for existing
// stateless clients while the SDK owns modern negotiation, envelopes and codecs.
export function createWorkspaceMcpHttpHandler(factory) {
  const modern = createMcpHandler(factory, { legacy: "reject" });
  return {
    close: () => modern.close(),
    async fetch(request, options = {}) {
      if (!await isLegacyRequest(request, options.parsedBody)) return modern.fetch(request, options);
      const server = await factory({ era: "legacy", authInfo: options.authInfo, requestInfo: request });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try {
        await server.connect(transport);
        return await transport.handleRequest(request, options);
      } finally {
        await server.close();
        await transport.close();
      }
    },
  };
}
