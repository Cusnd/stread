// Logical v1 rows, independent of a Workspace or its physical SQLite tables.
// Keep this contract in step with local syncSchema(); the parity test detects drift.
const tables = {
  files: ["id", "id filename media_type sha256 size created_at"],
  collections: ["id", "id label parent_id version"],
  documents: ["id", "id version current_revision metadata archived_at created_at updated_at"],
  revisions: ["document_id revision", "document_id revision content text_index fingerprints resources report authoring identity read_only created_at actor"],
  reading: ["document_id", "document_id payload"],
  object_preferences: ["document_id block_id", "document_id block_id payload"],
  insights: ["id", "id document_id version payload archived_at"],
  references_map: ["reference", "reference insight_id"],
  change_requests: ["id", "id document_id version reference payload"],
  legacy_aliases: ["document_id reference insight_id", "document_id reference insight_id"],
  legacy_items: ["session_key local_id", "session_key local_id insight_id signature"],
  glossary: ["id", "id revision normalized_name payload deleted_at"],
  proposals: ["id", "id document_id status payload"],
  conversions: ["id", "id source_id status payload"],
  authoring_previews: ["id", "id payload published_document_id"],
  authoring_drafts: ["id", "id payload"],
  bibliographic_works: ["id", "id identity_key payload"],
  bibliographic_documents: ["document_id", "document_id revision work_id payload"],
  document_relations: ["id", "id document_id source_key version payload"],
  insight_reviews: ["insight_id", "insight_id pending added_at reviewed_at updated_at"],
  reading_sessions: ["id", "id actor_id document_id document_revision started_ms ended_ms mode start_position end_position end_reason start_input end_input created_at"],
  reading_activity: ["session_id sequence", "session_id sequence started_ms ended_ms reported_ms input"],
  receipts: ["request_id", "request_id hash payload actor created_at"],
  metadata: ["key", "key value"],
};
export const cloudSyncSchema = new Map(Object.entries(tables).map(([name, [keys, columns]]) => [name, { name, keys: keys.split(" "), columns: columns.split(" ") }]));

// Small state values and relational invariants live in D1. Complete documents
// remain immutable R2 objects; business projections remain local responsibilities.
const nullable = {
  collections: "parent_id", documents: "archived_at", revisions: "authoring identity", insights: "archived_at",
  glossary: "deleted_at", authoring_previews: "published_document_id", insight_reviews: "reviewed_at",
  reading_sessions: "ended_ms mode start_position end_position end_reason end_input",
};
const links = {
  collections: [["parent_id", "collections"]], revisions: [["document_id", "documents"]], reading: [["document_id", "documents"]],
  object_preferences: [["document_id", "documents"]], insights: [["document_id", "documents"]], change_requests: [["document_id", "documents"]],
  references_map: [["insight_id", "insights"]], legacy_aliases: [["insight_id", "insights"]], conversions: [["source_id", "files"]],
  bibliographic_documents: [["document_id", "documents"], ["work_id", "bibliographic_works"]], document_relations: [["document_id", "documents"]],
  insight_reviews: [["insight_id", "insights"]], reading_sessions: [["document_id", "documents"]], reading_activity: [["session_id", "reading_sessions"]],
};
const uniques = {
  glossary: [{ name: "glossary_active_name", columns: ["normalized_name"], whereNull: "deleted_at" }],
  change_requests: [{ name: "change_requests_reference", columns: ["reference"] }],
  bibliographic_works: [{ name: "bibliographic_works_identity", columns: ["identity_key"] }],
  document_relations: [{ name: "document_relations_source", columns: ["document_id", "source_key"] }],
};
export const cloudSyncConstraints = new Map([...cloudSyncSchema].map(([entity, table]) => [entity, {
  // TEXT PRIMARY KEY is nullable in SQLite, but the v1 key grammar already
  // rejects null keys. Do not count those as separate NOT NULL declarations.
  required: table.columns.filter((column) => !table.keys.includes(column) && !(nullable[entity] || "").split(" ").includes(column)),
  links: (links[entity] || []).map(([column, target]) => ({ columns: [column], target, targetColumns: ["id"] })),
  unique: uniques[entity] || [],
}]));
