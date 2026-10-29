import { canonical, check, clone, hash, identifier, text } from "./errors.mjs";
import { readerNavigation } from "../../prototypes/insight-composer/src/reader-navigation.js";
import { parseHtml } from "../../prototypes/insight-composer/src/html-content.js";
import { inlineTokens } from "../../prototypes/insight-composer/src/document-content.js";
import { parseFragment } from "parse5";
import { authoringReviewPlan, COMPLETION_REVIEW_FORMAT, COMPACT_REVIEW_FORMAT, validateWorkflowShape, workflowCompletion, workflowReviewTemplate } from "./authoring-review-workflow.mjs";

// Review evidence is a projection over an immutable preview, never input to its
// compiler or hash. This module validates claims and their exact addresses; it
// does not run a reviewer or authenticate an asserted independent identity.
export const QUALITY_REVIEW_FORMAT = "reader-quality-review-1";
export const QUALITY_REPORT_FORMAT = "reader-quality-report-1";
export const QUALITY_LIMITS = Object.freeze({ evidenceFiles: 40, evidenceBytes: 64 * 1024 * 1024, jsonBytes: 2 * 1024 * 1024, reviews: 8, issuesPerReview: 200 });
export const QUALITY_LAYERS = Object.freeze(["source_fidelity", "reader_visual", "usability"]);
const statuses = ["verified", "failed", "unverified", "not_applicable"];
const evidenceMedia = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf", "application/json", "text/markdown", "text/plain"]);
const invalid = (ok, message, details) => check(ok, "QUALITY_REVIEW_INVALID", message, 400, details);
const fields = (value, allowed, label) => {
  invalid(value && typeof value === "object" && !Array.isArray(value), `${label}必须是对象。`);
  for (const field of Object.keys(value)) invalid(allowed.includes(field), `${label}包含未知字段。`, { field });
};
const strings = (value, label, maximum = QUALITY_LIMITS.evidenceFiles) => {
  invalid(Array.isArray(value) && value.length <= maximum, `${label}必须是有界标识数组。`);
  const ids = value.map(id => identifier(id, label));
  invalid(new Set(ids).size === ids.length, `${label}不能含重复标识。`);
  return ids;
};
const sha256 = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const message = (value, label, maximum = 2000) => text(value, label, maximum, true);
const optionalText = (value, label, maximum = 160) => { if (value !== undefined) text(value, label, maximum, true); };

export function qualityEvidenceIds(value = []) {
  return strings(value, "质量检查证据");
}

function reviewTarget(issue, snapshot) {
  const blocks = snapshot.validated.document.blocks;
  const byId = new Map(blocks.map(block => [block.id, block]));
  let keyed;
  if (issue.authorKey !== undefined) {
    message(issue.authorKey, "问题作者 key", 160);
    keyed = snapshot.compiled.identity?.blocks?.[issue.authorKey]?.id;
    check(keyed && byId.has(keyed), "QUALITY_TARGET_INVALID", "问题作者 key 不属于此快照。", 400, { issueKey: issue.key, authorKey: issue.authorKey });
  }
  if (issue.target !== undefined) {
    const target = issue.target;
    fields(target, ["blockId", "itemId", "nodeId", "field", "row", "column"], "质量问题位置");
    identifier(target.blockId, "问题内容块");
    check(byId.has(target.blockId) && (!keyed || keyed === target.blockId), "QUALITY_TARGET_INVALID", "问题位置或作者 key 与此快照不一致。", 400, { issueKey: issue.key, target });
    const block = byId.get(target.blockId), index = snapshot.validated.index || [];
    for (const part of ["itemId", "nodeId"]) if (target[part] !== undefined) identifier(target[part], "问题子对象");
    if (target.field !== undefined) message(target.field, "问题字段", 80);
    for (const part of ["row", "column"]) if (target[part] !== undefined) invalid(Number.isSafeInteger(target[part]) && target[part] >= 0, "问题单元格坐标无效。", { issueKey: issue.key, part });
    invalid((target.row === undefined) === (target.column === undefined), "问题单元格需要同时给出行和列。", { issueKey: issue.key });
    invalid(!(target.itemId && target.nodeId), "问题位置不能同时指向列表项和 HTML 文本单元。", { issueKey: issue.key });
    const exactFields = ["itemId", "nodeId", "field", "row", "column"].filter(key => target[key] !== undefined);
    if (exactFields.length) {
      const known = index.some(entry => entry.blockId === block.id && entry.variant === "source" && exactFields.every(key => entry[key] === target[key]));
      check(known, "QUALITY_TARGET_INVALID", "问题子对象、字段或单元格不是此快照的有效原文位置。", 400, { issueKey: issue.key, target });
    }
  }
  if (issue.source !== undefined) {
    fields(issue.source, ["page", "box"], "问题原页位置");
    const { page, box } = issue.source, count = snapshot.validation.summary.pageCount;
    invalid(Number.isSafeInteger(count) && Number.isSafeInteger(page) && page >= 1 && page <= count, "问题原页超出此 PDF 范围。", { issueKey: issue.key, page, pageCount: count });
    if (box !== undefined) invalid(Array.isArray(box) && box.length === 4 && box.every(n => Number.isFinite(n) && n >= 0 && n <= 1) && box[0] < box[2] && box[1] < box[3], "问题原页区域无效。", { issueKey: issue.key });
  }
}

