# Detailed authoring format

Read the fields relevant to your content. Start with the [short guide](authoring-guide.md); the [schema](authoring-schema.json) defines exact accepted input. Review and publication use the [compact workflow](conversion-workflow.md).

## Authoring fields

Submit UTF-8 JSON with `format: "reader-authoring-1"`, a stable authoring `key`, `meta`, optional document `source`, and ordered `blocks`. Each block has a stable author-written `key`; list items also have `key`. Keys match `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}` and are unique in their relevant scope. Use meaningful stable keys, and retain a key when correcting the same content. Never put generated `id`, `revision`, `schema`, `data-node-id`, character offsets or translation `source_hash` into the authoring input. The compiler generates the `continous-reader` document, identity registry, text index, fingerprints and report.

The linked storage-format references include generated fields. For authoring, use `key` instead of `id`, omit `schema`/`revision`, and let HTML compilation choose `reader-html-2`. Existing authoring that explicitly supplies `html_profile: "reader-html-2"` receives a compatibility hint; omit this redundant field in new input. Other HTML profiles are not authoring choices. Source hashes identify uploaded original bytes and come from `query_uploaded_sources` with `action: "get"`; do not confuse them with generated translation fingerprints.

Authoring fields are strict. Unknown fields and misplaced generated fields produce diagnostics rather than silently creating new behavior. For example, `placment` cannot substitute for `placement`, a paragraph's `layout: "pair"` is unsupported, and a paragraph translation uses `text`, not `content`. Put optional provider metadata under a namespaced `extensions` object where the schema permits it; extensions cannot override content or secretly add layout. This strict input boundary is separate from preserving unknown fields while reading or revising older stored documents.

`meta.title` is required. `meta.language` is the source language, such as `en` or `zh-CN`; use the actual language, or `und` if genuinely unknown. `meta.authors` and `meta.date` may preserve known source metadata. The title can have `meta.translations[language].title`. Blocks and list items may override source `language`. Content order is exactly the array order; do not concatenate the whole paper into one block.

## Standard block types

All types accept optional `source` locations, source `language`, `origin` and `placement`. Missing `origin` or `"source"` denotes source content. `origin: "user"` identifies a requested supplement and must not have PDF source locations. Corrections to extraction remain source content.

| Type | Authoring payload | Structure |
| --- | --- | --- |
| `heading` | `level`, `text`, optional `num` | Level is integer 1–6; preserve source section numbering in `num`. |
| `para` | `text`, optional `role`, `cont` | One coherent paragraph. Use `role: "abstract"` or `"reference"` where useful. |
| `list` | `ordered`, `items: [{ key, text }]` | Each item has its own stable key and optional translation/language/source locations. Use HTML for genuinely nested lists. |
| `math` | `tex`, optional `tag` | TeX without surrounding `$$`; `tag` preserves the printed equation number. |
| `figure` | `src`, optional `alt`, `caption`, `num`, `image_text` | `src` is a document-relative uploaded asset path. Preserve the image; text cannot substitute for it. |
| `table` | `head`, `rows`, optional `caption`, `caption_pos`, `num`, `align` | Both head/rows are arrays of equal-width string rows; `head` can be empty. `caption_pos` is `above` or `below`. `align` may be `lrr` for three columns. |
| `html` | `html`, optional `role`, `num`, layout-only `css` | One coherent complex object; follow the next section. |

Standard textual fields allow `**bold**`, `*italic*`, inline code, ordinary HTTP/HTTPS links, internal links and `$inline TeX$`. This is a finite inline syntax, not full Markdown: headings, lists and tables use their own block types. Raw HTML, including `<strong>` or `<h2>`, belongs in an explicit HTML block and is not accepted as paragraph markup. Standard paragraphs may retain fenced code; multi-part algorithms can be semantic HTML. Escape backslashes in JSON, for example `"tex": "\\frac{a}{b}"`. Preserve exact numeric strings, decimal places, signs, percentages and footnote markers. Empty cells remain `""`; never shift values left to fill a blank.

