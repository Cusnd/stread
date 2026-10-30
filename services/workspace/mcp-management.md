# MCP tool contract

MCP server **0.6.0** exposes exactly **32 tools**. HTTP MCP and the desktop stdio forwarder expose the same catalog. This replaces the older names and parameter shapes; there is no legacy catalog, alias layer or daily subset. Reconnect an existing client to refresh `tools/list` and initialization instructions. The [migration mapping](mcp-tool-mapping.json) records where each earlier operation now belongs.

Tools use the same workspace service, objects and database as the desktop application. They retain bounded results, stable identities, version checks and idempotent receipts. This interface change does not discard documents, insights, glossary entries, authoring drafts, reading activity or synchronization state. Desktop HTTP commands are a separate internal contract; their camelCase fields are not MCP parameter aliases.

As of 2026-10-25, execution and storage are fully local. This changes no tool names, input schemas, output schemas or business capabilities. Local HTTP and stdio share SQLite, files, scoped resource links and the same reviewed immutable preview/publication workflow. Cloud delivery is retired; external Agents connect through a client able to access this computer.

## Queue resources and task identities

Queue adds MCP resources, not public tools or tool input fields. Desktop stdio and loopback HTTP expose the same resource reads and the same 32 tools. Task content remains user data; a saved task is not blanket authorization for an external Agent to act.

- Read `stread://queue` for the first page of pending tasks. Each summary has its immutable UUID, stable `#T00024` reference, version, type, related objects, and a task resource URI. Read the full task before acting on a clipped summary.
- Read filtered lists at `stread://queue/list?type=all&status=pending&limit=10`. The advertised template `stread://queue/list?{+filters}` accepts `type`, `status`, `query`, `offset`, `limit`, and `revision` query parameters. Types are `all`, `conversion`, `correction`, `translation`, `question`, `instruction`; statuses are `all`, `pending`, `processing`, `needs_attention`, `completed`, `cancelled`. The default is pending tasks of all types. `limit` is 1–20. Follow the returned `next` URI exactly; a changed queue revision requires starting again.
- Read `stread://queue/tasks/{taskId}` using its UUID, `T00024`, or URL-encoded `%23T00024`. The template also accepts `part`, `offset`, `expected_version`, `max_chars`, and `source_index`. Text is bounded to 100–6000 characters per request, and continuations retain the task version.
- Existing `resolve_reference` accepts `#T00024` with its unchanged input schema and returns the same bounded text structure plus `task` and `workflow`. A task before publication has no `documentId`. Linked `#R`, `#Q`, and `#N` identities retain their existing meaning. A task's `answer` text is read through its linked Q reference rather than duplicated under T.

The returned `workflow.reads` gives exact next reads using existing tools. For conversion, get the retained uploaded source and authoring contract, then keep the returned binding in the authoring source:

```json
{
  "extensions": {
    "stread.queue": {
      "taskId": "the-task-uuid",
      "taskVersion": 1
    }
  }
}
```

Use the exact task version and source. Editing or withdrawing the task invalidates stale work; re-read and reassess the request, rather than changing a binding to bypass a guard. The regular source-first independent reviewer, live Reader inspection, latest frozen hash and reviewed publication requirements all apply. Successful publication completes the linked conversion task; creating a candidate does not. For article changes, preserve the linked R request ID and version in the existing revision or relation operation. For questions, save the answer to the same Q object through `answer_question`. Queue completion follows these saved results, with no generic mark-complete shortcut.

Resource reads require the same workspace read authorization as tools. They do not grant write access, claim tasks, run Agents, or expose file bytes. Download originals and inspect candidates through existing authorized file/preview descriptors. A copied or read task remains pending until real work changes its state.

## Catalog and read branches

Read discriminators are top-level parameters. Each branch accepts only its documented fields. Continue with returned `nextTool` and `next` arguments; continuations include the discriminator required by the public tool.

