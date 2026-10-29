import { canonical, check, clone, hash, identifier, object, text } from "./errors.mjs";
import { AUTHORING_CONTRACT_VERSION, authoringSubmission, verifyAuthoringFile } from "./authoring-core.mjs";
import { validateDocument } from "./documents.mjs";
import { collectQualityEvidence, previewQualityReport, requirePublishableQuality } from "./authoring-quality.mjs";
import { boundedWorkflowSummary } from "./authoring-review-workflow.mjs";

const digest = (value) => hash(canonical(JSON.parse(JSON.stringify(value))));
const resourceManifest = (resourceMap) => Object.entries(resourceMap).sort(([a], [b]) => a.localeCompare(b))
  .map(([path, value]) => ({ path, sha256: value.sha256, mediaType: value.mediaType, size: value.size }));
const artifactHashes = ({ compiled, validated, validation, resourceMap, authoringFile }) => ({
  authoring: digest(compiled.authoring), index: digest(validated.index), fingerprints: digest(validated.fingerprints),
  validationReport: digest(validated.report), compilerReport: digest(compiled.report), validation: digest(validation), readOnly: digest(validated.readOnly),
  resources: digest(resourceMap), authoringFile: digest(authoringFile),
});

export function verifyPreviewSnapshot(snapshot) {
  const manifest = snapshot?.manifest;
  check(manifest && ["reader-preview-1", "reader-preview-2", "reader-preview-3"].includes(manifest.version), "PREVIEW_HASH_MISMATCH", "草稿快照格式无效。", 409);
  check(hash(canonical(manifest)) === snapshot.hash && snapshot.id === "preview-" + snapshot.hash &&
    digest(snapshot.validated.document) === manifest.documentHash && digest(snapshot.compiled.identity) === manifest.identityHash &&
    snapshot.authoringFile.sha256 === manifest.authoringHash && canonical(resourceManifest(snapshot.resourceMap)) === canonical(manifest.resources),
    "PREVIEW_HASH_MISMATCH", "保存的草稿快照摘要不一致。", 409);
  if (["reader-preview-2", "reader-preview-3"].includes(manifest.version)) check(canonical(artifactHashes(snapshot)) === canonical(manifest.artifactHashes),
    "PREVIEW_HASH_MISMATCH", "草稿索引、作者输入或校验记录与已检查的快照不一致。", 409);
  if (manifest.version === "reader-preview-3") check(snapshot.revisionTarget && digest(snapshot.revisionTarget) === manifest.revisionTargetHash,
    "PREVIEW_HASH_MISMATCH", "修订目标、基准或引用影响与已检查的快照不一致。", 409);
  else check(!snapshot.revisionTarget, "PREVIEW_HASH_MISMATCH", "旧预览不能附加未冻结的修订目标。", 409);
  return snapshot;
}

export function previewSubmission(input) {
  object(input, "草稿预览提交");
  const { previousPreviewId, ...submission } = input;
  if (previousPreviewId !== undefined) identifier(previousPreviewId, "上一份草稿快照");
  return { ...authoringSubmission(submission, true), ...(previousPreviewId ? { previousPreviewId } : {}) };
}

export function freezeAuthoringPreview(prepared, previousPreviewId) {
  // Hash the exact JSON representation persisted in SQLite, not undefined-only JS properties.
  const { compiled, validated, resourceMap, authoringFile, validation, revisionTarget } = JSON.parse(JSON.stringify(prepared));
  const documentHash = hash(canonical(validated.document)), identityHash = hash(canonical(compiled.identity));
  const resources = resourceManifest(resourceMap);
  const manifest = { version: revisionTarget ? "reader-preview-3" : "reader-preview-2", contractVersion: AUTHORING_CONTRACT_VERSION, authoringHash: authoringFile.sha256,
    documentHash, identityHash, resources, artifactHashes: artifactHashes({ compiled, validated, validation, resourceMap, authoringFile }), ...(revisionTarget ? { revisionTargetHash: digest(revisionTarget) } : {}) };
  const previewHash = hash(canonical(manifest));
  return { id: "preview-" + previewHash, hash: previewHash, manifest, createdAt: new Date().toISOString(),
    ...(previousPreviewId ? { previousPreviewId } : {}),
    compiled: { authoring: compiled.authoring, identity: compiled.identity, report: compiled.report },
    validated, resourceMap, authoringFile, validation, ...(revisionTarget ? { revisionTarget } : {}) };
}