function validateCompactQualityReview(input, snapshot, availableEvidenceIds, reportSourceId) {
  fields(input, ["format", "preview", "reviewer", "result", "evidenceSourceIds", "issues", "delivery"], "精简复审报告");
  fields(input.reviewer, ["sessionId", "generatorSessionId", "traceSourceIds"], "独立审阅会话");
  for (const key of ["sessionId", "generatorSessionId"]) {
    message(input.reviewer[key], "实际会话或任务标识", 500);
    invalid(input.reviewer[key] === input.reviewer[key].trim(), "实际会话或任务标识不能含首尾空白。");
  }
  const traceIds = strings(input.reviewer.traceSourceIds, "实际独立审阅运行证据", 10);
  const attached = new Set(availableEvidenceIds);
  for (const id of traceIds) check(attached.has(id) && id !== reportSourceId, "QUALITY_EVIDENCE_MISSING", "实际运行证据必须明确附带，报告不能证明自身。", 400, { sourceId: reportSourceId, evidenceSourceId: id });
  fields(input.result, ["status", "summary", "sourceFirst", "readerInspected"], "复审结果");
  invalid(["unverified", "verified", "failed"].includes(input.result.status), "复审结果状态无效。");
  message(input.result.summary, "实际复审范围、发现和限制");
  for (const key of ["sourceFirst", "readerInspected"]) invalid(typeof input.result[key] === "boolean", `${key} 必须如实记录实际检查。`);
  const evidenceIds = strings(input.evidenceSourceIds, "复审支持证据");
  const plan = authoringReviewPlan(snapshot, observations(snapshot));
  if (input.delivery !== undefined) {
    fields(input.delivery, ["targetLanguage", "userRequest"], "交付语言");
    invalid(typeof input.delivery.targetLanguage === "string" && /^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(input.delivery.targetLanguage), "交付语言无效。");
    if (input.delivery.targetLanguage !== plan.defaultTargetLanguage) invalid(typeof input.delivery.userRequest === "string" && input.delivery.userRequest.trim().length >= 3 && input.delivery.userRequest.length <= 2000,
      "非默认语言或仅原文交付必须记录用户的明确要求。");
    else if (input.delivery.userRequest !== undefined) message(input.delivery.userRequest, "用户明确要求");
  }
  // One reviewer attestation is projected for existing Reader quality displays.
  // These layers are not separate checks or independently authenticated facts.
  const projectedStatus = layer => {
    if (layer === "source_fidelity" && !plan.sourceSha256) return "not_applicable";
    if (input.result.status !== "verified") return input.result.status;
    const independent = input.reviewer.sessionId !== input.reviewer.generatorSessionId && traceIds.length > 0;
    const inspected = layer === "source_fidelity" ? input.result.sourceFirst : input.result.readerInspected;
    return independent && inspected ? "verified" : "unverified";
  };
  const projected = validateQualityReview({ format: QUALITY_REVIEW_FORMAT, preview: input.preview,
    reviewer: { id: input.reviewer.sessionId, role: "independent", method: input.result.summary },
    baseline: { sourceSha256: plan.sourceSha256, artifactSourceIds: plan.sourceSha256 ? evidenceIds : [] },
    layers: Object.fromEntries(QUALITY_LAYERS.map(layer => [layer, { status: projectedStatus(layer),
      summary: input.result.summary, evidenceSourceIds: layer === "source_fidelity" && !plan.sourceSha256 ? [] : evidenceIds }])),
    issues: input.issues,
  }, snapshot, availableEvidenceIds, reportSourceId, true);
  return { ...projected, format: COMPACT_REVIEW_FORMAT,
    reviewer: { ...projected.reviewer, ...clone(input.reviewer) }, result: clone(input.result), evidenceSourceIds: evidenceIds,
    ...(input.delivery ? { delivery: clone(input.delivery) } : {}) };
}

