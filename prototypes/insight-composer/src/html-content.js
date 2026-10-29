import { parseFragment } from "parse5";
import { parse as parseCss, generate as generateCss, walk as walkCss, lexer } from "css-tree";
import { standardTranslationStates } from "./reading-language.js";

export const HTML_PROFILE = "reader-html-1";
export const HTML_PROFILE_SHARED = "reader-html-2";
export const SHARED_HTML_CLASSES = new Set("layout-stack layout-pair layout-grid text-start text-end scalar group-start ruled note".split(" "));
const TAGS = new Set("figure figcaption div section p span strong em b i sup sub blockquote pre code br a img table caption thead tbody tfoot tr th td ul ol li dl dt dd".split(" "));
const BLOCKS = new Set("p div section blockquote pre ul ol li dl dt dd".split(" "));
const REFERENCE_TAGS = new Set("figcaption div section p span strong em b i sup sub blockquote pre code a caption th td li dt dd".split(" "));
const asciiOrder = ([a], [b]) => a < b ? -1 : a > b ? 1 : 0;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CLASS = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const COMMON_ATTRIBUTES = new Set(["class", "lang", "title", "data-node-id"]);
const TAG_ATTRIBUTES = {
  span: ["data-tex"], th: ["rowspan", "colspan", "scope", "headers", "data-same-as"],
  td: ["rowspan", "colspan", "headers", "data-same-as"], a: ["href"],
  img: ["src", "alt", "width", "height"], ol: ["start"], li: ["value"],
};
const CSS_PROPERTIES = new Set(("display table-layout border-collapse border-spacing " +
  "text-align vertical-align white-space overflow-wrap font-weight font-style " +
  "gap column-gap row-gap padding padding-inline padding-block padding-top padding-right padding-bottom padding-left " +
  "margin-block margin-top margin-bottom border border-top border-bottom border-left border-right " +
  "border-width border-top-width border-bottom-width border-left-width border-right-width " +
  "border-style border-top-style border-bottom-style border-left-style border-right-style border-color " +
  "color background-color grid-template-columns align-items justify-content flex-wrap").split(" "));
const CSS_VARIABLES = new Set(["--html-text", "--html-muted", "--html-rule", "--html-surface"]);
const LAYOUT_PROPERTIES = new Set("display table-layout text-align vertical-align white-space overflow-wrap grid-template-columns align-items justify-content flex-wrap gap column-gap row-gap".split(" "));
const SPACE_VARIABLES = new Set(["--reader-space-1", "--reader-space-2", "--reader-space-3"]);
const error = (code, detail) => { throw new Error(`${code}: ${detail}`); };
const words = (value = "") => value.trim().split(/\s+/).filter(Boolean);
export const localHtmlClass = (name) => "html-local-" + name;
export const htmlScope = (blockId) => "html-" + Array.from(blockId).map((c) => c.codePointAt(0).toString(16)).join("-");

