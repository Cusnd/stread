# Workspace service

This fully local service is the single persisted authority for the document library, ordered reading plan, checkpoints, insights, Q/N references, document revisions, review proposals, authoring drafts/previews and glossary. The browser HTTP API, Streamable HTTP MCP endpoint and forwarding stdio adapter use the same commands and SQLite database.

From the repository root, with Node 24 or newer:

```powershell
npm --prefix services/workspace install
npm --prefix prototypes/insight-composer run build
npm --prefix services/workspace start
```

The server listens at `http://127.0.0.1:4177`. It serves the built reader from `prototypes/insight-composer/dist/client`, the API under `/api`, and MCP at `/mcp`. The root development launcher may instead run Vite with these paths proxied to the service. The four bundled article directories are imported without changing their files; Attention revisions 1 and 2 remain available, with revision 2 current. No example reading telemetry, plan membership or sample insights are inserted.

## Configuration

| Environment variable | Default and purpose |
| --- | --- |
| `WORKSPACE_HOST` | `127.0.0.1`; only loopback binding is supported. |
| `WORKSPACE_PORT` | `4177`. |
| `CONTINUOUS_READER_DATA` | `services/workspace/.data`; owns SQLite, immutable content-addressed blobs and rendered page cache. |
| `CONTINUOUS_READER_STATIC_ROOT` | `prototypes/insight-composer/dist/client`. |
| `CONTINUOUS_READER_PYTHON` | `python` on Windows or `python3` on other platforms, resolved on PATH. Set this variable to an explicit interpreter with PyMuPDF when needed. |
| `CONTINUOUS_READER_AUTH_TOKEN` | Optional secret bearer token for a protected single workspace. The API, MCP, originals, rendered pages and exports all require it when configured. |
| `CONTINUOUS_READER_ALLOWED_ORIGINS` | Additional comma-separated loopback HTTP browser origins. External origins are ignored. Loopback Vite and preview origins are already allowed. |
| `WORKSPACE_URL` | For the stdio adapter only: `http://127.0.0.1:4177`; only loopback HTTP origins are accepted and redirects are rejected. |

A browser may exchange the configured token with `POST /api/session` and `{ "token": "…" }`. The response creates an eight-hour HttpOnly, SameSite=Strict cookie. Sessions are held in memory and expire on service restart. This is a single-workspace access boundary, not a multi-user account or OAuth implementation. MCP clients must be able to reach this computer; the Reader no longer supplies a public cloud endpoint.

Stop the service before making a filesystem backup of its data directory. Keep the database and blobs together. Existing glossary JSON and browser sessions remain preserved; the server records import digests and stable ID/reference mappings rather than deleting the originals.

Preview creation, inspection and exact-hash publication execute locally. Resource and preview URLs point at the loopback service. Obsolete remote/sync/preview environment settings and server options cannot enable a proxy, upload or transfer worker; the retired preview-upload route returns `LOCAL_ONLY`. Existing historical synchronization tables remain intact. `/api/sync/client/conflicts`, local object reads and guarded conflict resolution preserve access to saved history without a network client; an empty library is never enrolled by these reads.

## API and consistency

### Flow and recorded reading time

`GET /api/flow/summary?timezone=America%2FLos_Angeles&days=7` returns the ordered existing reading plan (`upcoming`, `planVersion`), all-library insight/unresolved-question/manual-review counts, and measured reading totals plus a daily series. `days` is a rolling 1–90 local calendar days including today. Optional inclusive `from=YYYY-MM-DD&to=YYYY-MM-DD` selects at most 366 days. The IANA timezone controls local midnight and daylight-saving boundaries; omitted timezone defaults to UTC. `trackingStartedAt` records when this feature was initialized. Earlier checkpoints are preserved, but never turned into invented historical sessions or duration.

`GET /api/flow/insights` returns `{ items, total, offset, limit, hasMore, activityRevision }`. Filters are `type=all|annotation|question|note`, `question=all|unresolved|resolved`, `review=all|pending`, `documentId` and `query`. Search matches the independent insight `title`, detailed `body`, source quote, document title or reference. Items retain stable insight/source identities, optional `title`, and add `documentTitle` and `review: { pending, addedAt, lastReviewedAt }`. Archived insights/documents are excluded. `GET /api/flow/history` supports `documentId`, `timezone`, `from`, `to`, `offset` and `limit`; it returns persisted session summaries, at most 12 insights created during each session (including their optional titles), and `days` with measured intervals split at local midnight. Pagination defaults to 30, accepts 1–100 items and never expands the workspace snapshot with every insight or session.