export function validateQualityReview(input, snapshot, availableEvidenceIds, reportSourceId, sessionIdentity = false) {
  if (input?.format === COMPACT_REVIEW_FORMAT) return validateCompactQualityReview(input, snapshot, availableEvidenceIds, reportSourceId);
  fields(input, ["format", "preview", "reviewer", "baseline", "layers", "issues", "createdAt", ...(input?.format === COMPLETION_REVIEW_FORMAT ? ["workflow"] : [])], "结构化质量报告");
  invalid([QUALITY_REVIEW_FORMAT, COMPLETION_REVIEW_FORMAT].includes(input.format), "质量报告格式不受支持。");
  fields(input.preview, ["id", "hash"], "检查快照");
  check(input.preview.id === snapshot.id && input.preview.hash === snapshot.hash, "QUALITY_PREVIEW_MISMATCH", "质量报告属于其他快照；修改后必须对新快照重新检查。", 409,
    { sourceId: reportSourceId, expected: { id: snapshot.id, hash: snapshot.hash }, actual: input.preview });
  fields(input.reviewer, ["id", "role", "method"], "审阅者来源");
  if (sessionIdentity) message(input.reviewer.id, "实际审阅会话或任务标识", 500);
  else identifier(input.reviewer.id, "审阅者标识");
  invalid(["generator", "independent", "human"].includes(input.reviewer.role), "审阅者来源必须明确区分生成者、独立审阅者或用户。");
  message(input.reviewer.method, "实际审阅方法");
  optionalText(input.createdAt, "报告时间", 64);
  if (input.createdAt !== undefined) invalid(Number.isFinite(Date.parse(input.createdAt)), "报告时间无效。");
  const attached = new Set(availableEvidenceIds);
  const checkedIds = (value, label) => {
    const ids = strings(value, label);
    for (const id of ids) check(attached.has(id) && id !== reportSourceId, "QUALITY_EVIDENCE_MISSING", "报告引用的证据必须同时附在本次核对文件中，且不能用报告自身证明结论。", 400, { sourceId: reportSourceId, evidenceSourceId: id });
    return ids;
  };
  fields(input.baseline, ["sourceSha256", "artifactSourceIds"], "原件覆盖基线");
  const originalHash = snapshot.validated.document.source?.sha256 || null;
  invalid(input.baseline.sourceSha256 === null || sha256(input.baseline.sourceSha256), "原件基线摘要无效。");
  check(input.baseline.sourceSha256 === originalHash, "QUALITY_SOURCE_MISMATCH", "质量报告的原件基线与快照原件不一致。", 409,
    { sourceId: reportSourceId, expectedSourceSha256: originalHash, actualSourceSha256: input.baseline.sourceSha256 });
  const baselineIds = checkedIds(input.baseline.artifactSourceIds, "原件覆盖基线文件");
  fields(input.layers, QUALITY_LAYERS, "审阅层");
  for (const layer of QUALITY_LAYERS) {
    const claim = input.layers[layer];
    fields(claim, ["status", "summary", "evidenceSourceIds"], layer);
    invalid(statuses.includes(claim.status), "审阅状态无效。", { layer });
    message(claim.summary, "实际检查范围与结论");
    const ids = checkedIds(claim.evidenceSourceIds, "审阅证据");
    invalid(claim.status !== "verified" || ids.length > 0, "已核验结论必须有当前快照的证据。", { layer });
    invalid(layer !== "source_fidelity" || claim.status !== "verified" || baselineIds.length > 0, "源文保真核验必须保留原件覆盖基线文件。", { layer });
    invalid(claim.status !== "not_applicable" || layer === "source_fidelity" && !originalHash, "有原件的保真检查以及 Reader 显示、可用性检查不能标为不适用；未检查应标为 unverified。", { layer });
  }
  invalid(Array.isArray(input.issues) && input.issues.length <= QUALITY_LIMITS.issuesPerReview, "问题清单必须是最多 200 项的数组。");
  const keys = new Set();
  for (const issue of input.issues) {
    fields(issue, ["key", "layer", "severity", "status", "authorKey", "target", "source", "expected", "actual", "evidenceSourceIds", "recheck"], "质量问题");
    identifier(issue.key, "问题 key");
    invalid(!keys.has(issue.key), "同一报告中的问题 key 必须唯一。", { issueKey: issue.key }); keys.add(issue.key);
    invalid(QUALITY_LAYERS.includes(issue.layer), "问题审阅层无效。", { issueKey: issue.key });
    invalid(["blocking", "warning", "info"].includes(issue.severity), "问题严重程度无效。", { issueKey: issue.key });
    invalid(["failed", "resolved", "unverified"].includes(issue.status), "问题处理状态无效。", { issueKey: issue.key });
    message(issue.expected, "期望结果"); message(issue.actual, "实际结果");
    const ids = checkedIds(issue.evidenceSourceIds, "问题证据");
    invalid(issue.status !== "resolved" || ids.length > 0, "已解决问题必须附当前快照的复查证据。", { issueKey: issue.key });
    fields(issue.recheck, ["suggestion", "previousIssueKey", "previousPreviewId"], "问题复查信息");
    message(issue.recheck.suggestion, "复查方法");
    for (const field of ["previousIssueKey", "previousPreviewId"]) if (issue.recheck[field] !== undefined) identifier(issue.recheck[field], field);
    reviewTarget(issue, snapshot);
  }
  validateWorkflowShape(input, snapshot, availableEvidenceIds, authoringReviewPlan(snapshot, observations(snapshot)));
  return clone(input);
}

