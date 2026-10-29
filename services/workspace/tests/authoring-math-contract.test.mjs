import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import katex from "katex";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createWorkspaceServer } from "../server.mjs";
import { validateDocument } from "../documents.mjs";
import { compileAuthoring } from "../../../prototypes/insight-composer/scripts/authoring-compiler.mjs";
import { inlineTokens } from "../../../prototypes/insight-composer/src/document-content.js";

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "reader-math-contract-"));
  const token = randomUUID();
  const server = await createWorkspaceServer({ dataDir: root, bootstrap: false, glossaryPath: false, staticRoot: false, sync: false, authToken: token });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const client = new Client({ name: "fresh-math-author", version: "1" });
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    await client.close(); await server.shutdown();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.startsWith(join(tmpdir(), "reader-math-contract-")));
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers: { Authorization: "Bearer " + token } } }));
  const call = async (name, input = {}) => {
    const result = await client.callTool({ name, arguments: input });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  };
  const download = async descriptor => {
    assert.ok(new URL(descriptor.url).searchParams.has("access"), "a fresh MCP caller receives a usable scoped URL");
    const response = await fetch(descriptor.url);
    assert.equal(response.status, 200, descriptor.filename);
    return response.text();
  };
  return { client, call, download };
}

async function compiledMath(input) {
  const compiled = await compileAuthoring(input);
  const validated = await validateDocument(compiled.document);
  const paragraphs = validated.document.blocks.filter(block => block.type === "para");
  const mathByVariant = Object.fromEntries(["source", "zh-CN"].map(variant => {
    const formulas = paragraphs.flatMap(block => inlineTokens(variant === "source" ? block.text : block.translations?.[variant]?.text || ""))
      .filter(token => token.kind === "math").map(token => token.text);
    assert.ok(formulas.length >= 2, `${variant} demonstrates actual inline formula markup`);
    const html = formulas.map(tex => katex.renderToString(tex, { displayMode: false, throwOnError: true, trust: false })).join("");
    assert.match(html, /class="msupsub"/, `${variant} produces actual subscript/superscript layout`);
    assert.ok(!html.includes("katex-display"), `${variant} stays inline`);
    return [variant, formulas];
  }));
  assert.deepEqual(mathByVariant["source"], mathByVariant["zh-CN"], "language-neutral formulas survive in both stored variants");
  return validated;
}

test("a fresh MCP caller receives inline-math guidance and a working bilingual envelope before downloading docs", async t => {
  const h = await harness(t);
  const contract = await h.call("get_authoring_contract");
  const guidance = contract.rules.join("\n");
  assert.match(guidance, /\$[^$\n]+\$/, "the first response exposes the supported inline delimiter");
  assert.match(guidance, /translation|译文/i);
  assert.match(guidance, /\\binom/);
  assert.match(guidance, /data-tex/);
  await compiledMath(contract.envelope);

  const grant = await h.call("prepare_source_upload", { filename: "contract-envelope.json", authorized: true, request_id: randomUUID() });
  const upload = await fetch(grant.uploadUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(contract.envelope) });
  assert.equal(upload.status, 201);
  const file = await upload.json();
  const validation = await h.call("validate_authoring", { authoring_source_id: file.sourceId, resources: {} });
  assert.equal(validation.valid, true);
  assert.equal(validation.summary.translatedBlocks, 1);
  assert.equal(validation.scope, "structure-and-resources", "successful syntax validation does not certify source fidelity");
});

test("scoped documentation downloads preserve usable JSON/TeX examples and distinguish math from literal text", async t => {
  const h = await harness(t), contract = await h.call("get_authoring_contract");
  const docs = {};
  for (const filename of ["guide.md", "minimal-example.json", "format-reference.md"]) {
    const descriptor = contract.documentation.find(item => item.filename === filename);
    assert.ok(descriptor, `${filename} is available directly to the caller`);
    docs[filename] = await h.download(descriptor);
  }
  await compiledMath(JSON.parse(docs["minimal-example.json"]));
  assert.match(docs["guide.md"], /\$[^$\n]+\$/);
  assert.match(docs["format-reference.md"], /\\binom/);
  const examples = [...docs["guide.md"].matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  const paragraph = examples.find(value => value.type === "para" && value.text?.includes("$"));
  assert.ok(paragraph, "the short guide contains a copyable JSON example with inline formulas");
  await compiledMath({ ...contract.envelope, blocks: [paragraph] });
  const referenceExamples = [...docs["format-reference.md"].matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  const binomial = referenceExamples.find(value => value.type === "para" && value.text?.includes("\\binom"));
  assert.ok(binomial, "the detailed reference supplies valid JSON with an actual binomial command");
  await compiledMath({ ...contract.envelope, blocks: [binomial] });
  const binomialTex = inlineTokens(binomial.text).find(token => token.kind === "math" && token.text.includes("\\binom"));
  assert.match(katex.renderToString(binomialTex.text, { throwOnError: true, trust: false }), /class="mfrac"/, "JSON escaping survives into stacked binomial typesetting");

  const literal = "file_name.py and x_1 remain literal; `x_1^2` is code.";
  const tokens = inlineTokens(literal);
  assert.equal(tokens.filter(token => token.kind === "math").length, 0, "the reader never guesses formulas from ordinary text or code");
  assert.equal(tokens.map(token => literal.slice(token.start, token.end)).join(""), literal, "source offsets and literal bytes remain unchanged");
});