History shows a session only after it has accepted activity. A start awaiting its first interval, or a window whose intervals were entirely removed as overlaps, stays stored but is omitted from history counts and pages. Date filters require an actual accepted interval overlapping the selected local dates; the wall-clock span between session start and end does not fill inactive days.

Use `insight.review.add`, `insight.review.remove` or `insight.review.complete` through `/api/commands`, with `documentId`, `insightId`, `requestId`. This manual queue has its own SQLite membership; completing review removes the pending item and records `lastReviewedAt`. It does not answer a question or alter its content version. Archival temporarily hides membership and restoration keeps the same ID/reference. Review commands publish a workspace change so other views refresh. Derived `review`/`documentTitle` fields in read results cannot be written through `insight.save`.

Reading telemetry uses the same authenticated command endpoint:

| Command | Fields beyond `kind` and immutable `requestId` |
| --- | --- |
| `reading.session.start` | `sessionId`, `documentId`, `documentRevision`, `startedAt` (ISO instant), optional `position`, `mode` (`source`, `translation`, `bilingual`) |
| `reading.session.activity` | `sessionId`, positive `sequence`, `startedAt`, `endedAt`, `activeMs` (1–60,000, measured with a monotonic client clock) |
| `reading.session.end` | `sessionId`, `endedAt`, optional `position`, `reason` |

The client reports only visible, focused Reader activity, pausing on blur, hiding, idle or leaving the reader. It submits continuous intervals about every 15 seconds and retains immutable queued commands across offline retries. The service validates each interval against its session and the server clock (up to 30 days of delayed delivery), bounds its span, and subtracts already recorded overlaps for the same actor across all windows. `(sessionId, sequence)` is independently idempotent; changing an existing sequence conflicts even under a new request ID. Session ownership is checked before returning saved receipts. Late intervals may arrive after an end command only if they fit within that closed session.

These 15-second submissions are immediate local durable records. Every measured activity event and exact command receipt is retained in the local workspace. There is no cloud transfer schedule. Existing historical outbox requests, receipts, cursors, tombstones and conflict payloads are retained without automatically sending them.

Session commands use `workspaceChange: false` and an independent `activityRevision`; heartbeats do not reload Reader bodies or increment document versions. Totals are sums of accepted persisted intervals only. Nothing accrues after the last recorded interval, on service restart or from a checkpoint. The server does not infer attention from an open window. The client visibility/idle policy defines the meaning of measured reading activity.

Object width and font preferences use the same SQLite database, keyed by document ID and stable block ID in `object_preferences`. `GET /api/documents/:id/object-preferences` returns `{ documentId, objects }`. Submit `object_preferences.update` through `/api/commands` with `documentId`, `documentRevision`, `objects` and an idempotent `requestId`; each object patch accepts `widthPercent` (1–400) and/or `fontSize` (12–32), with `null` restoring the default width or following body typography. Patches merge only edited fields. The command does not revise content or modify insights, checkpoints or library metadata. The same authentication boundary applies.

The reader imports its former local cache with `onlyIfAbsent: true`, so existing server settings and explicit null resets win. Bundled examples use the canonical document ID too. Edits render immediately, coalesce for 350 ms, and use a serial write queue; visible clients refresh every five seconds and on focus/reconnection. Unacknowledged commands retain their request ID and pending fields in tab session storage, allowing retries after response loss or page reload. A failed request shows an unsynchronized status with a retry control; only acknowledged settings are durable on the server. Local storage is a cache, while body font size, overall reading width and other global browser preferences keep their existing scope.

Additional supported read paths are `GET /api/changes?after=N` and `GET /api/documents/:id/export?revision=N`. Change cursors increase after committed commands, including authoring publication. Exports return the retained JSON document, including unknown optional fields.

Commands use camelCase and require a `requestId`. A command receipt is checked before version checks, so retrying the same command after losing its response returns its original result. Reusing a key with a different payload returns `IDEMPOTENCY_CONFLICT`. Content writes use `expectedRevision`; library and insight updates use their separate `expectedVersion`. Q and N references are allocated inside the same transaction as the saved insight and receipt. Old type-specific references still identify the same insight. Ambiguous imported tab-local references require a document ID.

