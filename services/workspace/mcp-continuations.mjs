import { z } from "zod";
import { canonical, check, hash } from "./errors.mjs";

const branches = { query_documents: ["action", ["list", "search"]], query_glossary: ["action", ["list", "search"]], query_uploaded_sources: ["action", ["list"]] };
const lists = new Set(["query_documents", "list_collections", "query_insights", "get_reading_plan", "query_reading_activity", "query_glossary", "list_change_requests", "list_revision_proposals", "list_document_relations", "query_uploaded_sources"]);
const tokenSchema = z.string().min(1).max(512).describe("Opaque next-page token returned in next; retain the original filters and offset.").optional();
const payloadSchema = z.object({ v: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), version: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(1) }).strict();

export function withListContinuation(name, schema) {
  if (!lists.has(name)) return schema;
  if (branches[name]) {
    const [key, values] = branches[name];
    return z.discriminatedUnion(key, schema.options.map((branch) => values.includes(branch.shape[key].value) ? branch.extend({ continuation: tokenSchema }) : branch)).meta({ type: "object" });
  }
  if (schema.options && name === "query_reading_activity") return z.discriminatedUnion("view", schema.options.map((branch) => branch.extend({ continuation: tokenSchema }))).meta({ type: "object" });
  return schema.extend({ continuation: tokenSchema });
}

async function listVersion(name, workspace, input) {
  // The business query owns its consistency inputs. MCP retains the exact
  // signature/token representation without reaching into a database driver.
  return hash(canonical(await workspace.readListVersionState(name, input)));
}

export async function beginListRead(name, workspace, actor, input) {
  if (!lists.has(name) || branches[name] && !branches[name][1].includes(input[branches[name][0]])) return null;
  const { continuation, offset = 0, ...filters } = input;
  const scope = hash(canonical({ tool: name, actor: { workspaceId: actor.workspaceId, subjectId: actor.subjectId, scopes: [...actor.scopes].sort() }, filters }));
  const version = await listVersion(name, workspace, input);
  if (continuation) {
    let payload;
    try { payload = payloadSchema.parse(JSON.parse(Buffer.from(continuation, "base64url").toString("utf8"))); } catch { check(false, "INVALID_CONTINUATION", "The list continuation is invalid; restart this read."); }
    check(payload.scope === scope && payload.offset === offset, "CONTINUATION_SCOPE_MISMATCH", "The list continuation belongs to a different actor, filter, page size or offset.");
    check(payload.version === version, "LIST_CHANGED", "The list changed between pages; restart from its first page.", 409);
  }
  return {
    async finish(value) {
      check(await listVersion(name, workspace, input) === version, "LIST_CHANGED", "The list changed during this read; restart from its first page.", 409);
      value.consistency = { mode: continuation ? "continued" : "fresh_range", snapshot: version };
      if (value.page?.nextOffset != null) value.next = { ...filters, offset: value.page.nextOffset, continuation: Buffer.from(JSON.stringify({ v: 1, scope, version, offset: value.page.nextOffset })).toString("base64url") };
      return value;
    },
  };
}
