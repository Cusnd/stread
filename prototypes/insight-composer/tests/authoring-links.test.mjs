import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileAuthoring } from "../scripts/authoring-compiler.mjs";
import { validateDocument } from "../../../services/workspace/documents.mjs";

const authoring = blocks => ({ format: "reader-authoring-1", key: "link-preservation", meta: { title: "Link preservation", language: "en" }, blocks });

test("only rendered Markdown links resolve author keys; literal code survives in every text field", async () => {
  const source = "See [target](#intro). Keep `[target](#intro)` verbatim.\n\n```md\n[target](#intro)\n```";
  const translated = "见 [目标](#intro)。保留 `[target](#intro)`。\n\n```md\n[target](#intro)\n```";
  const input = authoring([
    { key: "intro", type: "para", text: "Target." },
    { key: "text", type: "para", text: source, translations: { "zh-CN": { text: translated } } },
    { key: "list", type: "list", ordered: false, items: [{ key: "item", text: source, translations: { "zh-CN": { text: translated } } }] },
    { key: "table", type: "table", head: [["Example"]], rows: [[source]], caption: source,
      translations: { "zh-CN": { rows: [[translated]], caption: translated } } },
  ]);
  const before = structuredClone(input), result = await compileAuthoring(input);
  const [target, paragraph, list, table] = result.document.blocks;
  const expected = source.replace("[target](#intro)", `[target](#${target.id})`);
  const expectedTranslation = translated.replace("[目标](#intro)", `[目标](#${target.id})`);
  for (const value of [paragraph.text, list.items[0].text, table.rows[0][0], table.caption]) assert.equal(value, expected);
  for (const value of [paragraph.translations["zh-CN"].text, list.items[0].translations["zh-CN"].text, table.translations["zh-CN"].rows[0][0], table.translations["zh-CN"].caption]) assert.equal(value, expectedTranslation);
  assert.equal(result.report.internal_links, 8);
  assert.deepEqual(input, before);
  await validateDocument(result.document);
  assert.deepEqual((await compileAuthoring(input, result.registry)).document, result.document, "unchanged recompilation retains identities and literal text");
});

test("HTML links resolve independent of quote style without rewriting code or text nodes", async () => {
  for (const href of ["href='#intro'", 'href="#intro"', "href=#intro", 'href="&#35;intro"']) {
    const html = `<p data-key="link"><a ${href}>Target</a></p><pre data-key="code"><code>[target](#intro) &lt;a href='#intro'&gt;</code></pre>`;
    const input = authoring([{ key: "intro", type: "para", text: "Target." }, { key: "html", type: "html", html,
      translations: { "zh-CN": { alignment: "same-structure", html: html.replace(">Target<", ">目标<") } } }]);
    const result = await compileAuthoring(input), [target, block] = result.document.blocks;
    for (const value of [block.html, block.translations["zh-CN"].html]) {
      assert.ok(value.includes(`href="#${target.id}"`));
      assert.ok(value.includes("[target](#intro) &lt;a href='#intro'&gt;"));
    }
    assert.equal(result.report.internal_links, 2);
    await validateDocument(result.document);
  }
});

test("prototype property names are valid author keys and never masquerade as existing targets", async () => {
  for (const key of ["constructor", "toString", "hasOwnProperty"]) {
    const result = await compileAuthoring(authoring([{ key, type: "para", text: "Target." }, { key: "link", type: "para", text: `[Target](#${key})` }]));
    assert.equal(result.document.blocks[1].text, `[Target](#${result.document.blocks[0].id})`);
    await validateDocument(result.document);
    await assert.rejects(compileAuthoring(authoring([{ key: "link", type: "para", text: `[Missing](#${key})` }])), /E_AUTHOR_LINK/);
  }
});

test("figure alt stays plain accessible text while its caption uses real link markup", async () => {
  const alt = "Code [example](#missing) and $\\notACommand$ are literal image text.";
  const result = await compileAuthoring(authoring([{ key: "intro", type: "para", text: "Target." },
    { key: "figure", type: "figure", src: "figure.png", alt, caption: "See [target](#intro).", translations: { "zh-CN": { alt: "代码 [example](#missing) 与 $\\notACommand$。", caption: "见 [目标](#intro)。" } } }]));
  assert.equal(result.document.blocks[1].alt, alt);
  assert.equal(result.report.internal_links, 2);
  const validated = await validateDocument(result.document);
  assert.equal(validated.index.find(entry => entry.field === "alt" && entry.variant === "source").text, alt);
});

test("HTML link rewriting rejects parse errors in original and translated fragments", async () => {
  const invalid = '<p data-key="p" data-key="q"><a href="#intro">Target</a></p>';
  for (const translated of [false, true]) {
    const block = { key: "html", type: "html", html: translated ? '<p data-key="p">Source</p>' : invalid };
    if (translated) block.translations = { "zh-CN": { html: invalid } };
    await assert.rejects(compileAuthoring(authoring([{ key: "intro", type: "para", text: "Target" }, block])), /E_AUTHOR_HTML \[html\]: duplicate-attribute/);
  }
});

test("unchanged legacy HTML retains repeated unkeyed identities with and without links", async () => {
  for (const link of ["", '<a href="#intro">Target</a>']) {
    const html = `<p class='note'>Repeated ${link}</p><p class='note'>Repeated ${link}</p>`;
    const input = authoring([{ key: "intro", type: "para", text: "Target" }, { key: "html", type: "html", html }]);
    const first = await compileAuthoring(input), previous = structuredClone(first.registry);
    // Registries written before parsed-link rewriting hashed the raw fragment,
    // replacing only double-quoted block targets before assigning node IDs.
    const legacyInput = html.replaceAll('href="#intro"', `href="#${previous.blocks.intro.id}"`);
    previous.blocks.html.htmlInput = createHash("sha256").update(legacyInput).digest("hex");
    const second = await compileAuthoring(input, previous);
    assert.deepEqual(second.registry.blocks.html.nodes.map(node => node.id), previous.blocks.html.nodes.map(node => node.id));
    assert.ok(!second.report.warnings.some(warning => warning.code === "W_IDENTITY_UNRESOLVED"));
    assert.deepEqual(second.document, first.document);
  }
});

test("HTML unit references use only authored keys, including prototype property names", async () => {
  for (const key of ["constructor", "toString", "hasOwnProperty"]) {
    const html = `<p data-key="${key}">Target</p><p data-key="link"><a href="#${key}">Target</a></p>`;
    const result = await compileAuthoring(authoring([{ key: "html", type: "html", html,
      translations: { "zh-CN": { html: html.replaceAll("Target", "目标") } } }]));
    const targetId = result.registry.blocks.html.nodes[0].id;
    for (const value of [result.document.blocks[0].html, result.document.blocks[0].translations["zh-CN"].html]) assert.ok(value.includes(`href="#${targetId}"`));
    await assert.rejects(compileAuthoring(authoring([{ key: "html", type: "html", html: `<p><a href="#${key}">Missing</a></p>` }])), /E_AUTHOR_LINK/);
    await assert.rejects(compileAuthoring(authoring([{ key: "html", type: "html", html: '<p data-key="source">Source</p>',
      translations: { "zh-CN": { html: `<p data-key="${key}">译文</p>` } } }])), /E_AUTHOR_ALIGNMENT/);
  }
});