`document.revise` with `authorized: true` directly applies an explicitly authorized change. Without it, the command stores a concrete before/after proposal. Accepting that proposal rechecks its payload and exact original revision. The authorization flag declares the MCP host's user intent; authentication comes from the service boundary. Stored document text is always reference data and cannot authorize writes.

Original uploads are retained by SHA-256. Document resource paths resolve only through that document revision's resource map. Raw HTML, SVG, JSON and other active or textual originals are attachments with `nosniff` and a sandbox CSP. Sanitized reader content is separate from the retained uploaded bytes. Raster images and PDFs can be displayed inline. API errors use `{error, code, details?}` and do not return local-only success.

## Agent authoring and publication

Finished conversion is performed by the Agent. The service supplies original access, a target format, validators, resource binding, a live draft in the same reader used for publication, and transactional publication of an exact reviewed snapshot. It does not run a model or infer a complete article from a PDF. The Agent preserves source facts/relationships and chooses meaningful grouping, module composition and layout; the reader supplies consistent typography and interaction. Structure/resource validation, source fidelity and rendered review remain separate evidence.

`GET /api/authoring/contract` (MCP `get_authoring_contract`) returns the concise workflow and authorized HTTP downloads for the [complete authoring guide](authoring-guide.md), [strict authoring schema](authoring-schema.json), [editable all-type example](authoring-example.json), [adaptable layout examples](authoring-examples/index.md) and supporting references. Documentation is served under `/api/authoring/docs/`, including the relative paths used by the example index, resource manifest and offline ZIP. An external Agent does not need this checkout to obtain the contract. The small MCP response contains descriptors, not the full documents. Optionally pass `sourceId` on HTTP or `source_id` on MCP to include an uploaded original descriptor.

1. Find retained files with `GET /api/sources?filename=...` or `?query=...` (MCP `query_uploaded_sources` with `action: "list"`), or upload original bytes with `POST /api/sources?filename=...` and their actual Content-Type. `GET /api/sources/:id` / `query_uploaded_sources` with `action: "get"` returns a hash and authorized `/api/sources/:id/original` download URL. Source lists default to 10 and allow at most 20 items per page.
2. Author `reader-authoring-1` JSON using stable keys and faithful ordered content. Upload its UTF-8 bytes and any figure assets through the same upload endpoint. Bind every relative resource path to its uploaded file ID. New authoring uses strict field validation; extensions remain explicit, and unknown role/class behavior is diagnosed. The service does not accept arbitrary local paths or remote URLs as resource bindings.
3. Optionally call `POST /api/authoring/validate` with `{ "authoringSourceId": "file-id", "resources": { "source.pdf": "original-file-id", "figures/one.png": "figure-file-id" } }`. MCP `validate_authoring` uses `authoring_source_id` and the same `resources`. Repair errors and review warnings. Validation does not create a document; preview creation performs its own required checks.
4. Call `POST /api/authoring/previews` with the same fields plus `requestId`, or MCP `create_authoring_preview`. Open the returned `preview.previewUrl` in the real reader. This is a stable `/?draft=<draft-id>` URL; the separate `preview.snapshotUrl` is `/?preview=<preview-id>` for the frozen snapshot. Read-only preview does not add a library document or save reading activity to it.
5. Inspect source content, layout and interactions. Re-upload edits and call preview creation with a new request ID and `previousPreviewId` set to the latest successful snapshot. The same draft URL advances to a newly frozen snapshot, reusing confirmed identities through stable keys. A failed edit leaves the previous successful display intact with diagnostics; do not mistake it for successful rendering of the new input.
6. Publish only the draft's latest successful reviewed snapshot with `POST /api/authoring/previews/publish` / MCP `publish_authoring_preview`. HTTP supplies `previewId`, `expectedHash`, `requestId` and `review: { sourceReview, layoutReview, interactionReview, evidenceSourceIds? }`; MCP supplies `preview_id`, `expected_hash`, `request_id` and `review: { source_review, layout_review, interaction_review, evidence_source_ids? }`. The three review texts are required; uploaded evidence IDs are optional. Computer/browser inspection is accepted and no PDF export is mandatory. A stale hash, superseded snapshot or outstanding draft error prevents publication. The transaction publishes the frozen document/resources/artifacts without recompiling editable input. Reuse the same request ID and exact payload after response loss; a different payload under that key conflicts.
7. Keep the compact receipt, reader URL and artifact URLs. `GET /api/documents/:id/authoring?revision=N` / `read_resources` with `kind: "authoring_artifacts"` lists version-pinned downloads of the exact uploaded authoring JSON, identity registry, compiler/validation report and complete derived text index. Original files and bound image assets remain retained. Later direct content revisions preserve the input but expose `authoringRevision` and `matchesDocumentRevision`, so an old input is not presented as reproducing newer edits.

