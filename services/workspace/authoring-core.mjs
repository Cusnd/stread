import { createHash } from "node:crypto";
import { canonical, check, clone, fail, hash, identifier, object, text } from "./errors.mjs";
import { compileInput, validateDocument } from "./documents.mjs";
import { safeHtmlAsset } from "../../prototypes/insight-composer/src/html-content.js";
import { authoringRevisionPrevious, authoringRevisionTarget, createAuthoringEditPackage, revisionImpact, revisionReferenceGuard } from "./authoring-edit-package.mjs";
import { storedAuthoringQuality } from "./authoring-quality.mjs";
import { deriveAuthoringReviewScope } from "./authoring-review-scope.mjs";
import { CONVERSION_INSTRUCTIONS } from "../../prototypes/insight-composer/src/conversion-request.js";

// Documentation/review simplification does not change compiled authoring or
// invalidate already-frozen candidates. Review records version independently.
export const AUTHORING_CONTRACT_VERSION = "reader-authoring-1/2026-10-26";
export const MAX_AUTHORING_BYTES = 16 * 1024 * 1024;
const MAX_RESOURCE_BINDINGS = 2000;
const artifactKinds = ["authoring", "identity", "report", "index"];
export const documentation = [
  ["guide.md", "Start authoring", "./authoring-guide.md"],
  ["conversion-workflow.md", "Independent review and publication", "./conversion-workflow.md"],
  ["minimal-example.json", "Minimal bilingual example", "./authoring-minimal-example.json"],
  ["format-reference.md", "Detailed format reference", "./authoring-format-reference.md"],
  ["file-access.md", "Authorized upload and preview capabilities", "./file-access.md"],
  ["mcp-management.md", "MCP tool reference", "./mcp-management.md"],
  ["example.json", "All-type authoring example", "./authoring-example.json"],
  ["authoring-schema.json", "Strict author input schema", "./authoring-schema.json"],
  ["Agent转换约定.md", "Multi-agent conversion workflow", "../../spec/Agent转换约定.md"],
  ["转换质量反馈.md", "Bound issues, evidence and recheck", "../../spec/转换质量反馈.md"],
  ["辅助阅读导航.md", "Navigation without source headings", "../../spec/辅助阅读导航.md"],
  ["文档格式.md", "Stored document reference", "../../spec/文档格式.md"],
  ["自定义HTML内容块.md", "Semantic HTML and alignment", "../../spec/自定义HTML内容块.md"],
  ["双语对照.md", "Translation fields and provenance", "../../spec/双语对照.md"],
  ["统一样式.md", "Shared styles and allowed CSS", "../../spec/统一样式.md"],
  ["内容模块与布局.md", "Block and HTML layout", "../../spec/内容模块与布局.md"],
  ...["index.md", "agent-conversion-prompt.md", "manifest.json", "image-text.json", "multi-figure.json", "steps-notes.json", "definition-explanation.json", "grouped-table.json", "layout-examples.zip", "images/scattered.png", "images/paired.png", "images/grouped.png"].map((name) =>
    ["examples/" + name, "Layout: " + name, "./authoring-examples/" + name]),
];

export function uploadedSourceDescriptor(file) {
  return { sourceId: file.id, filename: file.filename, mediaType: file.mediaType, sha256: file.sha256, size: file.size,
    url: `/api/sources/${encodeURIComponent(file.id)}/original`, requiresAuthorization: true };
}

