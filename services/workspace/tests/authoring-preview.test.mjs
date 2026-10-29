import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createWorkspaceServer } from "../server.mjs";
import { canonical, hash } from "../errors.mjs";
import { defaultPython } from "../resources.mjs";
import { withoutFileAccess } from "./mcp-result-fixture.mjs";
import { createProtocolReviewEvidence } from "./authoring-protocol-evidence-fixture.mjs";

async function harness(t, { authToken = "" } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-authoring-preview-test-"));
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  let server, base;
  const start = async () => {
    server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false, authToken });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  await start();
  const request = async (path, body, status = 200) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`);
    return value;
  };
  const upload = async (bytes, filename, mediaType = "application/json") => {
    const response = await fetch(base + "/api/sources?filename=" + encodeURIComponent(filename), { method: "POST", headers: { ...headers, "Content-Type": mediaType }, body: bytes });
    const value = await response.json(); assert.equal(response.status, 201, JSON.stringify(value)); return value;
  };
  const author = (input) => upload(Buffer.from(JSON.stringify(input, null, 2) + "\n"), "authoring.json");
  const binary = async (path, status = 200) => {
    const response = await fetch(base + path, { headers });
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(response.status, status, `${path}: ${bytes.toString("utf8").slice(0, 500)}`);
    return { response, bytes };
  };
  t.after(async () => {
    await server.shutdown();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    assert.ok(basename(dataDir).startsWith("reader-authoring-preview-test-"));
    await rm(dataDir, { recursive: true, force: true });
  });
  const protocolEvidence = (preview, evidenceSourceIds = []) => createProtocolReviewEvidence({ preview, upload, evidenceSourceIds,
    readReport: current => request(`/api/authoring/previews/${current.id}/artifacts/report.json`) });
  return { get server() { return server; }, get w() { return server.workspace; }, get base() { return base; }, dataDir, headers, request, upload, author, binary, protocolEvidence,
    restart: async () => { await server.shutdown(); await start(); } };
}

function example() {
  return { format: "reader-authoring-1", key: "preview-example", meta: { title: "An editable preview", language: "en" }, blocks: [
    { key: "intro", type: "heading", level: 1, text: "Introduction" },
    { key: "paragraph", type: "para", text: "See the [paired explanation](#pair)." },
    { key: "items", type: "list", ordered: true, items: [{ key: "first", text: "First item." }, { key: "second", text: "Second item." }] },
    { key: "pair", type: "html", html: '<div class="layout-pair"><p data-key="claim">A statement.</p><p data-key="condition">Its condition.</p></div>',
      translations: { "zh-CN": { alignment: "same-structure", html: '<div class="layout-pair"><p data-key="claim">一个陈述。</p><p data-key="condition">成立条件。</p></div>' } } },
  ] };
}

const artifactUrl = (preview, kind) => preview.artifacts.find((item) => item.kind === kind).url;
const publishInput = (preview, extra = {}) => ({ previewId: preview.id, expectedHash: preview.hash, requestId: randomUUID(),
  review: { sourceReview: "Checked the illustrative source content and preserved its stated relationships.", layoutReview: "Checked the paired object at two desktop reading widths.", interactionReview: "Checked bilingual text selection and the paragraph link." }, ...extra });
const draftUrl = (preview) => `/api/authoring/drafts/${preview.draftId}`;

async function createPreview(h, input = example(), extra = {}) {
  const file = await h.author(input);
  const submission = { authoringSourceId: file.sourceId, requestId: randomUUID(), ...extra };
  const receipt = await h.request("/api/authoring/previews", submission, 201);
  return { file, submission, receipt, preview: receipt.preview };
}

test("preview creation is immutable and idempotent without changing formal documents, reading, current document or changes", async (t) => {
  const h = await harness(t), priorFile = await h.author({ ...example(), key: "existing-reading-document" });
  const prior = await h.request("/api/authoring/publish", { authoringSourceId: priorFile.sourceId, requestId: randomUUID() }, 201);
  const documentId = prior.document.id, priorSaved = await h.request(`/api/documents/${documentId}`);
  await h.request("/api/commands", { kind: "reading.open", documentId, requestId: randomUUID() });
  await h.request("/api/commands", { kind: "reading.checkpoint", documentId, requestId: randomUUID(), readingState: { revision: 1, blockId: priorSaved.document.blocks[1].id, offsetRatio: 0.4, mode: "source" } });
  const before = await h.request("/api/workspace"), changes = await h.request("/api/changes"), beforeDocument = await h.request(`/api/documents/${documentId}`);
  const input = example(), raw = Buffer.from("\n" + JSON.stringify(input, null, 4) + "\n\n"), file = await h.upload(raw, "preview-source.json");
  const submission = { authoringSourceId: file.sourceId, requestId: randomUUID() };
  const [first, retry] = await Promise.all([h.request("/api/authoring/previews", submission, 201), h.request("/api/authoring/previews", submission, 201)]);
  assert.deepEqual(first, retry);
  assert.equal(first.validation.published, false); assert.equal(first.preview.published, false);
  const saved = await h.request(first.preview.documentUrl), draft = await h.request(draftUrl(first.preview));
  assert.equal(saved.readOnly, true); assert.equal(draft.draft.currentPreviewId, first.preview.id); assert.equal(draft.draft.lastError, null);
  assert.equal(draft.draft.version, 1); assert.deepEqual(draft.document, saved.document);
  const manifest = await h.request(artifactUrl(first.preview, "manifest"));
  assert.equal(hash(canonical(saved.document)), manifest.documentHash);
  assert.equal(hash(canonical(await h.request(artifactUrl(first.preview, "identity")))), manifest.identityHash);
  assert.equal(hash(canonical(manifest)), first.preview.hash);
  assert.deepEqual((await h.binary(artifactUrl(first.preview, "authoring"))).bytes, raw);
  assert.equal((await h.request(`/api/documents/${saved.document.id}`, undefined, 404)).code, "NOT_FOUND");
  assert.deepEqual(await h.request("/api/workspace"), before); assert.deepEqual(await h.request("/api/changes"), changes);
  assert.deepEqual(await h.request(`/api/documents/${documentId}`), beforeDocument);
  assert.equal((await h.request("/api/authoring/previews", { ...submission, resources: { "extra.json": file.sourceId } }, 409)).code, "IDEMPOTENCY_CONFLICT");
});

test("draft updates keep block, item and HTML identities; failed edits preserve the snapshot and block publication until repaired", async (t) => {
  const h = await harness(t), first = await createPreview(h), originalSnapshot = await h.request(first.preview.documentUrl);
  const firstIdentity = await h.request(artifactUrl(first.preview, "identity"));
  const changed = example(); changed.blocks[1].text = "Corrected wording. See the [paired explanation](#pair).";
  changed.blocks[2].items.reverse(); changed.blocks[3].html = changed.blocks[3].html.replaceAll("layout-pair", "layout-stack");
  changed.blocks[3].translations["zh-CN"].html = changed.blocks[3].translations["zh-CN"].html.replaceAll("layout-pair", "layout-stack");
  const second = await createPreview(h, changed, { previousPreviewId: first.preview.id });
  assert.equal(second.preview.draftId, first.preview.draftId); assert.notEqual(second.preview.id, first.preview.id);
  const secondSnapshot = await h.request(second.preview.documentUrl), secondIdentity = await h.request(artifactUrl(second.preview, "identity"));
  assert.equal(secondSnapshot.document.id, originalSnapshot.document.id); assert.equal(secondSnapshot.document.revision, 2);
  for (const key of Object.keys(firstIdentity.blocks)) assert.equal(secondIdentity.blocks[key].id, firstIdentity.blocks[key].id);
  assert.deepEqual(secondIdentity.blocks.items.items, firstIdentity.blocks.items.items);
  assert.deepEqual(secondIdentity.blocks.pair.nodes.map(({ key, id }) => ({ key, id })), firstIdentity.blocks.pair.nodes.map(({ key, id }) => ({ key, id })));
  assert.deepEqual(await h.request(first.preview.documentUrl), originalSnapshot, "the previous snapshot remains immutable");
  const bad = structuredClone(changed); bad.blocks[1].layout = "ignored-layout";
  const badFile = await h.author(bad), before = await h.request("/api/workspace"), changes = await h.request("/api/changes");
  const failed = await h.request("/api/authoring/previews", { authoringSourceId: badFile.sourceId, previousPreviewId: second.preview.id, requestId: randomUUID() }, 400);
  assert.equal(failed.code, "VALIDATION_FAILED");
  const failedDraft = await h.request(draftUrl(second.preview));
  assert.equal(failedDraft.draft.currentPreviewId, second.preview.id); assert.equal(failedDraft.draft.lastError.code, "VALIDATION_FAILED");
  assert.deepEqual(failedDraft.document, secondSnapshot.document);
  assert.equal((await h.request("/api/authoring/previews/publish", publishInput(second.preview), 409)).code, "PREVIEW_INVALID_UPDATE");
  const repaired = structuredClone(changed); repaired.blocks[1].text = "Repaired. See the [paired explanation](#pair).";
  const third = await createPreview(h, repaired, { previousPreviewId: second.preview.id });
  const latest = await h.request(draftUrl(first.preview));
  assert.equal(latest.draft.currentPreviewId, third.preview.id); assert.equal(latest.draft.lastError, null);
  assert.ok(latest.draft.version > failedDraft.draft.version);
  assert.equal((await h.request("/api/authoring/previews", { authoringSourceId: third.file.sourceId, previousPreviewId: first.preview.id, requestId: randomUUID() }, 409)).code, "PREVIEW_SUPERSEDED");
  assert.equal((await h.request("/api/authoring/previews/publish", publishInput(second.preview), 409)).code, "PREVIEW_SUPERSEDED");
  assert.deepEqual(await h.request("/api/workspace"), before); assert.deepEqual(await h.request("/api/changes"), changes);
});

test("publication requires the reviewed hash and three review fields, then retains the exact frozen document, identities and authoring bytes", async (t) => {
  const h = await harness(t), initial = await createPreview(h), input = example(); input.blocks[0].text = "Revised introduction";
  const { preview } = await createPreview(h, input, { previousPreviewId: initial.preview.id });
  const snapshot = await h.request(preview.documentUrl), identity = await h.request(artifactUrl(preview, "identity"));
  const authoring = (await h.binary(artifactUrl(preview, "authoring"))).bytes;
  assert.equal((await h.request("/api/authoring/previews/publish", publishInput(preview, { expectedHash: "0".repeat(64) }), 409)).code, "PREVIEW_HASH_MISMATCH");
  for (const field of ["sourceReview", "layoutReview", "interactionReview"]) {
    const missing = publishInput(preview); delete missing.review[field];
    assert.equal((await h.request("/api/authoring/previews/publish", missing, 400)).code, "VALIDATION_FAILED");
    const empty = publishInput(preview); empty.review[field] = " ";
    assert.equal((await h.request("/api/authoring/previews/publish", empty, 400)).code, "VALIDATION_FAILED");
  }
  for (const invalid of [publishInput(preview, { extra: true }), publishInput(preview, { review: { ...publishInput(preview).review, approved: true } }), publishInput(preview, { review: { ...publishInput(preview).review, evidenceSourceIds: "not-an-array" } })]) {
    assert.equal((await h.request("/api/authoring/previews/publish", invalid, 400)).code, "VALIDATION_FAILED");
  }
  assert.equal((await h.request("/api/workspace")).documents.length, 0);
  const evidenceBytes = Buffer.from("Checked this frozen preview against the illustrative source.\n"), evidence = await h.upload(evidenceBytes, "review.md", "text/markdown");
  const submission = publishInput(preview, { review: (await h.protocolEvidence(preview, [evidence.sourceId])).review });
  const [receipt, concurrentRetry] = await Promise.all([h.request("/api/authoring/previews/publish", submission, 201), h.request("/api/authoring/previews/publish", submission, 201)]);
  assert.deepEqual(receipt, concurrentRetry); assert.equal(receipt.document.id, snapshot.document.id);
  assert.equal(receipt.document.revision, snapshot.document.revision); assert.equal(receipt.preview.published, true);
  const saved = await h.request(`/api/documents/${receipt.document.id}`);
  assert.deepEqual(saved.document, snapshot.document);
  const artifacts = await h.request(`/api/documents/${receipt.document.id}/authoring`);
  const artifact = (kind) => artifacts.artifacts.find((item) => item.kind === kind).url;
  assert.deepEqual(await h.request(artifact("identity")), identity);
  assert.deepEqual((await h.binary(artifact("authoring"))).bytes, authoring);
  const report = await h.request(artifact("report")), review = report.validation.previewSubmission;
  assert.equal(review.previewId, preview.id); assert.equal(review.previewHash, preview.hash);
  assert.deepEqual(review.review, submission.review); assert.equal(review.evidence[0].sha256, hash(evidenceBytes));
  assert.equal((await h.request(draftUrl(preview))).preview.publishedDocumentId, receipt.document.id);
  assert.equal((await h.request("/api/workspace")).documents.length, 1);
  assert.equal((await h.request("/api/changes")).changes.filter((item) => item.kind === "authoring.preview.publish").length, 1);
  assert.deepEqual(await h.request("/api/authoring/previews/publish", submission, 201), receipt);
  assert.equal((await h.request("/api/authoring/previews/publish", publishInput(preview), 409)).code, "PREVIEW_ALREADY_PUBLISHED");
});

test("draft heads, immutable previews and idempotent preview/publication receipts survive restart", async (t) => {
  const h = await harness(t), first = await createPreview(h), snapshot = await h.request(first.preview.documentUrl);
  await h.restart();
  assert.deepEqual(await h.request(first.preview.documentUrl), snapshot);
  assert.equal((await h.request(draftUrl(first.preview))).draft.currentPreviewId, first.preview.id);
  assert.deepEqual(await h.request("/api/authoring/previews", first.submission, 201), first.receipt);
  const input = publishInput(first.preview, { review: (await h.protocolEvidence(first.preview)).review });
  const published = await h.request("/api/authoring/previews/publish", input, 201);
  await h.restart();
  assert.deepEqual(await h.request("/api/authoring/previews/publish", input, 201), published);
  assert.equal((await h.request(draftUrl(first.preview))).preview.published, true);
  assert.deepEqual((await h.request(`/api/documents/${published.document.id}`)).document, snapshot.document);
  assert.equal((await h.request("/api/workspace")).documents.length, 1);
});

test("preview documents, artifacts, assets, PDF pages and authoring docs share authentication without formal publication", async (t) => {
  const h = await harness(t, { authToken: "preview-test-token" }), pdfPath = join(h.dataDir, "original.pdf");
  const made = spawnSync(defaultPython, ["-B", "-c", "import fitz,sys\nd=fitz.open()\np=d.new_page(width=400,height=500)\np.insert_text((50,80),'A statement.')\nd.save(sys.argv[1])", pdfPath], { encoding: "utf8", windowsHide: true });
  assert.equal(made.status, 0, made.stderr);
  const pdfBytes = await readFile(pdfPath), original = await h.upload(pdfBytes, "original.pdf", "application/pdf");
  const imageBytes = await readFile(new URL("../authoring-examples/images/paired.png", import.meta.url)), image = await h.upload(imageBytes, "paired.png", "image/png");
  const input = example(); input.source = { path: "source.pdf", sha256: original.sha256, media_type: "application/pdf" };
  input.blocks[1].source = [{ page: 1, box: [0.1, 0.1, 0.8, 0.2] }];
  input.blocks.push({ key: "image", type: "figure", src: "images/paired.png", alt: "Pairs", source: [{ page: 1 }] });
  const { preview } = await createPreview(h, input, { resources: { "source.pdf": original.sourceId, "images/paired.png": image.sourceId } });
  const prefix = `/api/authoring/previews/${preview.id}`, pdf = await h.request(prefix + "/pdf");
  assert.equal(pdf.sourceHash, original.sha256); assert.equal(pdf.pages.length, 1);
  assert.ok(pdf.sourceUrl.startsWith(prefix + "/assets/")); assert.ok(pdf.pages[0].imageUrl.startsWith(prefix + "/pages/"));
  assert.deepEqual((await h.binary(pdf.sourceUrl)).bytes, pdfBytes);
  assert.deepEqual((await h.binary(prefix + "/assets/images/paired.png")).bytes, imageBytes);
  const rendered = await h.binary(pdf.pages[0].imageUrl + "?width=400");
  assert.match(rendered.response.headers.get("content-type"), /image\/png/); assert.equal(rendered.bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const paths = [preview.documentUrl, draftUrl(preview), prefix + "/pdf", pdf.sourceUrl, pdf.pages[0].imageUrl,
    prefix + "/assets/images/paired.png", "/api/authoring/docs/guide.md", "/api/authoring/docs/authoring-examples/manifest.json", ...preview.artifacts.map((item) => item.url)];
  for (const path of paths) {
    const response = await fetch(h.base + path); assert.equal(response.status, 401, path); assert.equal((await response.json()).code, "UNAUTHORIZED");
  }
  for (const path of ["/api/authoring/previews", "/api/authoring/previews/publish"]) {
    const response = await fetch(h.base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); assert.equal(response.status, 401);
  }
  assert.match((await h.binary("/api/authoring/docs/guide.md")).response.headers.get("content-type"), /text\/markdown/);
  assert.equal((await h.request("/api/workspace")).documents.length, 0);
});

test("publication rejects changed evidence or source bytes and remains retryable after byte restoration", async (t) => {
  const h = await harness(t), first = await createPreview(h), evidenceBytes = Buffer.from("Verified preview evidence.\n");
  const evidence = await h.upload(evidenceBytes, "review.txt", "text/plain"), evidencePath = h.w.resources.path(evidence.sha256);
  const submission = publishInput(first.preview, { review: (await h.protocolEvidence(first.preview, [evidence.sourceId])).review });
  await writeFile(evidencePath, "tampered evidence");
  assert.equal((await h.request("/api/authoring/previews/publish", submission, 400)).code, "SOURCE_HASH_MISMATCH");
  assert.equal((await h.request("/api/workspace")).documents.length, 0);
  assert.equal((await h.request(first.preview.documentUrl)).preview.published, false);
  await writeFile(evidencePath, evidenceBytes);
  const authoringPath = h.w.resources.path(first.file.sha256), authoringBytes = await readFile(authoringPath);
  await writeFile(authoringPath, "{}");
  assert.equal((await h.request("/api/authoring/previews/publish", submission, 400)).code, "SOURCE_HASH_MISMATCH");
  assert.equal((await h.request("/api/workspace")).documents.length, 0);
  await writeFile(authoringPath, authoringBytes);
  const receipt = await h.request("/api/authoring/previews/publish", submission, 201);
  assert.equal(receipt.preview.published, true); assert.equal((await h.request("/api/workspace")).documents.length, 1);
});

test("concurrent successor retries share one snapshot, competing edits keep one draft head and publication races create one document", async (t) => {
  const h = await harness(t), first = await createPreview(h), input = example();
  input.blocks[0].text = "A successor";
  const file = await h.author(input), submission = { authoringSourceId: file.sourceId, previousPreviewId: first.preview.id, requestId: randomUUID() };
  const [one, two] = await Promise.all([h.request("/api/authoring/previews", submission, 201), h.request("/api/authoring/previews", submission, 201)]);
  assert.deepEqual(one, two); assert.equal((await h.request(draftUrl(first.preview))).draft.version, 2);
  const post = async (path, body) => {
    const response = await fetch(h.base + path, { method: "POST", headers: { ...h.headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const left = structuredClone(input), right = structuredClone(input); left.blocks[0].text = "Left edit"; right.blocks[0].text = "Right edit";
  const leftFile = await h.author(left), rightFile = await h.author(right);
  const outcomes = await Promise.all([leftFile, rightFile].map((author) => post("/api/authoring/previews", { authoringSourceId: author.sourceId, previousPreviewId: one.preview.id, requestId: randomUUID() })));
  assert.deepEqual(outcomes.map((item) => item.status).sort(), [201, 409]);
  assert.equal(outcomes.find((item) => item.status === 409).value.code, "PREVIEW_SUPERSEDED");
  const winner = outcomes.find((item) => item.status === 201).value.preview, current = await h.request(draftUrl(first.preview));
  assert.equal(current.draft.currentPreviewId, winner.id); assert.equal(current.draft.version, 3);
  assert.deepEqual(await h.request("/api/authoring/previews", submission, 201), one, "an old successful request retry is a receipt lookup");
  assert.equal((await h.request(draftUrl(first.preview))).draft.currentPreviewId, winner.id);
  const review = (await h.protocolEvidence(winner)).review;
  const publications = await Promise.all([post("/api/authoring/previews/publish", publishInput(winner, { review })), post("/api/authoring/previews/publish", publishInput(winner, { review }))]);
  assert.deepEqual(publications.map((item) => item.status).sort(), [201, 409]);
  assert.equal(publications.find((item) => item.status === 409).value.code, "PREVIEW_ALREADY_PUBLISHED");
  assert.equal((await h.request("/api/workspace")).documents.length, 1);
  assert.equal((await h.request("/api/changes")).changes.length, 1);
});

test("MCP preview tools expose compact live-draft descriptors and publish using explicit snake-case review fields", async (t) => {
  const h = await harness(t, { authToken: "preview-mcp-test-token" });
  const client = new Client({ name: "authoring-preview-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.base + "/mcp"), { requestInit: { headers: h.headers } }));
  t.after(() => client.close());
  const marker = "Full document body must stay outside compact MCP results.";
  const input = example(); input.blocks[1].text = marker.repeat(500);
  const file = await h.author(input), tools = (await client.listTools()).tools;
  for (const name of ["create_authoring_preview", "inspect_authoring_preview", "publish_authoring_preview"]) assert.ok(tools.some((tool) => tool.name === name), name);
  const schema = tools.find((tool) => tool.name === "publish_authoring_preview").inputSchema.properties.review;
  for (const field of ["source_review", "layout_review", "interaction_review", "evidence_source_ids"]) assert.ok(schema.properties[field], field);
  assert.equal(schema.properties.sourceReview, undefined);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    const value = result.structuredContent, serialized = JSON.stringify(value);
    assert.ok(serialized.length < 9000, `${name}: ${serialized.length}`); assert.ok(!serialized.includes(marker), name);
    assert.ok(!value.document?.blocks && !value.preview?.document && !value.preview?.identity, name);
    if (value.preview) {
      for (const field of ["previewUrl", "snapshotUrl", "documentUrl"]) assert.ok(value.preview[field].startsWith(h.base), field);
      assert.ok(value.preview.artifacts.every((item) => item.url.startsWith(h.base) && item.requiresAuthorization));
    }
    return value;
  };
  const create = { authoring_source_id: file.sourceId, request_id: randomUUID() }, first = await call("create_authoring_preview", create);
  assert.deepEqual(withoutFileAccess(await call("create_authoring_preview", create)), withoutFileAccess(first));
  const snapshot = await call("inspect_authoring_preview", { target: "preview", preview_id: first.preview.id });
  assert.equal(snapshot.preview.hash, first.preview.hash);
  const draft = await call("inspect_authoring_preview", { target: "draft", draft_id: first.preview.draftId });
  assert.equal(draft.draft.currentPreviewId, first.preview.id); assert.equal(draft.draft.lastError, null);
  const broken = structuredClone(input); broken.blocks[1].layout = "misspelled-layout";
  const brokenFile = await h.author(broken);
  const failed = await client.callTool({ name: "create_authoring_preview", arguments: { authoring_source_id: brokenFile.sourceId, previous_preview_id: first.preview.id, request_id: randomUUID() } });
  assert.equal(failed.isError, true); assert.equal(failed.structuredContent.code, "VALIDATION_FAILED"); assert.ok(JSON.stringify(failed).length < 9000);
  assert.equal((await call("inspect_authoring_preview", { target: "draft", draft_id: first.preview.draftId })).draft.lastError.code, "VALIDATION_FAILED");
  const fixed = structuredClone(input); fixed.blocks[0].text = "Reviewed introduction";
  const fixedFile = await h.author(fixed), latest = await call("create_authoring_preview", { authoring_source_id: fixedFile.sourceId, previous_preview_id: first.preview.id, request_id: randomUUID() });
  assert.equal(latest.preview.draftId, first.preview.draftId);
  assert.equal((await call("inspect_authoring_preview", { target: "draft", draft_id: first.preview.draftId })).draft.lastError, null);
  const evidence = await h.upload(Buffer.from("MCP integration review fixture.\n"), "review.txt", "text/plain");
  const review = (await h.protocolEvidence(latest.preview, [evidence.sourceId])).mcpReview;
  const publish = { preview_id: latest.preview.id, expected_hash: latest.preview.hash, request_id: randomUUID(), review };
  const wrongReview = await client.callTool({ name: "publish_authoring_preview", arguments: { ...publish, review: publishInput(latest.preview).review } });
  assert.equal(wrongReview.isError, true, "camelCase review is not the MCP authoring contract");
  assert.equal((await h.request("/api/workspace")).documents.length, 0);
  const receipt = await call("publish_authoring_preview", publish);
  assert.deepEqual(withoutFileAccess(await call("publish_authoring_preview", publish)), withoutFileAccess(receipt));
  assert.equal(receipt.preview.published, true); assert.ok(receipt.readerUrl.startsWith(h.base));
  const saved = await h.request(`/api/documents/${receipt.document.id}`), retainedReview = saved.report.previewSubmission.review;
  assert.deepEqual(retainedReview, { sourceReview: review.source_review, layoutReview: review.layout_review, interactionReview: review.interaction_review, evidenceSourceIds: review.evidence_source_ids });
  assert.equal(saved.document.blocks[1].text, marker.repeat(500), "the full body is retained outside MCP responses");
});
