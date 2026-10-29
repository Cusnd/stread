# Independent review and publication

The external Agent chooses how to generate, inspect and repair. Deliver complete original content plus `zh-CN` unless the user explicitly chooses another language or source-only. The caller must actually spawn a separate reviewer that did not author the candidate. The reviewer reads the original first, then checks the required content, translation and live Reader. Repair findings and recheck the latest candidate. If independent review or browser inspection is unavailable, retain the preview and report the unfinished work. Reader does not launch or coordinate Agent processes.

## One review record

The preview's `report.json` provides `quality.workflow.plan` (the service-derived scope and source information), translation diagnostics and an unchecked `quality.workflow.reviewTemplate`. Fill that template from actual review. Do not retype scope hashes, block lists or a separate run/inventory JSON.

```json
{
  "format": "reader-quality-review-3",
  "preview": { "id": "returned-preview-id", "hash": "returned-preview-hash" },
  "reviewer": {
    "sessionId": "actual-reviewer-task-id",
    "generatorSessionId": "actual-generator-task-id",
    "traceSourceIds": ["uploaded-raw-spawn-evidence"]
  },
  "result": {
    "status": "unverified",
    "summary": "Actual review scope, findings and limits.",
    "sourceFirst": false,
    "readerInspected": false
  },
  "evidenceSourceIds": [],
  "issues": []
}
```

`verified` asserts review of the **entire service-selected scope**, including translation meaning, retained names, source fidelity and Reader display/interaction. It requires actual distinct generator/reviewer identities, uploaded raw spawn/session evidence, supporting review evidence, source-first work when an original is attached, and actual Reader inspection. Choose checks appropriate to the content and explain them in `summary`; a page load alone does not establish complete review. Use `unverified` for unfinished work and `failed` for failed review. The service derives source/scope bindings from the exact preview and continues to show structured, source, display and usability results without requiring separate summaries from you.

For mathematical content, compare inline and display formulas with the source in each applicable Reader language mode. Check subscripts, superscripts, fractions/binomials, visible set braces and operators. Literal `x_i`, `F^n`, `binom(...)` or `floor(...)` where the source typesets mathematics is an encoding defect, even if structural validation passes. Record malformed or unrendered notation as a blocking finding and inspect its repaired rendering on the latest hash. See [formula encoding](authoring-format-reference.md#formula-encoding).

Evidence may be ordinary review notes, an inspection log, source observations or screenshots in supported formats. No fixed source-inventory structure, timestamp form or per-field translation-exception form is required. Identical original/translation fields remain visible for semantic review; missing translations still block default delivery. The service verifies bytes/bindings and declared provenance, not the authenticity of every host identity or the truth of a semantic conclusion.

When the user explicitly selects a nondefault language, add `delivery:{targetLanguage,userRequest}` with the actual instruction; use `source` for source-only. Otherwise omit `delivery`.

## Findings, repairs and publication

Record actionable defects in `issues`, retaining stable keys through repair. An issue uses `key`, `layer` (`source_fidelity`, `reader_visual` or `usability`), `severity` (`blocking`, `warning`, `info`), `status` (`failed`, `resolved`, `unverified`), `expected`, `actual`, `evidenceSourceIds` and `recheck:{suggestion}`. Add `authorKey`, an exact `target` or a source page/box where useful. Resolved findings need current-candidate evidence. A failed report or unresolved blocking finding cannot be hidden by adding a passing report. See [quality feedback](../../spec/转换质量反馈.md) for result boundaries.

Upload the record and supporting files via `prepare_source_upload`, then call `publish_authoring_preview` with the latest `preview_id`, `expected_hash`, a fresh `request_id` and **all** report/supporting IDs in `review.evidence_source_ids`. The existing `source_review`, `layout_review` and `interaction_review` parameters accept short truthful summaries. Reports cannot serve as their own or each other's supporting evidence. Limits remain 40 attached files, 64 MiB total, 2 MiB per JSON, eight reports and 200 issues per report.

Repair with `previous_preview_id`, then review the new candidate/hash. Publication failures return concrete unfinished items and a recovery step. Version conflicts require rereading the current state; an unknown response outcome requires retrying the exact request ID/payload. After success, read back the published document/artifacts and return the saved reading link. Existing v2 reports remain supported under their original stricter checks; historical v1/text or generator self-review cannot complete publication.