export function authoringContract(source) {
  return {
    version: AUTHORING_CONTRACT_VERSION, format: "reader-authoring-1", ...(source ? { source } : {}),
    documentation: documentation.filter(([filename]) => ["guide.md", "authoring-schema.json", "minimal-example.json", "conversion-workflow.md", "format-reference.md"].includes(filename)).map(([filename, title]) => ({ title, filename, url: `/api/authoring/docs/${filename}`, requiresAuthorization: true })),
    envelope: { format: "reader-authoring-1", key: "paper", meta: { title: "Title", language: "en", translations: { "zh-CN": { title: "标题" } } },
      blocks: [{ key: "p1", type: "para", text: "Let $x_i \\in \\mathbb{R}$; then $x_i^2 \\ge 0$.", translations: { "zh-CN": { text: "设 $x_i \\in \\mathbb{R}$，则 $x_i^2 \\ge 0$。" } } }] },
    rules: [
      CONVERSION_INSTRUCTIONS,
      String.raw`Encode inline mathematics as $...$ in each source and translated sentence, e.g. $x_i^2$. Bare x_i or F^n stays literal. Display equations use type: "math" and tex without $$; semantic HTML uses <span data-tex="x_i^2"></span>. Use real TeX such as \binom{n}{k}, \lfloor t\rfloor and \{x\}, not binom(...) or floor(...). Escape backslashes in JSON ("\\binom{n}{k}"). Inspect inline and display formulas against the original in every applicable Reader language mode; syntax PASS does not prove correct notation.`,
      "The service does not run a model. It checks structure/resources and stores exact versions. External callers own independent review and publication, including actual source and Reader review.",
    ],
    steps: [
      "Get original URL/hash with query_uploaded_sources. Upload authoring/assets using prepare_source_upload; bind relative paths to file IDs.",
      "Create a preview. Its Reader URL and report supply diagnostics, review scope and a compact review template. Repair with previous_preview_id; publish the reviewed hash with review/evidence IDs.",
      "For revisions, first read_resources(kind=authoring_artifacts,mode=editing); reuse its bindings and target. Retain receipts and exact request IDs for retries.",
    ],
    submission: { authoringSourceId: "Uploaded authoring JSON file ID", resources: { "source.pdf": "Uploaded original file ID", "figures/figure-1.png": "Uploaded figure file ID" } },
    checks: ["Format, identities and links", "Marked TeX syntax, not mathematical fidelity", "Translation presence/alignment", "Resource hashes and source locations"],
    limits: { authoringBytes: MAX_AUTHORING_BYTES, resourceBindings: MAX_RESOURCE_BINDINGS },
    routes: { validate: "/api/authoring/validate", previews: "/api/authoring/previews", publishPreview: "/api/authoring/previews/publish", sources: "/api/sources", contract: "/api/authoring/contract" },
  };
}

export function authoringSubmission(input, publish = false) {
  object(input, "作者输入提交");
  const allowed = new Set(["authoringSourceId", "resources", "target", ...(publish ? ["requestId"] : [])]);
  for (const key of Object.keys(input)) check(allowed.has(key), "VALIDATION_FAILED", "作者输入提交含未知字段。", 400, { field: key });
  identifier(input.authoringSourceId, "作者输入文件标识");
  const resources = object(input.resources ?? {}, "资源绑定");
  check(Object.keys(resources).length <= MAX_RESOURCE_BINDINGS, "VALIDATION_FAILED", "资源绑定数量超过限制。");
  const bindings = {};
  for (const [path, fileId] of Object.entries(resources)) {
    check(path.length <= 500 && safeHtmlAsset(path) && !["__proto__", "constructor", "prototype"].includes(path), "VALIDATION_FAILED", "资源路径必须是文档内的相对路径。", 400, { path });
    bindings[path] = identifier(fileId, "资源文件标识");
  }
  if (publish) text(input.requestId, "请求标识", 160, true);
  return { authoringSourceId: input.authoringSourceId, resources: bindings, ...(input.target === undefined ? {} : { target: authoringRevisionTarget(input.target) }), ...(publish ? { requestId: input.requestId } : {}) };
}

export async function verifyAuthoringFile(file, resources) {
  const digest = createHash("sha256"); let size = 0;
  try {
    for await (const chunk of await resources.open(file.sha256)) { size += chunk.length; digest.update(chunk); }
  } catch (error) {
    if (error.code === "ENOENT") fail("RESOURCE_MISSING", "已上传资源的原始字节不可用。", 400, { sourceId: file.id });
    throw error;
  }
  check(size === file.size && digest.digest("hex") === file.sha256, "SOURCE_HASH_MISMATCH", "已上传资源字节与保存的摘要不同。", 400, { sourceId: file.id });
}

const warningSummary = (warning) => ({ code: String(warning.code || "AUTHORING_REVIEW").slice(0, 80),
  ...(warning.key ? { key: String(warning.key).slice(0, 160) } : {}),
  ...(warning.path ? { path: String(warning.path).slice(0, 500) } : {}),
  ...(warning.field ? { field: String(warning.field).slice(0, 160) } : {}),
  ...(warning.hint ? { hint: String(warning.hint).slice(0, 500) } : {}),
  ...(warning.language ? { language: String(warning.language).slice(0, 64) } : {}),
  message: String(warning.message || warning.detail || warning.code || "Review required").slice(0, 320) });