| Tool | Parameters and result |
| --- | --- |
| `query_documents` | `action: list/search/metadata`. List unifies `document_id`, `collection_id`, `status`, `tag`, `include_archived`. Search adds `query` and optional `variant`, returning bounded hits with exact addresses. Metadata reads one progressive field using `document_id`, `part`, `offset`, `limit`, `max_chars`, `expected_version`; nonzero offsets require the version. Text parts are `title/kind/summary`; list parts are `tags/collections`. |
| `list_collections` | IDs, labels, parent IDs and versions. Omitted `parent_id` lists all; `null` selects roots; an ID selects direct children. |
| `read_context` | `view: exact/outline/content`; omitted view means `exact`. Exact uses a document/block or Q/N/R source address with optional list/table/HTML coordinates. Outline discovers real sections; content reads continuously across blocks. See the reading rules below. |
| `resolve_reference` | Bounded T task or Q/N/R title, body, quote or answer content, stable identity and source address. A source-conversion T task may have no document yet; its result contains `task` rather than `insight` or `changeRequest`. Surrounding document text and a task's linked Q answer are read separately. |
| `read_resources` | `kind: asset/pdf_pages/authoring_artifacts`. Asset takes `document_id`, `path`, optional `revision`; PDF pages take `document_id`, optional `offset`, `limit`, `revision`; artifacts take `document_id`, optional `revision`, and `mode: stored/editing` (default `stored`). Stored artifacts retain historical authoring; editing exports the selected revision's verified complete editing package. Descriptors and short-lived URLs only. |
| `query_insights` | Optional `query` defaults to empty; `state: active/archived/all`, optional `document_id`, `type`, `question`, `review`. Bounded previews, references, versions, archive state and independent review membership. |
| `get_reading_plan` | Persisted order, absolute `planIndex`, saved positions and `planVersion`. Archived members remain visible until removed. |
| `query_reading_activity` | `view: summary/history`. Summary returns measured totals and daily statistics; history returns the authenticated actor's sessions with document/date filters and compact positions. `timezone` defaults to UTC; supply the viewer's IANA timezone. Summary `days` is 1–90; inclusive `from/to` spans at most 366 days. Daily-series pagination does not change totals. History includes at most three insight previews and seven daily details per session. |
| `list_change_requests` | Bounded request summaries and versions. Saving a request is neither execution nor authorization. |
| `list_revision_proposals` | Bounded change previews and status; full before/after snapshots stay in the reader. |
| `list_document_relations` | `direction: incoming/outgoing`, evidence, candidates and stable source/target identities. |
| `query_glossary` | `action: list/search/get`. List supports optional `document_id`, `include_deleted`; search requires `query` and supports `include_deleted`; both paginate. Get uses UUID `id` and revision-pinned definition continuations. Original definitions, aliases, source association and deletion state are retained. |
| `get_object_preferences` | Bounded persisted sizes/fonts with `documentRevision` and `workspaceRevision`. |
| `query_uploaded_sources` | `action: list/get`. List supports filename search and pagination; get uses `source_id`. Returns file descriptors, hashes and scoped URLs. |
| `get_authoring_contract` | Format, schema, guide, examples and HTTP route information. |
| `validate_authoring` | `authoring_source_id`, uploaded resource bindings in `resources`, and optional `target: {document_id, base_revision, base_hash}` for an existing article. Structural/resource and revision-target validation without creating preview or publication state. |
| `inspect_authoring_preview` | `target: preview/draft`, with respectively `preview_id` or `draft_id`. Preview is immutable; draft tracks its latest successful preview and `lastError`. Returns the local candidate's exact hash, validation and scoped local preview/artifact URLs for Reader review. |
| `update_document` | Write: metadata/archive/restore. |
| `update_collection` | Write: create/update/remove. |
| `update_insight` | Write: create/update/archive/restore. |
| `answer_question` | Write: typed answer and question resolution in one transaction. |
| `set_insight_review` | Write: add/remove/complete review membership independently of answers. |
| `update_reading_plan` | Write: add/remove/move. |
| `update_change_request` | Write: create/update/cancel/reopen. |
| `revise_document` | Write or create a proposal, retaining exact source addresses and document revision checks. |
| `decide_revision_proposal` | Write: accept/reject a stored proposal after checking its target revision. |
| `set_document_relation` | Write or create a proposal: link/dismiss/reset with its relation version and evidence. |
| `update_glossary` | Write: explicitly requested create/update/remove/restore. |
| `update_object_preferences` | Write: atomic batch with document/workspace revision checks. |
| `prepare_source_upload` | Write: short-lived filename-bound upload grant; bytes use the returned HTTP URL. |
| `create_authoring_preview` | Write: freeze a candidate, optionally for an existing-article `target`, or continue a draft with `previous_preview_id` and its inherited target. |
| `publish_authoring_preview` | Write: publish the reviewed newest snapshot with exact `expected_hash` and review evidence. |

