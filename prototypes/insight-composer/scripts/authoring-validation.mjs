import schema from "../../../services/workspace/authoring-schema.json" with { type: "json" };
import { parseFragment } from "parse5";
import { parse as parseCss, walk as walkCss } from "css-tree";
import { SHARED_HTML_CLASSES } from "../src/html-content.js";
import { inlineTokens } from "../src/document-content.js";

// The downloadable schema is also the executable shape contract. Keep semantic
// checks (HTML, resources, cross-field relationships) in the compiler/validator.
export const authoringSchema = schema;
const GENERATED = new Set(["id", "schema", "revision", "source_hash", "data-node-id", "reference_mappings", "compiledHtml", "offset", "offsets", "start", "end"]);
const ROLES = new Set("abstract reference footnote rights publication author-details ethics table figure algorithm code theorem proof".split(" "));
const RAW_HTML = /<!--|<!doctype\b|<\/?(?:a|abbr|address|article|aside|audio|b|base|bdi|bdo|blockquote|body|br|button|canvas|caption|cite|code|col|colgroup|data|datalist|dd|del|details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hgroup|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|menu|meta|meter|nav|noscript|object|ol|optgroup|option|output|p|picture|pre|progress|q|rp|rt|ruby|s|samp|script|search|section|select|slot|small|source|span|strong|style|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr)(?=[\s/>])[^<>]*>/i;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const childPath = (path, key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
const dereference = (schema) => schema.$ref ? authoringSchema.$defs[schema.$ref.split("/").at(-1)] : schema;
const valueType = (value) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

export function containsRawHtml(value) {
  return inlineTokens(value).some((token) => !["math", "code", "fenced-code"].includes(token.kind) && RAW_HTML.test(token.text));
}

export class AuthoringValidationError extends Error {
  constructor(diagnostics, truncated = false) {
    const first = diagnostics[0];
    super(`${first.code} [${first.key || "$"}] ${first.path}: ${first.message}`);
    this.name = "AuthoringValidationError";
    this.diagnostics = diagnostics;
    this.diagnosticsTruncated = truncated;
  }
}

export function validateAuthoringInput(input) {
  const errors = [], warnings = []; let truncated = false;
  const issue = (list, code, key, path, message, hint, extra = {}) => {
    if (list.length >= 100) { if (list === errors) truncated = true; return; }
    list.push({ code, key: key || "$", path, field: path.split(".").at(-1), message, hint, ...extra });
  };
  const error = (code, key, path, message, hint, extra) => issue(errors, code, key, path, message, hint, extra);
  const warn = (code, key, path, message, hint, extra) => issue(warnings, code, key, path, message, hint, extra);
  function visit(value, rawSchema, path, key) {
    if (errors.length >= 100) { truncated = true; return; }
    const schema = dereference(rawSchema);
    if (schema.oneOf) {
      const variants = schema.oneOf.map(dereference), chosen = variants.find((candidate) => candidate.properties?.type?.const === value?.type);
      if (!chosen) { error("E_AUTHOR_TYPE", key, `${path}.type`, "Unsupported content block type.", "Choose a supported semantic block type.", { allowedValues: variants.map((candidate) => candidate.properties.type.const) }); return; }
      return visit(value, chosen, path, value?.key || key);
    }
    const actual = valueType(value), matches = schema.type === "integer" ? Number.isInteger(value) : schema.type === "number" ? typeof value === "number" && Number.isFinite(value) : schema.type === "object" ? isObject(value) : actual === schema.type;
    if (schema.type && !matches) { error("E_AUTHOR_VALUE", key, path, `Expected ${schema.type}; received ${actual}.`, `Use a JSON ${schema.type}.`); return; }
    if (Object.hasOwn(schema, "const") && value !== schema.const) error("E_AUTHOR_VALUE", key, path, "Unexpected fixed value.", "Use the declared format value.", { allowedValues: [schema.const] });
    if (schema.enum && !schema.enum.includes(value)) error(path.endsWith(".placement") ? "E_AUTHOR_PLACEMENT" : "E_AUTHOR_VALUE", key, path, "Value is not supported.", "Choose one of the supported values.", { allowedValues: schema.enum });
    if (typeof value === "string") {
      if (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength) error("E_AUTHOR_VALUE", key, path, "String length is outside the allowed range.", `Use ${schema.minLength || 0}–${schema.maxLength ?? "unbounded"} characters.`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) error(path.endsWith(".key") ? "E_AUTHOR_KEY" : "E_AUTHOR_VALUE", key, path, "String does not match the required format.", `Match ${schema.pattern}.`);
    }
    if (typeof value === "number" && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) error(path.includes(".source") ? "E_AUTHOR_SOURCE" : "E_AUTHOR_VALUE", key, path, "Number is outside the allowed range.", `Use a value from ${schema.minimum ?? "unbounded"} to ${schema.maximum ?? "unbounded"}.`);
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) error("E_AUTHOR_VALUE", key, path, "Array length is outside the allowed range.", `Use ${schema.minItems || 0}–${schema.maxItems ?? "unbounded"} entries.`);
      if (schema.items) value.forEach((entry, index) => visit(entry, schema.items, `${path}[${index}]`, entry?.key || key));
    }
    if (isObject(value)) {
      for (const required of schema.required || []) if (!Object.hasOwn(value, required)) error("E_AUTHOR_REQUIRED", key, childPath(path, required), "Required field is missing.", `Add ${required} with the documented content.`);
      // Translation payloads must contain content, not just a reviewed flag.
      if (schema.anyOf && !schema.anyOf.some((candidate) => candidate.required.every((name) => Object.hasOwn(value, name)))) error("E_AUTHOR_REQUIRED", key, path, "At least one translated content field is required.", "Omit a missing translation instead of submitting an empty object.", { allowedFields: schema.anyOf.flatMap((candidate) => candidate.required) });
      for (const [name, entry] of Object.entries(value)) {
        const nextPath = childPath(path, name);
        if (schema.propertyNames) visit(name, schema.propertyNames, nextPath, key);
        if (Object.hasOwn(schema.properties || {}, name)) visit(entry, schema.properties[name], nextPath, key);
        else if (schema.additionalProperties === false) {
          const generated = GENERATED.has(name), placement = name === "placement";
          const allowedFields = Object.keys(schema.properties || {}), suggestion = allowedFields.find((field) => editDistance(name, field) <= 2);
          error(generated ? "E_AUTHOR_DERIVED" : placement ? "E_AUTHOR_PLACEMENT" : "E_AUTHOR_FIELD", key, nextPath,
            generated ? "This field is generated by the compiler." : placement ? "Placement belongs to the source block, not its translation." : "Unknown or unsupported authoring field.",
            generated ? "Remove generated fields; use stable author keys." : placement ? "Move placement to the source block." : suggestion ? `Did you mean ${suggestion}?` : "Use a documented field; keep ignorable metadata in extensions.", { allowedFields, ...(suggestion ? { suggestion } : {}) });
        } else if (isObject(schema.additionalProperties)) visit(entry, schema.additionalProperties, nextPath, key);
      }
    }
  }
  visit(input, authoringSchema, "$", input?.key);
  // Structural shape errors are aggregated before semantic inspection, keeping
  // malformed objects away from parser code and preserving actionable paths.
  if (errors.length) throw new AuthoringValidationError(errors, truncated);

  if (input.navigation) {
    const positions = new Map(input.blocks.map((block, index) => [block.key, index])), seen = new Set();
    let previousPosition = -1;
    const inspectLabel = (label, path) => {
      if (!label.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(label) || containsRawHtml(label) || inlineTokens(label).some((token) => token.kind !== "text")) {
        error("E_AUTHOR_NAVIGATION_LABEL", input.key, path, "Navigation labels must be nonblank, single-line plain text.", "Use a short label without HTML, Markdown, formula markup or control characters.");
      }
    };
    input.navigation.items.forEach((item, index) => {
      const path = `$.navigation.items[${index}]`, position = positions.get(item.targetKey);
      if (position === undefined) error("E_AUTHOR_NAVIGATION_TARGET", input.key, `${path}.targetKey`, "Navigation target is not an existing top-level block.", "Use the key of a source block, not a list item or HTML node.");
      else if (seen.has(item.targetKey)) error("E_AUTHOR_NAVIGATION_TARGET", input.key, `${path}.targetKey`, "Navigation targets must be unique.", "Keep one navigation item per target block.");
      else if (position <= previousPosition) error("E_AUTHOR_NAVIGATION_ORDER", input.key, `${path}.targetKey`, "Navigation items must follow source block order.", "Order items by their target blocks without reordering the body.");
      if (position !== undefined) previousPosition = position;
      seen.add(item.targetKey);
      inspectLabel(item.text, `${path}.text`);
      for (const [language, translation] of Object.entries(item.translations || {})) inspectLabel(translation.text, `${path}.translations[${JSON.stringify(language)}].text`);
    });
  }

  function inspectText(value, key, path) {
    if (typeof value === "string" && containsRawHtml(value)) error("E_AUTHOR_RAW_HTML", key, path, "Standard text fields do not render raw HTML.", "Use supported Markdown emphasis/links or a semantic html block. Put literal code in code spans/fences.");
  }
  function inspectContent(value, key, path) {
    for (const field of ["text", "title", "caption", "alt", "image_text"]) if (value[field] !== undefined) inspectText(value[field], key, childPath(path, field));
    for (const field of ["head", "rows"]) value[field]?.forEach((row, r) => row.forEach((cell, c) => inspectText(cell, key, `${path}.${field}[${r}][${c}]`)));
    for (const [language, translation] of Object.entries(value.translations || {})) inspectContent(translation, key, `${path}.translations[${JSON.stringify(language)}]`);
  }
  inspectContent(input.meta, input.key, "$.meta");
  input.blocks.forEach((block, index) => {
    const path = `$.blocks[${index}]`;
    inspectContent(block, block.key, path);
    block.items?.forEach((item, i) => inspectContent(item, item.key, `${path}.items[${i}]`));
    if (block.role && !ROLES.has(block.role)) warn("W_AUTHOR_ROLE", block.key, `${path}.role`, `Semantic role ${JSON.stringify(block.role)} has no reader-specific presentation behavior.`, "Keep it as semantic metadata, or use a documented role/placement/shared layout for presentation.", { knownValues: [...ROLES] });
    if (block.type !== "html") return;
    if (block.html_profile !== undefined) warn("W_AUTHOR_DERIVED_HINT", block.key, `${path}.html_profile`, "The shared HTML profile is assigned by the compiler.", "Omit html_profile from new authoring input.");
    const defined = new Set(), used = new Set();
    try { if (block.css) walkCss(parseCss(block.css), (node) => { if (node.type === "ClassSelector") defined.add(node.name); }); } catch { /* The HTML compiler reports invalid CSS with its exact rule. */ }
    const inspectHtml = (html, htmlPath) => {
      function node(current) {
        for (const attr of current.attrs || []) {
          if (attr.name === "data-node-id") error("E_AUTHOR_DERIVED", block.key, htmlPath, "HTML data-node-id is generated by the compiler.", "Use data-key to identify a text-owning unit.");
          if (attr.name === "class") attr.value.split(/\s+/).filter(Boolean).forEach((name) => used.add(name));
        }
        current.childNodes?.forEach(node);
      }
      node(parseFragment(html));
    };
    inspectHtml(block.html, `${path}.html`);
    Object.entries(block.translations || {}).forEach(([language, value]) => inspectHtml(value.html, `${path}.translations[${JSON.stringify(language)}].html`));
    for (const name of used) if (!SHARED_HTML_CLASSES.has(name) && !defined.has(name)) {
      const suggestion = [...SHARED_HTML_CLASSES].find((known) => editDistance(name, known) <= 2);
      warn("W_AUTHOR_CLASS", block.key, `${path}.html`, `Class ${JSON.stringify(name)} has no shared or object-local CSS definition.`, suggestion ? `Did you mean ${suggestion}?` : "Remove the class or define permitted object-local layout CSS.", { className: name, ...(suggestion ? { suggestion } : {}) });
    }
    for (const name of defined) if (!used.has(name)) warn("W_AUTHOR_CSS_UNUSED", block.key, `${path}.css`, `CSS class ${JSON.stringify(name)} is unused in both source and translation HTML.`, "Remove the unused rule or correct its selector/class.", { className: name });
  });
  if (errors.length) throw new AuthoringValidationError(errors, truncated);
  return { warnings };
}

function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