Figure `alt` is plain accessible text, including its translations. Write a readable description there; use `caption` or `image_text` for visible formatted text. Link resolution applies only to actual Markdown links and HTML anchor destinations; code examples retain their literal contents.

### Formula encoding

In paragraph/heading/list text, table cells and captions, enclose each inline formula in single `$...$` delimiters on one line. Do this independently in the original and every translated sentence. Bare `x_i`, `F^n` and `binom(n,k)` remain ordinary text; `\(...\)` is not an alternative delimiter in these fields. Do not put formulas in code spans or emphasis and expect math rendering. Literal code and filenames should retain their meaning, not be converted to formulas.

```json
{"key":"bound","type":"para","text":"There are $\\binom{n}{k}$ choices with $x_i^2 \\le 1$.","translations":{"zh-CN":{"text":"有 $\\binom{n}{k}$ 种选择，且 $x_i^2 \\le 1$。"}}}
```

Standalone equations use `{"key":"set","type":"math","tex":"A=\\{x_i \\mid i \\in I\\}"}` without `$` delimiters. In semantic HTML, use the empty `span data-tex` form described below instead of `$...$` text. Use `\binom{n}{k}` for a binomial coefficient, `\lfloor t\rfloor` for a floor, and `\{` / `\}` for visible set braces; ordinary TeX braces only group expressions. JSON requires every TeX backslash to be escaped. Keep language-neutral mathematics unchanged inside translated prose, and translate any explanatory words around it.

Compare both inline and displayed mathematics with the original in the actual Reader, including subscripts, superscripts, fractions, set delimiters and operators. A TeX syntax check cannot detect unmarked mathematics or prove that a syntactically valid expression matches the source.

References and footnotes are ordinary blocks with their own keys. Internal links may target author keys, for example `[1](#reference-one)`; compilation resolves them to generated identities. A missing target is a validation error. Do not make reference numbering into a separate handwritten offset/index system.

For library citation matching, give each reference a separate paragraph with `role: "reference"`, or retain individually keyed items beneath a References heading. Keep the original citation text and its real marker. Source and translation are one reference, not two entries. A semantic HTML reference list must retain an individually addressable text owner for each entry. Internal citation links provide the exact places from which that reference is cited.

Optional bibliographic metadata belongs in the existing namespaced extension, not new `meta` fields. At document level, `extensions["continous-reader.bibliography"].work` may supply `{ "title", "authors", "year", "identifiers": { "doi", "arxiv" } }`; at a reference paragraph or list item, `extensions["continous-reader.bibliography"]` may supply the same fields directly, with optional `label`. For example, `{ "identifiers": { "arxiv": "1706.03762v7" } }` retains the requested version. Include only facts verified from the corresponding source. Do not put a cited paper's identifiers in the document's own `work`. These optional fields support identity matching; they neither replace visible source text nor select a local document. Matching results, candidates and manual corrections are stored separately by the workspace, and should not be written into authoring JSON. Ambiguous titles, differing publication years and conflicting identifiers remain candidates for review.

## Choosing where content is displayed

### Navigation for an unsectioned source

Do not invent source `heading` blocks to obtain a table of contents. An optional top-level `navigation` object can supply auxiliary labels separately from the body:

```json
{"kind":"auxiliary","items":[
  {"targetKey":"forward-pass","text":"Forward computation","level":1,
   "translations":{"zh-CN":{"text":"前向计算"}}},
  {"targetKey":"backward-pass","text":"Back-propagation","level":1}
]}
```

Put this object in `authoring.navigation`. Each target must be an existing top-level block key, used at most once. Items follow body order; supply 1–200 items, levels 1–3 and nonempty plain-text labels up to 120 characters. Omit navigation when none is useful. The compiler resolves targets to stable block IDs; the editing package preserves the key mapping. Labels neither become source text nor acquire source coordinates. Reader uses original level 1–3 headings when available, otherwise these entries under 阅读导航. With neither, the empty sidebar and its width disappear without changing the saved outline preference.

### Body and frontmatter

