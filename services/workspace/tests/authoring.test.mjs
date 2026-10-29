import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createWorkspaceServer } from "../server.mjs";
import { createWorkspace, localActor } from "../service.mjs";
import { defaultPython } from "../resources.mjs";
import { hash } from "../errors.mjs";
import { withoutFileAccess } from "./mcp-result-fixture.mjs";
import { createProtocolReviewEvidence } from "./authoring-protocol-evidence-fixture.mjs";

async function harness(t, { authToken = "" } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-authoring-test-"));
  const server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false, authToken });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`, headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  const request = async (path, body, status = 200) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const upload = async (bytes, filename, mediaType = "application/json") => {
    const response = await fetch(base + "/api/sources?filename=" + encodeURIComponent(filename), { method: "POST", headers: { ...headers, "Content-Type": mediaType }, body: bytes });
    const value = await response.json(); assert.equal(response.status, 201, JSON.stringify(value)); return value;
  };
  const author = async (input) => upload(Buffer.from(JSON.stringify(input, null, 2) + "\n"), "authoring.json");
  t.after(async () => { await server.shutdown(); assert.ok(dataDir.startsWith(join(tmpdir(), "reader-authoring-test-"))); await rm(dataDir, { recursive: true, force: true }); });
  return { server, w: server.workspace, dataDir, base, headers, request, upload, author };
}

function example() {
  return { format: "reader-authoring-1", key: "agent-paper", meta: { title: "An authored paper", language: "en", translations: { zh: { title: "作者整理的论文" } } }, blocks: [
    { key: "intro", type: "heading", level: 1, text: "Introduction" },
    { key: "p1", type: "para", text: "Alpha beta $x^2$.", translations: { zh: { text: "阿尔法贝塔 $x^2$。" } } },
    { key: "items", type: "list", ordered: false, items: [{ key: "first", text: "Stable item", translations: { zh: { text: "稳定列表项" } } }] },
    { key: "formula", type: "math", tex: "x^2+1" },
    { key: "values", type: "table", head: [["Name", "Value"]], rows: [["Alpha", "0.82"], ["Beta", "0.91"]] },
    { key: "merged", type: "html", role: "table", html: '<table><thead><tr><th scope="col">Group</th><th scope="col">Value</th></tr></thead><tbody><tr><th scope="row" rowspan="2">A</th><td>1</td></tr><tr><td>2</td></tr></tbody></table>' },
  ] };
}

async function paperFixture(h) {
  const path = join(h.dataDir, "original.pdf");
  const made = spawnSync(defaultPython, ["-B", "-c", "import fitz,sys\nd=fitz.open()\np=d.new_page(width=400,height=500)\np.insert_text((50,80),'Alpha beta')\nd.new_page(width=400,height=500)\nd.save(sys.argv[1])", path], { encoding: "utf8", windowsHide: true });
  assert.equal(made.status, 0, made.stderr);
  const bytes = await readFile(path), original = await h.upload(bytes, "original.pdf", "application/pdf");
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
  const image = await h.upload(imageBytes, "figure.png", "image/png");
  const input = example(); input.source = { path: "source.pdf", sha256: original.sha256, media_type: "application/pdf" };
  input.blocks[1].source = [{ page: 1, box: [.1, .1, .8, .2] }];
  input.blocks.push({ key: "figure", type: "figure", src: "figures/one.png", alt: "A source figure", source: [{ page: 2 }] });
  return { input, original, bytes, imageBytes, resources: { "source.pdf": original.sourceId, "figures/one.png": image.sourceId } };
}

test("HTTP authoring validates without publication, publishes exact originals and artifacts, and keeps prior material intact", async (t) => {
  const h = await harness(t), priorInput = example(), priorFile = await h.author(priorInput);
  const prior = await h.request("/api/authoring/publish", { authoringSourceId: priorFile.sourceId, requestId: randomUUID() }, 201);
  await h.request("/api/commands", { kind: "insight.save", requestId: randomUUID(), documentId: prior.document.id, insight: { type: "note", body: "Retain existing insight", color: "sky" } });
  const priorBefore = await h.request("/api/documents/" + prior.document.id);
  const fixture = await paperFixture(h), raw = Buffer.from(JSON.stringify(fixture.input, null, 2) + "\n");
  const authored = await h.upload(raw, "paper-authoring.json", "text/plain"), submission = { authoringSourceId: authored.sourceId, resources: fixture.resources };
  const descriptor = await h.request("/api/sources/" + fixture.original.sourceId);
  assert.equal(descriptor.sha256, hash(fixture.bytes)); assert.ok(descriptor.requiresAuthorization);
  const contract = await h.request("/api/authoring/contract?sourceId=" + fixture.original.sourceId);
  assert.equal(contract.source.sha256, fixture.original.sha256); assert.equal(contract.format, "reader-authoring-1");
  assert.ok(contract.rules.some((rule) => rule.includes("does not run a model")));
  const before = await h.request("/api/workspace"), validation = await h.request("/api/authoring/validate", submission);
  assert.equal(validation.valid, true); assert.equal(validation.published, false); assert.equal(validation.summary.blockCount, 7);
  assert.equal(validation.summary.pageCount, 2); assert.equal(validation.summary.sourceBoxBlocks, 1); assert.equal(validation.scope, "structure-and-resources");
  assert.deepEqual(await h.request("/api/workspace"), before);
  const receipt = await h.request("/api/authoring/publish", { ...submission, requestId: randomUUID() }, 201);
  assert.notEqual(receipt.document.id, prior.document.id); assert.ok(!receipt.document.blocks); assert.ok(JSON.stringify(receipt).length < 5000);
  const saved = await h.request("/api/documents/" + receipt.document.id);
  assert.equal(saved.document.source.sha256, hash(fixture.bytes)); assert.deepEqual(saved.document.blocks[1].source, fixture.input.blocks[1].source);
  const indexed = (await h.w.revision(receipt.document.id)).index;
  assert.ok(indexed.some((row) => row.blockId === "$meta" && row.variant === "zh" && row.translationState === "current"));
  assert.ok(indexed.some((row) => row.itemId && row.variant === "zh" && row.translationState === "current"));
  const rawOriginal = await fetch(h.base + descriptor.url); assert.deepEqual(Buffer.from(await rawOriginal.arrayBuffer()), fixture.bytes);
  const rawFigure = await fetch(h.base + saved.assetBase + "figures/one.png"); assert.deepEqual(Buffer.from(await rawFigure.arrayBuffer()), fixture.imageBytes);
  const manifest = await h.request(`/api/documents/${receipt.document.id}/authoring`);
  assert.deepEqual(manifest.artifacts.map((item) => item.kind), ["authoring", "identity", "report", "index"]); assert.equal(manifest.matchesDocumentRevision, true);
  const artifacts = {};
  for (const item of manifest.artifacts) {
    const response = await fetch(h.base + item.url); assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition"), /^attachment;/);
    const bytes = Buffer.from(await response.arrayBuffer()); artifacts[item.kind] = JSON.parse(bytes.toString("utf8"));
    if (item.kind === "authoring") { assert.deepEqual(bytes, raw); assert.match(response.headers.get("content-type"), /application\/json/); }
  }
  assert.equal(artifacts.identity.documentId, receipt.document.id); assert.ok(artifacts.identity.blocks.merged.nodes.length >= 5);
  assert.equal(artifacts.report.compiler.result, "PASS"); assert.equal(artifacts.report.authoringHash, hash(raw)); assert.equal(artifacts.report.summary.blockCount, 7);
  assert.deepEqual(artifacts.index, indexed); assert.deepEqual(await h.request("/api/documents/" + prior.document.id), priorBefore);
  const revised = await h.request("/api/commands", { kind: "document.revise", requestId: randomUUID(), documentId: receipt.document.id, expectedRevision: 1, authorized: true,
    operations: [{ kind: "replace", blockId: saved.document.blocks[1].id, field: "text", value: "An authorized correction." }] });
  assert.equal(revised.document.revision, 2);
  const currentArtifacts = await h.request(`/api/documents/${receipt.document.id}/authoring`);
  assert.equal(currentArtifacts.authoringRevision, 1); assert.equal(currentArtifacts.matchesDocumentRevision, false);
  const historical = await h.request(`/api/documents/${receipt.document.id}/authoring?revision=1`); assert.equal(historical.matchesDocumentRevision, true);
});

test("invalid authoring is repairable without a partial document; resources, hashes, pages and paths are checked", async (t) => {
  const h = await harness(t), fixture = await paperFixture(h);
  const checkInvalid = async (input, resources, code = "VALIDATION_FAILED") => {
    const file = await h.author(input), submission = { authoringSourceId: file.sourceId, resources };
    const invalid = await h.request("/api/authoring/validate", submission, 400); assert.equal(invalid.code, code);
    assert.equal((await h.request("/api/authoring/publish", { ...submission, requestId: randomUUID() }, 400)).code, code);
    assert.equal((await h.request("/api/workspace")).documents.length, 0); return invalid;
  };
  const broken = structuredClone(fixture.input); broken.blocks[5].html = '<table><tr><td rowspan="2">Bad span</td></tr></table>';
  assert.match((await checkInvalid(broken, fixture.resources)).details.message, /E_HTML_SPAN/);
  await checkInvalid(fixture.input, {}, "RESOURCE_MISSING");
  await checkInvalid(fixture.input, { "source.pdf": fixture.resources["source.pdf"] }, "RESOURCE_MISSING");
  const wrongHash = structuredClone(fixture.input); wrongHash.source.sha256 = "0".repeat(64); await checkInvalid(wrongHash, fixture.resources, "SOURCE_HASH_MISMATCH");
  const wrongPage = structuredClone(fixture.input); wrongPage.blocks[1].source[0].page = 3; await checkInvalid(wrongPage, fixture.resources);
  const withoutOriginal = structuredClone(fixture.input); delete withoutOriginal.source; await checkInvalid(withoutOriginal, fixture.resources, "SOURCE_REQUIRED");
  const file = await h.author(fixture.input);
  const traversal = await h.request("/api/authoring/validate", { authoringSourceId: file.sourceId, resources: { "../outside.pdf": fixture.original.sourceId } }, 400); assert.equal(traversal.code, "VALIDATION_FAILED");
  const repaired = await h.request("/api/authoring/validate", { authoringSourceId: file.sourceId, resources: fixture.resources }); assert.equal(repaired.valid, true);
  const originalPath = h.w.resources.path(fixture.original.sha256); await writeFile(originalPath, "changed bytes");
  assert.equal((await h.request("/api/authoring/validate", { authoringSourceId: file.sourceId, resources: fixture.resources }, 400)).code, "SOURCE_HASH_MISMATCH");
  await writeFile(originalPath, fixture.bytes);
  const published = await h.request("/api/authoring/publish", { authoringSourceId: file.sourceId, resources: fixture.resources, requestId: randomUUID() }, 201); assert.equal(published.validation.published, true);
});

test("compact authoring entry links to complete format references and both examples validate", async (t) => {
  const h = await harness(t), fixture = await paperFixture(h), contract = await h.request("/api/authoring/contract");
  assert.deepEqual(contract.documentation.map(item => item.filename).sort(), ["authoring-schema.json", "conversion-workflow.md", "format-reference.md", "guide.md", "minimal-example.json"]);
  assert.ok(JSON.stringify(contract).length < 4000, "entry contract stays bounded before adding source metadata and scoped URLs");
  assert.equal(contract.tests, undefined, "external callers do not need repository test commands");
  const docs = {};
  for (const descriptor of contract.documentation) {
    assert.equal(descriptor.requiresAuthorization, true);
    const response = await fetch(h.base + descriptor.url); assert.equal(response.status, 200, descriptor.filename);
    assert.match(response.headers.get("content-disposition"), /^attachment;/); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    docs[descriptor.filename] = await response.text(); assert.ok(docs[descriptor.filename].length > 100);
  }
  const linkedResources = new Set();
  for (const [filename, markdown] of Object.entries(docs).filter(([filename]) => filename.endsWith(".md"))) {
    for (const [, , target] of markdown.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
      assert.ok(target.startsWith("/api/authoring/docs/"), `${filename} contains an unresolved downloaded-document link: ${target}`);
      linkedResources.add(target.split("#")[0]);
    }
  }
  assert.ok(linkedResources.has("/api/authoring/docs/examples/index.md"));
  assert.ok(linkedResources.has("/api/authoring/docs/authoring-schema.json"));
  assert.ok(linkedResources.has("/api/authoring/docs/format-reference.md"), "detailed format guidance is available on demand");
  assert.ok(linkedResources.has("/api/authoring/docs/example.json"), "all-type example remains discoverable");
  for (const path of linkedResources) {
    const response = await fetch(h.base + path); assert.equal(response.status, 200, path);
    const bytes = await response.arrayBuffer(); assert.ok(bytes.byteLength > 0, path);
    if (/\.(?:md|json)$/.test(path)) docs[decodeURIComponent(path.slice("/api/authoring/docs/".length))] = new TextDecoder().decode(bytes);
  }
  for (const topic of ["rowspan", "colspan", "data-key", "same-structure", "box"]) assert.ok(docs["format-reference.md"].includes(topic), topic);
  const guidance = [...contract.rules, ...contract.steps, docs["guide.md"], docs["conversion-workflow.md"]].join("\n");
  assert.match(guidance, /zh-CN/);
  assert.match(guidance, /independent|独立/i);
  assert.match(guidance, /Reader/);
  assert.match(guidance, /reader-quality-review-3/);
  assert.ok(!JSON.stringify(contract).includes("reader-quality-review-2"), "the entry advertises the compact review protocol");
  const canonicalManifest = await h.request("/api/authoring/docs/examples/manifest.json");
  assert.deepEqual(await h.request("/api/authoring/docs/authoring-examples/manifest.json"), canonicalManifest);
  const minimal = JSON.parse(docs["minimal-example.json"]);
  if (minimal.source) minimal.source.sha256 = fixture.original.sha256;
  const minimalFile = await h.author(minimal), minimalValidation = await h.request("/api/authoring/validate", {
    authoringSourceId: minimalFile.sourceId, resources: minimal.source ? { [minimal.source.path]: fixture.original.sourceId } : {},
  });
  assert.equal(minimalValidation.valid, true);
  assert.ok(minimalValidation.summary.translatedBlocks > 0, "the minimal example demonstrates the default bilingual input");
  const input = JSON.parse(docs["example.json"]); input.source.sha256 = fixture.original.sha256;
  assert.deepEqual([...new Set(input.blocks.map((block) => block.type))].sort(), ["figure", "heading", "html", "list", "math", "para", "table"]);
  const file = await h.author(input), validation = await h.request("/api/authoring/validate", { authoringSourceId: file.sourceId,
    resources: { "source.pdf": fixture.original.sourceId, "figures/example.png": fixture.resources["figures/one.png"] } });
  assert.equal(validation.valid, true); assert.equal(validation.summary.blockCount, 9); assert.ok(validation.summary.translatedBlocks >= 4);
  assert.equal((await h.request("/api/authoring/docs/unknown.md", undefined, 404)).code, "NOT_FOUND");
  assert.equal((await h.request("/api/workspace")).documents.length, 0);
});

test("asset bindings require uploaded own properties even for prototype method names", async (t) => {
  const h = await harness(t);
  for (const path of ["toString", "valueOf", "hasOwnProperty"]) {
    const input = { ...example(), blocks: [{ key: "image", type: "figure", src: path }] };
    const file = await h.author(input);
    const invalid = await h.request("/api/authoring/validate", { authoringSourceId: file.sourceId, resources: {} }, 400);
    assert.equal(invalid.code, "RESOURCE_MISSING");
  }
  assert.equal((await h.request("/api/workspace")).documents.length, 0);
});

test("HTTP authoring returns stable repair diagnostics for unconsumed fields and exposes its strict schema", async (t) => {
  const h = await harness(t), input = example();
  input.blocks[1].placment = "frontmatter";
  input.blocks[1].translations.zh = { content: "不能显示的内容" };
  input.blocks[2].items[0].id = "hand-written-runtime-id";
  const file = await h.author(input), result = await h.request("/api/authoring/validate", { authoringSourceId: file.sourceId }, 400);
  assert.equal(result.code, "VALIDATION_FAILED");
  assert.ok(result.details.diagnostics.some((issue) => issue.path === "$.blocks[1].placment" && issue.suggestion === "placement" && issue.key === "p1"));
  assert.ok(result.details.diagnostics.some((issue) => issue.code === "E_AUTHOR_DERIVED" && issue.key === "first"));
  assert.equal((await h.request("/api/workspace")).documents.length, 0);
  const contract = await h.request("/api/authoring/contract"), descriptor = contract.documentation.find((doc) => doc.filename === "authoring-schema.json");
  assert.ok(descriptor);
  const schema = await h.request(descriptor.url);
  assert.equal(schema.properties.format.const, "reader-authoring-1"); assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.para.additionalProperties, false);
  assert.ok(!Object.hasOwn(schema.$defs.para.properties, "id"));
});

test("concurrent publication and restart retries return the same receipt before recompilation", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-authoring-retry-"));
  let w = await createWorkspace({ dataDir, bootstrap: false, glossaryPath: false });
  t.after(async () => { await w.close(); assert.ok(dataDir.startsWith(join(tmpdir(), "reader-authoring-retry-"))); await rm(dataDir, { recursive: true, force: true }); });
  const file = await w.upload(localActor, Buffer.from(JSON.stringify(example())), { filename: "authoring.json", mediaType: "application/json" });
  const command = { authoringSourceId: file.sourceId, resources: {}, requestId: randomUUID() };
  const receipts = await Promise.all([w.publishAuthoring(command), w.publishAuthoring(command)]); assert.deepEqual(receipts[0], receipts[1]); assert.equal(w.snapshot({}).documents.length, 1);
  const receipt = receipts[0]; await w.close(); w = await createWorkspace({ dataDir, bootstrap: false, glossaryPath: false });
  // A receipt must be recoverable even if its uploaded input becomes unavailable later.
  await writeFile(w.resources.path(file.sha256), "broken retained input");
  assert.deepEqual(await w.publishAuthoring(command), receipt);
  await assert.rejects(w.publishAuthoring({ ...command, resources: { "different.json": file.sourceId } }), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(w.publishAuthoring({ ...command, requestId: randomUUID() }), { code: "SOURCE_HASH_MISMATCH" });
  assert.equal((await w.revision(receipt.document.id)).document.id, receipt.document.id);
});

test("MCP gives bounded Agent contracts, validation and publication receipts; source and artifact routes require authentication", async (t) => {
  const h = await harness(t, { authToken: "authoring-test-token" }), file = await h.author(example());
  const client = new Client({ name: "authoring-contract-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.base + "/mcp"), { requestInit: { headers: h.headers } }));
  t.after(() => client.close());
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent); return result.structuredContent; };
  const names = (await client.listTools()).tools.map((item) => item.name);
  for (const name of ["query_uploaded_sources", "get_authoring_contract", "validate_authoring", "create_authoring_preview", "inspect_authoring_preview", "publish_authoring_preview", "read_resources"]) assert.ok(names.includes(name), name);
  const found = await call("query_uploaded_sources", { action: "list", filename: "authoring.json" }); assert.equal(found.sources.length, 1); assert.ok(!found.sources[0].content);
  const descriptor = await call("query_uploaded_sources", { action: "get", source_id: file.sourceId }); assert.equal(descriptor.sha256, file.sha256); assert.ok(descriptor.url.startsWith(h.base));
  const contract = await call("get_authoring_contract", { source_id: file.sourceId }); assert.equal(contract.source.sha256, file.sha256);
  assert.ok(JSON.stringify(withoutFileAccess(contract)).length < 4500, "compact MCP contract retains source identity without expanding the authoring instructions");
  const input = { authoring_source_id: file.sourceId, resources: {} }, valid = await call("validate_authoring", input);
  assert.equal(valid.published, false); assert.equal(valid.summary.hasOriginal, false); assert.equal(valid.summary.sourceMappedBlocks, 0);
  const bad = await h.author({ ...example(), blocks: [{ key: "broken", type: "html", html: '<table><tr><td rowspan="2">Bad</td></tr></table>' }] });
  const invalid = await client.callTool({ name: "validate_authoring", arguments: { authoring_source_id: bad.sourceId, resources: {} } });
  assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.code, "VALIDATION_FAILED"); assert.ok(JSON.stringify(invalid).length < 4000);
  const created = await call("create_authoring_preview", { ...input, request_id: randomUUID() });
  const checked = await call("inspect_authoring_preview", { target: "preview", preview_id: created.preview.id });
  assert.equal(checked.preview.hash, created.preview.hash);
  const evidence = await createProtocolReviewEvidence({ preview: checked.preview, upload: h.upload,
    readReport: preview => h.request(`/api/authoring/previews/${preview.id}/artifacts/report.json`) });
  const publication = { preview_id: checked.preview.id, expected_hash: checked.preview.hash, request_id: randomUUID(), review: evidence.mcpReview };
  const receipt = await call("publish_authoring_preview", publication);
  assert.deepEqual(withoutFileAccess(await call("publish_authoring_preview", publication)), withoutFileAccess(receipt)); assert.ok(!receipt.document.blocks); assert.ok(receipt.readerUrl.startsWith(h.base));
  const artifacts = await call("read_resources", { kind: "authoring_artifacts", document_id: receipt.document.id });
  assert.equal(artifacts.artifacts.length, 4); assert.ok(artifacts.artifacts.every((item) => item.url.startsWith(h.base) && item.requiresAuthorization));
  for (const path of ["/api/sources", "/api/sources/" + file.sourceId, descriptor.url.slice(h.base.length), "/api/authoring/contract", ...contract.documentation.map((item) => item.url.slice(h.base.length)), `/api/documents/${receipt.document.id}/authoring`, ...artifacts.artifacts.map((item) => item.url.slice(h.base.length))]) {
    const withoutGrant = new URL(path, h.base); withoutGrant.searchParams.delete("access");
    const response = await fetch(withoutGrant); assert.equal(response.status, 401, withoutGrant.pathname);
  }
  const fetched = await fetch(artifacts.artifacts[0].url, { headers: h.headers }); assert.equal(fetched.status, 200);
  const special = await h.upload(Buffer.from("literal percent"), "100%_complete.txt", "text/plain");
  const exact = await h.request("/api/sources?query=" + encodeURIComponent("%_")); assert.deepEqual(exact.sources.map((item) => item.sourceId), [special.sourceId]);
  const limited = await call("query_uploaded_sources", { action: "list", limit: 1 }); assert.equal(limited.sources.length, 1); assert.equal(limited.page.nextOffset, 1);
  assert.equal(limited.nextTool, "query_uploaded_sources"); assert.equal(limited.next.action, "list");
  const following = await call(limited.nextTool, limited.next); assert.equal(following.sources.length, 1); assert.notEqual(following.sources[0].sourceId, limited.sources[0].sourceId);
});
