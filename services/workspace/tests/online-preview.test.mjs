import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createWorkspaceServer } from "../server.mjs";
import { localActor } from "../actor.mjs";
import { canonical, hash } from "../errors.mjs";
import { createFileCapabilities } from "../file-capabilities.mjs";

const remoteOrigin = "https://reader-preview.test", remoteToken = "test-preview-token-1234567890123456";
const example = () => ({ format: "reader-authoring-1", key: "online-preview-example", meta: { title: "Online candidate", language: "en" },
  blocks: [{ key: "intro", type: "heading", level: 1, text: "Introduction" }, { key: "body", type: "para", text: "A complete immutable Reader file." }] });

function remote() {
  const state = { objects: new Map(), posts: [], calls: [], mode: "online", response: null };
  state.fetch = async (address, options) => {
    const url = new URL(address), method = options.method || "GET";
    assert.equal(url.origin, remoteOrigin); assert.equal(options.headers.Authorization, `Bearer ${remoteToken}`);
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit");
    state.calls.push({ method, path: url.pathname });
    if (state.mode === "offline") throw new Error("Simulated network interruption");
    const object = url.pathname.match(/^\/api\/sync\/objects\/([a-f0-9]{64})$/);
    if (object) {
      const key = `${url.searchParams.get("kind") === "object" ? "objects/sha256" : "blobs"}/${object[1]}`;
      if (method === "HEAD") return new Response(null, { status: state.objects.has(key) ? 204 : 404 });
      assert.equal(method, "PUT");
      const bytes = Buffer.from(options.body);
      assert.equal(hash(bytes), object[1]); assert.equal(bytes.length, Number(url.searchParams.get("size")));
      state.objects.set(key, bytes); return new Response(null, { status: 204 });
    }
    assert.equal(url.pathname, "/api/previews"); assert.equal(method, "POST");
    const input = JSON.parse(options.body);
    state.posts.push(input);
    if (state.mode === "missing-object") return Response.json({ code: "SYNC_OBJECT_MISSING" }, { status: 409 });
    for (const ref of [input.document, input.resourceMap, ...Object.values(input.artifacts)]) {
      const bytes = state.objects.get(ref.key); assert.ok(bytes, `reference committed before object: ${ref.key}`);
      assert.equal(bytes.length, ref.size); assert.equal(hash(bytes), ref.sha256);
    }
    const resources = JSON.parse(state.objects.get(input.resourceMap.key));
    for (const file of Object.values(resources)) assert.ok(state.objects.has(`blobs/${file.sha256}`));
    const response = { previewId: input.preview.id, hash: input.preview.hash,
      snapshotUrl: `${remoteOrigin}/?preview=${input.preview.id}&access=fixture`,
      previewUrl: `${remoteOrigin}/?draft=${input.preview.draftId}&access=fixture`,
      documentUrl: `${remoteOrigin}/api/authoring/previews/${input.preview.id}?access=fixture`,
      accessExpiresAt: new Date(Date.now() + 60000).toISOString() };
    return Response.json(state.response ? state.response(response) : response);
  };
  return state;
}

async function harness(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "reader-online-preview-test-")), cloud = remote();
  const server = await createWorkspaceServer({ dataDir, bootstrap: false, glossaryPath: false, staticRoot: false, sync: false,
    authToken: "local-preview-test-token", onlinePreview: { origin: remoteOrigin, token: remoteToken, fetchImpl: cloud.fetch }, ...options });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: "Bearer local-preview-test-token" };
  t.after(async () => {
    await server.shutdown();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir())); assert.ok(basename(dataDir).startsWith("reader-online-preview-test-"));
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = async (path, body, status = 200) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  };
  const upload = async (bytes, filename, mediaType = "application/json") => {
    const response = await fetch(base + "/api/sources?filename=" + encodeURIComponent(filename), { method: "POST", headers: { ...headers, "Content-Type": mediaType }, body: bytes });
    const value = await response.json(); assert.equal(response.status, 201, JSON.stringify(value)); return value;
  };
  const author = async (input = example()) => upload(Buffer.from("\n" + JSON.stringify(input, null, 2) + "\n"), "authoring.json");
  return { server, cloud, base, headers, request, upload, author };
}