The format lets the Agent choose a useful reading arrangement through semantic block types, coherent HTML objects, shared layout classes and optional block-level `placement`. Make those choices from the content's meaning and the reader's capabilities. The reader supplies consistent typography and interaction; this choice does not expand the CSS allowlist or introduce another document format.

The top-level `blocks` array is a reading sequence. Keep article headings as standard heading blocks; use one HTML block for content that benefits from a shared local arrangement. There is no top-level group type, arbitrary block `layout` field, sidebar slot or author-defined interactive disclosure. Do not merge an entire article into HTML to simulate those capabilities. Use the existing composition choices first; describe a concrete unmet relationship if the format cannot represent it.

`placement` accepts exactly `"frontmatter"` or `"body"` when present. `frontmatter` places the block in the disclosure beneath the article title, suitable for author contributions, affiliations, copyright and publication notes. `body` explicitly keeps it in the main reading flow, including when its `role` would otherwise select frontmatter. When omitted, existing role defaults apply: `rights`, `publication` and `author-details` use frontmatter, and other blocks stay in the body. Source and translation share the same placement; never put `placement` inside a translation object.

```json
[
  {"key":"author-note","type":"para","role":"footnote","placement":"frontmatter","text":"Equal contribution."},
  {"key":"technical-note","type":"para","role":"footnote","placement":"body","num":"4","text":"Technical detail needed near this section."},
  {"key":"publication-context","type":"para","role":"publication","placement":"body","text":"Publication context that belongs in the reading flow."}
]
```

Technical footnotes usually remain in the body near the material they explain. Preserve a real printed marker in `num` when needed; keys, generated IDs and a synthetic `Footnote` label are not reader-facing content. Moving a block to frontmatter retains its content, source mappings and stable identity, and does not turn it into a user supplement.

`role` is a semantic description, not a request to invent a component. Known roles include `abstract`, `reference`, `footnote`, `rights`, `publication`, `author-details`, `table`, `figure`, `algorithm` and `code`. A custom nonempty role can describe content, but a warning indicates that it has no recognized system role behavior. Choose placement or supported HTML layout explicitly instead of assuming a new role creates styling or grouping.

## Semantic HTML, identity and reader-owned layout

Supported semantic tags are `figure/figcaption`, `div/section`, `p/span`, `strong/em/b/i`, `sup/sub`, `blockquote`, `pre/code`, `br`, `a/img`, `table/caption/thead/tbody/tfoot/tr/th/td`, `ul/ol/li` and `dl/dt/dd`. Article h1–h6 headings, full pages, scripts, event handlers, frames, interactive controls and embedded runtime implementation are not supported inside an HTML object. Images use relative `src` paths bound to uploaded files. Attributes are limited to supported local class, language/title, link/resource, table relationship, list-number and author-key/math fields; inline `style` and arbitrary `data-*` attributes are not a layout escape hatch.

For a merged table, encode positive integer `rowspan` and `colspan`. Every grid position must be covered once, with no overlaps or missing slots; a spanning cell must remain inside its row group. Do not insert empty cells where a rowspan already occupies the slot. Use `th` plus `scope="col"`, `"row"`, `"colgroup"` or `"rowgroup"` according to meaning. Keep one table block for the full object, including its header/body. Its PDF source box covers the table, not just its caption.

`data-key` optionally names a text-owning unit such as a `p`, `th`, `td`, `caption`, `figcaption`, `li` or `pre`. A key cannot identify `table`/`tr`/`tbody` or another structural-only element, and keyed owners cannot contain nested keyed owners. The compiler assigns `data-node-id` automatically. Explicit keys preserve an intended unit's identity during editing and allow translation pairing. Unique unchanged units can also be matched; ambiguous duplicates are not assigned guessed old identities.

HTML mathematics uses an empty inline span inside a text-owning unit, for example `<p><span data-tex="x^2"></span></p>`. Use a standard `math` block for a standalone displayed equation. In JSON, escape TeX backslashes. Do not put HTML formula text in both the span and its attribute. Put emphasis in semantic tags. Use shared classes `layout-stack`, `layout-pair`, `layout-grid`, `text-start`, `text-end`, `scalar`, `group-start`, `ruled`, `note` where needed. Font, color, spacing and interaction belong to the reader.

