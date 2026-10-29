import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createWorkspaceServer } from "../server.mjs";
import { createFileCapabilities, createMcpFileAccess, authorizeFileCapability } from "../file-capabilities.mjs";
import { defaultPython } from "../resources.mjs";
import { previewAccessUrl } from "../../../prototypes/insight-composer/src/preview-access-url.js";
import { hash } from "../errors.mjs";
import { createProtocolReviewEvidence } from "./authoring-protocol-evidence-fixture.mjs";

const denied = { code: "INVALID_FILE_CAPABILITY" };
const withAccess = (path, grant) => {
  const url = new URL(path, grant); url.searchParams.set("access", new URL(grant).searchParams.get("access")); return url.href;
};
test("file capabilities bind method, origin, exact resource and query, expire, and fail after signer restart", async () => {
  let now = 100000;
  const capabilities = await createFileCapabilities({ clock: () => now, ttlMs: 1000 });
  const grant = await capabilities.issue("https://reader.example/api/documents/doc/assets/source.pdf?revision=2");
  assert.equal((await capabilities.verify(grant.url, "GET")).target, "/api/documents/doc/assets/source.pdf?revision=2");
  await capabilities.verify(grant.url, "HEAD");
  for (const value of [grant.url.replace("revision=2", "revision=3"), grant.url.replace("/doc/", "/other/"), grant.url.replace("reader.example", "other.example"), grant.url + "&extra=1", grant.url + "&access=duplicate"]) {
    await assert.rejects(capabilities.verify(value, "GET"), denied);
  }
  await assert.rejects(capabilities.verify(grant.url, "POST"), denied);
  const tampered = new URL(grant.url); tampered.searchParams.set("access", "A" + tampered.searchParams.get("access").slice(1));
  await assert.rejects(capabilities.verify(tampered.href, "GET"), denied);
  const restarted = await createFileCapabilities({ clock: () => now, ttlMs: 1000 });
  await assert.rejects(restarted.verify(grant.url, "GET"), denied);
  now += 1000; await assert.rejects(capabilities.verify(grant.url, "GET"), denied);
  for (const path of ["/api/workspace", "/api/commands", "/mcp", "/api/authoring/previews/publish"]) {
    await assert.rejects(capabilities.issue("https://reader.example" + path, { method: "POST" }), denied);
  }
  const upload = await capabilities.issue("https://reader.example/api/sources?filename=notes.json", { method: "POST" });
  await capabilities.verify(upload.url, "POST");
  await assert.rejects(capabilities.verify(upload.url, "GET"), denied);
  await assert.rejects(capabilities.verify(upload.url.replace("notes.json", "other.json"), "POST"), denied);
});

test("preview grants cover only read-only dependencies in the exact snapshot or draft, including future draft updates", async () => {
  const capabilities = await createFileCapabilities();
  const draft = await capabilities.issue("https://reader.example/?draft=draft-a", { scope: { kind: "draft", id: "draft-a" } });
  const snapshot = await capabilities.issue("https://reader.example/?preview=preview-old", { scope: { kind: "preview", id: "preview-old" } });
  const workspace = { getAuthoringPreview: (_actor, id) => ({ preview: { draftId: id === "preview-other" ? "draft-b" : "draft-a" } }) };
  for (const path of ["/api/authoring/drafts/draft-a", "/api/authoring/previews/preview-old", "/api/authoring/previews/preview-new/pdf?revision=1",
    "/api/authoring/previews/preview-new/assets-by-hash/" + "a".repeat(64),
    "/api/authoring/previews/preview-new/pages/1.png?width=1200", "/api/authoring/previews/preview-new/assets/image.png", "/api/authoring/previews/preview-new/artifacts/document.json"]) {
    await authorizeFileCapability(capabilities, withAccess(path, draft.url), "GET", workspace, {});
  }
  for (const path of ["/api/authoring/drafts/draft-b", "/api/authoring/previews/preview-other", "/api/workspace", "/api/sources", "/api/documents/one", "/mcp", "/api/commands",
    "/api/authoring/previews/preview-new/unknown", "/api/authoring/previews/preview-new/pdf?unknown=1", "/api/authoring/previews/preview-new/pages/1.png?width=99999"]) {
    await assert.rejects(authorizeFileCapability(capabilities, withAccess(path, draft.url), "GET", workspace, {}), denied);
  }
  await assert.rejects(authorizeFileCapability(capabilities, withAccess("/api/authoring/previews/preview-new", draft.url), "POST", workspace, {}), denied);
  await capabilities.verify(withAccess("/api/authoring/previews/preview-old/assets/a.png", snapshot.url), "GET");
  await assert.rejects(capabilities.verify(withAccess("/api/authoring/previews/preview-new/assets/a.png", snapshot.url), "GET"), denied);
  await assert.rejects(capabilities.verify(withAccess("/api/authoring/drafts/draft-a", snapshot.url), "GET"), denied);
  for (const suffix of ["short", "a".repeat(64) + ".pdf", "A".repeat(64), "a".repeat(64) + "/extra"]) {
    await assert.rejects(authorizeFileCapability(capabilities, withAccess("/api/authoring/previews/preview-new/assets-by-hash/" + suffix, draft.url), "GET", workspace, {}), denied);
  }
  const hashUrl = "https://reader.example/api/documents/doc/assets-by-hash/" + "b".repeat(64) + "?revision=2";
  const hashGrant = await capabilities.issue(hashUrl);
  await capabilities.verify(hashGrant.url, "GET");
  await assert.rejects(capabilities.verify(hashGrant.url.replace("revision=2", "revision=3"), "GET"), denied);
});