test("HTTP previews remain local with obsolete cloud options, preserve exact retries and reject upload", async (t) => {
  const h = await harness(t), file = await h.author();
  const submission = { authoringSourceId: file.sourceId, requestId: randomUUID() };
  const value = await h.request("/api/authoring/previews", submission, 201);
  assert.equal(value.onlinePreview, undefined); assert.equal(h.cloud.calls.length, 0);
  const snapshot = await h.server.workspace.previewSnapshot(value.preview.id);
  assert.equal(hash(canonical(snapshot.manifest)), value.preview.hash);
  const retry = await h.request("/api/authoring/previews", submission, 201);
  assert.deepEqual(retry, value);
  assert.equal((await h.request("/api/workspace")).documents.length, 0);
  assert.equal((await h.request(`/api/authoring/previews/${value.preview.id}/online`, {}, 410)).code, "LOCAL_ONLY");
  assert.equal(h.cloud.calls.length, 0);
});

test("all 32 MCP tools retain local preview inspection and invalid-update diagnostics without upload", async (t) => {
  const h = await harness(t), client = new Client({ name: "local-preview-test", version: "1" });
  // Even an injected delivery adapter cannot change the MCP or HTTP path.
  h.server.workspace.onlinePreview = { publishFromWorkspace() { throw new Error("Cloud must not run"); } };
  await client.connect(new StreamableHTTPClientTransport(new URL(h.base + "/mcp"), { requestInit: { headers: h.headers } }));
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 32);
  const call = async (name, args) => {
    const value = await client.callTool({ name, arguments: args }); assert.ok(!value.isError, JSON.stringify(value));
    assert.ok(JSON.stringify(value.structuredContent).length < 12000); return value.structuredContent;
  };
  const file = await h.author(), created = await call("create_authoring_preview", { authoring_source_id: file.sourceId, request_id: randomUUID() });
  assert.equal(created.onlinePreview, undefined);
  assert.equal(new URL(created.preview.snapshotUrl).origin, h.base);
  const broken = example(); broken.blocks[1].layout = "invalid-layout";
  const badFile = await h.author(broken);
  const failed = await client.callTool({ name: "create_authoring_preview", arguments: { authoring_source_id: badFile.sourceId, previous_preview_id: created.preview.id, request_id: randomUUID() } });
  assert.equal(failed.isError, true);
  const latest = await call("inspect_authoring_preview", { target: "draft", draft_id: created.preview.draftId });
  assert.equal(latest.draft.lastError.code, "VALIDATION_FAILED");
  assert.equal(latest.document, undefined); assert.equal(latest.preview.document, undefined);
  const inspected = await call("inspect_authoring_preview", { target: "preview", preview_id: created.preview.id });
  assert.equal(inspected.preview.hash, created.preview.hash); assert.equal(inspected.onlinePreview, undefined);
  assert.equal(h.cloud.calls.length, 0);
});

test("the actual local static server serves PDF.js modules and WASM with browser-compatible MIME and nosniff", async (t) => {
  const staticRoot = fileURLToPath(new URL("../../../prototypes/insight-composer/node_modules/pdfjs-dist/", import.meta.url));
  const h = await harness(t, { onlinePreview: false, staticRoot });
  for (const [path, mediaType] of [["build/pdf.worker.min.mjs", "text/javascript; charset=utf-8"], ["wasm/openjpeg.wasm", "application/wasm"]]) {
    const response = await fetch(h.base + "/" + path);
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), mediaType);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(join(staticRoot, path))));
  }
});

