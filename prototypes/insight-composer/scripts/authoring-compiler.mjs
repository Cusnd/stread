import { createHash, randomUUID } from "node:crypto";
import { parseFragment, serialize } from "parse5";
import katex from "katex";
import { HTML_PROFILE_SHARED, parseHtml, htmlFingerprint, prepareReaderDocument, safeHtmlAsset } from "../src/html-content.js";
import { inlineTokens } from "../src/document-content.js";
import { validateAuthoringInput } from "./authoring-validation.mjs";

const digest = (value) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const fail = (code, key, detail) => { throw new Error(`${code} [${key}]: ${detail}`); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const OWNERS = new Set("p th td caption figcaption pre li dt dd blockquote".split(" "));
const INLINE = new Set("span strong em b i sup sub code a br img".split(" "));
const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value;
const put = (node, name, value) => { node.attrs = node.attrs.filter((a) => a.name !== name); node.attrs.push({ name, value }); };
const fresh = (prefix) => prefix + randomUUID().replaceAll("-", "");
const clone = (value) => structuredClone(value);

function ownerNodes(fragment) {
  const result = [];
  const signature = (node) => node.nodeName === "#text" ? node.value : [node.tagName, (node.attrs || []).filter((a) => !["class", "data-key", "data-node-id"].includes(a.name)).map((a) => [a.name, a.value]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), (node.childNodes || []).map(signature)];
  function visit(node, path = "") {
    if (!node.tagName) return;
    const key = attr(node, "data-key");
    if (key && !ID.test(key)) fail("E_AUTHOR_KEY", key, "invalid HTML unit key");
    if (attr(node, "data-node-id")) fail("E_AUTHOR_DERIVED", key || path, "data-node-id is generated; use data-key");
    const owns = OWNERS.has(node.tagName) || key || (["div", "section", "span"].includes(node.tagName) && node.childNodes.every((n) => !n.tagName || INLINE.has(n.tagName)));
    if (owns) {
      if (["img", "br", "table", "tr", "thead", "tbody", "tfoot", "ul", "ol"].includes(node.tagName) || attr(node, "data-tex")) fail("E_AUTHOR_KEY", key || path, "key must name a text unit");
      function nested(current) {
        for (const child of current.childNodes || []) {
          if (attr(child, "data-key") || attr(child, "data-node-id")) fail("E_AUTHOR_KEY", key || path, "nested identity");
          nested(child);
        }
      }
      nested(node);
      result.push({ node, path, key, signature: digest(signature(node)) });
    } else node.childNodes.forEach((child, i) => visit(child, path + "." + i));
  }
  fragment.childNodes.forEach((node, i) => visit(node, String(i)));
  return result;
}

function authorFragment(html, key, locations = false) {
  if (typeof html !== "string" || html.length > 120000) fail("E_AUTHOR_HTML", key, "HTML must be a bounded fragment");
  const errors = [];
  const root = parseFragment(html, { sourceCodeLocationInfo: locations, onParseError: (e) => errors.push(e.code) });
  if (errors.length) fail("E_AUTHOR_HTML", key, errors.join(", "));
  return root;
}

function identifyHtml(html, blockKey, previous = {}, warnings) {
  const fragment = authorFragment(html, blockKey), units = ownerNodes(fragment);
  const keys = new Set(), used = new Set(), records = [], previousNodes = previous.nodes || [];
  const sameInput = previous.htmlInput === digest(html);
  const counts = new Map();
  for (const unit of units) counts.set(unit.signature, (counts.get(unit.signature) || 0) + 1);
  for (const unit of units) {
    if (unit.key && keys.has(unit.key)) fail("E_AUTHOR_KEY", blockKey, "duplicate HTML key " + unit.key);
    if (unit.key) keys.add(unit.key);
    const candidates = previousNodes.filter((old) => unit.key ? old.key === unit.key : !old.key && (sameInput ? old.path === unit.path : counts.get(unit.signature) === 1 && old.signature === unit.signature));
    const old = candidates.length === 1 && !used.has(candidates[0].id) ? candidates[0] : null;
    const id = old?.id || fresh("n-"); used.add(id);
    records.push({ id, key: unit.key || null, path: unit.path, signature: unit.signature });
    unit.node.attrs = unit.node.attrs.filter((a) => a.name !== "data-key");
    put(unit.node, "data-node-id", id);
  }
  const keyIds = Object.assign(Object.create(null), Object.fromEntries(records.filter((r) => r.key).map((r) => [r.key, r.id])));
  function rewrite(node) {
    for (const a of node.attrs || []) {
      if (["headers", "data-same-as"].includes(a.name)) a.value = a.value.split(/\s+/).map((key) => keyIds[key] || key).join(" ");
      if (a.name === "href" && a.value.startsWith("#") && keyIds[a.value.slice(1)]) a.value = "#" + keyIds[a.value.slice(1)];
    }
    (node.childNodes || []).forEach(rewrite);
  }
  rewrite(fragment);
  const removed = previousNodes.filter((n) => !used.has(n.id));
  if (removed.length) warnings.push({ code: "W_IDENTITY_UNRESOLVED", key: blockKey, node_ids: removed.map((n) => n.id), detail: "Old references must be checked; no positional remapping was guessed." });
  return { html: serialize(fragment), nodes: records, htmlInput: digest(html) };
}

function alignTranslation(html, sourceHtml, sourceNodes, key, alignment) {
  const root = authorFragment(html, key), units = ownerNodes(root);
  if (units.length !== sourceNodes.length) fail("E_AUTHOR_ALIGNMENT", key, "source/translation unit counts differ");
  const keyed = units.every((u) => u.key) && sourceNodes.every((u) => u.key);
  if (!keyed && alignment !== "same-structure") fail("E_AUTHOR_ALIGNMENT", key, "declare verified same-structure alignment or key every unit");
  const keyIds = Object.assign(Object.create(null), Object.fromEntries(sourceNodes.filter((n) => n.key).map((n) => [n.key, n.id])));
  const assigned = new Set();
  units.forEach((unit, index) => {
    const id = keyed ? keyIds[unit.key] : sourceNodes[index].id;
    if (!id || assigned.has(id)) fail("E_AUTHOR_ALIGNMENT", key, "unknown or duplicate translated unit key");
    assigned.add(id);
    unit.node.attrs = unit.node.attrs.filter((a) => a.name !== "data-key");
    put(unit.node, "data-node-id", id);
  });
  function rewrite(node) {
    for (const a of node.attrs || []) {
      if (["headers", "data-same-as"].includes(a.name)) a.value = a.value.split(/\s+/).map((k) => keyIds[k] || k).join(" ");
      if (a.name === "href" && a.value.startsWith("#") && keyIds[a.value.slice(1)]) a.value = "#" + keyIds[a.value.slice(1)];
    }
    (node.childNodes || []).forEach(rewrite);
  }
  rewrite(root);
  const result = serialize(root);
  if (alignment === "same-structure" && parseHtml(sourceHtml).scaffold !== parseHtml(result).scaffold) fail("E_AUTHOR_ALIGNMENT", key, "declared same-structure translation changes scaffolding");
  return result;
}

function standardFingerprint(block, language) {
  const payload = block.type === "table" ? [block.head, block.rows, block.caption ?? null]
    : block.type === "figure" ? [block.src, block.alt ?? null, block.caption ?? null, block.image_text ?? null]
    : block.type === "list" ? [block.ordered, block.items.map((item) => [item.id, item.text])]
    : [block.type === "math" ? block.tex : block.text];
  return "sha256:" + digest([language, block.type, ...payload]);
}

function validateStandard(block, key) {
  if (block.placement !== undefined && !["frontmatter", "body"].includes(block.placement)) fail("E_AUTHOR_PLACEMENT", key, "placement must be frontmatter or body");
  if (["heading", "para"].includes(block.type) && typeof block.text !== "string") fail("E_AUTHOR_TEXT", key, "text required");
  if (block.type === "heading" && (!Number.isInteger(block.level) || block.level < 1 || block.level > 6)) fail("E_AUTHOR_HEADING", key, "level must be 1-6");
  if (block.type === "math" && typeof block.tex !== "string") fail("E_AUTHOR_MATH", key, "TeX required");
  if (block.type === "figure" && !safeHtmlAsset(block.src)) fail("E_AUTHOR_RESOURCE", key, "relative image required");
  if (block.type === "table") {
    const rows = [...(block.head || []), ...(block.rows || [])], width = rows[0]?.length;
    if (!width || !rows.every((r) => Array.isArray(r) && r.length === width && r.every((v) => typeof v === "string"))) fail("E_AUTHOR_TABLE", key, "complete string matrix required");
  }
  for (const source of block.source || []) {
    if (!Number.isInteger(source.page) || source.page < 1 || (source.box && (source.box.length !== 4 || source.box.some((v) => !Number.isFinite(v) || v < 0 || v > 1) || source.box[0] >= source.box[2] || source.box[1] >= source.box[3]))) fail("E_AUTHOR_SOURCE", key, "invalid page/box");
  }
}

export async function compileAuthoring(input, previous = null) {
  const inputValidation = validateAuthoringInput(input);
  if (input.format !== "reader-authoring-1" || !ID.test(input.key || "") || !input.meta?.title || !Array.isArray(input.blocks) || !input.blocks.length) fail("E_AUTHOR_INPUT", input.key, "invalid authoring envelope");
  if (previous && previous.key !== input.key) fail("E_AUTHOR_IDENTITY", input.key, "previous registry belongs to another authoring document");
  const registry = { version: 1, key: input.key, documentId: previous?.documentId || fresh("doc-"), inputHash: digest(input), blocks: {} };
  const warnings = [...inputValidation.warnings], ids = Object.create(null), blocks = [], assets = new Set(input.source?.path ? [input.source.path] : []);
  for (const block of input.blocks) {
    if (!ID.test(block.key || "") || ids[block.key]) fail("E_AUTHOR_KEY", block.key, "missing, invalid or duplicate block key");
    ids[block.key] = previous?.blocks[block.key]?.id || fresh("b-");
  }
  // Resolve only links the Reader actually renders. Text in code spans/fences,
  // math and HTML text nodes must retain its literal source bytes.
  const rewriteLinks = (text) => inlineTokens(text).map((token) => token.kind === "link" && token.href.startsWith("#") && ids[token.href.slice(1)]
    ? `[${token.text}](#${ids[token.href.slice(1)]})` : text.slice(token.start, token.end)).join("");
  const rewriteHtmlLinks = (html, key) => {
    const root = authorFragment(html, key, true), replacements = new Map();
    const visit = (node) => {
      const href = node.tagName === "a" && node.attrs.find((attribute) => attribute.name === "href");
      if (href && href.value.startsWith("#") && ids[href.value.slice(1)]) {
        const location = node.sourceCodeLocation?.attrs?.href;
        if (!location) fail("E_AUTHOR_HTML", key, "link has no source location");
        replacements.set(location.startOffset, { ...location, value: `href="#${ids[href.value.slice(1)]}"` });
      }
      node.childNodes?.forEach(visit);
    };
    visit(root);
    // Preserve all other source bytes: older registries hash this fragment to
    // retain identities for repeated, unkeyed units on unchanged recompilation.
    for (const replacement of [...replacements.values()].sort((a, b) => b.startOffset - a.startOffset)) {
      html = html.slice(0, replacement.startOffset) + replacement.value + html.slice(replacement.endOffset);
    }
    return html;
  };
  for (const original of input.blocks) {
    const { key, translations, ...data } = clone(original), old = previous?.blocks[key];
    if (!["heading", "para", "list", "math", "figure", "table", "html"].includes(data.type)) fail("E_AUTHOR_TYPE", key, data.type);
    const block = { ...data, id: ids[key] }, record = { id: ids[key], inputHash: digest(original), translationInputs: {}, translationHashes: {} };
    const language = block.language || input.meta.language || "und";
    validateStandard(block, key);
    if (block.type === "html") {
      const identified = identifyHtml(rewriteHtmlLinks(block.html, key), key, old, warnings);
      block.html = identified.html; block.html_profile = HTML_PROFILE_SHARED;
      Object.assign(record, identified); delete record.html;
    }
    if (block.type === "list") {
      const itemKeys = new Set(); record.items = {};
      block.items = block.items.map((item) => {
        if (!ID.test(item.key || "") || itemKeys.has(item.key)) fail("E_AUTHOR_KEY", key, "list items need unique keys");
        itemKeys.add(item.key);
        const id = old?.items?.[item.key] || fresh("i-"); record.items[item.key] = id;
        const { key: itemKey, ...rest } = item;
        for (const translation of Object.values(rest.translations || {})) {
          if (typeof translation.text === "string") translation.text = rewriteLinks(translation.text);
        }
        return { ...rest, id, text: rewriteLinks(item.text) };
      });
    }
    for (const field of ["text", "caption", "image_text"]) if (typeof block[field] === "string") block[field] = rewriteLinks(block[field]);
    for (const field of ["head", "rows"]) if (block[field]) block[field] = block[field].map((row) => row.map(rewriteLinks));
    const sourceHash = block.type === "html" ? await htmlFingerprint(parseHtml(block.html), language, block.html_profile) : standardFingerprint(block, language);
    record.sourceHash = sourceHash;
    for (const [lang, translation] of Object.entries(translations || {})) {
      if (translation.placement !== undefined) fail("E_AUTHOR_PLACEMENT", key, "placement belongs to the source block and is shared by translations");
      const { alignment, reviewed, ...value } = clone(translation);
      if (block.type === "html") value.html = alignTranslation(rewriteHtmlLinks(value.html, key), block.html, record.nodes, key, alignment);
      else {
        for (const field of ["text", "caption", "image_text"]) if (typeof value[field] === "string") value[field] = rewriteLinks(value[field]);
        for (const field of ["head", "rows"]) if (value[field]) value[field] = value[field].map((row) => row.map(rewriteLinks));
      }
      const inputHash = digest(translation);
      const stale = old?.translationHashes?.[lang] !== sourceHash && old?.translationInputs?.[lang] === inputHash && !reviewed;
      value.source_hash = stale ? old.translationHashes[lang] : sourceHash;
      if (stale) warnings.push({ code: "W_TRANSLATION_STALE", key, language: lang });
      (block.translations ||= {})[lang] = value;
      record.translationInputs[lang] = inputHash; record.translationHashes[lang] = value.source_hash;
    }
    if (block.type === "figure") assets.add(block.src);
    if (block.fallback?.image) assets.add(block.fallback.image);
    registry.blocks[key] = record; blocks.push(block);
  }
  const revision = previous ? previous.revision + (previous.inputHash === registry.inputHash ? 0 : 1) : 1;
  registry.revision = revision;
  const document = { format: "continous-reader", schema: 2, id: registry.documentId, revision, meta: clone(input.meta), source: clone(input.source), blocks,
    extensions: { ...clone(input.extensions || {}), "continous-reader.authoring": { format: input.format, key: input.key } } };
  if (input.navigation) document.navigation = { kind: "auxiliary", items: input.navigation.items.map(({ targetKey, ...item }) => ({ ...clone(item), targetId: ids[targetKey] })) };
  const prepared = await prepareReaderDocument(document);
  const index = [], mathErrors = [], internalLinks = [];
  for (const [variant, meta] of [["source", prepared.meta], ...Object.entries(prepared.meta.translations || {})]) {
    for (const token of inlineTokens(meta.title || "")) if (token.kind === "math") validateMath(token.text, "$meta", variant);
  }
  const targets = new Set(blocks.flatMap((block) => [block.id, ...(block.items || []).map((item) => item.id)]));
  const originalsById = new Map();
  for (const original of input.blocks) {
    const id = ids[original.key];
    if (!originalsById.has(id)) originalsById.set(id, original);
  }
  for (const block of prepared.blocks) {
    const key = originalsById.get(block.id).key;
    if (block.compiledHtml?.error) fail("E_AUTHOR_COMPILE", key, block.compiledHtml.error);
    if (block.compiledHtml) {
      for (const [variant, compiled] of Object.entries(block.compiledHtml.variants)) for (const node of Object.values(compiled.index)) {
        targets.add(node.id);
        index.push({ block_id: block.id, variant, field: "html_text", node_id: node.id, text: node.text });
      }
      function visit(node) {
        if (node.kind !== "element") return;
        if (node.tag === "img") assets.add(node.attrs.src);
        if (node.attrs.href?.startsWith("#")) internalLinks.push({ key, target: node.attrs.href.slice(1) });
        if (node.attrs["data-tex"]) validateMath(node.attrs["data-tex"], key);
        node.children.forEach(visit);
      }
      Object.values(block.compiledHtml.variants).forEach((v) => v.tree.forEach(visit));
    } else {
      if (block.type === "math") {
        validateMath(block.tex, key);
        for (const [variant, translation] of Object.entries(block.translations || {})) validateMath(translation.tex, key, variant);
      }
      const textObjects = [block, ...Object.values(block.translations || {}),
        ...(block.items || []).flatMap((item) => [item, ...Object.values(item.translations || {})])];
      for (const value of textObjects) for (const text of [value.text, value.caption, value.image_text, ...(value.head || []).flat(), ...(value.rows || []).flat()].filter((v) => typeof v === "string")) {
        for (const token of inlineTokens(text)) {
          if (token.kind === "math") validateMath(token.text, key);
          if (token.kind === "link" && token.href.startsWith("#")) internalLinks.push({ key, target: token.href.slice(1) });
        }
      }
    }
  }
  function validateMath(tex, key, variant = "source") {
    try { katex.renderToString(tex, { throwOnError: true, trust: false, strict: "ignore" }); }
    catch (e) { mathErrors.push({ key, variant, tex, message: e.message }); }
  }
  if (mathErrors.length) fail("E_AUTHOR_MATH", mathErrors[0].key, JSON.stringify(mathErrors));
  const missingLinks = internalLinks.filter((link) => !targets.has(link.target));
  if (missingLinks.length) fail("E_AUTHOR_LINK", missingLinks[0].key, JSON.stringify(missingLinks));
  for (const path of assets) if (!safeHtmlAsset(path)) fail("E_AUTHOR_RESOURCE", input.key, path);
  const oldKeys = Object.keys(previous?.blocks || {}).filter((key) => !registry.blocks[key]);
  if (oldKeys.length) warnings.push({ code: "W_REMOVED_BLOCKS", keys: oldKeys });
  const report = { result: "PASS", authoring_key: input.key, document_id: document.id, revision, block_count: blocks.length,
    types: Object.fromEntries([...new Set(blocks.map((b) => b.type))].map((type) => [type, blocks.filter((b) => b.type === type).length])),
    html_nodes: index.filter((r) => r.variant === "source").length, translated_blocks: blocks.filter((b) => b.translations).length,
    custom_css_blocks: blocks.filter((b) => b.css?.trim()).length, internal_links: internalLinks.length, assets: [...assets], warnings,
    scope: "Compiler structure, identity, translation provenance and math checks. Content fidelity and UI are verified separately." };
  return { document, registry, index, report };
}