export async function prepareAuthoring(workspace, input, previous = null, { reads } = {}) {
  const submission = authoringSubmission(input), authoringFile = await workspace.file(submission.authoringSourceId);
  let baseline, editing, baselineRow;
  if (submission.target) {
    const target = submission.target;
    const current = await workspace.row(target.documentId);
    check(current.current_revision === target.baseRevision, "REVISION_CONFLICT", "正式正文已改变，请取得新的当前版本编辑包。", 409, { documentId: target.documentId, expectedRevision: target.baseRevision, currentRevision: current.current_revision });
    baselineRow = await workspace.revisionRow(target.documentId, target.baseRevision);
    baseline = await workspace.storage.load(baselineRow);
    check(hash(canonical(baseline.document)) === target.baseHash, "REVISION_BASE_MISMATCH", "编辑包的基准正文摘要与保存版本不同。", 409, { documentId: target.documentId, baseRevision: target.baseRevision });
    editing = await createAuthoringEditPackage(baseline);
  }
  check(authoringFile.size <= MAX_AUTHORING_BYTES, "CONVERSION_LIMIT", "作者输入 JSON 不得超过 16 MiB。", 413);
  await verifyAuthoringFile(authoringFile, workspace.resources);
  let authoring;
  try {
    const bytes = await workspace.resources.read(authoringFile.sha256);
    authoring = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
  } catch { fail("INVALID_JSON", "作者输入文件必须是有效 UTF-8 JSON。"); }
  object(authoring, "作者输入");
  check(authoring.format === "reader-authoring-1", "UNSUPPORTED_FORMAT", "请提交 reader-authoring-1 作者输入，而不是已编译文档。");
  const resourceMap = clone(baseline?.resourceMap || {}), checked = new Set([authoringFile.sha256]);
  const resourceEntries = Object.entries(submission.resources);
  const resourceFiles = await workspace.files(resourceEntries.map(([, fileId]) => fileId));
  for (let index = 0; index < resourceEntries.length; index++) {
    const [path] = resourceEntries[index], file = resourceFiles[index];
    check(file, "NOT_FOUND", "来源文件不存在。", 404);
    if (!checked.has(file.sha256)) { await verifyAuthoringFile(file, workspace.resources); checked.add(file.sha256); }
    resourceMap[path] = file;
  }
  let pageCount;
  if (authoring.source) {
    object(authoring.source, "原文件");
    check(safeHtmlAsset(authoring.source.path), "VALIDATION_FAILED", "原文件路径必须是文档内的相对路径。");
    const source = resourceMap[authoring.source.path];
    check(source, "RESOURCE_MISSING", "请把作者输入声明的原文件路径绑定到已上传的原文件。", 400, { path: authoring.source.path });
    check(authoring.source.sha256 === source.sha256, "SOURCE_HASH_MISMATCH", "作者输入声明的原文件摘要与绑定的上传文件不同。", 400, { path: authoring.source.path });
    if (source.mediaType === "application/pdf" || authoring.source.media_type === "application/pdf" || authoring.source.path.toLowerCase().endsWith(".pdf")) pageCount = (await workspace.resources.manifest(source)).pages.length;
  } else check(!Array.isArray(authoring.blocks) || !authoring.blocks.some((block) => block?.source?.length || (block?.type === "list" && Array.isArray(block.items) && block.items.some((item) => item?.source?.length))), "SOURCE_REQUIRED", "含原页位置的作者输入必须声明并绑定原文件。");
  const compilePrevious = editing ? authoringRevisionPrevious(editing, baseline.document, previous, authoring) : previous;
  const compiled = await compileInput(authoring, compilePrevious);
  if (baseline) {
    check(compiled.document.id === baseline.document.id, "REVISION_BASE_MISMATCH", "候选必须保留原文档身份。", 409);
    check(canonical(compiled.document.source || null) === canonical(baseline.document.source || null), "SOURCE_HASH_MISMATCH", "既有文章修订必须保留原文件引用和摘要。", 409);
    compiled.document.revision = submission.target.baseRevision + 1;
    compiled.identity.revision = compiled.document.revision; compiled.report.revision = compiled.document.revision;
  }
  const validated = await validateDocument(compiled.document, { resourceMap, pageCount });
  const warnings = [...compiled.report.warnings, ...validated.report.diagnostics];
  const summary = { blockCount: validated.document.blocks.length, types: compiled.report.types,
    translatedBlocks: compiled.report.translated_blocks, sourceMappedBlocks: validated.document.blocks.filter((block) => block.source?.length).length,
    sourceBoxBlocks: validated.document.blocks.filter((block) => block.source?.some((source) => source.box)).length,
    pageCount: pageCount ?? null, resourceCount: Object.keys(resourceMap).length, hasOriginal: Boolean(authoring.source) };
  const validation = { valid: true, published: false, authoringSourceId: authoringFile.id, authoringHash: authoringFile.sha256,
    summary, warnings: warnings.slice(0, 12).map(warningSummary), warningCount: warnings.length, warningsTruncated: warnings.length > 12, scope: "structure-and-resources" };
  // Preserve the exact uploaded authoring bytes separately from compiled data.
  // Reports remain derivatives; neither they nor the resource map are editable input.
  validated.report.authoringSubmission = { contractVersion: AUTHORING_CONTRACT_VERSION, documentRevision: validated.document.revision, sourceId: authoringFile.id, sha256: authoringFile.sha256,
    resources: clone(submission.resources), compiler: compiled.report, summary };
  let revisionTarget;
  if (baseline) {
    const impact = revisionImpact(baseline, validated), guard = await revisionReferenceGuard(reads || { all: (sql, ...values) => workspace.sql.query(sql, values) }, baseline.document.id, impact, validated.index);
    revisionTarget = { ...submission.target, baseIdentityHash: editing.base.identityHash, baseRecordHash: hash(canonical(baselineRow)), baseTitle: baseline.document.meta.title,
      referenceGuardHash: guard.hash, impact: { ...impact, references: guard.references },
      reviewScope: deriveAuthoringReviewScope({ baseline: baseline.document, candidate: validated.document, baselineResourceMap: baseline.resourceMap, candidateResourceMap: resourceMap }) };
    validation.revisionTarget = { documentId: revisionTarget.documentId, baseRevision: revisionTarget.baseRevision, affectedBlocks: impact.affectedBlocks.length, removedIdentities: impact.removed.length,
      affectedReferences: guard.references.length, unresolvedReferences: guard.references.flatMap((entry) => entry.references).filter((entry) => entry.candidateReferenceStatus === "unresolved").length };
  }
  return { compiled, validated, resourceMap, authoringFile, validation, ...(revisionTarget ? { revisionTarget } : {}) };
}

