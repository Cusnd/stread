import { z } from "zod";
import { check } from "./errors.mjs";
import { mcpFailureValue } from "./mcp-recovery.mjs";
import { beginListRead, withListContinuation } from "./mcp-continuations.mjs";
import { errorOutputSchema, toolOutputSchema } from "./mcp-output-schemas.mjs";
import { MAX_READING_RESPONSE_BYTES } from "./mcp-reading.mjs";

const output = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
const failure = (error, context) => ({ ...output(errorOutputSchema.parse(mcpFailureValue(error, context))), isError: true });

export function createToolRegistrar(server, workspace, actor, { fileAccess } = {}) {
  return (name, description, schema, handler, options = {}) => {
    const { write = false, destructive = false, requiresAuthorization = false } = typeof options === "boolean" ? { write: options } : options;
    const inputSchema = withListContinuation(name, schema?.safeParse ? schema : z.object(schema).strict());
    const outputSchema = options.outputSchema || toolOutputSchema(name);
    return server.registerTool(name, { description, inputSchema, ...(outputSchema ? { outputSchema } : {}), annotations: { readOnlyHint: !write, destructiveHint: destructive, idempotentHint: true, openWorldHint: false } }, async (input) => {
      try {
        await workspace.authorize(actor, write ? "write" : "read");
        if (requiresAuthorization) check(input.authorized === true, "APPROVAL_REQUIRED", "Only an explicit instruction from the user in the active conversation authorizes this operation.", 403);
        const listRead = await beginListRead(name, workspace, actor, input);
        const { continuation, ...handlerInput } = input;
        const value = await handler(handlerInput);
        await listRead?.finish(value);
        // Every pageable result provides directly reusable arguments for this
        // same public tool. It never exposes an internal/retired tool name.
        if (value && typeof value === "object") {
          if (value.next === undefined && value.page?.nextOffset != null) value.next = { ...input, offset: value.page.nextOffset };
          if (value.next) { value.next = inputSchema.parse(value.next); value.nextTool = name; }
        }
        const decorated = fileAccess ? await fileAccess.decorate(value) : value;
        if (outputSchema) check(outputSchema.safeParse(decorated).success, "OUTPUT_CONTRACT_VIOLATION", "The tool result failed its output contract. A write may already have committed; retain its request_id.", 500);
        const result = output(decorated);
        // URL grants and other delivery metadata are added after the reading
        // projection chooses its page. Enforce the advertised wire ceiling on
        // the final compatibility-text + structured-content envelope as well.
        if (name === "read_context" && ["outline", "content"].includes(input.view)) check(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_READING_RESPONSE_BYTES,
          "READING_LIMIT", "The decorated reading response exceeds its wire budget. Reduce max_chars or read a narrower/exact target.", 413, { maxResponseBytes: MAX_READING_RESPONSE_BYTES });
        return result;
      } catch (error) {
        return failure(error, { name, input, write });
      }
    });
  };
}