export function previewDescriptor(snapshot, publishedDocumentId = null, publicationQuality = null) {
  const base = `/api/authoring/previews/${encodeURIComponent(snapshot.id)}`;
  const quality = previewQualityReport(snapshot);
  return { id: snapshot.id, hash: snapshot.hash, authoringHash: snapshot.manifest.authoringHash, documentHash: snapshot.manifest.documentHash,
    identityHash: snapshot.manifest.identityHash, contractVersion: snapshot.manifest.contractVersion, createdAt: snapshot.createdAt,
    previousPreviewId: snapshot.previousPreviewId || null, draftId: snapshot.draftId, summary: snapshot.validation.summary,
    review: { ...boundedWorkflowSummary(publicationQuality?.workflow?.completion || quality.workflow.completion),
      ...(publishedDocumentId && !publicationQuality?.workflow ? { status: "historical", next: "This was published under an earlier review policy. Retained evidence remains readable; it is not a new completion claim." } : {}),
      reportUrl: `${base}/artifacts/report.json` },
    ...(snapshot.revisionTarget ? { target: { documentId: snapshot.revisionTarget.documentId, baseRevision: snapshot.revisionTarget.baseRevision, baseHash: snapshot.revisionTarget.baseHash }, impact: snapshot.validation.revisionTarget } : {}),
    published: Boolean(publishedDocumentId), publishedDocumentId, requiresAuthorization: true,
    previewUrl: `/?draft=${encodeURIComponent(snapshot.draftId)}`, snapshotUrl: `/?preview=${encodeURIComponent(snapshot.id)}`, documentUrl: base,
    artifacts: ["authoring", "document", "identity", "report", "index", "manifest"].map((kind) => ({ kind, filename: `${kind}.json`,
      mediaType: "application/json", url: `${base}/artifacts/${kind}.json`, requiresAuthorization: true })) };
}

export function previewPublication(input) {
  object(input, "草稿发布");
  const allowed = new Set(["previewId", "expectedHash", "requestId", "review"]);
  for (const name of Object.keys(input)) check(allowed.has(name), "VALIDATION_FAILED", "草稿发布含未知字段。", 400, { field: name });
  identifier(input.previewId, "草稿快照标识"); text(input.requestId, "请求标识", 160, true);
  check(typeof input.expectedHash === "string" && /^[a-f0-9]{64}$/.test(input.expectedHash), "VALIDATION_FAILED", "请指定已检查的草稿摘要。");
  const review = object(input.review, "Agent 核对记录");
  for (const name of Object.keys(review)) check(["sourceReview", "layoutReview", "interactionReview", "evidenceSourceIds"].includes(name), "VALIDATION_FAILED", "核对记录含未知字段。", 400, { field: "review." + name });
  for (const field of ["sourceReview", "layoutReview", "interactionReview"]) text(review[field], field, 5000, true);
  check(review.evidenceSourceIds === undefined || (Array.isArray(review.evidenceSourceIds) && review.evidenceSourceIds.length <= 40), "VALIDATION_FAILED", "检查证据最多 40 份。完成发布需要独立复审报告及其全部支持文件。");
  const evidenceSourceIds = [...new Set((review.evidenceSourceIds || []).map((id) => identifier(id, "检查证据文件")))];
  return { previewId: input.previewId, expectedHash: input.expectedHash, requestId: input.requestId, review: { ...review, evidenceSourceIds } };
}

export async function preparePreviewPublication(workspace, snapshot, submission) {
  verifyPreviewSnapshot(snapshot);
  check(snapshot.hash === submission.expectedHash, "PREVIEW_HASH_MISMATCH", "草稿摘要与已检查的版本不同，请重新读取并核对。", 409);
  check(snapshot.manifest.contractVersion === AUTHORING_CONTRACT_VERSION, "PREVIEW_CONTRACT_CHANGED", "作者格式约定已更新，请重新生成预览并核对。", 409);
  check(hash(canonical(snapshot.validated.document)) === snapshot.manifest.documentHash && hash(canonical(snapshot.compiled.identity)) === snapshot.manifest.identityHash,
    "PREVIEW_HASH_MISMATCH", "保存的草稿快照摘要不一致。", 409);
  for (const file of [snapshot.authoringFile, ...Object.values(snapshot.resourceMap)]) await verifyAuthoringFile(file, workspace.resources);
  const { evidence, reviews, jsonEvidence } = await collectQualityEvidence(workspace, snapshot, submission.review.evidenceSourceIds, verifyAuthoringFile);
  const quality = previewQualityReport(snapshot, { evidence, reviews, jsonEvidence, legacyReview: submission.review });
  requirePublishableQuality(quality);
  // Recheck the frozen output, never recompile it or allocate new identities.
  const checked = await validateDocument(snapshot.validated.document, { resourceMap: snapshot.resourceMap, pageCount: snapshot.validation.summary.pageCount ?? undefined });
  check(hash(canonical(JSON.parse(JSON.stringify(checked.document)))) === snapshot.manifest.documentHash, "PREVIEW_HASH_MISMATCH", "重新校验改变了草稿内容，请重新生成预览。", 409);
  // v1 candidates keep their original reviewed hash. Their derived data was not
  // in that manifest, so verify it against the frozen document before reuse.
  check(digest(checked.index) === digest(snapshot.validated.index) && digest(checked.fingerprints) === digest(snapshot.validated.fingerprints) && checked.readOnly === snapshot.validated.readOnly,
    "PREVIEW_HASH_MISMATCH", "草稿索引与已检查的正文不一致。", 409);
  const prepared = clone(snapshot);
  prepared.validated.report.previewSubmission = { previewId: snapshot.id, previewHash: snapshot.hash, documentHash: snapshot.manifest.documentHash,
    identityHash: snapshot.manifest.identityHash, reviewedAt: new Date().toISOString(), review: clone(submission.review), evidence, quality,
    scope: "Free-text declarations and structured review evidence are recorded separately. The service verifies snapshot/evidence bytes, bindings and findings; it does not prove reviewer conclusions or declared independence." };
  return prepared;
}