test("extensionless source delivery preserves bytes and binds access to preview or selected document revision", async (t) => {
  const capabilities = await createFileCapabilities(), h = await harness(t, { onlinePreview: false, fileCapabilities: capabilities });
  const pdfBytes = await readFile(new URL("../../../prototypes/insight-composer/public/articles/mapreduce/source.pdf", import.meta.url));
  const source = await h.upload(pdfBytes, "source.pdf", "application/pdf"), unbound = await h.upload(Buffer.from("Unbound source"), "private.txt", "text/plain");
  const input = example(); input.source = { path: "source.pdf", sha256: source.sha256, media_type: "application/pdf" };
  input.blocks[1].source = [{ page: 1 }];
  const authored = await h.author(input), created = await h.request("/api/authoring/previews", { authoringSourceId: authored.sourceId, resources: { "source.pdf": source.sourceId }, requestId: randomUUID() }, 201);
  const base = `/api/authoring/previews/${created.preview.id}`, path = `${base}/assets-by-hash/${source.sha256}`;
  const signed = await capabilities.issue(h.base + created.preview.snapshotUrl, { scope: { kind: "preview", id: created.preview.id } });
  const withGrant = (path) => { const url = new URL(path, h.base); url.searchParams.set("access", new URL(signed.url).searchParams.get("access")); return url.href; };
  const response = await fetch(withGrant(path)); assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/vnd.continuous-reader.source");
  assert.equal(response.headers.get("content-disposition"), "inline"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /sandbox/); assert.equal(response.headers.get("etag"), '"' + source.sha256 + '"');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdfBytes);
  assert.equal((await fetch(h.base + path)).status, 401);
  assert.equal((await fetch(withGrant(`${base}/assets-by-hash/${unbound.sha256}`))).status, 404);
  const otherInput = example(); otherInput.key = "other-byte-scope"; const otherFile = await h.author(otherInput);
  const other = await h.request("/api/authoring/previews", { authoringSourceId: otherFile.sourceId, requestId: randomUUID() }, 201);
  assert.equal((await fetch(withGrant(`/api/authoring/previews/${other.preview.id}/assets-by-hash/${source.sha256}`))).status, 403);
  const manual = await fetch(withGrant(`${base}/assets/source.pdf`)); assert.equal(manual.headers.get("content-type"), "application/pdf");
  // The document fixture exercises revision-bound source delivery. Conversion
  // completion and immutable preview publication have dedicated protocol tests.
  const published = await h.request("/api/authoring/publish", { authoringSourceId: authored.sourceId,
    resources: { "source.pdf": source.sourceId }, requestId: randomUUID() }, 201);
  const documentPath = `/api/documents/${published.document.id}/assets-by-hash/`, oldUrl = documentPath + source.sha256 + "?revision=1";
  const documentGrant = await capabilities.issue(h.base + oldUrl), old = await fetch(documentGrant.url);
  assert.equal(old.status, 200); assert.deepEqual(Buffer.from(await old.arrayBuffer()), pdfBytes);
  const updatedBytes = Buffer.concat([pdfBytes, Buffer.from("\n% source revision test\n")]), updated = await h.upload(updatedBytes, "updated.pdf", "application/pdf");
  const w = h.server.workspace, saved = await w.revision(published.document.id), nextDocument = structuredClone(saved.document);
  nextDocument.revision = 2; nextDocument.source.sha256 = updated.sha256;
  const nextSaved = { ...saved, resourceMap: { "source.pdf": w.file(updated.sourceId) } }, validated = await w.validateCandidate(nextDocument, nextSaved);
  await w.prepareRevision(validated, nextSaved.resourceMap, nextSaved);
  // Build only the revision-bound source fixture through the shared storage
  // preparation; publication itself has its own transactional contract tests.
  const preparedRevision = w.storage.preparedChanges(validated, nextSaved.resourceMap, { ...nextSaved, actor: localActor.subjectId });
  const { changeStatements } = await import('../business-commit.mjs');
  await w.sql.batch([...changeStatements(preparedRevision.changes), ...preparedRevision.statements,
    { sql: 'UPDATE documents SET current_revision=2,version=version+1 WHERE id=?', values: [published.document.id] }]);
  assert.equal((await fetch(h.base + documentPath + source.sha256 + "?revision=2", { headers: h.headers })).status, 404);
  assert.equal((await fetch(h.base + documentPath + updated.sha256 + "?revision=1", { headers: h.headers })).status, 404);
  const current = await fetch(h.base + documentPath + updated.sha256 + "?revision=2", { headers: h.headers });
  assert.equal(current.status, 200); assert.deepEqual(Buffer.from(await current.arrayBuffer()), updatedBytes);
  assert.equal((await fetch(documentGrant.url.replace("revision=1", "revision=2"))).status, 403);
  assert.deepEqual(Buffer.from(await (await fetch(documentGrant.url)).arrayBuffer()), pdfBytes);
  const storedPath = w.resources.path(source.sha256); await writeFile(storedPath, Buffer.from("changed original"));
  try { const corrupt = await fetch(withGrant(path)); assert.equal(corrupt.status, 400); assert.equal((await corrupt.json()).code, "SOURCE_HASH_MISMATCH"); }
  finally { await writeFile(storedPath, pdfBytes); }
});