test("URL decoration and Reader propagation never attach grants to business endpoints or external resources", async () => {
  const access = createMcpFileAccess({ capabilities: await createFileCapabilities(), baseUrl: "https://reader.example" });
  const input = { readerUrl: "https://reader.example/?document=one", url: "https://other.example/api/sources/one/original", routes: { publish: "https://reader.example/api/authoring/previews/publish" }, documentation: [{ url: "https://reader.example/api/authoring/docs/guide.md" }] };
  const result = await access.decorate(input);
  assert.equal(result.readerUrl, input.readerUrl); assert.equal(result.url, input.url); assert.deepEqual(result.routes, input.routes);
  assert.ok(new URL(result.documentation[0].url).searchParams.has("access")); assert.equal(input.documentation[0].url.includes("access="), false);
  assert.equal(previewAccessUrl("/api/authoring/previews/one/pdf?revision=1", "short-token", "https://reader.example"), "/api/authoring/previews/one/pdf?revision=1&access=short-token");
  for (const url of ["https://other.example/api/authoring/previews/one/assets/a.png", "/api/documents/one/assets/a.png", "https://other.example/link", "/api/commands"]) {
    assert.equal(previewAccessUrl(url, "short-token", "https://reader.example"), url);
  }
});

test("multipart URLs share one capability limited to the named session's upload, complete and abort operations", async () => {
  const capabilities = await createFileCapabilities();
  const access = createMcpFileAccess({ capabilities, baseUrl: "https://reader.example" });
  const value = await access.decorate({ multipart: { sessionId: "upload-one", partSize: 8 * 1024 * 1024, maximumBytes: 100 * 1024 * 1024,
    partUrlTemplate: "/api/uploads/upload-one/parts/{part}", completeUrl: "/api/uploads/upload-one/complete", abortUrl: "/api/uploads/upload-one" } });
  const part = value.multipart.partUrlTemplate.replace("{part}", "1");
  assert.ok(part.includes("/parts/1?access="));
  const grant = new URL(part).searchParams.get("access");
  assert.equal(new URL(value.multipart.completeUrl).searchParams.get("access"), grant);
  assert.equal(new URL(value.multipart.abortUrl).searchParams.get("access"), grant);
  await capabilities.verify(part, "PUT");
  await capabilities.verify(value.multipart.completeUrl, "POST");
  await capabilities.verify(value.multipart.abortUrl, "DELETE");
  for (const [path, method] of [["/api/uploads/upload-two/parts/1", "PUT"], ["/api/uploads/upload-one/parts/0", "PUT"], ["/api/uploads/upload-one/parts/10001", "PUT"],
    ["/api/uploads/upload-one/parts/1", "GET"], ["/api/uploads/upload-one/complete", "GET"], ["/api/uploads/upload-one", "POST"], ["/api/sources?filename=a.pdf", "POST"],
    ["/api/commands", "POST"], ["/api/uploads/upload-one/parts/1?other=1", "PUT"]]) {
    await assert.rejects(capabilities.verify(withAccess(path, part), method), denied);
  }
});

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "reader-file-capability-test-"));
  let now = Date.now();
  const token = randomUUID(), server = await createWorkspaceServer({ dataDir: join(root, "workspace"), bootstrap: false, glossaryPath: false, staticRoot: false, authToken: token, fileCapabilityOptions: { clock: () => now, ttlMs: 60000 } });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = "http://127.0.0.1:" + server.address().port;
  const client = new Client({ name: "capability-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers: { Authorization: "Bearer " + token } } }));
  t.after(async () => {
    await client.close(); await server.shutdown();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(root.startsWith(join(tmpdir(), "reader-file-capability-test-")));
    await rm(root, { recursive: true, force: true });
  });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes(token), false, "long-lived credentials never occur in MCP output"); return result.structuredContent;
  };
  const request = async (url, { expected = 200, ...options } = {}) => {
    const response = await fetch(new URL(url, base), options); const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, expected, bytes.toString().slice(0, 300)); return { response, bytes };
  };
  const upload = async (bytes, filename, type = "application/json") => {
    const grant = await call("prepare_source_upload", { filename, authorized: true, request_id: randomUUID() });
    const { bytes: response } = await request(grant.uploadUrl, { method: "POST", headers: { "Content-Type": type }, body: bytes, expected: 201 });
    return JSON.parse(response);
  };
  const protocolEvidence = preview => createProtocolReviewEvidence({ preview, upload,
    readReport: async current => JSON.parse((await request(current.review.reportUrl)).bytes) });
  return { root, server, base, client, call, request, upload, protocolEvidence, expire: () => { now += 60000; } };
}