Normally omit `css`. Necessary object-local layout CSS is limited to the allowlist in the shared-style contract, such as grid columns, alignment and gaps using `var(--reader-space-1)` through `--reader-space-3`. Do not supply fonts, sizes, colors, borders, pixel gaps, margin/padding, global selectors, ordering/hiding rules, resource URLs or scripts. Do not special-case a paper or table number to make a broken structure appear correct.

Handle class diagnostics as authoring feedback. `W_AUTHOR_CLASS` means a class is neither a shared class nor defined by this block's accepted CSS; check typos such as `layout-piar`. `W_AUTHOR_CSS_UNUSED` means a local CSS class is not present in the source or translated HTML. Supported custom layout classes are allowed; merely naming a class does not define its visual behavior. `layout-pair` and `layout-grid` fall back to DOM order in a narrow reader container; verify that the composition remains understandable in that state.

## Translation

For this workspace, converting a non-Chinese paper defaults to a complete original plus Simplified Chinese (`zh-CN`) translation. Only skip translation when the user explicitly requests source-only content or specifies a different target language. Producing a source-only preview is an intermediate result, not a completed default conversion. The external conversion Agent generates and checks the translations; Reader displays saved variants and does not silently call a model when a mode button is pressed.

Cover the title, headings, prose, list items, captions, figure alt/image text, table labels, HTML prose/algorithms, footnotes and appendices. Preserve original author names, bibliographic identifiers and citation details where scholarly practice requires them; do not translate identifiers or invent names. Share language-neutral equations, numeric cells and original images. Translate explanatory text around them. Do not claim that copied English prose is a translation or that an absent field is complete. The storage schema still permits partial translations and explicit source-only work; keep missing content honestly marked while work is in progress. Use the same source block and its `translations` map:

```json
{"key":"p1","type":"para","text":"Original.","translations":{"zh-CN":{"text":"译文。"}}}
```

Heading/paragraph translations contain `text`; title translations contain `title`; each list item's translation contains `text`; table translations contain a same-shape `head`/`rows` and optional `caption`; figure translations contain `alt`, `caption` and/or `image_text`; math translation uses `tex` only when a meaningful translated form is required. Do not duplicate source IDs, ordering, source boxes, image path or language-independent structural fields into translations. The compiler computes translation provenance from the source content.

HTML translation contains a complete `html` fragment. With `alignment: "same-structure"`, source and translation must have the same semantic scaffold, table spans, resource references, link relationships and text-owner count. Alternatively, key every source and translation text unit with matching `data-key` values. Never rely on equal array positions while changing structure. Example:

```json
{"key":"object","type":"html","html":"<p data-key=\"caption\">Original caption.</p>","translations":{"zh-CN":{"alignment":"same-structure","html":"<p data-key=\"caption\">原始题注的译文。</p>"}}}
```

## Original and coordinates

Document `source` names an uploaded original through `{ "path": "source.pdf", "sha256": "the actual uploaded 64-character hash", "media_type": "application/pdf" }`. Every source/image path is relative to the document resource root and uses `/`; no absolute paths, `..`, remote URLs or temporary signed URLs. Bind each path to an uploaded file ID when validating or publishing. The service verifies retained bytes, their hash and resource availability.

Block `source` is an array. `page` is the actual one-based PDF page index. A reliable normalized `box: [x0,y0,x1,y1]` is optional. The box is measured against the displayed page after its crop and rotation, top-left origin, values in `[0,1]`, and strict positive width/height. A cross-page paragraph can have one box per page; same-page multiple areas remain separate. List items can provide their own `source` to preserve item-level locations; otherwise they inherit the block's mapping. Preserve known source boxes. If only page is reliable, submit `{ "page": 3 }` and do not invent a region. User supplements have no source locations. A source-less syntax example may omit both document source and block locations, but cannot be claimed as a complete conversion of an uploaded paper.

Source mappings are part of that saved document revision. The Reader opens the original bytes with client-side PDF.js and uses these locations directly; it never runs text matching to invent missing rectangles. Page images remain disposable client rendering output. A protected extensionless byte endpoint supplies originals for embedded reading; the explicit original-file link remains available separately.


