import assert from "node:assert/strict";

// This helper is ONLY for publication-protocol regressions that need to reach
// immutable snapshot, receipt, version, race or authorization behavior. Every
// report/session/check below is deliberately constructed test data. Nothing in
// it is an actual Agent execution, source-first comparison or Reader review.
// Ordinary business-data setup must use authoring-fixture.mjs instead. Real
// completion evidence must come from the actual independent review workflow.
export const protocolEvidenceBoundary = "Constructed protocol fixture only. No actual reviewer subagent, source comparison, translation review or browser acceptance is claimed.";

export async function createProtocolReviewEvidence({ preview, readReport, upload, evidenceSourceIds = [] }) {
  const quality = (await readReport(preview)).quality;
  assert.deepEqual(quality.preview, { id: preview.id, hash: preview.hash });
  const report = structuredClone(quality.workflow.reviewTemplate);
  assert.equal(report.format, "reader-quality-review-3");
  const json = (value, filename) => upload(Buffer.from(JSON.stringify(value, null, 2) + "\n"), filename, "application/json");
  const trace = await upload(Buffer.from(protocolEvidenceBoundary + "\n"), "protocol-fixture-trace.txt", "text/plain");
  const supporting = await upload(Buffer.from(protocolEvidenceBoundary + "\n"), "protocol-fixture-review-evidence.txt", "text/plain");
  const ids = [...evidenceSourceIds, trace.sourceId, supporting.sourceId];
  report.reviewer = { sessionId: "/synthetic-protocol/reviewer", generatorSessionId: "/synthetic-protocol/generator", traceSourceIds: [trace.sourceId] };
  report.result = { status: "verified", summary: protocolEvidenceBoundary, sourceFirst: true, readerInspected: true };
  report.evidenceSourceIds = [supporting.sourceId];
  // The protocol tests intentionally retain their existing source-language
  // fixtures. This explicit synthetic exception does not authorize source-only
  // delivery for a user task and does not change any candidate's saved content.
  report.delivery = { targetLanguage: "source",
    userRequest: "Protocol-test instruction: keep this existing synthetic source-language fixture unchanged while testing publication, hashes, versions and authorization. This is not a user conversion delivery." };
  const file = await json(report, "protocol-fixture-review.json"); ids.push(file.sourceId);
  const review = { sourceReview: protocolEvidenceBoundary, layoutReview: protocolEvidenceBoundary,
    interactionReview: protocolEvidenceBoundary, evidenceSourceIds: ids };
  return { review, mcpReview: { source_review: review.sourceReview, layout_review: review.layoutReview,
    interaction_review: review.interactionReview, evidence_source_ids: ids }, report, ids };
}