Lists default to ten entries and accept at most twenty. The projection budget may return fewer; reuse the complete returned `next` with `nextTool`, including any continuation token. Text defaults to 2,000 UTF-16 units and has a hard maximum of 6,000 per read. Compact previews are not complete replacement values. Binary files and authoring artifacts use [scoped URLs](file-access.md).

## Continuous reading and exact addresses

| `read_context` branch | Scope and continuation |
| --- | --- |
| `exact`, or omitted `view` | Requires an anchored Q/N/R reference or `document_id` plus `block_id`. Optional field, variant, item/node and zero-based cell coordinates narrow the target. `start`, `entry_offset` and `before_chars` control exact text and nearby context within one shared character budget. Missing anchors fail explicitly. |
| `outline` | Requires `document_id`; optional `revision` and `variant` select the version/language. Returns real heading levels and stable `sectionId` values, plus an untitled preamble when blocks precede the first heading. A section ends at the next heading, including a child heading; it is not a recursive subtree. |
| `content` | Requires `document_id`; reads the document's `blocks` in order. Use a returned `section_id` for one section, or `block_id` to start at that block and continue to the document end; these selectors are mutually exclusive. Long fields and tables continue across pages. |

Outline/content responses are read-only projections with a shared **6,000 UTF-16** maximum, **32 sections/spans** maximum, and **64 KiB UTF-8** response maximum. The byte budget counts the serialized MCP result containing both `content` text and `structuredContent`; it is not a second allowance for each copy. Separators count toward the text budget. These independent limits may end a page early. Follow the returned `next` unchanged: its cursor pins the document revision, language, projection version, selected scope, entry order and offset. `currentRevision` separately reports the current head; a continued old revision does not become the head silently.

Both projections explicitly report `contentScope: "blocks"` and `metadataIncluded: false`. They exclude metadata such as the document title. Read library metadata through `query_documents(action:"metadata")`; for the revisioned body title use exact `read_context` with `block_id:"$meta", field:"title"`.

Content `spans` map projected text back to block/item/cell/node addresses, source offsets, field, source hash, language and translation state. They preserve indexed TeX, table coordinates, available HTML table/list/link relationships and footnote markers, with explicit flags when structural metadata is incomplete. They are not editable document objects. Before a precise change, reread the exact target and check its current revision; never replace a whole field with a truncated projection.

`coverage.complete` means the requested range has no remaining page. `contentComplete` additionally excludes unavailable/unsupported content and truncated semantics in that range. `documentTraversed` requires reaching the end of a range spanning all blocks; `documentComplete` additionally requires complete supported content there. These flags remain limited to `blocks`, exclude metadata and do not prove that the caller read preceding pages. A completed section or suffix is not a completed whole-document read. Images are marked `unavailable` with `image_bytes_not_read`; alt text/captions do not mean image bytes were inspected. Missing translations and unsupported structures also remain explicit. Use resource URLs when the task requires original images or PDF inspection.

## Stable list continuations

Document list/search, collections, insights, plans, activity, glossary list/search, change requests, proposals, relations and uploaded-source lists return version-bound continuations. Each token binds the tool branch, actor, filters, page size and next offset to a stable data version. Reuse the complete `next`; changing its filters or offset fails with `CONTINUATION_SCOPE_MISMATCH`, while a changed data version fails with `LIST_CHANGED`. Restart the read and reassess previously collected pages after such a conflict. Some guards conservatively use the workspace version, so an unrelated write can require restarting a list.