// File IDs must be explicitly attached by the caller. A review JSON cannot
// expand its authority or request arbitrary files through nested references.
export async function collectQualityEvidence(workspace, snapshot, sourceIds, verifyFile) {
  const ids = qualityEvidenceIds(sourceIds), evidence = [], reviews = [], jsonEvidence = new Map();
  const files = [];
  let total = 0;
  for (const id of ids) {
    const file = await workspace.file(id);
    check(evidenceMedia.has(file.mediaType), "VALIDATION_FAILED", "检查证据需要图像、PDF 或文字报告。", 400, { sourceId: id });
    total += file.size;
    check(total <= QUALITY_LIMITS.evidenceBytes, "QUALITY_EVIDENCE_LIMIT", "本次质量证据总量不能超过 64 MiB。", 413, { maximumBytes: QUALITY_LIMITS.evidenceBytes });
    check(file.mediaType !== "application/json" || file.size <= QUALITY_LIMITS.jsonBytes, "QUALITY_EVIDENCE_LIMIT", "每份 JSON 质量证据不能超过 2 MiB。", 413, { sourceId: id, maximumBytes: QUALITY_LIMITS.jsonBytes });
    files.push({ id, file });
  }
  for (const { id, file } of files) {
    await verifyFile(file, workspace.resources);
    evidence.push({ sourceId: id, filename: file.filename, mediaType: file.mediaType, sha256: file.sha256, size: file.size });
    if (file.mediaType !== "application/json") continue;
    const bytes = await workspace.resources.read(file.sha256);
    check(bytes.length === file.size && hash(bytes) === file.sha256, "SOURCE_HASH_MISMATCH", "读取的证据字节与摘要不同。", 400, { sourceId: id });
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "")); }
    catch { check(false, "QUALITY_REVIEW_INVALID", "JSON 证据不是有效的 UTF-8 JSON。", 400, { sourceId: id }); }
    jsonEvidence.set(id, value);
    if (typeof value?.format === "string" && value.format.startsWith("reader-quality-")) {
      check(reviews.length < QUALITY_LIMITS.reviews, "QUALITY_EVIDENCE_LIMIT", "每次最多附 8 份结构化审阅报告。", 413);
      reviews.push({ sourceId: id, sha256: file.sha256, review: validateQualityReview(value, snapshot, ids, id) });
    }
  }
  const reportIds = new Set(reviews.map(review => review.sourceId));
  for (const { sourceId, review } of reviews) {
    const run = review.workflow ? jsonEvidence.get(review.workflow.runSourceId) : null;
    const supporting = [...review.baseline.artifactSourceIds, ...QUALITY_LAYERS.flatMap(layer => review.layers[layer].evidenceSourceIds), ...review.issues.flatMap(issue => issue.evidenceSourceIds),
      ...(review.format === COMPACT_REVIEW_FORMAT ? review.reviewer.traceSourceIds : []),
      ...(review.workflow ? [review.workflow.runSourceId, ...review.workflow.checks.flatMap(item => item.evidenceSourceIds), ...(review.workflow.translationExceptions || []).flatMap(item => item.evidenceSourceIds)] : []),
      ...(Array.isArray(run?.traceSourceIds) ? run.traceSourceIds : [])];
    for (const id of supporting) check(ids.includes(id) && !reportIds.has(id), "QUALITY_EVIDENCE_MISSING", "全部支持证据必须明确附带；审阅报告不能互相充当原件、显示或运行证据。", 400, { sourceId, evidenceSourceId: id });
  }
  return { evidence, reviews, jsonEvidence };
}

