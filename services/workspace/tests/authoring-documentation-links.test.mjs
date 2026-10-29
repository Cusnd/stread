import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { authoringDocumentation } from "../authoring.mjs";
import { createFileCapabilities, decorateDocumentationLinks } from "../file-capabilities.mjs";
import { createWorkspaceServer } from "../server.mjs";

const markdownLinks = text => [...text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map(match => ({ label: match[1], url: match[2] }));
const expiry = url => Number.parseInt(new URL(url).searchParams.get("access").split(".")[1], 36);

test("documentation decoration signs only catalog-resolved links and preserves fragments, expiry and binding", async () => {
  let now = Date.now();
  const capabilities = await createFileCapabilities({ clock: () => now, ttlMs: 60_000 });
  const initial = await capabilities.issue("https://reader.example/api/authoring/docs/guide.md", { binding: "run-a" });
  const parent = await capabilities.verify(initial.url, "GET", { authorizeBinding: id => id === "run-a" });
  now += 20_000;
  const resource = await authoringDocumentation("guide.md");
  const before = resource.body.toString();
  const decorated = await decorateDocumentationLinks(resource, { capabilities, baseUrl: "https://reader.example", parent });
  const output = new TextDecoder().decode(decorated.body);
  assert.equal(resource.body.toString(), before, "the underlying documentation is not mutated");
  assert.ok(resource.documentationLinks.length >= 4);
  for (const original of resource.documentationLinks) {
    const expected = new URL(original, "https://reader.example");
    const link = markdownLinks(output).find(item => new URL(item.url, "https://reader.example").pathname === expected.pathname && new URL(item.url, "https://reader.example").hash === expected.hash);
    assert.ok(link, original);
    const claims = await capabilities.verify(link.url, "GET", { authorizeBinding: id => id === "run-a" });
    assert.equal(claims.binding, "run-a");
    assert.equal(claims.expiresAt, parent.expiresAt, "following links does not extend access");
    assert.equal(new URL(link.url).hash, expected.hash);
  }
  const arbitrary = { body: Buffer.from("[external](https://other.example/api/authoring/docs/guide.md) [command](/api/commands) [unlisted](/api/authoring/docs/guide.md)"),
    documentationLinks: ["https://other.example/api/authoring/docs/guide.md", "/api/commands"] };
  const unchanged = await decorateDocumentationLinks(arbitrary, { capabilities, baseUrl: "https://reader.example", parent });
  assert.equal(new TextDecoder().decode(unchanged.body), arbitrary.body.toString());
  now = parent.expiresAt;
  await assert.rejects(decorateDocumentationLinks(resource, { capabilities, baseUrl: "https://reader.example", parent }), { code: "INVALID_FILE_CAPABILITY" });
});

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "reader-doc-links-"));
  let now = Date.now();
  const token = randomUUID(), clients = [];
  const fileCapabilities = await createFileCapabilities({ clock: () => now, ttlMs: 60_000 });
  const server = await createWorkspaceServer({ dataDir: root, authToken: token, bootstrap: false, glossaryPath: false, staticRoot: false,
    fileCapabilities });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await server.shutdown();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.startsWith(join(tmpdir(), "reader-doc-links-")));
    await rm(root, { recursive: true, force: true });
  });
  async function contract(credential = token) {
    const client = new Client({ name: "authoring-doc-links", version: "1" }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers: { Authorization: "Bearer " + credential } } }));
    const response = await client.callTool({ name: "get_authoring_contract", arguments: {} });
    assert.ok(!response.isError, JSON.stringify(response));
    return response.structuredContent;
  }
  async function read(url, expected = 200) {
    const response = await fetch(new URL(url, base));
    const text = await response.text();
    assert.equal(response.status, expected, text.slice(0, 200));
    return { response, text };
  }
  return { server, base, contract, read, fileCapabilities, advance: ms => { now += ms; } };
}

test("a fresh MCP caller follows guide, format and nested example links without transferring credentials", async t => {
  const h = await harness(t), contract = await h.contract();
  const guideUrl = contract.documentation.find(doc => doc.filename === "guide.md").url;
  h.advance(20_000);
  const guide = await h.read(guideUrl);
  assert.equal(guide.response.headers.get("cache-control"), "no-store");
  const links = markdownLinks(guide.text);
  for (const link of links) {
    assert.equal(new URL(link.url).origin, h.base);
    assert.equal(expiry(link.url), expiry(guideUrl));
    await h.read(link.url);
  }
  const format = links.find(link => new URL(link.url).pathname.endsWith("/format-reference.md") && !new URL(link.url).hash);
  assert.ok(format, "the detailed inline-math documentation is reachable from the guide");
  assert.match((await h.read(format.url)).text, /inline TeX/);
  const examples = links.find(link => new URL(link.url).pathname.endsWith("/examples/index.md"));
  const nested = markdownLinks((await h.read(examples.url)).text);
  const sample = nested.find(link => new URL(link.url).pathname.endsWith("/examples/image-text.json"));
  assert.ok(sample);
  assert.equal(expiry(sample.url), expiry(guideUrl));
  await h.read(sample.url);
  const copied = new URL(guideUrl); copied.pathname = "/api/authoring/docs/format-reference.md";
  await h.read(copied.href, 403);
  const escape = new URL(format.url); escape.pathname = "/api/workspace";
  await h.read(escape.href, 403);
  h.advance(40_000);
  await h.read(guideUrl, 403);
  await h.read(format.url, 403);
  await h.read(sample.url, 403);
});

test("retired run-bound documentation capabilities cannot become ordinary file access", async t => {
  const h = await harness(t);
  const retired = await h.fileCapabilities.issue(new URL("/api/authoring/docs/guide.md", h.base).href, { binding: "retired-run" });
  await h.read(retired.url, 403);
  const contract = await h.contract();
  await h.read(contract.documentation.find(doc => doc.filename === "guide.md").url);
});