test("authenticated MCP grants usable upload/download/docs without credential handoff, while malformed or expired URLs cannot write", async (t) => {
  const h = await harness(t);
  const missingAuthorization = await h.client.callTool({ name: "prepare_source_upload", arguments: { filename: "sample.json", request_id: randomUUID() } });
  assert.ok(missingAuthorization.isError);
  const grant = await h.call("prepare_source_upload", { filename: "sample.json", authorized: true, request_id: randomUUID() });
  assert.equal((await h.call("query_uploaded_sources", { action: "list" })).sources.length, 0, "issuing an upload grant does not create data");
  for (const [url, method] of [[grant.uploadUrl, "GET"], [grant.uploadUrl.replace("sample.json", "other.json"), "POST"], [withAccess("/api/commands", grant.uploadUrl), "POST"]]) {
    await h.request(url, { method, ...(method === "POST" ? { body: "{}", headers: { "Content-Type": "application/json" } } : {}), expected: 403 });
  }
  assert.equal((await h.call("query_uploaded_sources", { action: "list" })).sources.length, 0);
  const raw = Buffer.from('{"content":"source bytes α"}');
  const file = JSON.parse((await h.request(grant.uploadUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw, expected: 201 })).bytes);
  const retained = await h.call("query_uploaded_sources", { action: "get", source_id: file.sourceId });
  const download = await h.request(retained.url); assert.deepEqual(download.bytes, raw);
  assert.equal(download.response.headers.get("cache-control"), "no-store"); assert.equal(download.response.headers.get("referrer-policy"), "no-referrer");
  await h.request(retained.url, { method: "HEAD" });
  const contract = await h.call("get_authoring_contract", { source_id: file.sourceId });
  for (const item of contract.documentation) await h.request(item.url);
  assert.deepEqual((await h.request(contract.source.url)).bytes, raw);
  h.expire(); await h.request(retained.url, { expected: 403 });
  await h.request(grant.uploadUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw, expected: 403 });
  const fresh = await h.call("query_uploaded_sources", { action: "get", source_id: file.sourceId }); await h.request(fresh.url);
});