// Presence coverage is deliberately separate from translation quality. Numbers,
// equations and image pixels are shared; copied prose is never proof of a translation.
export function translationCoverage(document, targetLanguage = "zh-CN", { missingLimit = 40, identicalLimit = 20 } = {}) {
  const missing = [], copied = [];
  let expectedFields = 0, presentFields = 0;
  const isChinese = language => /^zh(?:-|$)/i.test(language || "");
  const needsTranslation = language => targetLanguage === "zh-CN" ? !isChinese(language) : language !== targetLanguage;
  const hasContent = value => typeof value === "string" ? Boolean(value.trim()) : Array.isArray(value) && value.some(hasContent);
  const hasWords = value => typeof value === "string" && /\p{L}/u.test(value);
  // Match the Reader's actual tokens. Delimiter-looking prose inside code,
  // emphasis or link labels stays literal, as do unsupported TeX delimiters.
  const hasInlineWords = value => typeof value === "string" && inlineTokens(value).some(token => token.kind !== "math" && hasWords(token.text));
  const htmlText = node => node.kind === "text" ? node.text
    : node.attrs["data-tex"] !== undefined ? "" : node.children.map(htmlText).join("");
  // Older records may not have addressable HTML units. Read their text through
  // the HTML parser too; raw dollar text is not an HTML math atom.
  const fragmentText = node => node.nodeName === "#text" ? node.value : (node.childNodes || []).map(fragmentText).join("");
  const inspect = (source, translation, field, location, language, { allowSame = false, sourceHasWords = hasInlineWords(source) } = {}) => {
    if (!needsTranslation(language) || !sourceHasWords) return;
    expectedFields++;
    if (hasContent(translation)) {
      presentFields++;
      if (!allowSame && canonical(source) === canonical(translation)) copied.push({ ...location, field });
    } else missing.push({ ...location, field });
  };
  const language = document.meta?.language || "und";
  inspect(document.meta?.title, document.meta?.translations?.[targetLanguage]?.title, "title", { kind: "meta" }, language);
  for (const block of document.blocks || []) {
    const translation = block.translations?.[targetLanguage] || {}, blockLanguage = block.language || language, target = { blockId: block.id };
    if (block.type === "heading" || block.type === "para") inspect(block.text, translation.text, "text", target, blockLanguage, { allowSame: block.role === "reference" });
    else if (block.type === "list") for (const item of block.items || []) inspect(item.text, item.translations?.[targetLanguage]?.text, "text", { ...target, itemId: item.id }, item.language || blockLanguage);
    else if (block.type === "figure") for (const field of ["caption", "alt", "image_text"]) inspect(block[field], translation[field], field, target, blockLanguage,
      field === "alt" ? { sourceHasWords: hasWords(block[field]) } : {});
    else if (block.type === "table") {
      for (const field of ["head", "rows"]) for (const [row, cells] of (block[field] || []).entries()) {
        for (const [column, cell] of cells.entries()) inspect(cell, translation[field]?.[row]?.[column], field, { ...target, row, column }, blockLanguage);
      }
      inspect(block.caption, translation.caption, "caption", target, blockLanguage);
    }
    else if (block.type === "html") {
      // Stored HTML has stable, non-overlapping text units. A translated first
      // paragraph cannot cover a missing later paragraph or table cell.
      if (/\bdata-node-id\s*=/.test(block.html || "")) {
        const sourceUnits = parseHtml(block.html).index;
        const translatedUnits = translation.html?.trim() ? parseHtml(translation.html).index : {};
        for (const unit of Object.values(sourceUnits)) inspect(unit.text, translatedUnits[unit.id]?.text,
          "html_text", { ...target, nodeId: unit.id }, unit.ast.attrs.lang || blockLanguage, { sourceHasWords: hasWords(htmlText(unit.ast)) });
      } else inspect(block.html, translation.html, "html", target, blockLanguage, { sourceHasWords: hasWords(fragmentText(parseFragment(block.html || ""))) });
    }
  }
  return { targetLanguage, expectedFields, presentFields, missingFieldCount: missing.length, missing: missing.slice(0, missingLimit), missingTruncated: missing.length > missingLimit,
    identicalFieldCount: copied.length, identical: copied.slice(0, identicalLimit), identicalTruncated: copied.length > identicalLimit,
    status: !expectedFields ? "not_applicable" : missing.length ? "incomplete" : "present",
    scope: "Field presence only, including individual natural-language table cells and stable HTML text units, not semantic translation verification. Default conversion requires zh-CN unless the user explicitly requests source-only or another language. Pure equations/numbers/images are shared; original scholarly names and bibliography may remain unchanged. Inspect identical natural-language fields instead of calling copied source translated." };
}

