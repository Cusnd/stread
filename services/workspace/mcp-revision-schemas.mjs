import { z } from "zod";

const id = z.string().min(1).max(160), position = z.number().int().min(0);
const address = {
  block_id: id,
  variant: z.string().max(64).optional(),
  item_id: id.optional(), node_id: id.optional(),
  source_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
};
const textFields = ["title", "text", "tex", "caption", "alt", "image_text", "html", "html_text"];
const cell = { row: position, column: position };
const tableFields = z.enum(["head", "rows"]);
const text = z.string().max(200000);
const matrix = z.array(z.array(z.string().max(100000)).max(1000)).max(10000);
const block = z.object({
  type: z.enum(["heading", "para", "list", "math", "table", "figure", "html"]),
  language: z.string().min(2).max(64).optional(),
}).passthrough();

// Keep requirements in JSON Schema, rather than hiding them exclusively in a
// refinement. The business layer still validates source identities, Unicode,
// exact text, hashes and the sequential/atomic semantics of the whole batch.
const range = {
  kind: z.literal("replace_range"), ...address,
  start: position, end: position, expected_text: z.string().max(6000), value: text,
};
export const revisionOperation = z.union([
  z.object({ kind: z.literal("replace"), ...address, field: z.enum(textFields), value: text }).strict(),
  z.object({ kind: z.literal("replace"), ...address, field: tableFields, ...cell, value: z.string().max(100000) }).strict(),
  z.object({ kind: z.literal("replace"), ...address, field: tableFields, value: matrix }).strict(),
  z.object({ ...range, field: z.enum(textFields.filter((field) => field !== "html")) }).strict(),
  z.object({ ...range, field: tableFields, ...cell }).strict(),
  z.object({ kind: z.literal("insert"), before_block_id: id, block }).strict(),
  z.object({ kind: z.literal("insert"), after_block_id: id, block }).strict(),
  z.object({ kind: z.literal("remove"), block_id: id }).strict(),
  z.object({ kind: z.literal("move"), block_id: id, before_block_id: id }).strict(),
  z.object({ kind: z.literal("move"), block_id: id, after_block_id: id }).strict(),
]);
