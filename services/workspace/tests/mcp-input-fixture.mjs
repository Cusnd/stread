// Shared writes keep authorization and idempotency outside the discriminated
// operation. This helper only constructs that wire shape; it never maps names.
export function mergedWrite(action, input = {}) {
  const { authorized, request_id, ...fields } = input;
  return { ...(authorized === undefined ? {} : { authorized }), ...(request_id === undefined ? {} : { request_id }), operation: { action, ...fields } };
}

export function schemaBranches(schema) {
  return schema.oneOf || schema.anyOf || [];
}

export const publicMcpTools = [
  "query_documents", "update_document", "list_collections", "update_collection", "read_context", "resolve_reference", "read_resources",
  "query_insights", "update_insight", "answer_question", "set_insight_review", "get_reading_plan", "update_reading_plan", "query_reading_activity",
  "list_change_requests", "update_change_request", "revise_document", "list_revision_proposals", "decide_revision_proposal", "list_document_relations",
  "set_document_relation", "query_glossary", "update_glossary", "get_object_preferences", "update_object_preferences", "query_uploaded_sources",
  "prepare_source_upload", "get_authoring_contract", "validate_authoring", "create_authoring_preview", "inspect_authoring_preview", "publish_authoring_preview",
].sort();

export const removedMcpTools = [
  "list_documents", "search_documents", "list_collection_documents", "get_document_metadata", "update_document_metadata", "archive_document", "restore_document",
  "create_collection", "remove_collection", "get_document_resource", "get_pdf_pages", "get_authoring_artifacts", "list_insights", "search_insights", "list_archived_insights",
  "save_insight", "archive_insight", "restore_insight", "add_to_reading_plan", "remove_from_reading_plan", "move_reading_plan_item", "get_flow_summary", "list_reading_history",
  "create_change_request", "cancel_change_request", "reopen_change_request", "list_glossary", "search_glossary", "get_glossary_term", "create_glossary_term",
  "update_glossary_term", "remove_glossary_term", "restore_glossary_term", "list_uploaded_sources", "get_uploaded_source", "get_authoring_preview", "get_authoring_draft", "publish_authoring",
];