function observations(snapshot) {
  const document = snapshot.validated.document, blocks = document.blocks;
  const headings = blocks.filter(block => block.type === "heading");
  const navigation = readerNavigation(document), auxiliaryNavigation = readerNavigation({ ...document, blocks: blocks.map(block => block.type === "heading" ? { ...block, type: "para" } : block) });
  const sourceHeadings = headings.filter(block => block.level >= 1 && block.level <= 3 && typeof block.id === "string");
  const pages = [...new Set(blocks.flatMap(block => [...(block.source || []), ...(block.items || []).flatMap(item => item.source || [])]).map(location => location.page))].sort((a, b) => a - b);
  return {
    blockCount: blocks.length, headingCount: headings.length, sourceHeadingCount: sourceHeadings.length,
    auxiliaryEntryCount: auxiliaryNavigation.items.length, navigationEntryCount: navigation.items.length,
    navigationKind: navigation.kind,
    figureCount: blocks.filter(block => block.type === "figure").length,
    tableCount: blocks.filter(block => block.type === "table" || block.type === "html" && block.role === "table").length,
    mathBlockCount: blocks.filter(block => block.type === "math").length,
    referenceBlockCount: blocks.filter(block => block.role === "reference").length,
    sourceSha256: document.source?.sha256 || null,
    pdfPageCount: snapshot.validation.summary?.pageCount ?? null, mappedPages: pages,
    sourceMappedBlockCount: blocks.filter(block => block.source?.length).length,
    sourceBoxBlockCount: blocks.filter(block => block.source?.some(location => location.box)).length,
    translation: translationCoverage(document),
  };
}

function automaticIssues(snapshot, facts) {
  const issues = [], keyForId = new Map(Object.entries(snapshot.compiled.identity?.blocks || {}).map(([key, value]) => [value.id, key]));
  if (!facts.navigationEntryCount) issues.push({ key: "navigation-no-entries", layer: "usability", severity: "warning", status: "unverified",
    expected: "Confirm that the article remains easy to navigate. An original without headings may use separately identified auxiliary navigation.",
    actual: `${facts.headingCount} heading blocks and ${facts.auxiliaryEntryCount} usable auxiliary navigation entries. No claim is made that original headings are missing.`,
    evidenceSourceIds: [], recheck: { suggestion: "Compare the original heading structure and inspect the Reader outline; no-heading content is not itself a conversion failure." }, origin: "service-observation" });
  if (facts.translation.missingFieldCount) issues.push({ key: "translation-incomplete-zh-CN", layer: "usability", severity: "warning", status: "unverified",
    expected: "Default non-Chinese conversion includes complete saved zh-CN translation unless the user explicitly requested source-only or another target language.",
    actual: `${facts.translation.presentFields}/${facts.translation.expectedFields} translatable fields have zh-CN content; ${facts.translation.missingFieldCount} are missing. See observations.translation.missing for exact targets.`,
    evidenceSourceIds: [], recheck: { suggestion: "Translate missing title/body/list/caption/table/HTML fields, preserve source identities and values, rebuild a preview and inspect translation and bilingual modes. Shared pure equations/images need no duplicate translation. Record an explicit source-only request if applicable." }, origin: "service-observation" });
  if (facts.translation.identicalFieldCount) issues.push({ key: "translation-identical-source-zh-CN", layer: "usability", severity: "warning", status: "unverified",
    expected: "Natural-language translation is reviewed separately from field presence; legitimate unchanged names and identifiers are explained.",
    actual: `${facts.translation.identicalFieldCount} natural-language fields are exactly equal to their source. This is a review hint, not proof of a defective translation. See observations.translation.identical.`,
    evidenceSourceIds: [], recheck: { suggestion: "Check whether these are untranslated prose or intentionally retained proper names/identifiers. Do not mark copied English paragraphs as complete Chinese translations." }, origin: "service-observation" });
  if (facts.sourceSha256) {
    for (const block of snapshot.validated.document.blocks) {
      if (block.origin === "user" || block.source?.length) continue;
      issues.push({ key: "source-location-" + block.id, layer: "source_fidelity", severity: "warning", status: "unverified",
        ...(keyForId.has(block.id) ? { authorKey: keyForId.get(block.id) } : {}), target: { blockId: block.id },
        expected: "Source content has a reliable original page or an explicit explanation of why no mapping is available.",
        actual: "The frozen source block has no page mapping.", evidenceSourceIds: [],
        recheck: { suggestion: "Compare this block with the unchanged original; add only reliable page/region evidence and rebuild the preview." }, origin: "service-observation" });
      if (issues.length >= QUALITY_LIMITS.issuesPerReview) break;
    }
  }
  return issues;
}

