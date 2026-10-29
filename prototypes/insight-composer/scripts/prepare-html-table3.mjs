import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { inlineTokens } from "../src/document-content.js";
import { HTML_PROFILE, parseHtml, htmlFingerprint, prepareReaderDocument } from "../src/html-content.js";

const article = new URL("../public/articles/attention-is-all-you-need/", import.meta.url);
const evidence = new URL("../evidence/html-table3/", import.meta.url);
const proposal = JSON.parse(await readFile(new URL("../tests/fixtures/table3-proposal.json", import.meta.url), "utf8"));
const originalBytes = await readFile(new URL("document.json", article));
const original = JSON.parse(originalBytes);
assert.equal(createHash("sha256").update(originalBytes).digest("hex"), proposal.source_document.document_sha256, "Re-review the source if the canonical article changed.");
const previous = original.blocks.find((block) => block.id === "S6.T3");
const table = proposal.table;
const escape = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const inline = (text) => inlineTokens(text).map((token) => {
  if (token.kind === "math") return `<span data-tex="${escape(token.text)}"></span>`;
  const value = escape(token.text).replaceAll("\n", "<br>");
  if (token.kind === "link") return `<a href="${escape(token.href)}">${value}</a>`;
  const tag = { strong: "strong", em: "em", code: "code" }[token.kind];
  return tag ? `<${tag}>${value}</${tag}>` : value;
}).join("");

function html(variant) {
  const translated = variant !== "source";
  const value = (cell) => translated ? table.translations[variant].cells[cell.id] : cell.text;
  function cellMarkup(cell) {
    const tag = cell.role === "data" ? "td" : "th";
    const c = table.columns.findIndex((column) => column.id === cell.column_id);
    const classes = [c === 0 ? "group-label" : "", c === 10 ? "metric-start" : "", cell.col_span > 1 ? "prose" : "scalar"].filter(Boolean);
    const attrs = { "data-node-id": cell.id, class: classes.join(" "), ...(cell.scope ? { scope: cell.scope } : {}),
      ...(cell.row_span ? { rowspan: cell.row_span } : {}), ...(cell.col_span ? { colspan: cell.col_span } : {}),
      ...(cell.headers?.length ? { headers: cell.headers.join(" ") } : {}), ...(cell.empty?.kind === "same-as" ? { "data-same-as": cell.empty.ref } : {}) };
    return `<${tag} ${Object.entries(attrs).map(([key, val]) => `${key}="${escape(val)}"`).join(" ")}>${inline(value(cell))}</${tag}>`;
  }
  const caption = translated ? table.translations[variant].caption : table.caption;
  const groups = [];
  for (const row of table.rows) {
    let group = groups.at(-1);
    if (group?.name !== row.group) { group = { name: row.group, rows: [] }; groups.push(group); }
    group.rows.push(row);
  }
  return `<figure><figcaption data-node-id="t3-caption">${inline(caption)}</figcaption><table><thead>${table.head.map((row) => `<tr>${row.cells.map(cellMarkup).join("")}</tr>`).join("")}</thead>`
    + groups.map((group) => `<tbody>${group.rows.map((row, i) => `<tr${i === 0 ? ' class="group-start"' : ""}>${row.cells.map(cellMarkup).join("")}</tr>`).join("")}</tbody>`).join("") + "</table></figure>";
}

const sourceHtml = html("source"), translatedHtml = html("zh-CN");
const nodeIndexes = { source: parseHtml(sourceHtml).index, "zh-CN": parseHtml(translatedHtml).index };
const mappings = [];
function mapping(variant, field, row, column, nodeId, kind = "exact") {
  const old = variant === "source" ? previous : previous.translations[variant];
  const previousText = row === undefined ? old[field] : old[field][row][column];
  if (kind === "exact" && previousText !== nodeIndexes[variant][nodeId].text) kind = "reformatted";
  mappings.push({ from_revision: original.revision, variant, field, ...(row === undefined ? {} : { row, column }), node_id: nodeId, kind,
    previous_text: previousText });
}
for (const variant of ["source", "zh-CN"]) {
  mapping(variant, "caption", undefined, undefined, "t3-caption");
  table.head[0].cells.forEach((cell, column) => mapping(variant, "head", 0, column, cell.id, "reformatted"));
  table.rows.forEach((row, r) => row.cells.forEach((cell) => {
    const column = table.columns.findIndex((item) => item.id === cell.column_id);
    mapping(variant, "rows", r, column, cell.id, cell.row_span > 1 ? "merged" : "exact");
    for (let dr = 1; dr < (cell.row_span || 1); dr++) {
      if (previous.rows[r + dr][column]) mapping(variant, "rows", r + dr, column, cell.id, "merged");
    }
  }));
}
const css = `.group-label { border-right: 1px solid var(--html-rule); }
.metric-start { border-left: 1px solid var(--html-rule); }
.group-start > td, .group-start > th { border-top: 1px solid var(--html-rule); }
.scalar { white-space: nowrap; }
.prose { text-align: left; }`;
const htmlBlock = {
  id: table.id, type: "html", html_profile: HTML_PROFILE, role: "table", num: table.num, language: "en",
  html: sourceHtml, css, source: previous.source,
  fallback: { image: previous.extensions["continous-reader.source-table"].image, alt: "Attention Is All You Need, Table 3, source PDF page 9" },
  reference_mappings: mappings,
  translations: { "zh-CN": { html: translatedHtml, source_hash: await htmlFingerprint(parseHtml(sourceHtml), "en") } },
  extensions: { ...previous.extensions, "continous-reader.source-table": { ...previous.extensions["continous-reader.source-table"], normalization: "HTML preserves verified row/column spans and blank-cell meaning. Source PDF and prior schema-1 document are retained." } },
};
const sample = { ...original, schema: 2, revision: original.revision + 1, blocks: original.blocks.map((block) => block.id === table.id ? htmlBlock : block) };
const prepared = await prepareReaderDocument(sample);
const compiled = prepared.blocks.find((block) => block.id === table.id).compiledHtml;
assert.ok(!compiled.error, compiled.error);
assert.equal(compiled.translationStates["zh-CN"], "current");
assert.equal(compiled.source.scaffold, compiled.variants["zh-CN"].scaffold);
for (const block of original.blocks) if (block.id !== table.id) assert.deepEqual(sample.blocks.find((b) => b.id === block.id), block);
await writeFile(new URL("document.html-sample.json", article), JSON.stringify(sample, null, 2) + "\n");
await mkdir(evidence, { recursive: true });
const report = { result: "PASS", scope: "Fixture structure, source identity and translation fingerprint; browser interaction is checked separately.",
  original_document_sha256: createHash("sha256").update(originalBytes).digest("hex"), document_id: original.id, original_revision: original.revision, sample_revision: sample.revision,
  modified_blocks: [table.id], other_blocks_unchanged: original.blocks.length - 1, body_rows: table.rows.length, columns: table.columns.length,
  nodes_per_variant: Object.keys(compiled.source.index).length, legacy_reference_mappings: mappings.length,
  shared_nodes: Object.keys(compiled.source.index).filter((id) => compiled.source.index[id].semantic === compiled.variants["zh-CN"].index[id].semantic).length,
  translation_state: compiled.translationStates["zh-CN"], source_pdf_page: 9 };
await writeFile(new URL("fixture-check.json", evidence), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
