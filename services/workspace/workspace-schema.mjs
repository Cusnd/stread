// Original migrations are retained byte-for-byte so existing ledgers remain valid.
export const workspaceSchemaMigrations = [{ version: 1, name: "Adopt existing workspace state without replacing rows", sql: `
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, version INTEGER NOT NULL, current_revision INTEGER NOT NULL, metadata TEXT NOT NULL, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (document_id TEXT NOT NULL REFERENCES documents(id), revision INTEGER NOT NULL, content TEXT NOT NULL, text_index TEXT NOT NULL, fingerprints TEXT NOT NULL, resources TEXT NOT NULL, report TEXT NOT NULL, authoring TEXT, identity TEXT, read_only INTEGER NOT NULL, created_at TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(document_id, revision));
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, filename TEXT NOT NULL, media_type TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, label TEXT NOT NULL, parent_id TEXT REFERENCES collections(id), version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reading (document_id TEXT PRIMARY KEY REFERENCES documents(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS object_preferences (document_id TEXT NOT NULL REFERENCES documents(id), block_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(document_id, block_id));
      CREATE TABLE IF NOT EXISTS insights (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), version INTEGER NOT NULL, payload TEXT NOT NULL, archived_at TEXT);
      CREATE INDEX IF NOT EXISTS insights_document ON insights(document_id);
      CREATE TABLE IF NOT EXISTS change_requests (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), version INTEGER NOT NULL, reference TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS change_requests_document ON change_requests(document_id);
      CREATE TABLE IF NOT EXISTS references_map (reference TEXT PRIMARY KEY, insight_id TEXT NOT NULL REFERENCES insights(id));
      CREATE TABLE IF NOT EXISTS counters (series TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_aliases (document_id TEXT NOT NULL, reference TEXT NOT NULL, insight_id TEXT NOT NULL REFERENCES insights(id), PRIMARY KEY(document_id, reference, insight_id));
      CREATE TABLE IF NOT EXISTS receipts (request_id TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS glossary (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, normalized_name TEXT NOT NULL, payload TEXT NOT NULL, deleted_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS glossary_active_name ON glossary(normalized_name) WHERE deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS migrations (key TEXT PRIMARY KEY, digest TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_items (session_key TEXT NOT NULL, local_id TEXT NOT NULL, insight_id TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(session_key, local_id));
      CREATE TABLE IF NOT EXISTS conversions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES files(id), status TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS authoring_previews (id TEXT PRIMARY KEY, payload TEXT NOT NULL, published_document_id TEXT);
      CREATE TABLE IF NOT EXISTS authoring_drafts (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes (cursor INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    ` }, { version: 2, name: "Cache verified preview identity without hydrating candidate objects", sql: `
      CREATE TABLE IF NOT EXISTS preview_metadata (preview_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, preview_hash TEXT NOT NULL, payload_hash TEXT NOT NULL);
    ` }, { version: 3, name: "Index bounded workspace list queries without changing stored values", sql: `
      CREATE INDEX IF NOT EXISTS documents_created_order ON documents(created_at,id);
      CREATE INDEX IF NOT EXISTS documents_archived_created_order ON documents(archived_at,created_at,id);
      CREATE INDEX IF NOT EXISTS collections_label_order ON collections(label,id);
      CREATE INDEX IF NOT EXISTS collections_parent_label_order ON collections(parent_id,label,id);
      CREATE INDEX IF NOT EXISTS files_created_order ON files(created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS files_filename_created_order ON files(filename,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS proposals_document_order ON proposals(document_id);
      CREATE INDEX IF NOT EXISTS change_requests_status_order ON change_requests(CASE WHEN json_valid(payload) THEN json_extract(payload,'$.status') ELSE NULL END);
      CREATE INDEX IF NOT EXISTS glossary_deleted_order ON glossary((deleted_at IS NULL));
      CREATE INDEX IF NOT EXISTS glossary_document_order ON glossary(CASE WHEN json_valid(payload) THEN json_extract(payload,'$.documentId') ELSE NULL END);
      CREATE INDEX IF NOT EXISTS glossary_deleted_document_order ON glossary((deleted_at IS NULL),CASE WHEN json_valid(payload) THEN json_extract(payload,'$.documentId') ELSE NULL END);
    ` }];