function layerResult(layer, reviews, issues) {
  const assessments = reviews.map(({ sourceId, review }) => ({ sourceId, reviewerId: review.reviewer.id, reviewerRole: review.reviewer.role,
    ...(review.format === COMPACT_REVIEW_FORMAT ? { claimScope: "single-whole-scope-attestation" } : {}),
    reportedStatus: review.layers[layer].status,
    effectiveStatus: review.reviewer.role === "generator" && review.layers[layer].status === "verified" ? "unverified" : review.layers[layer].status,
    summary: review.layers[layer].summary, evidenceSourceIds: review.layers[layer].evidenceSourceIds }));
  const eligible = assessments.filter(item => item.reviewerRole !== "generator");
  const failed = assessments.some(item => item.reportedStatus === "failed") || issues.some(issue => issue.layer === layer && issue.status !== "resolved" && issue.severity === "blocking");
  const status = failed ? "failed" : !eligible.length || eligible.some(item => item.effectiveStatus === "unverified") ? "unverified"
    : eligible.every(item => item.effectiveStatus === "not_applicable") ? "not_applicable" : "verified";
  return { status, basis: status === "verified" ? "reviewer-attestation" : status === "not_applicable" ? "explicit-reviewed-scope" : status === "failed" ? "reported-finding" : "not-established", assessments,
    scope: "Evidence bytes, snapshot binding and locations are checked by the service. Reviewer conclusions and declared independence are not authenticated or proved by the service." };
}

export function previewQualityReport(snapshot, { reviews = [], evidence = [], legacyReview = null, jsonEvidence = new Map() } = {}) {
  const facts = observations(snapshot), automatic = automaticIssues(snapshot, facts);
  const plan = authoringReviewPlan(snapshot, facts), required = new Set(plan.requiredCoverage.blockIds);
  const scopedDocument = plan.scope.kind === "full" ? snapshot.validated.document : { ...snapshot.validated.document,
    meta: { ...snapshot.validated.document.meta, ...(plan.requiredCoverage.meta ? {} : { title: undefined }) },
    blocks: snapshot.validated.document.blocks.filter(block => required.has(block.id)) };
  const completion = workflowCompletion(snapshot, plan, reviews, evidence, jsonEvidence, language => translationCoverage(scopedDocument, language, { missingLimit: 100000, identicalLimit: 100000 }));
  const scopedTranslation = translationCoverage(scopedDocument, completion.targetLanguage === "source" ? plan.defaultTargetLanguage : completion.targetLanguage, { missingLimit: 100000, identicalLimit: 100000 });
  const reported = reviews.flatMap(({ sourceId, review }) => [
    ...review.issues.map(issue => ({ ...clone(issue), reviewSourceId: sourceId,
      reviewerId: review.reviewer.id, reviewerRole: review.reviewer.role, origin: "reviewer-report" })),
    ...(review.workflow?.checks || []).filter(item => item.status === "failed").map(item => ({ key: `review-check-${item.key}`,
      layer: plan.checks.find(required => required.key === item.key)?.layer || "usability", severity: "blocking", status: "failed",
      expected: plan.checks.find(required => required.key === item.key)?.instruction || "Complete the required review check.", actual: item.summary,
      evidenceSourceIds: item.evidenceSourceIds, recheck: { suggestion: "Resolve this failed check and retain its repair/recheck evidence for the exact candidate; another passing report cannot erase a supplied failure." },
      reviewSourceId: sourceId, reviewerId: review.reviewer.id, reviewerRole: review.reviewer.role, origin: "reviewer-check" })),
  ]);
  const issues = [...automatic, ...reported];
  const layers = { structural_resources: { status: "verified", basis: "service-validation",
    scope: "Frozen authoring compilation, resource hashes, source page/box bounds, identities, table shape, internal links and math syntax. This does not compare values, crops, source completeness or rendered layout with the original." } };
  for (const layer of QUALITY_LAYERS) layers[layer] = layerResult(layer, reviews, reported);
  const failedLayers = Object.entries(layers).filter(([, value]) => value.status === "failed").map(([key]) => key);
  const blocking = reported.filter(issue => issue.severity === "blocking" && issue.status !== "resolved");
  const status = failedLayers.length || blocking.length ? "failed" : completion.ready && QUALITY_LAYERS.every(layer => ["verified", "not_applicable"].includes(layers[layer].status)) ? "verified" : "unverified";
  return { format: QUALITY_REPORT_FORMAT, evaluatorVersion: 7,
    preview: snapshot.id && snapshot.hash ? { id: snapshot.id, hash: snapshot.hash } : null,
    document: { id: snapshot.validated.document.id, revision: snapshot.validated.document.revision, sha256: snapshot.manifest?.documentHash || hash(canonical(snapshot.validated.document)) },
    status, layers, observations: facts, issues, workflow: { plan, completion, translation: scopedTranslation, reviewTemplate: workflowReviewTemplate(snapshot, plan) }, automaticIssueLimit: QUALITY_LIMITS.issuesPerReview,
    automaticIssuesTruncated: facts.sourceSha256 ? snapshot.validated.document.blocks.filter(block => block.origin !== "user" && !block.source?.length).length + Number(!facts.navigationEntryCount) + Number(Boolean(facts.translation.missingFieldCount)) + Number(Boolean(facts.translation.identicalFieldCount)) > automatic.length : false,
    reviews: reviews.map(({ sourceId, sha256: digest, review }) => ({ sourceId, sha256: digest, reviewer: clone(review.reviewer), baseline: clone(review.baseline), independence: "declared-not-authenticated" })),
    evidence: clone(evidence), legacyReview: legacyReview ? { supplied: true, status: "unverified", scope: "Free-text review remains compatible, but is not structured evidence of verified quality." } : null,
    publication: { allowed: status !== "failed" && completion.ready, blockingIssueKeys: blocking.map(issue => issue.key), failedLayers,
      pendingCheckKeys: uniqueKeys(completion.pending.map(item => item.key)),
      policy: "Publication requires complete requested translations and an independent review of the service-selected scope against the original and actual Reader, with actual spawn evidence. The compact v3 report is preferred; valid v2 reports remain supported. Failed results, unresolved blocking findings and incomplete review prevent publication. Historical v1/text records cannot satisfy a new publication." },
    scope: "Derived quality assessment bound to the frozen preview. It is not part of the preview manifest/hash. Counts and missing mappings are observations, not source-fidelity scores. No image crop, pixel, text-similarity, browser or model review is performed automatically." };
}

