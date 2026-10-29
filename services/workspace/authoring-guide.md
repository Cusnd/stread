# Author a Reader document

Convert the requested original to `reader-authoring-1`, preserving complete source content and, by default for non-Chinese material, complete Simplified Chinese (`zh-CN`). Choose your own extraction, composition and repair methods. The external caller must actually spawn an independent reviewer who did not author the candidate: it reads the original first, then compares content and translation and inspects the live Reader. Fix findings and recheck the latest candidate before publication. Report unavailable checks honestly.

## Target format

Use UTF-8 JSON with a stable `key`, article `meta`, original-file `source` and ordered `blocks`. Blocks have stable keys and use `heading`, `para`, `list`, `math`, `figure`, `table` or semantic `html`. The compiler generates IDs, indexes and translation fingerprints. Keep existing keys when revising content.

Start from the [minimal bilingual example](authoring-minimal-example.json). Its text, page and zero hash are placeholders: replace them with the actual original and its uploaded SHA-256. The [schema](authoring-schema.json) defines supported fields; the [all-type example](authoring-example.json) covers the other block types.

```json
{"key":"p1","type":"para","text":"Let $x_i \\in \\mathbb{R}$; then $x_i^2 \\ge 0$.","translations":{"zh-CN":{"text":"设 $x_i \\in \\mathbb{R}$，则 $x_i^2 \\ge 0$。"}},"source":[{"page":1}]}
```

Encode **inline formulas with `$...$` in both original and translated sentences**. Bare `x_i` or `F^n` stays literal. Display equations use a `math` block with `tex` and no surrounding `$$`; semantic HTML uses an empty `<span data-tex="x_i^2"></span>`. Use real TeX: `\binom{n}{k}`, `\lfloor t\rfloor`, and `\{x\}` for visible set braces. `binom(...)` and `floor(...)` do not typeset those notations. Escape backslashes in JSON, as in the example above. Shared standalone equations do not replace inline markup inside each language's prose.

Preserve facts, numbers, formulas, images, references and meaningful relationships. Share language-neutral equations/numbers/images; preserve scholarly names where appropriate. Use reliable source pages and optional normalized `box` coordinates. Do not invent headings or source locations. Reader owns typography and interaction; choose semantic grouping and supported layout to suit the content.

For formula encoding, tables with spans, HTML alignment, captions, frontmatter or auxiliary navigation, consult the relevant section of the [format reference](authoring-format-reference.md). [Layout examples](authoring-examples/index.md) are optional starting points.

## Tools

1. Get the original URL/hash with `query_uploaded_sources(action=get)`. Upload your authoring JSON and assets using `prepare_source_upload`; send bytes to the returned URL with the actual Content-Type. Bind document-relative paths to the returned file IDs in `resources`.
2. Call `create_authoring_preview` with `authoring_source_id`, `resources` and a fresh `request_id`. `validate_authoring` is an optional earlier diagnostic check. Preview creation performs the same structural checks and returns the actual Reader URL and report.
3. Review and repair using the [compact review record](conversion-workflow.md). Continue with `previous_preview_id`. Publish the latest reviewed `preview_id`/`expected_hash`. Return the saved reading link and review limitations after publication succeeds.

For existing articles, first use `read_resources(kind=authoring_artifacts,mode=editing)`. Reuse its authoring keys/resource bindings and pass `target:{document_id,base_revision,base_hash}` from the package's `base`; see [revision details](authoring-format-reference.md#revise-an-existing-article). A bounded reading excerpt is not an editing package.

Keep the exact request ID/payload after a lost response; use a new ID for a changed submission. [File access](file-access.md) explains scoped URLs and multipart uploads when needed. The workspace service stores and executes locally and runs no models. Reader does not launch Agents or infer semantic correctness from a structural PASS.
