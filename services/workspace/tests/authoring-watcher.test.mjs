import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceServer } from "../server.mjs";

const script = fileURLToPath(new URL("../scripts/watch-authoring.mjs", import.meta.url));
const pairedPng = new URL("../authoring-examples/images/paired.png", import.meta.url);
const groupedPng = new URL("../authoring-examples/images/grouped.png", import.meta.url);

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), "reader-authoring-watcher-test-"));
  const resources = join(directory, "resources"), authoring = join(directory, "authoring.json");
  await mkdir(resources);
  const token = "authoring-watcher-integration-token";
  const server = await createWorkspaceServer({ dataDir: join(directory, "store"), bootstrap: false, glossaryPath: false, staticRoot: false, authToken: token });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const response = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const run = (previous, { url = base, nodeArgs = [] } = {}) => new Promise((done, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, script, authoring, resources, "--url", url, "--once", ...(previous ? ["--previous", previous] : [])], {
      env: { ...process.env, CONTINUOUS_READER_AUTH_TOKEN: token }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [], stderr = [];
    const timeout = setTimeout(() => { child.kill(); reject(new Error("watch-authoring --once timed out")); }, 15000);
    child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => { clearTimeout(timeout); done({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
  });
  t.after(async () => {
    await server.shutdown();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("reader-authoring-watcher-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, resources, authoring, base, get, run, save: (input) => writeFile(authoring, JSON.stringify(input, null, 2) + "\n"),
    receipt: async () => JSON.parse(await readFile(join(directory, "preview-receipt.json"), "utf8")) };
}

const input = () => ({ format: "reader-authoring-1", key: "watcher-fixture", meta: { title: "Watcher fixture", language: "en" }, blocks: [
  { key: "paragraph", type: "para", text: "Original text." },
  { key: "pair", type: "html", role: "figure", html: '<figure><img src="diagram.png" alt="Pairs"><figcaption data-key="caption">Paired items.</figcaption></figure>' },
] });

test("watcher --once uploads actual resources and updates a live draft after resource-only edits without publication", async (t) => {
  const h = await harness(t); await h.save(input()); await writeFile(join(h.resources, "diagram.png"), await readFile(pairedPng));
  const before = await h.get("/api/workspace"), changes = await h.get("/api/changes");
  const first = await h.run(); assert.equal(first.code, 0, first.stderr);
  const output = JSON.parse(first.stdout.trim()), receipt = await h.receipt();
  assert.equal(output.previewId, receipt.preview.id); assert.equal(output.hash, receipt.preview.hash);
  assert.equal(output.previewUrl, h.base + receipt.preview.previewUrl); assert.equal(output.receiptPath, join(h.directory, "preview-receipt.json"));
  const frozen = await h.get(receipt.preview.documentUrl);
  assert.equal(receipt.validation.summary.resourceCount, 1); assert.equal(frozen.document.blocks[1].type, "html");
  await writeFile(join(h.resources, "diagram.png"), await readFile(groupedPng));
  const second = await h.run(receipt.preview.id); assert.equal(second.code, 0, second.stderr);
  const updated = await h.receipt(), latest = await h.get(`/api/authoring/drafts/${receipt.preview.draftId}`);
  assert.notEqual(updated.preview.hash, receipt.preview.hash); assert.equal(updated.preview.draftId, receipt.preview.draftId);
  assert.equal(latest.draft.currentPreviewId, updated.preview.id); assert.equal(latest.draft.lastError, null);
  assert.deepEqual(latest.document, frozen.document, "resource changes preserve the authored document and identities");
  assert.deepEqual(await h.get("/api/workspace"), before); assert.deepEqual(await h.get("/api/changes"), changes);
});

test("watcher forwards malformed JSON to draft validation and preserves the last receipt and snapshot until repaired", async (t) => {
  const h = await harness(t); await h.save(input()); await writeFile(join(h.resources, "diagram.png"), await readFile(pairedPng));
  const first = await h.run(); assert.equal(first.code, 0, first.stderr);
  const receipt = await h.receipt(), frozen = await h.get(receipt.preview.documentUrl);
  await writeFile(h.authoring, '{"format":"reader-authoring-1","blocks":');
  const invalid = await h.run(receipt.preview.id); assert.equal(invalid.code, 1); assert.equal(invalid.stdout, "");
  assert.equal(JSON.parse(invalid.stderr).code, "INVALID_JSON");
  const failedDraft = await h.get(`/api/authoring/drafts/${receipt.preview.draftId}`);
  assert.equal(failedDraft.draft.lastError.code, "INVALID_JSON"); assert.equal(failedDraft.draft.currentPreviewId, receipt.preview.id);
  assert.deepEqual(failedDraft.document, frozen.document); assert.deepEqual(await h.receipt(), receipt);
  const fixed = input(); fixed.blocks[0].text = "Corrected text."; await h.save(fixed);
  const success = await h.run(receipt.preview.id); assert.equal(success.code, 0, success.stderr);
  const current = await h.get(`/api/authoring/drafts/${receipt.preview.draftId}`);
  assert.equal(current.draft.lastError, null); assert.equal(current.document.blocks[0].text, "Corrected text.");
  assert.equal(current.document.blocks[0].id, frozen.document.blocks[0].id);
  assert.equal((await h.get("/api/workspace")).documents.length, 0);
});

test("watcher reports missing and escaped resource bindings without reading or uploading outside the resource root", async (t) => {
  const h = await harness(t); await h.save(input()); await writeFile(join(h.resources, "diagram.png"), await readFile(pairedPng));
  const first = await h.run(); assert.equal(first.code, 0, first.stderr);
  const receipt = await h.receipt(), missing = input(); missing.blocks[1].html = missing.blocks[1].html.replace("diagram.png", "missing.png"); await h.save(missing);
  const failure = await h.run(receipt.preview.id); assert.equal(failure.code, 1); assert.equal(JSON.parse(failure.stderr).code, "RESOURCE_MISSING");
  const outside = join(h.directory, "outside"); await mkdir(outside); await writeFile(join(outside, "outside.png"), await readFile(groupedPng));
  await symlink(outside, join(h.resources, "linked"), process.platform === "win32" ? "junction" : "dir");
  const escaped = input(); escaped.blocks[1].html = escaped.blocks[1].html.replace("diagram.png", "linked/outside.png"); await h.save(escaped);
  const denied = await h.run(receipt.preview.id); assert.equal(denied.code, 1); assert.equal(JSON.parse(denied.stderr).code, "RESOURCE_MISSING");
  const draft = await h.get(`/api/authoring/drafts/${receipt.preview.draftId}`);
  assert.equal(draft.draft.currentPreviewId, receipt.preview.id); assert.equal(draft.draft.lastError.code, "RESOURCE_MISSING");
  assert.equal((await h.get("/api/sources?filename=outside.png")).sources.length, 0);
  assert.deepEqual(await h.receipt(), receipt); assert.equal((await h.get("/api/workspace")).documents.length, 0);
});

test("watcher binds the declared fallback image as well as rendered HTML images", async (t) => {
  const h = await harness(t), authored = input(); authored.blocks[1].fallback = { image: "fallback.png", alt: "Original diagram" };
  await h.save(authored); await writeFile(join(h.resources, "diagram.png"), await readFile(pairedPng)); await writeFile(join(h.resources, "fallback.png"), await readFile(groupedPng));
  const result = await h.run(); assert.equal(result.code, 0, result.stderr);
  const receipt = await h.receipt(); assert.equal(receipt.validation.summary.resourceCount, 2);
  const manifest = await h.get(receipt.preview.artifacts.find((item) => item.kind === "manifest").url);
  assert.deepEqual(manifest.resources.map((resource) => resource.path).sort(), ["diagram.png", "fallback.png"]);
});

test("watcher refuses nonlocal or credential-bearing endpoints before fetch without exposing the supplied URL", async (t) => {
  const h = await harness(t); await h.save(input());
  const guard = "data:text/javascript," + encodeURIComponent("globalThis.fetch = () => { throw new Error('FETCH_SHOULD_NOT_RUN'); };");
  for (const url of ["https://reader.example.test", "http://user:private-watch-token@127.0.0.1:4177", h.base + "/mcp", h.base + "?token=private-watch-token"]) {
    const result = await h.run(undefined, { url, nodeArgs: ["--import", guard] });
    assert.equal(result.code, 1); assert.equal(result.stdout, ""); assert.ok(result.stderr.trim());
    assert.doesNotMatch(result.stderr, /FETCH_SHOULD_NOT_RUN|private-watch-token|reader\.example\.test/);
  }
  assert.equal((await h.get("/api/sources")).sources.length, 0);
  await assert.rejects(h.receipt(), { code: "ENOENT" });
});

test("watcher never follows upload or preview redirects and leaves no successful receipt", async (t) => {
  const h = await harness(t), authored = input(); authored.blocks = authored.blocks.slice(0, 1); await h.save(authored);
  for (const phase of ["upload", "preview"]) {
    const paths = [];
    const redirector = http.createServer((request, response) => {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname; paths.push(pathname); request.resume();
      if (phase === "preview" && pathname === "/api/sources") {
        response.writeHead(201, { "Content-Type": "application/json" }); response.end(JSON.stringify({ sourceId: "local-source" })); return;
      }
      response.writeHead(307, { Location: "/unexpected-destination" }); response.end();
    });
    await new Promise((done) => redirector.listen(0, "127.0.0.1", done));
    try {
      const result = await h.run(undefined, { url: "http://127.0.0.1:" + redirector.address().port });
      assert.equal(result.code, 1); assert.equal(result.stdout, "");
      assert.deepEqual(paths, phase === "upload" ? ["/api/sources"] : ["/api/sources", "/api/authoring/previews"]);
      await assert.rejects(h.receipt(), { code: "ENOENT" });
    } finally { redirector.closeAllConnections(); await new Promise((done) => redirector.close(done)); }
  }
});
