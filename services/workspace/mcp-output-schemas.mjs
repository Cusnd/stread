import { z } from "zod";

const id = z.string().min(1), integer = z.number().int().min(0), revision = integer.min(1);
const object = (fields) => z.object(fields).passthrough();
const row = object({ id });
const page = object({ offset: integer, count: integer, total: integer, nextOffset: integer.nullable() });
const excerpt = object({ text: z.string(), start: integer, end: integer, totalChars: integer, truncated: z.boolean(), nextOffset: integer.nullable() });
export const errorOutputSchema = object({ code: z.string(), error: z.string().max(1000), recovery: object({ mode: z.enum(["exact_retry", "reread", "repair_input", "request_authorization", "unknown"]), retryable: z.boolean(), requestIdPolicy: z.enum(["reuse_exact", "new_after_review", "preserve_unknown", "not_applicable"]), message: z.string().max(1000) }) });
const paged = (key, item = row) => object({ [key]: z.array(item), page });
const receipt = (key, target = row) => object({ requestId: id, [key]: target });
const preview = object({ id, hash: z.string().regex(/^[a-f0-9]{64}$/) });
const statisticsTotals = object({ activeMs: integer, sessionCount: integer, documentCount: integer });
const statisticsDay = object({ date: z.string(), activeMs: integer, sessionCount: integer });
const statisticsGroup = object({ date: z.string().optional(), documentId: id.optional(), actorId: id.optional(),
  activeMs: integer, sessionCount: integer, documentCount: integer });
const statisticsBase = { timezone: z.string(), range: object({ startDate: z.string(), endDate: z.string() }), page };
const candidates = {
  read_context: object({ documentId: id, revision }),
  resolve_reference: z.union([
    object({ documentId: id, part: z.enum(["title", "body", "quote", "answer"]), content: excerpt }),
    object({ task: object({ id, reference: z.string().regex(/^#T[0-9]{5,}$/), version: revision }), documentId: id.optional(), part: z.enum(["title", "body", "quote", "answer"]), content: excerpt }),
  ]),
  query_documents: z.union([paged("documents"), paged("matches", object({ documentId: id, revision })), object({ document: row, part: z.string() })]),
  get_reading_plan: object({ documents: z.array(row), page, planVersion: integer }),
  query_insights: object({ insights: z.array(row), page, activityRevision: integer }),
  query_reading_activity: z.union([
    object({ ...statisticsBase, totals: statisticsTotals, days: z.array(statisticsDay) }),
    object({ ...statisticsBase, totals: statisticsTotals, groups: z.array(statisticsGroup), groupBy: z.array(z.enum(["day", "document", "actor"])) }),
    object({ ...statisticsBase, status: z.literal("pending"), totals: z.null(), requiresProjection: object({ timezone: z.string(), dates: z.array(z.string()) }) }),
    paged("sessions"),
  ]),
  list_collections: paged("collections"),
  list_change_requests: paged("changeRequests"),
  list_revision_proposals: paged("proposals"),
  list_document_relations: paged("relations"),
  revise_document: z.union([receipt("document", object({ id, revision })), receipt("proposal")]),
  answer_question: receipt("insight"),
  update_document: receipt("document", object({ id, version: revision })),
  update_collection: receipt("collection", object({ id, version: revision })),
  update_insight: receipt("insight", object({ id, version: revision })),
  update_change_request: receipt("changeRequest", object({ id, version: revision })),
  update_glossary: receipt("entry", object({ id, revision })),
  update_reading_plan: object({ requestId: id, planVersion: integer, planCount: integer }),
  set_insight_review: object({ requestId: id, activityRevision: integer, insight: row }),
  update_object_preferences: object({ requestId: id, revision: integer, objectCount: integer }),
  create_authoring_preview: object({ preview }),
  inspect_authoring_preview: object({ preview }),
  publish_authoring_preview: object({ preview }),
};

// Validate stable public fields while retaining domain-specific projections.
// A richer projection can evolve without silently stripping source metadata.
export function toolOutputSchema(name) {
  const success = candidates[name];
  // MCP outputSchema applies to successful results. Both supported SDK eras
  // skip it for isError; keep one internally validated error contract instead
  // of repeating the complete recovery model in every tools/list entry.
  return success?.meta({ type: "object" });
}