An `offset` read without a continuation remains supported as an independent `consistency.mode:"fresh_range"` query. It does not promise consistency with an earlier page. Successful token continuation reports `mode:"continued"` and the same `snapshot`. Metadata, glossary-definition and exact text reads retain their separate version-pinned continuation rules.

## Merged write shape

The six merged write tools accept a strict outer object containing `authorized`, `request_id` and `operation`. The operation is a discriminated union containing `action` and that action's fields. Do not place action/IDs/versions beside `operation`, or authorization/request fields inside it. Unknown fields and fields belonging to another branch are rejected.

Example for `update_reading_plan`:

```json
{
  "authorized": true,
  "request_id": "a-new-request-for-this-deliberate-change",
  "operation": {
    "action": "move",
    "document_id": "document-id",
    "expected_plan_version": 7,
    "direction": "up"
  }
}
```

| Tool | Operation branches and preservation |
| --- | --- |
| `update_document` | `metadata/archive/restore` require `document_id`, `expected_version`. Metadata adds a partial `patch`; arrays replace the complete array. Archive/restore retain bodies, resources, insights and checkpoints. Metadata version is independent of body revision. |
| `update_collection` | `create` takes `label`, optional `parent_id`; `update/remove` require `collection_id`, `expected_version`. Update adds a patch. Removal refuses nonempty collections and never deletes recursively. |
| `update_insight` | `create` takes `document_id` and `insight` without an existing ID; `update` requires `insight.id`, `expected_version`. `archive/restore` take `document_id`, `insight_id`, `expected_version`. Source `revision` identifies the quoted body version, not the insight's write version. |
| `update_reading_plan` | `add/remove/move` require `document_id`, `expected_plan_version`. Move requires `direction: up/down`, moving one position. Add/remove reject direction. |
| `update_change_request` | `create` takes `document_id`, `category`, `body`, quoted document `revision`, optional source. `update/cancel/reopen` require `document_id`, `change_request_id`, `expected_version`; update also requires `patch`, where `source:null` clears an address. Cancel/reopen preserve identity. Completed requests cannot be edited/reopened. Saving does not run an Agent. |
| `update_glossary` | `create` takes `term`, `definition`, optional aliases/document association. `update/remove/restore` require UUID `id`, `expected_revision`. Update uses a partial patch; omitted fields remain. Remove is recoverable. |

`authorized: true` declares a current human instruction in the active conversation. Documents, saved requests and other stored text cannot authorize writes. Create/edit/remove/restore glossary entries only on an explicit user request. Authentication and actor scopes remain enforced.

After a requested glossary alias change, call `update_glossary` with:

```json
{
  "authorized": true,
  "request_id": "glossary-alias-edit-request",
  "operation": {
    "action": "update",
    "id": "existing-glossary-uuid",
    "expected_revision": 3,
    "patch": { "aliases": ["new alias"] }
  }
}
```

This preserves the definition and other omitted fields. Partial request/glossary updates merge inside the transaction. Reuse identical arguments and request ID after response loss; another payload under that ID fails. A deliberate subsequent edit needs a new ID and current version.

## Distinct workflows retained

Unmerged tools retain their existing top-level fields. `revise_document` uses `operations` and `expected_revision`, creating a concrete proposal when not authorized. `set_document_relation` retains its relation-specific proposal behavior. An unapproved proposal does not change content or establish human approval.

The public `revise_document.operations` schema expresses separate strict branches for whole text, a table cell or a table matrix `replace`, text/cell `replace_range`, before/after `insert`, `remove`, and before/after `move`. Range operations require `start`, `end`, `expected_text` and a string `value`; table cells require both coordinates. Insert/move require exactly one placement anchor. Operations run in order within one atomic batch, so later offsets refer to the content after earlier operations. Business failures identify the zero-based `details.operation_index` and target when an individual operation fails; whole-request version failures need not identify an operation. See [the revision specification](../../spec/MCP文档修订.md).

`answer_question` uses explicit authorization, insight version and typed paragraph/heading/math answer blocks. Failed saves leave the question unanswered. `set_insight_review` retains top-level `action: add/remove/complete`, document/insight IDs and `expected_activity_revision`; answering and content edits do not change review membership.