export function authoringArtifactManifest(saved) {
  check(saved.authoring && saved.identity, "AUTHORING_UNAVAILABLE", "此文档版本没有保留作者输入与身份登记。", 404);
  const documentId = saved.document.id, revision = saved.document.revision;
  const authoringRevision = saved.report.authoringSubmission?.documentRevision ?? null;
  return { documentId, revision, authoringRevision, matchesDocumentRevision: authoringRevision === revision, requiresAuthorization: true, artifacts: artifactKinds.map((kind) => ({ kind, filename: `${kind}.json`, mediaType: "application/json",
    url: `/api/documents/${encodeURIComponent(documentId)}/authoring/${kind}.json?revision=${revision}`, requiresAuthorization: true })) };
}

export function authoringArtifact(saved, kind) {
  authoringArtifactManifest(saved);
  check(artifactKinds.includes(kind), "NOT_FOUND", "没有找到此作者输入附件。", 404);
  if (kind === "authoring") return saved.authoring;
  if (kind === "identity") return saved.identity;
  if (kind === "index") return saved.index;
  const report = clone(saved.report), submission = report.authoringSubmission;
  delete report.authoringSubmission;
  return { contractVersion: submission?.contractVersion || null, documentId: saved.document.id, revision: saved.document.revision,
    authoringRevision: submission?.documentRevision ?? null,
    compiler: submission?.compiler || null, validation: report, summary: submission?.summary || null,
    authoringSourceId: submission?.sourceId || null, authoringHash: submission?.sha256 || null, quality: storedAuthoringQuality(saved),
    scope: "Compiler/validation evidence covers structure and resources. Quality distinguishes unverified declarations, source/Reader review evidence and reported failures; reviewer identity and factual conclusions are not authenticated by this service." };
}