## Revise an existing article

Use exact `read_context` and `revise_document` for local changes. For a larger content/layout revision, use the complete editing package and the same reviewed-preview workflow. Reading `outline/content` projections are bounded views of `blocks`, exclude metadata, and can omit unavailable images or unsupported structure; they are not a complete authoring export. The reading and coverage rules are in [the MCP contract](mcp-management.md#continuous-reading-and-exact-addresses).

1. Call `read_resources` with `kind:"authoring_artifacts"`, `mode:"editing"`, `document_id` and optionally the required `revision`. Omission selects the current revision. Download the returned `editing.json` URL and verify its descriptor hash. The `reader-editing-package-1` package includes `base`, editable `authoring`, current saved `document`, identity registry, resources, `resourceBindings`, historical-authoring status and round-trip verification. Preserve these distinctions: generated document/index/identity fields are evidence, not the authoring input to upload.
2. The exporter reconstructs the selected saved revision and verifies content/identity equivalence and source fingerprints by recompiling it. Explicit historical exports reproduce that saved revision; they never fall back to its possibly older authoring input. If a structure, identity, resource binding or size cannot round-trip, `EDITING_EXPORT_UNSUPPORTED` refuses a complete baseline without changing the original. Use supported precise revisions or resolve the diagnostic; do not substitute `mode:"stored"` authoring.
3. Edit the complete `authoring`, retaining unchanged keys, translations, source mappings and original-file reference/hash. Upload its JSON and any new assets. Reuse package `resourceBindings` for retained files and add/replace only intended resource bindings. Build MCP `target` from `base.documentId`, `base.revision` and `base.documentHash` as shown below. `base_hash` is the saved document hash, not the editing-file hash or preview hash. The target must still be the current article revision when validating/creating a candidate, even if historical exports are available for inspection.

```json
{
  "authoring_source_id": "uploaded-edited-authoring-id",
  "resources": { "source.pdf": "retained-original-file-id" },
  "target": {
    "document_id": "the-package-base-documentId",
    "base_revision": 3,
    "base_hash": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

The example contains placeholders; replace the ID, revision, hash and bindings with the actual package values. Pass this shape to `validate_authoring` when a diagnostic check is useful, and add a fresh `request_id` for `create_authoring_preview`. HTTP equivalents use `target:{documentId,baseRevision,baseHash}`. Continuing via `previous_preview_id` inherits the frozen target when omitted and rejects switching its document or baseline within the same draft.

4. Review the candidate's source, layout and interactions as usual. Its hash covers the target, base evidence, resources, compiled content, identities and reference-impact evidence. The compact preview/validation result reports affected blocks, removed identities and affected/unresolved reference counts; download the preview report for full details. Stable identities are retained where correspondence is proven. Deletion, splitting or merging must not guess a replacement anchor: the old revision/source reference and quote remain, and unresolved candidate targets are explicit. Retained translations keep their source-fingerprint history and can remain stale pending review.
5. Publish with `preview_id`, the reviewed `expected_hash`, review evidence and a fresh `request_id`; the publish call does not accept a replacement target. The transaction checks the latest successful draft, no `lastError`, exact frozen snapshot, current base revision/record, and a compare-and-swap guard for affected insight/change-request/relation references and their versions. A newly added or changed affected reference can reject publication even when the body revision is unchanged. Reread and rebuild/review the candidate after such a conflict; unrelated independent state is not overwritten by the package.

Success creates `base_revision + 1` under the original document ID, preserves previous revisions and original/resources, and uses the existing atomic receipt/synchronization path. It preserves library/plan state, insights, answers, review membership, measured reading facts and their independent versions; it does not manufacture new Q/N/R identities or reading duration. The candidate changes the title only when its body title intentionally differs from the base, preserving otherwise concurrent library metadata. Failed publication does not replace the formal article. Unknown commit outcomes and response loss require the same request ID/payload or inspection, as described in [recovery](mcp-management.md#output-contracts-and-recovery).