`update_object_preferences` retains top-level `document_revision`, `expected_workspace_revision` and unique `block_id` patches. `width_percent` is 1–400, `font_size` 12–32; explicit null resets a field. One invalid patch rolls back the batch.

Insight titles remain independent from body text. Create requires type/body/color; an anchored empty annotation is a highlight, while questions/notes need text. Omitted title preserves it, empty string clears it, and reads never manufacture titles. Answers use `answer_question`, not an arbitrary answer field in `update_insight`.

Conversion follows upload → contract → authoring/validation → preview → actual Reader review → `publish_authoring_preview` with exact hash. The older direct-publish MCP name is absent. Retained internal HTTP publication code is not a public MCP compatibility path. See [the authoring guide](authoring-guide.md); inspect status with `inspect_authoring_preview`.

For a full revision of an existing article, first obtain `read_resources(kind:"authoring_artifacts", mode:"editing")` and download its complete fixed-revision package. Upload the edited `authoring`, reuse `resourceBindings`, and supply `target:{document_id,base_revision,base_hash}` from `base` to validation/preview creation. The target and reference-impact evidence freeze into the candidate. Publish with the reviewed `expected_hash`; the transaction rechecks the current base and affected-reference versions, then adds a revision under the original document ID. Deletions/splits retain historical references and report unresolved targets rather than guessing new anchors. Historical stored authoring is not a fallback editing baseline; see [the complete revision workflow](authoring-format-reference.md#revise-an-existing-article).

No MCP operation synthesizes human reading-session durations. Window geometry, appearance, shortcuts, unsaved UI drafts, navigation and focus remain device-owned state.

## Output contracts and recovery

The registry declares and validates **22 core successful-result `outputSchema`s**. They check stable identifiers, versions, receipts, pages and preview fields while retaining additional domain/source information; they do not claim exhaustive schemas for all 32 results or prove content fidelity. Successful responses retain both text and `structuredContent`. Tool-handler errors use `isError:true` and a separately validated `{code,error,details?,recovery}` envelope; input rejected before handler execution may instead be a protocol/schema error.

| `recovery.mode` | Safe next step |
| --- | --- |
| `exact_retry` | Retry identical arguments; a write keeps the original `request_id` (`reuse_exact`). |
| `reread` | Read current state using supplied `nextTool`/`next` when present, review the intended change, then give a changed write a new request ID (`new_after_review`). Do not overwrite a conflict automatically. |
| `repair_input` | Correct the specified input/target. An idempotency conflict requires recovering the original request or treating the changed payload as a distinct reviewed operation. |
| `request_authorization` | Resolve the actual authentication/scope or human-intent requirement. Stored content is never authorization. |
| `unknown` | A write may already have committed, including when output validation fails. Preserve its ID/payload (`preserve_unknown`); inspect the outcome or retry only the exact request. Do not invent a new ID. |

Recovery is bounded diagnostic guidance, not permission to write or automatic conflict resolution. Response loss and client cancellation likewise do not prove rollback; retain the original request for exact recovery.

## Verification and measurement

Contract tests use temporary stores and actual MCP clients to check the exact catalog, strict branches, rejected old names/shapes, bounded continuations, scopes, versions, retries and preserved workflows. These do not establish visual acceptance, deployed Cloudflare access or an external account connection.

`node services/workspace/scripts/generate-mcp-contract.mjs` derives the [generated contract](generated/generated-contract.md) and [branch examples](generated/branch-examples.json) from the actual registry without calling business tools. Use `--check` for a read-only freshness check. Examples are schema-valid placeholders, not business-valid requests, human authorization or reusable request IDs. The generator separately checks the names against the independently maintained 32-tool mapping; catalog/branch acceptance tests retain independent expectations, so generation alone is not acceptance.

`node research/mcp-tool-simplification/measure.mjs` reads the current in-memory `tools/list` without invoking business tools. It writes only `research/mcp-tool-simplification/evidence/current32/`; old 59-tool snapshots remain unchanged. Local serialization/token counts do not measure host prompt injection, caching or billing.
