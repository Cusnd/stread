import test from "node:test";
import assert from "node:assert/strict";
import { inlineTokens, safeLink } from "../src/document-content.js";
import { compileAuthoring } from "../scripts/authoring-compiler.mjs";
import { validateDocument } from "../../../services/workspace/documents.mjs";

const doi = "https://doi.org/10.1016/S0167-6377(03)00076-9";
const unchangedOffsets = (text, tokens) => {
  assert.equal(tokens.map(token => text.slice(token.start, token.end)).join(""), text);
  for (let index = 1; index < tokens.length; index++) assert.equal(tokens[index - 1].end, tokens[index].start);
};

test("inline DOI links preserve balanced parentheses and adjacent prose", () => {
  const text = `See [paper](${doi}), then [nested](https://example.org/a(b(c)d)e).`;
  const tokens = inlineTokens(text), links = tokens.filter(token => token.kind === "link");
  assert.deepEqual(links.map(token => token.href), [doi, "https://example.org/a(b(c)d)e"]);
  assert.deepEqual(links.map(token => token.text), ["paper", "nested"]);
  for (const link of links) assert.equal(safeLink(link.href), link.href);
  assert.equal(text.slice(links[0].end, links[0].end + 7), ", then ");
  assert.equal(text.slice(links[1].end), ".");
  unchangedOffsets(text, tokens);
});

test("link-shaped code and math stay atomic and malformed destinations remain literal", () => {
  const code = `[paper](${doi})`;
  for (const text of ["`" + code + "`", "```md\n" + code + "\n```", "$[x](a(b)c)$"]) {
    const tokens = inlineTokens(text);
    assert.equal(tokens.filter(token => token.kind === "link").length, 0);
    unchangedOffsets(text, tokens);
  }
  for (const text of ["[broken](https://example.org/a(b)", "[broken](https://example.org/a(b", "[broken](https://example.org/a(b c))", "[empty]()"]) {
    const tokens = inlineTokens(text);
    assert.equal(tokens.filter(token => token.kind === "link").length, 0, text);
    unchangedOffsets(text, tokens);
  }
  const text = "[outer](https://example.org/a($x$)) and $y$";
  const tokens = inlineTokens(text);
  assert.deepEqual(tokens.filter(token => token.kind !== "text").map(token => token.kind), ["link", "math"]);
  assert.equal(tokens[0].href, "https://example.org/a($x$)");
  unchangedOffsets(text, tokens);
});

test("compilation keeps external DOI bytes while resolving neighboring internal targets", async () => {
  const text = `See [paper](${doi}) and [section](#section).`;
  const input = { format: "reader-authoring-1", key: "link-destinations", meta: { title: "Links", language: "en" }, blocks: [
    { key: "intro", type: "para", text, translations: { "zh-CN": { text: `见[论文](${doi})和[章节](#section)。` } } },
    { key: "section", type: "heading", level: 1, text: "Section" },
  ] };
  const compiled = await compileAuthoring(input), target = compiled.document.blocks[1].id;
  for (const value of [compiled.document.blocks[0].text, compiled.document.blocks[0].translations["zh-CN"].text]) {
    assert.deepEqual(inlineTokens(value).filter(token => token.kind === "link").map(token => token.href), [doi, "#" + target]);
  }
  await validateDocument(compiled.document);
  assert.equal(input.blocks[0].text, text);
});