test("MCP preview grants load actual document, images, PDF and artifacts, follow only their draft and never authorize publication", async (t) => {
  const h = await harness(t), pdfPath = join(h.root, "source.pdf");
  const made = spawnSync(defaultPython, ["-B", "-c", "import fitz,sys\nd=fitz.open()\np=d.new_page(width=400,height=500)\np.insert_text((50,80),'Capability test')\nd.save(sys.argv[1])", pdfPath], { encoding: "utf8", windowsHide: true });
  assert.equal(made.status, 0, made.stderr);
  const pdfBytes = await readFile(pdfPath), source = await h.upload(pdfBytes, "source.pdf", "application/pdf");
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
  const image = await h.upload(imageBytes, "image.png", "image/png");
  const resources = { "source.pdf": source.sourceId, "figures/image.png": image.sourceId };
  const authoring = { format: "reader-authoring-1", key: "cap-test", meta: { title: "Capability test", language: "en" }, source: { path: "source.pdf", sha256: source.sha256, media_type: "application/pdf" }, blocks: [{ key: "text", type: "para", text: "Capability test", source: [{ page: 1 }] }, { key: "image", type: "figure", src: "figures/image.png", alt: "Fixture image", source: [{ page: 1 }] }] };
  const create = async (input, previous) => {
    const author = await h.upload(JSON.stringify(input), "authoring.json");
    return (await h.call("create_authoring_preview", { authoring_source_id: author.sourceId, resources, request_id: randomUUID(), ...(previous ? { previous_preview_id: previous } : {}) })).preview;
  };
  const first = await create(authoring), draftUrl = withAccess("/api/authoring/drafts/" + first.draftId, first.previewUrl);
  const firstEnvelope = JSON.parse((await h.request(draftUrl)).bytes); assert.equal(firstEnvelope.preview.id, first.id);
  await h.request(first.documentUrl); for (const artifact of first.artifacts) await h.request(artifact.url);
  const imageUrl = withAccess(firstEnvelope.assetBase + "figures/image.png", first.previewUrl);
  assert.deepEqual((await h.request(imageUrl)).bytes, imageBytes);
  const pdf = JSON.parse((await h.request(withAccess("/api/authoring/previews/" + first.id + "/pdf?revision=1", first.previewUrl))).bytes);
  assert.deepEqual((await h.request(withAccess(pdf.sourceUrl, first.previewUrl))).bytes, pdfBytes);
  const page = await h.request(withAccess(pdf.pages[0].imageUrl, first.previewUrl)); assert.equal(page.response.headers.get("content-type"), "image/png");
  const newer = structuredClone(authoring); newer.blocks[0].text = "A corrected capability test";
  const next = await create(newer, first.id); assert.equal(next.draftId, first.draftId);
  assert.equal(JSON.parse((await h.request(draftUrl)).bytes).preview.id, next.id);
  await h.request(withAccess("/api/authoring/previews/" + next.id, first.previewUrl));
  await h.request(withAccess("/api/authoring/previews/" + next.id, first.snapshotUrl), { expected: 403 });
  const otherInput = structuredClone(authoring); otherInput.key = "separate-draft"; otherInput.meta.title = "Unrelated preview";
  const other = await create(otherInput);
  await h.request(withAccess("/api/authoring/previews/" + other.id, first.previewUrl), { expected: 403 });
  for (const route of ["/api/workspace", "/api/sources", "/api/changes"]) await h.request(withAccess(route, first.previewUrl), { expected: 403 });
  await h.request(withAccess("/api/authoring/previews/publish", first.previewUrl), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", expected: 403 });
  assert.equal((await h.call("query_documents", { action: "list" })).documents.length, 0);
  const checked = await h.call("inspect_authoring_preview", { target: "preview", preview_id: next.id }); assert.equal(checked.preview.hash, next.hash);
  const publication = await h.call("publish_authoring_preview", { preview_id: checked.preview.id, expected_hash: checked.preview.hash, request_id: randomUUID(), review: (await h.protocolEvidence(checked.preview)).mcpReview });
  const asset = await h.call("read_resources", { kind: "asset", document_id: publication.document.id, path: "figures/image.png" });
  assert.equal(asset.sha256, image.sha256); assert.deepEqual((await h.request(asset.url)).bytes, imageBytes);
  const pages = await h.call("read_resources", { kind: "pdf_pages", document_id: publication.document.id, limit: 1 });
  assert.equal(pages.pages.length, 1); assert.equal((await h.request(pages.pages[0].imageUrl)).response.headers.get("content-type"), "image/png");
  const artifacts = await h.call("read_resources", { kind: "authoring_artifacts", document_id: publication.document.id });
  assert.equal(artifacts.artifacts.length, 4); for (const artifact of artifacts.artifacts) await h.request(artifact.url);
  h.expire(); await h.request(draftUrl, { expected: 403 });
});

test("authenticated MCP edits the current revision through a hash-verified download and publishes under the original identity", async (t) => {
  const h = await harness(t);
  const authoring = { format: "reader-authoring-1", key: "editing-wire", meta: { title: "Current revision wire fixture", language: "en" }, blocks: [
    { key: "paragraph", type: "para", text: "Original statement.", translations: { "zh-CN": { text: "原始陈述。" } } },
    { key: "table", type: "table", head: [["Sample", "Result"]], rows: [["A", "1"]] },
  ] };
  const source = await h.upload(JSON.stringify(authoring), "authoring.json");
  const first = (await h.call("create_authoring_preview", { authoring_source_id: source.sourceId, request_id: randomUUID() })).preview;
  const initial = await h.call("publish_authoring_preview", { preview_id: first.id, expected_hash: first.hash, request_id: randomUUID(), review: (await h.protocolEvidence(first)).mcpReview });
  const documentId = initial.document.id, original = await h.server.workspace.revision(documentId);
  await h.call("revise_document", { document_id: documentId, expected_revision: 1, authorized: true, request_id: randomUUID(), operations: [
    { kind: "replace", block_id: original.document.blocks[0].id, field: "text", value: "Current precise correction." },
  ] });
  const stored = await h.call("read_resources", { kind: "authoring_artifacts", document_id: documentId });
  assert.equal(stored.matchesDocumentRevision, false);
  const descriptor = await h.call("read_resources", { kind: "authoring_artifacts", mode: "editing", document_id: documentId, revision: 2 });
  const editingUrl = descriptor.artifacts.find((item) => item.kind === "editing").url;
  const { bytes } = await h.request(editingUrl);
  assert.equal(hash(bytes), descriptor.sha256); assert.equal(bytes.length, descriptor.size);
  await h.request(editingUrl.replace("revision=2", "revision=1"), { expected: 403 });
  await h.request(withAccess("/api/workspace", editingUrl), { expected: 403 });
  const pkg = JSON.parse(bytes);
  assert.equal(pkg.authoring.blocks[0].text, "Current precise correction.");
  pkg.authoring.blocks[1].rows[0][1] = "2";
  const edited = await h.upload(JSON.stringify(pkg.authoring), "edited.json");
  const target = { document_id: pkg.base.documentId, base_revision: pkg.base.revision, base_hash: pkg.base.documentHash };
  const input = { authoring_source_id: edited.sourceId, resources: pkg.resourceBindings, target };
  assert.equal((await h.call("validate_authoring", input)).valid, true);
  const candidate = (await h.call("create_authoring_preview", { ...input, request_id: randomUUID() })).preview;
  const inspected = await h.call("inspect_authoring_preview", { target: "preview", preview_id: candidate.id });
  assert.equal(inspected.preview.hash, candidate.hash);
  await h.request(candidate.documentUrl);
  const publish = { preview_id: candidate.id, expected_hash: candidate.hash, request_id: randomUUID(), review: (await h.protocolEvidence(candidate)).mcpReview };
  const receipt = await h.call("publish_authoring_preview", publish);
  assert.equal(receipt.document.id, documentId); assert.equal(receipt.document.revision, 3);
  // Capabilities are refreshed per response, while the persisted business receipt is exact.
  const replay = await h.call("publish_authoring_preview", publish);
  assert.deepEqual(replay.document, receipt.document); assert.equal(replay.preview.hash, receipt.preview.hash); assert.equal(replay.document.revision, 3);
  const current = await h.server.workspace.revision(documentId);
  assert.equal(current.document.blocks[0].text, "Current precise correction.");
  assert.equal(current.document.blocks[1].rows[0][1], "2");
  assert.deepEqual(current.document.blocks.map((block) => block.id), original.document.blocks.map((block) => block.id));
  assert.equal((await h.call("query_documents", { action: "list" })).documents.length, 1);
  assert.deepEqual((await h.server.workspace.revision(documentId, 1)).authoring, authoring);
});