export function safeHtmlAsset(path) {
  return typeof path === "string" && path.length <= 500 && /^[^\\:%?#\s]+$/u.test(path)
    && !path.startsWith("/") && path.split("/").every((part) => part && part !== "." && part !== "..");
}

function validateAttributes(tag, list) {
  const attrs = Object.create(null);
  for (const { name, value } of list) {
    if (!COMMON_ATTRIBUTES.has(name) && !(TAG_ATTRIBUTES[tag] || []).includes(name)) error("E_HTML_ATTRIBUTE", `${tag}.${name}`);
    attrs[name] = value;
  }
  if (attrs["data-node-id"] && !IDENTIFIER.test(attrs["data-node-id"])) error("E_HTML_NODE_ID", attrs["data-node-id"]);
  if ("data-node-id" in attrs && !attrs["data-node-id"]) error("E_HTML_NODE_ID", "empty identity");
  if (attrs.class && words(attrs.class).some((name) => !CLASS.test(name))) error("E_HTML_CLASS", attrs.class);
  if (attrs.lang && !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(attrs.lang)) error("E_HTML_LANG", attrs.lang);
  for (const key of ["rowspan", "colspan", "width", "height"]) {
    if (key in attrs && (!/^[1-9]\d{0,3}$/.test(attrs[key]) || Number(attrs[key]) > 2000)) error("E_HTML_INTEGER", key);
  }
  for (const key of ["start", "value"]) {
    if (key in attrs && !/^-?\d{1,6}$/.test(attrs[key])) error("E_HTML_INTEGER", key);
  }
  if (attrs.scope && !["row", "col", "rowgroup", "colgroup"].includes(attrs.scope)) error("E_HTML_SCOPE", attrs.scope);
  for (const name of ["headers", "data-same-as"]) {
    if (name in attrs && (!words(attrs[name]).length || words(attrs[name]).some((id) => !IDENTIFIER.test(id)))) error("E_HTML_TARGET", name);
  }
  if (attrs["data-same-as"] && words(attrs["data-same-as"]).length !== 1) error("E_HTML_TARGET", "same-as must have one target");
  if (tag === "a" && (!attrs.href || !/^(https?:\/\/[^\s]+|#[A-Za-z0-9][A-Za-z0-9_.:-]*)$/.test(attrs.href))) error("E_HTML_LINK", attrs.href);
  if (tag === "img" && (!safeHtmlAsset(attrs.src) || !("alt" in attrs))) error("E_HTML_RESOURCE", attrs.src);
  return attrs;
}

function semantic(node) {
  if (node.kind === "text") return node.text;
  return [node.tag, Object.entries(node.attrs).filter(([key]) => key !== "class").sort(asciiOrder), node.children.map(semantic)];
}

function scaffold(node) {
  if (node.kind === "text") return node.text;
  const attrs = Object.entries(node.attrs).filter(([key]) => !["lang", "title"].includes(key)).sort(asciiOrder);
  return node.nodeId ? [node.tag, attrs, ["node", node.nodeId]] : [node.tag, attrs, node.children.map(scaffold)];
}

function validateTables(tree, index) {
  const tables = [], tableFor = new Map();
  function collect(node, table = null) {
    if (node.kind !== "element") return;
    if (node.tag === "table") {
      if (table) error("E_HTML_TABLE", "nested tables are outside reader-html-1");
      tables.push(node); table = node;
    }
    if (["th", "td"].includes(node.tag)) {
      if (!table) error("E_HTML_TABLE", "cell outside table");
      if (node.nodeId) tableFor.set(node.nodeId, table);
    }
    node.children.forEach((child) => collect(child, table));
  }
  tree.forEach((node) => collect(node));
  for (const table of tables) {
    let width = null;
    const groups = table.children.filter((node) => ["thead", "tbody", "tfoot"].includes(node.tag));
    if (!groups.length) error("E_HTML_TABLE", "table has no row groups");
    for (const group of groups) {
      const rows = group.children.filter((node) => node.tag === "tr");
      if (!rows.length) error("E_HTML_TABLE", "empty row group");
      const occupied = rows.map(() => new Set());
      rows.forEach((row, r) => {
        const cells = row.children.filter((node) => ["th", "td"].includes(node.tag));
        let column = 0;
        for (const cell of cells) {
          while (occupied[r].has(column)) column++;
          const rowSpan = Number(cell.attrs.rowspan || 1), colSpan = Number(cell.attrs.colspan || 1);
          if (r + rowSpan > rows.length || column + colSpan > 2000) error("E_HTML_SPAN", "span crosses group or table budget");
          for (let dr = 0; dr < rowSpan; dr++) for (let dc = 0; dc < colSpan; dc++) {
            if (occupied[r + dr].has(column + dc)) error("E_HTML_SPAN", "overlapping cells");
            occupied[r + dr].add(column + dc);
          }
          column += colSpan;
          for (const target of words(cell.attrs.headers)) {
            if (index[target]?.tag !== "th" || tableFor.get(target) !== table) error("E_HTML_HEADER", target);
          }
          const target = cell.attrs["data-same-as"];
          if (target && (!cell.nodeId || index[cell.nodeId].text.trim() || !index[target]?.text.trim() || tableFor.get(target) !== table)) error("E_HTML_EMPTY", target);
        }
      });
      for (const row of occupied) {
        width ??= row.size;
        if (!width || row.size !== width || [...row].some((column) => column >= width)) error("E_HTML_GRID", "incomplete table grid");
      }
    }
  }
}

export function parseHtml(html) {
  if (typeof html !== "string" || !html.trim() || html.length > 120000 || [...html].some((c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)) error("E_HTML_INPUT", "invalid text or size");
  const parseErrors = [];
  const fragment = parseFragment(html, { onParseError: (item) => parseErrors.push(item.code) });
  if (parseErrors.length) error("E_HTML_PARSE", parseErrors.join(", "));
  const index = Object.create(null);
  let count = 0;
  function convert(node, owner = null, pre = false, depth = 0) {
    if (++count > 10000 || depth > 32) error("E_HTML_BUDGET", "node count or depth");
    if (node.nodeName === "#comment") return null;
    if (node.nodeName === "#text") {
      if (!owner) {
        if (node.value.trim()) error("E_HTML_UNOWNED_TEXT", node.value.slice(0, 50));
        return null;
      }
      const text = pre ? node.value : node.value.replace(/[\t\r\n\f ]+/g, " ");
      const start = owner.text.length;
      owner.text += text;
      return { kind: "text", text, start, end: owner.text.length };
    }
    if (!TAGS.has(node.tagName) || node.namespaceURI !== "http://www.w3.org/1999/xhtml") error("E_HTML_TAG", node.tagName || node.nodeName);
    const attrs = validateAttributes(node.tagName, node.attrs);
    const nodeId = attrs["data-node-id"];
    if (nodeId) {
      if (!REFERENCE_TAGS.has(node.tagName) || "data-tex" in attrs) error("E_HTML_NODE_ID", "identity must address a text container, cell or caption");
      if (owner || index[nodeId]) error("E_HTML_NODE_ID", `nested or duplicate identity ${nodeId}`);
      owner = { id: nodeId, tag: node.tagName, text: "" };
      index[nodeId] = owner;
    }
    const item = { kind: "element", tag: node.tagName, attrs, children: [], ...(nodeId ? { nodeId } : {}) };
    if ("data-tex" in attrs) {
      if (!owner || !attrs["data-tex"] || attrs["data-tex"].length > 5000 || node.childNodes.length) error("E_HTML_MATH", "math must be an empty span inside a reference node");
      item.start = owner.text.length;
      owner.text += "$" + attrs["data-tex"] + "$";
      item.end = owner.text.length;
    } else if (node.tagName === "br") {
      if (!owner) error("E_HTML_UNOWNED_TEXT", "br outside a reference node");
      item.start = owner.text.length; owner.text += "\n"; item.end = owner.text.length;
    } else {
      node.childNodes.forEach((child) => {
        if (owner && BLOCKS.has(child.tagName) && owner.text && !owner.text.endsWith("\n")) owner.text += "\n";
        const result = convert(child, owner, pre || node.tagName === "pre", depth + 1);
        if (result) item.children.push(result);
      });
    }
    if (nodeId) { index[nodeId].ast = item; index[nodeId].semantic = JSON.stringify(semantic(item)); }
    return item;
  }
  const tree = fragment.childNodes.map((node) => convert(node)).filter(Boolean);
  if (!Object.keys(index).length) error("E_HTML_NODE_ID", "no reference nodes");
  validateTables(tree, index);
  return { tree, index, semanticTree: tree.map(semantic), scaffold: JSON.stringify(tree.map(scaffold)), nodeCount: count };
}

export function compileHtmlCss(css = "", scope, profile = HTML_PROFILE) {
  const shared = profile === HTML_PROFILE_SHARED;
  if (typeof css !== "string" || css.length > 10000 || !/^[a-z0-9-]+$/.test(scope)) error("E_HTML_CSS", "invalid stylesheet or scope");
  if (!css.trim()) return "";
  let ast;
  try { ast = parseCss(css, { parseValue: true, parseRulePrelude: true, onParseError: (e) => { throw e; } }); }
  catch { error("E_HTML_CSS", "invalid CSS syntax"); }
  const output = [];
  ast.children.forEach((rule) => {
    if (rule.type !== "Rule" || rule.prelude?.type !== "SelectorList") error("E_HTML_CSS", "only scoped style rules are allowed");
    const selectors = [];
    rule.prelude.children.forEach((selector) => {
      walkCss(selector, (node) => {
        if (node.type === "ClassSelector") {
          if (!CLASS.test(node.name)) error("E_HTML_CSS", "invalid class");
          if (shared && SHARED_HTML_CLASSES.has(node.name)) error("E_HTML_CSS", "shared class cannot be overridden: " + node.name);
          node.name = localHtmlClass(node.name);
        } else if (node.type === "TypeSelector") {
          if (node.name !== "*" && !TAGS.has(node.name)) error("E_HTML_CSS", "unsupported selector");
        } else if (node.type === "Combinator") {
          if (![" ", ">", "+", "~"].includes(node.name)) error("E_HTML_CSS", "unsupported combinator");
        } else if (node.type !== "Selector") error("E_HTML_CSS", "unsupported selector type " + node.type);
      });
      selectors.push(`[data-html-scope="${scope}"] .html-content ${generateCss(selector)}`);
    });
    const declarations = [];
    rule.block.children.forEach((declaration) => {
      const property = declaration.property?.toLowerCase();
      if (declaration.type !== "Declaration" || !(shared ? LAYOUT_PROPERTIES : CSS_PROPERTIES).has(property) || declaration.important) error("E_HTML_CSS", "unsupported declaration " + property);
      let hasVariable = false;
      walkCss(declaration.value, (node) => {
        if (["Url", "Raw", "String", "Atrule"].includes(node.type)) error("E_HTML_CSS", "unsupported value");
        if (node.type === "Function") {
          if (node.name === "var") {
            const args = [...node.children];
            if (args.length !== 1 || args[0].type !== "Identifier" || !(shared ? SPACE_VARIABLES : CSS_VARIABLES).has(args[0].name)) error("E_HTML_CSS", "unsupported variable");
            hasVariable = true;
          } else if (!["minmax", "repeat", "fit-content", "rgb", "rgba", "hsl", "hsla"].includes(node.name)) error("E_HTML_CSS", "unsupported function");
        }
        if (["Number", "Dimension", "Percentage"].includes(node.type)) {
          if (Number(node.value) < 0 || Number(node.value) > 2000) error("E_HTML_CSS", "value outside layout budget");
          if (node.type === "Dimension" && !["px", "em", "rem", "fr"].includes(node.unit)) error("E_HTML_CSS", "unsupported unit");
          if (node.type === "Dimension" && Number(node.value) > 128) error("E_HTML_CSS", "dimension outside layout budget");
          if (node.type === "Percentage" && Number(node.value) > 100) error("E_HTML_CSS", "percentage outside layout budget");
        }
      });
      if (hasVariable && !(shared ? ["gap", "column-gap", "row-gap"] : ["color", "background-color", "border-color", "border", "border-top", "border-bottom", "border-left", "border-right"]).includes(property)) error("E_HTML_CSS", "variable used outside its role");
      if (shared && ["gap", "column-gap", "row-gap"].includes(property) && !/^var\(--reader-space-[123]\)(?: var\(--reader-space-[123]\))?$/.test(generateCss(declaration.value))) error("E_HTML_CSS", "spacing must use shared tokens");
      // Validate the whole value even when it contains an allowed color token.
      const validationValue = hasVariable ? parseCss(generateCss(declaration.value).replace(/var\(--html-(?:text|muted|rule|surface)\)/g, "#000").replace(/var\(--reader-space-[123]\)/g, "1em"), { context: "value" }) : declaration.value;
      if (lexer.matchProperty(property, validationValue).error) error("E_HTML_CSS", "invalid " + property);
      const value = generateCss(declaration.value);
      if (property === "display" && !["block", "inline", "inline-block", "grid", "inline-grid", "flex", "inline-flex", "table", "table-row", "table-cell"].includes(value)) error("E_HTML_CSS", "content-hiding display");
      if (property === "flex-wrap" && !["wrap", "nowrap"].includes(value)) error("E_HTML_CSS", "reversed visual order");
      declarations.push(`${property}:${value}`);
    });
    output.push(selectors.join(",") + "{" + declarations.join(";") + "}");
  });
  if (output.length > 100) error("E_HTML_CSS", "too many rules");
  return output.join("\n");
}

export async function htmlFingerprint(compiled, language = "und", profile = HTML_PROFILE) {
  const input = JSON.stringify([language, "html", profile, compiled.semanticTree]);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return "sha256:" + [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function prepareHtmlBlock(block, language, schema = 2) {
  try {
    if (schema !== 2 || ![HTML_PROFILE, HTML_PROFILE_SHARED].includes(block.html_profile)) error("E_HTML_PROFILE", "unsupported schema/profile");
    const source = parseHtml(block.html);
    const scope = htmlScope(block.id);
    const css = compileHtmlCss(block.css, scope, block.html_profile);
    const fingerprint = await htmlFingerprint(source, block.language || language || "und", block.html_profile);
    const variants = { source }, translationStates = Object.create(null);
    for (const [variant, value] of Object.entries(block.translations || {})) {
      if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(variant) || variant === "source") error("E_HTML_LANG", variant);
      if (!value.html) { translationStates[variant] = "missing"; continue; }
      if ("css" in value) error("E_HTML_CSS", "translation cannot override stylesheet");
      variants[variant] = parseHtml(value.html);
      translationStates[variant] = !value.source_hash ? "unconfirmed" : value.source_hash === fingerprint ? "current" : "stale";
    }
    const mappings = new Map();
    for (const mapping of block.reference_mappings || []) {
      const key = JSON.stringify([mapping.from_revision, mapping.variant, mapping.field, mapping.row ?? null, mapping.column ?? null]);
      if (mappings.has(key) || !Number.isInteger(mapping.from_revision) || !variants[mapping.variant]?.index[mapping.node_id] || typeof mapping.previous_text !== "string" || !["exact", "merged", "reformatted"].includes(mapping.kind)) error("E_HTML_MAPPING", key);
      mappings.set(key, mapping);
    }
    if (block.fallback && !safeHtmlAsset(block.fallback.image)) error("E_HTML_RESOURCE", "invalid fallback image");
    return { ...block, compiledHtml: { source, variants, translationStates, fingerprint, css, scope, mappings } };
  } catch (failure) {
    return { ...block, compiledHtml: { error: failure.message } };
  }
}

export async function prepareReaderDocument(document) {
  if (document.format !== "continous-reader" || !document.meta || !document.blocks?.length) throw new Error("不支持的文档格式");
  const [blocks, compiledTranslationStates] = await Promise.all([
    Promise.all(document.blocks.map((block) => block.type === "html" ? prepareHtmlBlock(block, document.meta?.language, document.schema) : block)),
    standardTranslationStates(document),
  ]);
  return { ...document, blocks, compiledTranslationStates, unsupportedSchema: ![1, 2].includes(document.schema) };
}
