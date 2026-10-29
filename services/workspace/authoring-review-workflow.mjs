import { canonical, check, clone, hash } from "./errors.mjs";

export const COMPLETION_REVIEW_FORMAT = "reader-quality-review-2";
export const COMPACT_REVIEW_FORMAT = "reader-quality-review-3";
const CHECKS = [
  ["source_inventory", "source_fidelity", "Establish article boundaries and an inventory from the original before opening the candidate. Include source link annotations/destinations, not just their visible labels."],
  ["content", "source_fidelity", "Compare all required source text, numbers, equations, tables, notes and references with the original; account for additions and removals in this revision."],
  ["objects", "source_fidelity", "Compare required figures/table structure with expanded original-page context, including crop edges and every numeric cell."],
  ["relationships", "source_fidelity", "Verify source mappings and actual source link destinations. Preserve source wording; never infer an embedded PDF destination only from its printed label."],
  ["translation", "usability", "Check complete target-language content and semantic accuracy, including table cells, captions, HTML, notes and appendices; explain unchanged names/identifiers."],
  ["reader_render", "reader_visual", "Inspect every required block in the actual Reader in applicable source/translation/bilingual modes, normal desktop and narrower/larger-text conditions."],
  ["reader_interaction", "usability", "Exercise navigation, source/reference links, object expansion and local overflow; check changed order/navigation and removal/reference impacts."],
];
const unique = values => [...new Set(values)];
const brief = value => String(value || "").slice(0, 500);

export function authoringReviewPlan(snapshot, facts) {
  const document = snapshot.validated.document, blocks = document.blocks;
  const full = { kind: "full", requiredBlockIds: blocks.map(block => block.id), removedBlockIds: [], metaChanged: true,
    navigationChanged: Boolean(document.navigation), orderChanged: true, sourceChanged: Boolean(document.source),
    changedResourcePaths: Object.keys(snapshot.resourceMap || {}).sort() };
  const scope = snapshot.revisionTarget?.reviewScope || { ...full, scopeHash: hash(canonical(full)) };
  const scoped = new Set(scope.requiredBlockIds);
  const hasObjects = blocks.some(block => scoped.has(block.id) && ["figure", "table", "math", "html"].includes(block.type));
  const plan = { format: "reader-review-plan-1", runEvidenceVersion: 2, scope: clone(scope),
    baseline: snapshot.revisionTarget ? { documentId: snapshot.revisionTarget.documentId, revision: snapshot.revisionTarget.baseRevision, hash: snapshot.revisionTarget.baseHash } : null,
    sourceSha256: document.source?.sha256 || null,
    requiredCoverage: { blockIds: scope.requiredBlockIds, removedBlockIds: scope.removedBlockIds,
      resourcePaths: unique([...(scope.changedResourcePaths || []), ...(document.source?.path ? [document.source.path] : [])]).filter(path => snapshot.resourceMap?.[path]),
      meta: scope.metaChanged, navigation: scope.navigationChanged, order: scope.orderChanged },
    checks: CHECKS.map(([key, layer, instruction]) => ({ key, layer, instruction,
      applicable: key === "source_inventory" ? Boolean(document.source) : key === "objects" ? hasObjects : true })),
    defaultTargetLanguage: facts.translation.expectedFields > 0 ? "zh-CN" : "source",
    originalPageCount: facts.pdfPageCount,
    boundary: scope.kind === "affected" ? "Review the service-selected change scope and its relationships. Unchanged content is outside this review, not newly verified. Inherited missing translations remain visible separately." : "Review the complete document. Presence counts and structure PASS are not semantic acceptance.",
  };
  return { ...plan, hash: hash(canonical(plan)) };
}

export function workflowReviewTemplate(snapshot, plan) {
  return { format: COMPACT_REVIEW_FORMAT, preview: { id: snapshot.id, hash: snapshot.hash },
    reviewer: { sessionId: "replace-with-actual-reviewer-task", generatorSessionId: "replace-with-actual-generator-task", traceSourceIds: [] },
    result: { status: "unverified", summary: "Review the complete service-selected scope against the original and in the Reader, including translation meaning. Record findings and limits.", sourceFirst: false, readerInspected: false },
    evidenceSourceIds: [], issues: [] };
}