For an existing article, use `read_resources(kind:"authoring_artifacts", mode:"editing")` before this sequence; default `mode:"stored"` retains historical artifacts. Download the complete fixed-revision editing package, edit its `authoring`, reuse `resourceBindings`, and pass `target:{document_id,base_revision,base_hash}` to MCP validation/preview creation (HTTP uses `documentId/baseRevision/baseHash`). The exporter verifies a lossless semantic/identity round-trip from the selected saved revision and refuses unsupported exports rather than substituting older authoring. Publication uses the exact reviewed preview hash, rechecks the current base and affected-reference versions, then saves a new revision under the original document ID. Deletions/splits preserve historical references and expose unresolved targets. The [complete revision workflow](authoring-format-reference.md#revise-an-existing-article) explains target inheritance, conflicts and independent-state preservation.

### Preview and draft routes

| HTTP route | Input or result | MCP tool |
| --- | --- | --- |
| `POST /api/authoring/previews` | `{ authoringSourceId, resources, requestId, previousPreviewId?, target?: { documentId, baseRevision, baseHash } }` → `{ preview, validation }` | `create_authoring_preview` |
| `GET /api/authoring/drafts/:id` | `{ draft: { id, version, currentPreviewId, lastError }, preview, document, assetBase, validation, readOnly: true }` for the live reader | `inspect_authoring_preview` with `target: "draft"` returns bounded status/descriptors |
| `GET /api/authoring/previews/:id` | One immutable snapshot and its reader envelope | `inspect_authoring_preview` with `target: "preview"` returns bounded status/descriptors |
| `POST /api/authoring/previews/publish` | `{ previewId, expectedHash, requestId, review }` publishes the selected frozen content | `publish_authoring_preview` |

The `preview` descriptor includes `id`, `hash`, `draftId`, `previewUrl`, `snapshotUrl` and artifact descriptors. The live reader polls the draft endpoint; only the current snapshot pointer and status change. Old snapshot content and bound resource hashes remain fixed. When a continuing draft's compile fails, `lastError` records the failure while `currentPreviewId` still names the last successful snapshot. Repair and generate a new valid snapshot before publishing; the visible older content does not bypass the error gate. The frozen snapshot route remains useful for inspecting exactly what was reviewed.

HTTP fields use camelCase; MCP uses `authoring_source_id`, `previous_preview_id`, `preview_id`, `draft_id`, `expected_hash` and `request_id`. The MCP review object uses `source_review`, `layout_review`, `interaction_review` and optional `evidence_source_ids`; resource path keys are unchanged. Reviews record the checks actually performed, including uncertainty and unsupported cases; their presence is not automatic proof of source fidelity.

MCP publication uses only the reviewed-preview path above, so the published result matches what the Agent inspected in the reader. The retained internal `POST /api/authoring/publish` business route is not a public MCP tool or a compatibility alias.

### Optional local watcher

The [local watcher](scripts/watch-authoring.mjs) uploads files and maintains the same live draft without publishing. From the repository root:

```powershell
node services/workspace/scripts/watch-authoring.mjs <authoring.json> <resource-root> --url http://127.0.0.1:4177
```

Use `--previous <preview-id>` to continue an existing draft and `--once` to perform one update without watching. The URL defaults to `http://127.0.0.1:4177`; protected workspaces use `CONTINUOUS_READER_AUTH_TOKEN` from the process environment. The client checks authoring/resource hashes about once per second, uploads changes and submits another preview with the prior successful preview ID. Failed edits retain the last successful page and expose diagnostics. Publish explicitly only after reviewing the current valid snapshot. The watcher reads local paths as a client; it does not give the service arbitrary filesystem ingestion.

Success writes `preview-receipt.json` beside the input and prints the current draft/snapshot URLs and hash. A failed update leaves that receipt unchanged and `--once` exits nonzero. Malformed JSON reaches server validation, allowing an existing live draft to show its error while keeping the previous snapshot. Missing resources or filesystem links that escape the selected resource root are not uploaded; missing bindings fail validation. Restarting the client requires an explicit `--previous` to continue the draft; the saved receipt is not automatically adopted.

Originals, sources, contract documentation, drafts, previews, validation/publication and artifacts share the configured authentication boundary. Active/text originals and generated artifacts are attachment downloads with `nosniff` and a sandbox CSP. Authoring input is limited to 16 MiB and at most 2,000 resource bindings. Source-less syntax examples are supported without fabricated page mappings; this does not establish a conversion of an uploaded paper. The service does not automatically translate content. A local live preview is the preferred inspection path; server-side automated captures and PDF generation are not required parts of this workflow.

## PDF resources and retired extraction jobs

The legacy extraction workflow was retired on 2026-10-22. MCP no longer exposes `convert_document`, `get_conversion` or `cancel_conversion`; `/api/conversions` and its task routes are removed. The service no longer extracts article content, runs OCR, schedules conversion jobs or resumes interrupted extraction jobs. Agent authoring, validation, live preview and reviewed snapshot publication provide the supported conversion workflow.

Existing documents, revisions, insights, originals, resources and historical conversion rows remain retained. Historical queued/running rows are not runnable work after restart. Reading an already-created document does not require the old conversion engine. This retirement does not delete stored data or the shared PDF runtime.

Python and PyMuPDF still supply page metadata, original-page rendering and source-region matching. Authoring validation uses the original PDF page count to check submitted locations. Source fingerprints determine whether retained translations are current, stale or unconfirmed. The reader can display lazily rendered original page images from a hash-bound manifest. Its `regions` list preserves supplied normalized boxes (`provenance: "source"`) and derives line boxes for uniquely matched text passages within declared source pages (`provenance: "pdf-text"`), including paragraphs split across pages.

For standard tables and semantic HTML tables, the manifest can derive a whole-table box (`provenance: "pdf-table"`) from actual PDF table geometry or aligned horizontal borders, verified against the source header and body cells. Matching checks row associations, exact numeric punctuation/tokens and uniqueness across candidate source pages; captions alone never establish a table region. Geometry detection uses disposable unrotated page copies, and normalized output uses the unchanged source page's crop and rotation. Derivatives are cached by matching-algorithm version, PDF hash and every matching field (including table headers, rows and source HTML), without changing revisions or source metadata. Ambiguous/unmatched content, scanned pages, borderless or split tables without a unique verified extent, and other objects without supplied coordinates retain page-only mappings. This runtime matching supplements source locations; it does not establish the authored table's completeness or fidelity.

Limits are 100 MiB per upload, 16 MiB per authoring input, 2,000 PDF pages and 120 seconds per PDF helper invocation. A failed authoring validation or preview does not publish a partial document. Uploaded originals remain retained for recovery and inspection.

## MCP tool inputs

### Article relations

`GET /api/documents/:id/relations` returns the current bibliography relations and incoming citations. Relations have their own stable IDs and write versions, independent of document body revisions. Matching runs locally when documents are imported, published, revised, archived or restored. DOI/arXiv matches and consistent title/author/year metadata can resolve automatically; ambiguous identities remain candidates with evidence. Unimported references retain work identities so a later import can resolve them. User dismissals persist across rescans and restarts. Historical revision queries return `readOnly: true` and no current relationships.

MCP `list_document_relations` takes `document_id`, `direction` (`outgoing` or `incoming`) and the ordinary bounded pagination parameters. `set_document_relation` takes `document_id`, `relation_id`, `expected_version`, `action` (`link`, `dismiss`, `reset`), `request_id`, and `target_document_id` for linking. `authorized: true` declares an already authorized operation; otherwise it stores a concrete `kind: "relation"` review proposal. The corresponding HTTP commands are `relation.link`, `relation.dismiss`, and `relation.reset`, using camelCase fields through `/api/commands`.

An operation can include `change_request_id` and `expected_change_request_version` to complete an existing R request in the same transaction. Successful application records `appliedRelationId` and `appliedRelationVersion`, without creating a body revision. Proposal creation, failure and version conflicts leave the request pending. Saving a request does not execute an Agent. External metadata enrichment and semantic relationships are outside this first local workflow. See [article relationship behavior](../../spec/文章关联.md).

### General inputs

Connect a Streamable HTTP client to `/mcp`, or run `node services/workspace/stdio.mjs` against the already-running service. The stdio adapter forwards calls and never opens its own database. Set `WORKSPACE_URL` and, for a protected workspace, `CONTINUOUS_READER_AUTH_TOKEN` in the MCP process environment.

The 2026-10-23 SDK upgrade uses `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.3.1 plus `@modelcontextprotocol/node` 2.1.1. Local HTTP supports MCP `2026-07-28` discovery and request envelopes, while the same `/mcp` endpoint preserves earlier stateless JSON protocol requests. The stdio forwarder accepts both protocol eras and negotiates upstream. Discovery, listing and calls retain authentication. Since 2026-10-25 the active product is fully local; connect MCP to this loopback service. Retired cloud implementations are not an active service in this public source snapshot. Separately, MCP server **0.6.0** exposes exactly **32 public tools**, with no old tool-name/parameter aliases and no legacy/daily catalog. This server version is independent of SDK and desktop package versions. Reconnect clients to refresh the catalog; see the [current tool contract](mcp-management.md) and [migration mapping](mcp-tool-mapping.json).

This protocol upgrade does not advertise or implement business MCP Events. Notifications that wake an Agent on a new change request or completed task additionally require a persistent event catalog, authenticated subscriptions, verified webhook callbacks, signed delivery and a retry outbox. Do not treat SSE, the workspace change cursor, or SDK task notifications as that feature.

MCP target fields use snake_case at the adapter boundary, including `query_glossary.document_id`; old camelCase MCP parameters are rejected. Merged reads use top-level `action/view/kind/target`. The six merged writes use `{authorized:true, request_id, operation:{action,...}}`, with IDs and expected versions inside the selected operation. Unmerged tools retain their own top-level fields. In particular, `revise_document.operations` is a typed union on **`kind`**, not `op`.

### Bounded context contract (2026-10-24)

`get_document` and `read_document` are removed from MCP. The reader's HTTP document API still supplies its own rendering data. MCP does not return unbounded document objects, raw full HTML/table objects, or full before/after snapshots in write receipts. Continuous reading can finish a short document's indexed blocks or a table's text within budget, and uses bounded pages for larger content.

Start with `resolve_reference` for `#Q00001`, `#N00001` or `#R00001`, or `query_documents` with `action: "search"` for exact text addresses. `read_context(view:"exact")`, also the default when `view` is omitted, requires a saved reference with a source anchor, or `document_id` plus `block_id`. It defaults to **2000 UTF-16 code units total across all segments**, with a hard maximum of **6000**. `before_chars` defaults to 300; set it to 0 for a cell-only read. The chosen language defaults to the source language; translations are requested explicitly. Missing or detached anchors return an error rather than falling back to the document start.

Each segment has its exact address, start/end offsets, total field length, truncation status, source hash, translation state and up to three PDF source locations. `next` is a ready-to-use continuation request pinned to the same document revision. A long field or multi-entry block can be read in bounded pages; later revisions cannot silently change the text beneath a continuation. Source mappings describe the containing source block, not character-level PDF boxes.

For continuous reading, `read_context(view:"outline", document_id)` discovers actual heading levels, section IDs and any untitled preamble. A section ends at the next heading, including a child heading. `view:"content"` reads across blocks, optionally within one returned `section_id` or starting from `block_id` through the end. Outline/content have a 32-section/span limit and a 64 KiB UTF-8 response limit counting both text and `structuredContent`, in addition to the shared 6000 UTF-16 text limit. Reuse the complete `next` to retain scope, revision, language and projection version.

Projections declare `contentScope:"blocks", metadataIncluded:false`; they exclude metadata/title. Use metadata queries or exact `$meta`/`title` reading when needed. `coverage.complete` ends only the selected range; document traversal and complete supported content are separate flags, and none proves the caller inspected all preceding pages. Image bytes remain unavailable until separately fetched; captions/alt text are not image inspection. Missing translations and unavailable/unsupported/truncated semantics stay explicit. Read projections are not editable exports. See [the detailed reading contract](mcp-management.md#continuous-reading-and-exact-addresses).

```json
{"reference":"#R00001","max_chars":600}
```

Lists default to 10 entries and allow at most 20; oversized list pages stop earlier and report the actual `nextOffset`. Use the full returned `next`, including version-bound `continuation`, rather than constructing the next call from that offset. Tokens bind actor, filters, page size and offset; changes return a scope/list conflict and require restarting the read. Bare `offset` remains an independent `fresh_range` query without cross-page consistency. Insight and request lists return 240-character body previews, without saved answers. `resolve_reference` returns a bounded body, quote or answer and a version-pinned `next`; answer text preserves formula delimiters. Search returns short excerpts with exact match offsets. PDF manifests are paginated; image/original bytes stay behind authorized HTTP URLs. `query_documents(action=list, document_id)` supplies the original source descriptor when needed.

For Codex CLI, connect the ordinary HTTP MCP server, for example with `codex mcp add reader --url http://127.0.0.1:4177/mcp`. Supported Codex model/provider combinations already defer MCP tools through native discovery; do not add the retired `tool_search` feature flags or a made-up MCP `defer_loading` setting. The server exposes distinct typed tools, including authoring/source/preview/artifact tools, with shared instructions preserved through both HTTP and stdio. Discover the current catalog and `get_authoring_contract` rather than relying on a historical tool count. No generic executor or per-connection catalog mutation is used. Validate the intended client connection separately from service protocol tests.

```json
{
  "document_id": "doc-example",
  "expected_revision": 3,
  "request_id": "a-new-id-for-this-deliberate-write",
  "authorized": true,
  "operations": [
    {
      "kind": "replace",
      "block_id": "paragraph-id",
      "field": "text",
      "value": "Corrected source text."
    }
  ]
}
```

| `kind` | Required fields and supported targets |
| --- | --- |
| `replace` | `block_id`, `field`, `value`. Text fields use a string. `head/rows` use either a string plus both zero-based `row/column`, or a complete string matrix without cell coordinates. Optional `variant`, `item_id`, `node_id`; translation writes also need the current `source_hash` returned by a read. |
| `replace_range` | The same exact text address plus `start`, `end`, `expected_text` and a string `value`. Offsets are UTF-16; the expected substring and document revision must match. Works on paragraph/list/title/math text, table cells and HTML text nodes. Preserves unread text and HTML inline formatting; a range crossing an HTML formula or structural separator is rejected. |
| `insert` | Exactly one `before_block_id` or `after_block_id`, plus a `block` with its content type and fields. The service assigns new IDs and `origin: "user"`; supply the actual content `language`. No PDF source mapping may be fabricated. Unknown optional block fields survive. |
| `remove` | `block_id`. New dangling internal links fail validation; existing insight excerpts remain and become unresolved when their target disappears. |
| `move` | `block_id` and exactly one `before_block_id` or `after_block_id`. Identity and source mapping stay attached to the block. |

For a table cell, use `field: "head"` or `"rows"` and zero-based `row` and `column`. For an HTML identity, use `field: "html_text"`, its `node_id`, and a string `value`; the server modifies retained markup and rebuilds the derived index. Use `block_id: "$meta"`, `field: "title"` for the document title. `read_context` accepts the same address filters. Never pass a truncated excerpt as a whole-field `replace`; use `replace_range` for that excerpt's exact offsets instead. Write replies contain IDs, versions, bounded change previews and request/proposal status; the complete resulting document stays in the service.

The registry schema expresses these branches directly, including required range fields and exactly one insert/move placement anchor. A batch applies in order and commits atomically; later ranges address the result of earlier operations. Individual operation failures include zero-based `details.operation_index` and the target where available. The [recovery contract](mcp-management.md#output-contracts-and-recovery) distinguishes exact retry, reread, input repair, authorization and unknown outcomes. An unknown write outcome, including an output-contract failure, must retain the original request ID/payload.

`update_insight` takes outer `authorized:true`, `request_id` and `operation`. The operation contains `action:create/update`, `document_id` and `insight`; update requires `insight.id` and `expected_version`, while create rejects an existing ID. Archive/restore use `insight_id` and `expected_version`. Insight `revision` identifies the quoted body version, distinct from its write version. Types are `annotation`, `question`, `note`; create requires `body` and `color`. An anchored empty annotation is a highlight; questions/notes need text. Answers use `answer_question` with explicit authorization and typed heading/paragraph/math blocks; failed saves leave questions unanswered. Explicit glossary lifecycle actions use `update_glossary.operation`. See [the complete contract](mcp-management.md) and [file grants](file-access.md).

Insights may carry a separate, editable `title`. HTTP `insight.save` and MCP `update_insight` apply the same contract: an explicitly supplied title must be a string, is trimmed at both ends, and must then be one line of at most 200 UTF-16 code units. Embedded CR, LF, NEL and Unicode line/paragraph separators are rejected. Omit `title` in an update to preserve its current value; `""` or whitespace-only input saves `title: ""` to clear it. Titles do not replace or satisfy required note/question bodies. Existing insights without titles remain untitled; reads and migrations never synthesize a title from the body. A title edit uses the existing insight version check and preserves ID, reference, source addresses, answer and review membership.

Document envelopes, insight lists, references, Flow results and persisted receipts retain the optional title. MCP list/write summaries expose it separately from the bounded body preview; `resolve_reference` additionally accepts `part: "title"` for version-pinned title reads and returns empty title text for untitled insights. No document revision or database backfill is needed because the title is stored in the existing insight payload.

## Verification

Run `npm --prefix services/workspace test`. Tests create independent temporary stores, use actual HTTP and MCP clients, and cover retries/conflicts, concurrent reference allocation, approved answers, exact proposals, HTML node edits and translation provenance, detached references, metadata/plan/checkpoint state, legacy aliases and drafts, glossary tombstones, restart recovery, authentication, unsafe retained originals, immutable source hashes and crop/rotation coordinates.

The registry declares 22 core successful-result `outputSchema`s and validates them before returning; tool-handler errors use a separate bounded recovery contract. Generate current contract documentation and schema-valid placeholder examples with `node services/workspace/scripts/generate-mcp-contract.mjs`, or check freshness without writing using `--check`. Output is tracked under [`generated/`](generated/generated-contract.md); generated examples do not execute business calls or confer authorization. The independently maintained 32-name mapping and catalog/branch tests remain separate acceptance checks. Reading, precise-operation, continuation/recovery and full-authoring-revision tests exercise the 0.6.0 additions; these are local contract checks, not model-performance or billing measurements.

The authoring tests download the complete guide and all-type example, bind actual PDF/image uploads, validate without publishing, repair a malformed merged table and publish through the formal HTTP/MCP path. They check source/resource hash mismatches, missing resources, out-of-range pages, path rejection, title/list translation provenance, exact authoring bytes, all four artifact downloads, concurrent/restart idempotency, unchanged prior documents/insights and protected source/docs/artifact access. These checks do not claim automated source-content correctness.

`tests/authoring-preview.test.mjs` exercises successful draft updates, stable document/block/item/HTML-node identities, failed-update diagnostics with the old snapshot retained, immutable hashes/resources, newest-snapshot/hash/error gates, required review texts, optional evidence bindings and exact frozen publication. It also covers restart recovery, request retries, competing edits/publications, authenticated PDF resources and compact MCP replies with snake_case review fields. `tests/authoring-watcher.test.mjs` runs the real CLI against an isolated HTTP server for resource-only edits, malformed JSON, missing or escaped resources and receipt retention. These are service/CLI checks; browser checks still use the actual read-only reader and verify that preview interactions do not save production reading activity. Capture generation, source fidelity and Agent review are separate evidence; a PDF file or screenshot alone does not establish all three.

PDF resource tests retain coverage for original-file hashes, page dimensions, crop/rotation coordinates, rendering and source mappings. Service fixtures publish authored content through the preview workflow; the service does not infer a completed article or perform OCR. These checks establish local transport, resource and persistence behavior. Browser appearance, motion, focus, PDF follow behavior and actual ChatGPT account access have separate acceptance checks.
## Offline storage inspection

Storage uses versioned schema migrations and retained immutable objects. Before a migration, inspect a stopped workspace or validate a separate copy:

```powershell
node services/workspace/scripts/storage-maintenance.mjs inspect <data-directory>
node services/workspace/scripts/storage-maintenance.mjs plan <data-directory>
node services/workspace/scripts/storage-maintenance.mjs copy-validate <data-directory> <new-evidence-directory>
```

The [maintenance tool](scripts/storage-maintenance.mjs) retains a consistent `before/` backup, migrates only a separate candidate, and validates raw/business semantics and independent reading projections. It never replaces the source automatically. Keep the database, retained objects and original files together for rollback. Temporary evidence may contain private paths and data, so keep it outside the public source tree or under the ignored `.audit/` directory. These local checks do not establish acceptance of a personal library or a future schema.