export function requirePublishableQuality(quality) {
  check(quality.publication.allowed, "AUTHORING_QUALITY_FAILED", "转换尚未完成，不能发布。读取预览 report.json 的 workflow，完成列出的复审或修复；内容变化后复核新快照。", 409,
    { preview: quality.preview, status: quality.status, failedLayers: quality.publication.failedLayers,
      blockingIssueKeys: quality.publication.blockingIssueKeys.slice(0, 8), pendingCheckKeys: quality.publication.pendingCheckKeys,
      pending: quality.workflow.completion.pending.slice(0, 4).map(({ key, action, details }) => ({ key, action: action.slice(0, 250), ...(details?.missingCount ? { missingCount: details.missingCount } : {}) })),
      issuesTruncated: quality.publication.blockingIssueKeys.length > 8 || quality.workflow.completion.pendingCount > 4,
      reportSourceIds: quality.reviews.map(review => review.sourceId).slice(0, 8) });
}

const uniqueKeys = values => [...new Set(values)];

export function storedAuthoringQuality(saved) {
  const retained = saved.report.previewSubmission?.quality, documentHash = hash(canonical(saved.document));
  const submission = saved.report.authoringSubmission, preview = saved.report.previewSubmission;
  if (retained && retained.document?.id === saved.document.id && retained.document.revision === saved.document.revision && retained.document.sha256 === documentHash) {
    // Keep the original review claims/evidence intact, but expose current
    // automatic observations (including coverage added by newer evaluators).
    const current = previewQualityReport({ id: preview.previewId, hash: preview.previewHash, manifest: { documentHash }, validated: saved,
      compiled: { authoring: saved.authoring, identity: saved.identity, report: submission?.compiler }, validation: { summary: submission?.summary || {} } });
    return { ...clone(retained), evaluatorVersion: current.evaluatorVersion, observations: current.observations,
      issues: [...current.issues, ...clone(retained.issues || []).filter(issue => issue.origin !== "service-observation")],
      automaticIssueLimit: current.automaticIssueLimit, automaticIssuesTruncated: current.automaticIssuesTruncated };
  }
  const samePreviewDocument = preview?.documentHash === documentHash;
  const result = previewQualityReport({ id: samePreviewDocument ? preview?.previewId : undefined, hash: samePreviewDocument ? preview?.previewHash : undefined,
    manifest: { documentHash },
    validated: saved, compiled: { authoring: saved.authoring, identity: saved.identity, report: submission?.compiler },
    validation: { summary: submission?.summary || {} } }, { legacyReview: preview?.review });
  if (retained || preview && !samePreviewDocument) result.previousAssessment = { preview: retained?.preview || { id: preview.previewId, hash: preview.previewHash },
    document: retained?.document || { sha256: preview.documentHash }, status: retained?.status || "unverified", recheckRequired: true,
    reason: "The saved document changed after the reviewed preview. Earlier review evidence is retained for history and cannot verify this revision." };
  return result;
}