export function validateWorkflowShape(review, snapshot, evidenceIds, plan) {
  if (review.format !== COMPLETION_REVIEW_FORMAT) return;
  const workflow = review.workflow;
  const invalid = (ok, message, details) => check(ok, "QUALITY_REVIEW_INVALID", message, 400, details);
  const fields = (value, names, label) => {
    invalid(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
    invalid(Object.keys(value).every(key => names.includes(key)), `${label} contains unknown fields.`);
  };
  fields(workflow, ["planHash", "scopeHash", "delivery", "runSourceId", "coverage", "checks", "translationExceptions"], "workflow");
  check(workflow.planHash === plan.hash && workflow.scopeHash === plan.scope.scopeHash, "QUALITY_PLAN_MISMATCH", "The review uses a different service review scope. Read this preview's report and review the exact required scope.", 409, { previewId: snapshot.id, expectedPlanHash: plan.hash });
  fields(workflow.delivery, ["targetLanguage", "userRequest"], "workflow.delivery");
  invalid(typeof workflow.delivery.targetLanguage === "string" && /^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(workflow.delivery.targetLanguage), "A target language or source is required.");
  if (workflow.delivery.targetLanguage !== plan.defaultTargetLanguage) invalid(typeof workflow.delivery.userRequest === "string" && workflow.delivery.userRequest.trim().length >= 3 && workflow.delivery.userRequest.length <= 2000,
    "A nondefault language/source-only delivery needs the actual explicit user request; do not infer it from source text.");
  const ids = (value, maximum, label) => {
    invalid(Array.isArray(value) && value.length <= maximum && value.every(id => typeof id === "string" && id.length > 0 && id.length <= 500), `${label} must be a bounded string array.`);
    invalid(new Set(value).size === value.length, `${label} contains duplicate entries.`);
  };
  const attached = new Set(evidenceIds);
  invalid(typeof workflow.runSourceId === "string" && attached.has(workflow.runSourceId), "Attach the actual reviewer-run evidence file in evidence_source_ids.");
  invalid(workflow.translationExceptions === undefined || Array.isArray(workflow.translationExceptions) && workflow.translationExceptions.length <= 100000, "Translation exceptions must be a bounded array.");
  const exceptions = new Set();
  for (const exception of workflow.translationExceptions || []) {
    fields(exception, ["target", "reason", "evidenceSourceIds"], "translation exception");
    fields(exception.target, ["kind", "blockId", "itemId", "nodeId", "field", "row", "column"], "translation exception target");
    const key = canonical(exception.target);
    invalid(!exceptions.has(key), "Translation exception targets must be unique."); exceptions.add(key);
    invalid(typeof exception.reason === "string" && exception.reason.trim().length >= 12 && exception.reason.length <= 1000, "Explain why this exact natural-language field legitimately remains unchanged.");
    ids(exception.evidenceSourceIds, 40, "translation exception evidence");
    invalid(exception.evidenceSourceIds.length > 0 && exception.evidenceSourceIds.every(id => attached.has(id)), "Translation exceptions need explicitly attached independent supporting evidence.");
  }
  fields(workflow.coverage, ["blockIds", "removedBlockIds", "resourcePaths", "meta", "navigation", "order"], "workflow.coverage");
  const allIds = new Set(snapshot.validated.document.blocks.map(block => block.id)), removedIds = new Set(plan.requiredCoverage.removedBlockIds);
  for (const key of ["blockIds", "removedBlockIds", "resourcePaths"]) ids(workflow.coverage[key], 100000, `coverage.${key}`);
  invalid(workflow.coverage.blockIds.every(id => allIds.has(id)), "Review coverage contains a block outside this snapshot.");
  invalid(workflow.coverage.removedBlockIds.every(id => removedIds.has(id)), "Removed coverage contains an identity not removed by this revision.");
  invalid(workflow.coverage.resourcePaths.every(path => snapshot.resourceMap?.[path]), "Review coverage contains an unbound resource path.");
  for (const key of ["meta", "navigation", "order"]) invalid(typeof workflow.coverage[key] === "boolean", `coverage.${key} must be boolean.`);
  invalid(Array.isArray(workflow.checks) && workflow.checks.length <= CHECKS.length, "workflow.checks must contain the bounded service checklist.");
  const keys = new Set();
  for (const item of workflow.checks) {
    fields(item, ["key", "status", "summary", "evidenceSourceIds"], "workflow check");
    const required = plan.checks.find(check => check.key === item.key);
    invalid(required && !keys.has(item.key), "Unknown or duplicate workflow check.", { key: item.key }); keys.add(item.key);
    invalid(["verified", "failed", "unverified", "not_applicable"].includes(item.status), "Unknown workflow check status.");
    invalid(typeof item.summary === "string" && item.summary.trim().length > 0 && item.summary.length <= 2000, "Each check needs its actual result and limits.");
    ids(item.evidenceSourceIds, 40, "check evidence IDs");
    invalid(item.evidenceSourceIds.every(id => attached.has(id)), "Attach every check evidence file explicitly.");
    invalid(item.status !== "verified" || item.evidenceSourceIds.length > 0, "Verified checks require actual supporting evidence.");
    invalid(item.status !== "not_applicable" || !required.applicable || item.key === "translation" && workflow.delivery.targetLanguage === "source", "An applicable check cannot be skipped.", { key: item.key });
  }
}

function runProblems(review, jsonEvidence, attached, snapshot, plan) {
  const run = jsonEvidence.get(review.workflow.runSourceId);
  const problems = [];
  if (run?.format !== "reader-review-run-1" || run.kind !== "subagent") return ["Attach a reader-review-run-1 record for an actually spawned reviewer subagent."];
  if (run.preview?.id !== snapshot.id || run.preview?.hash !== snapshot.hash || run.planHash !== plan.hash) problems.push("Bind this reviewer-run record to the exact preview ID/hash and current planHash; an older run cannot verify a new candidate.");
  if (![run.generatorSessionId, run.reviewerSessionId].every(id => typeof id === "string" && id.trim()) || run.generatorSessionId === run.reviewerSessionId) problems.push("Generator and reviewer must have distinct actual session/task IDs.");
  if (run.reviewerId !== review.reviewer.id || run.contextIsolation !== "fresh" || run.readOnly !== true) problems.push("Run identity must match the reviewer and declare a fresh read-only context.");
  if (!Array.isArray(run.traceSourceIds) || !run.traceSourceIds.length || run.traceSourceIds.length > 10 || !run.traceSourceIds.every(id => attached.has(id) && id !== review.workflow.runSourceId)) problems.push("Attach bounded raw spawn/session evidence referenced by traceSourceIds.");
  const times = [run.sourceFirstAt, run.candidateFirstAccessAt, run.completedAt].map(Date.parse);
  if (!times.every(Number.isFinite) || times[0] > times[1] || times[1] > times[2]) problems.push("Record source-first, first candidate access and completion times in their actual order.");
  const createdAt = Date.parse(snapshot.createdAt);
  if (!Number.isFinite(createdAt) || times[1] < createdAt || times[2] < createdAt) problems.push("The candidate access and review completion cannot predate this immutable snapshot's creation.");
  return problems;
}

export function workflowCompletion(snapshot, plan, reviews, evidence, jsonEvidence, coverageForLanguage) {
  const pending = [], add = (key, action, details) => pending.push({ key, action, ...(details ? { details } : {}) });
  const candidates = reviews.filter(({ review }) => [COMPLETION_REVIEW_FORMAT, COMPACT_REVIEW_FORMAT].includes(review.format) && review.reviewer.role === "independent");
  const attached = new Set(evidence.map(file => file.sourceId));
  if (!candidates.length) add("independent_review", "Spawn an independent reviewer, inspect the source and exact Reader preview, and attach the compact reviewTemplate with actual spawn and review evidence.");
  let selected, smallest;
  for (const candidate of candidates) {
    const { review } = candidate, workflow = review.workflow, gaps = [];
    const gap = (key, action, details) => gaps.push({ key, action, ...(details ? { details } : {}) });
    if (review.format === COMPACT_REVIEW_FORMAT) {
      if (review.reviewer.sessionId === review.reviewer.generatorSessionId) gap("reviewer_run", "The reviewer must be an actually spawned task distinct from the candidate's author.");
      if (!review.reviewer.traceSourceIds.length) gap("reviewer_run", "Attach raw evidence of the actual independent reviewer spawn/session.");
      if (plan.sourceSha256 && !review.result.sourceFirst) gap("source_first", "The independent reviewer must inspect the original before the candidate.");
      if (!review.result.readerInspected) gap("reader_inspection", "Inspect the exact candidate in the actual Reader, including relevant modes and interactions.");
      if (review.result.status !== "verified") gap("review_result", "Complete independent review of the whole service-selected scope and resolve its findings.");
      const target = review.delivery?.targetLanguage || plan.defaultTargetLanguage;
      if (target !== "source") {
        const coverage = coverageForLanguage(target);
        if (coverage.missingFieldCount) gap("translation_incomplete", `Complete ${target} for every required natural-language field.`, { missingCount: coverage.missingFieldCount, missing: coverage.missing.slice(0, 8) });
      }
      if (!smallest || gaps.length < smallest.length) { smallest = gaps; selected = candidate; }
      continue;
    }
    for (const problem of runProblems(review, jsonEvidence, attached, snapshot, plan)) gap("reviewer_run", problem);
    if (plan.sourceSha256) {
      const inventories = review.baseline.artifactSourceIds.map(id => jsonEvidence.get(id)).filter(value => value?.format === "reader-source-inventory-1");
      if (!inventories.some(value => value.sourceSha256 === plan.sourceSha256 && value.sourceFirst === true && typeof value.articleBoundary === "string" && value.articleBoundary.trim() && Array.isArray(value.entries) && value.entries.length && value.entries.length <= 100000)) {
        gap("source_inventory", "Attach a source-first reader-source-inventory-1 JSON with matching original SHA-256, articleBoundary and entries; arbitrary text is insufficient.");
      }
    }
    for (const required of plan.checks) {
      const item = workflow.checks.find(item => item.key === required.key);
      const skipped = !required.applicable || required.key === "translation" && workflow.delivery.targetLanguage === "source";
      if (!item || !(item.status === "verified" || skipped && item.status === "not_applicable")) gap(required.key, required.instruction);
    }
    for (const key of ["blockIds", "removedBlockIds", "resourcePaths"]) {
      const checked = new Set(workflow.coverage[key]), missing = plan.requiredCoverage[key].filter(id => !checked.has(id));
      if (missing.length) gap("coverage_" + key, "Review every service-selected target; do not reduce the scope to the first viewport or convenient objects.", { missingCount: missing.length, missing: missing.slice(0, 12) });
    }
    for (const key of ["meta", "navigation", "order"]) if (plan.requiredCoverage[key] && !workflow.coverage[key]) gap("coverage_" + key, `Review the changed ${key}.`);
    const target = workflow.delivery.targetLanguage;
    if (target !== "source") {
      const coverage = coverageForLanguage(target);
      if (coverage.missingFieldCount) gap("translation_incomplete", `Complete ${target} for every required natural-language field.`, { missingCount: coverage.missingFieldCount, missing: coverage.missing.slice(0, 8) });
      const retained = new Set((workflow.translationExceptions || []).map(exception => canonical(exception.target)));
      const unexplained = coverage.identical.filter(target => !retained.has(canonical(target)));
      if (unexplained.length) gap("translation_identical", "Translate copied natural-language fields or give an exact-field independent explanation/evidence for retained names and identifiers.", { missingCount: unexplained.length, missing: unexplained.slice(0, 8) });
      const known = new Set(coverage.identical.map(target => canonical(target)));
      if ((workflow.translationExceptions || []).some(exception => !known.has(canonical(exception.target)))) gap("translation_exception_target", "An exception names a field that is not an identical source/target field in this exact scope. Refresh the report and remove stale exceptions.");
    }
    for (const layer of ["source_fidelity", "reader_visual", "usability"]) {
      const claim = review.layers[layer];
      if (!(claim.status === "verified" || layer === "source_fidelity" && !plan.sourceSha256 && claim.status === "not_applicable")) gap("layer_" + layer, `Finish ${layer} within the service-selected scope; unchanged content is not part of a new verification claim.`);
    }
    if (!smallest || gaps.length < smallest.length) { smallest = gaps; selected = candidate; }
  }
  if (smallest) pending.push(...smallest);
  if (!candidates.length && plan.defaultTargetLanguage !== "source") {
    const coverage = coverageForLanguage(plan.defaultTargetLanguage);
    if (coverage.missingFieldCount) add("translation_incomplete", `Complete default ${plan.defaultTargetLanguage}; use an exception only for an explicit current-user request.`, { missingCount: coverage.missingFieldCount, missing: coverage.missing.slice(0, 8) });
  }
  return { status: pending.length ? "pending" : "ready", ready: !pending.length, planHash: plan.hash, scopeHash: plan.scope.scopeHash,
    reviewSourceId: selected?.sourceId || null, targetLanguage: selected?.review.delivery?.targetLanguage || selected?.review.workflow?.delivery.targetLanguage || plan.defaultTargetLanguage,
    pendingCount: pending.length, pending: pending.slice(0, 12), pendingTruncated: pending.length > 12,
    scope: plan.scope.kind,
    boundary: "The service checks required scope, evidence bytes/bindings and declared review provenance. It does not authenticate external Agent identities or prove semantic conclusions. A ready workflow is evidence of completed stated checks, not a guarantee of perfection." };
}

export function boundedWorkflowSummary(completion) {
  return { status: completion.status, pendingCount: completion.pendingCount, scope: completion.scope,
    pending: completion.pending.slice(0, 4).map(({ key, action, details }) => ({ key, action: brief(action), ...(details?.missingCount ? { missingCount: details.missingCount } : {}) })),
    next: "Open the Reader preview and report.json for the format, review scope and compact review template. Keep the candidate until independent review is complete." };
}
