import { z } from "zod";
import { check, hash } from "./errors.mjs";
import { parseHtml } from "../../prototypes/insight-composer/src/html-content.js";

export const READING_PROJECTION_VERSION = "reader-reading-1";
export const MAX_READING_CHARS = 6000;
export const MAX_READING_ITEMS = 32;
// Includes both compatibility text and structuredContent, not just body text.
export const MAX_READING_RESPONSE_BYTES = 64 * 1024;
const id = z.string().min(1).max(160), revision = z.number().int().min(1), position = z.number().int().min(0);
const budget = z.number().int().min(100).max(MAX_READING_CHARS).default(2000);
const exact = z.object({
  view: z.literal("exact").optional(), reference: z.string().max(64).optional(), document_id: id.optional(), block_id: id.optional(), revision: revision.optional(), source_index: position.default(0),
  node_id: id.optional(), item_id: id.optional(), variant: z.string().max(64).optional(), field: z.string().max(64).optional(), row: position.optional(), column: position.optional(),
  start: position.optional(), entry_offset: position.default(0), before_chars: z.number().int().min(0).max(1500).default(300), max_chars: budget,
}).strict();
const reading = { document_id: id, revision: revision.optional(), variant: z.string().min(1).max(64).default("source"), cursor: z.string().min(1).max(2048).optional(), max_chars: budget };
export const readContextInput = z.union([
  exact,
  z.object({ view: z.literal("outline"), ...reading }).strict(),
  z.object({ view: z.literal("content"), ...reading, section_id: z.string().min(1).max(192).optional(), block_id: id.optional() }).strict(),
]).meta({ type: "object" });
export const READ_CONTEXT_DESCRIPTION = "Read exact source text (view omitted or exact), or view=outline/content for bounded continuous reading. outline returns actual headings and an untitled preamble; each section ends at the next heading, including child headings. content crosses blocks, optionally from block_id or within section_id. Follow next unchanged: it pins revision, language and projection version. Text has a shared UTF-16 budget (default 2000, max 6000), plus item/wire limits. Spans map projected text to exact addresses; unavailable images/translations/structures are explicit. Exact supports Q/N/R, cells and HTML nodes. Projections are read-only and are not replacement documents; reread an exact target and check current revision before editing.";

const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
const address = (entry) => pick(entry, ["blockId", "field", "itemId", "nodeId", "row", "column"]);
const safe = (text, at) => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]) ? at - 1 : at;
const clipped = (text, count) => String(text ?? "").slice(0, safe(String(text ?? ""), count));
const key = (entry) => JSON.stringify(address(entry));
export const readingResponseBytes = (value) => Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }), "utf8");

function structuralMetadata(block) {
  const result = { kind: typeof block.type === "string" ? clipped(block.type, 128) : "unsupported" };
  // Stored revisions preserve unknown extension fields. Only these validated
  // primitive values belong to the reading projection; never recurse into an
  // extension object under a familiar field name (including URL-shaped data).
  if (block.type === "heading" && Number.isInteger(block.level) && block.level >= 1 && block.level <= 6) result.level = block.level;
  if (block.type === "list" && typeof block.ordered === "boolean") result.ordered = block.ordered;
  if (["frontmatter", "body"].includes(block.placement)) result.placement = block.placement;
  for (const name of ["role", "num", "tag"]) {
    const value = block[name];
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) continue;
    result[name] = clipped(value, 128);
    if (String(value).length > result[name].length) result.metadataTruncated = true;
  }
  return result;
}

function encodeCursor(value) {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return body + "." + hash(body).slice(0, 24);
}
function decodeCursor(cursor) {
  try {
    const [body, checksum, extra] = cursor.split(".");
    check(!extra && checksum === hash(body).slice(0, 24), "INVALID_CURSOR", "阅读游标已损坏，请重新读取所需范围。");
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const parsed = z.object({ p: z.literal(READING_PROJECTION_VERSION), d: id, r: revision, v: z.string().min(1).max(64), w: z.enum(["outline", "content"]), s: z.string().max(192).nullable(), b: id.nullable(), i: position, o: position }).strict().safeParse(value);
    check(parsed.success, "INVALID_CURSOR", "阅读游标版本或字段无效，请重新读取所需范围。");
    return parsed.data;
  } catch (error) {
    if (error.code === "INVALID_CURSOR") throw error;
    check(false, "INVALID_CURSOR", "阅读游标无法解析，请重新读取所需范围。");
  }
}

function sections(document, variant) {
  const result = [];
  document.blocks.forEach((block, index) => {
    if (index === 0 && block.type !== "heading") result.push({ sectionId: "preamble", title: "", level: 0, startBlock: 0, language: variant === "source" ? document.meta.language || "und" : variant, status: "available" });
    if (block.type === "heading") {
      const text = variant === "source" ? block.text : block.translations?.[variant]?.text;
      result.push({ sectionId: "heading:" + block.id, blockId: block.id, title: text ?? "", level: block.level, startBlock: index, language: variant === "source" ? block.language || document.meta.language || "und" : variant, status: text === undefined ? "unavailable" : "available" });
    }
  });
  return result.map((section, i) => ({ ...section, endBlock: result[i + 1]?.startBlock ?? document.blocks.length }));
}

// Preserve semantic HTML relationships without returning HTML/CSS or pretending
// that images were read. Text offsets still refer to the existing node index.
function htmlMetadata(block, variant) {
  const html = variant === "source" ? block.html : block.translations?.[variant]?.html;
  if (!html) return new Map();
  const parsed = parseHtml(html), result = new Map(), tables = [];
  result.images = [];
  const walk = (node, ancestors = []) => {
    if (node.kind !== "element") return;
    if (node.tag === "table") tables.push(node);
    if (node.tag === "img") result.images.push({ path: node.attrs.src, altAvailable: Boolean(node.attrs.alt) });
    if (node.nodeId) {
      const links = [], images = [];
      const inspect = (child) => {
        if (child.kind !== "element") return;
        if (child.tag === "a") links.push(child.attrs.href);
        if (child.tag === "img") images.push({ path: child.attrs.src, altAvailable: Boolean(child.attrs.alt), status: "unavailable", reason: "image_bytes_not_read" });
        child.children.forEach(inspect);
      };
      inspect(node);
      const table = [...ancestors].reverse().find((parent) => parent.tag === "table"), row = ancestors.findLast((parent) => parent.tag === "tr"), group = ancestors.findLast((parent) => ["thead", "tbody", "tfoot"].includes(parent.tag)), list = ancestors.findLast((parent) => ["ul", "ol"].includes(parent.tag));
      const attrs = pick(node.attrs, ["rowspan", "colspan", "scope", "headers", "data-same-as"]);
      result.set(node.nodeId, { tag: node.tag, ...Object.fromEntries(Object.entries(attrs).map(([name, value]) => [name, clipped(value, 600)])), attributesTruncated: Object.values(attrs).some((value) => value.length > 600),
        ...(list ? { list: { ordered: list.tag === "ol", start: Number(list.attrs.start || 1), ...(node.attrs.value !== undefined ? { value: Number(node.attrs.value) } : {}) } } : {}),
        ...(table ? { tableIndex: tables.indexOf(table), tableStructure: "html", ...(group ? { group: group.tag } : {}),
          ...(row && group ? { groupIndex: table.children.filter((child) => ["thead", "tbody", "tfoot"].includes(child.tag)).indexOf(group), row: group.children.filter((child) => child.tag === "tr").indexOf(row), cell: row.children.filter((child) => ["th", "td"].includes(child.tag)).indexOf(node) } : {}),
          ...(node.attrs.headers ? {} : { headerAssociation: "not_explicit" }) } : {}),
        ...(links.length ? { links: links.slice(0, 6).map((href) => clipped(href, 400)), linkCount: links.length, linksTruncated: links.length > 6 || links.some((href) => href.length > 400) } : {}),
        ...(images.length ? { images: images.slice(0, 2), imageCount: images.length, imagesTruncated: images.length > 2 } : {}) });
    }
    node.children.forEach((child) => walk(child, [...ancestors, node]));
  };
  parsed.tree.forEach((node) => walk(node));
  return result;
}

function units(saved, variant, startBlock, endBlock) {
  const grouped = new Map();
  for (const entry of saved.index) {
    if (!grouped.has(entry.blockId)) grouped.set(entry.blockId, []);
    grouped.get(entry.blockId).push(entry);
  }
  const result = [];
  for (let blockIndex = startBlock; blockIndex < endBlock; blockIndex++) {
    const block = saved.document.blocks[blockIndex], entries = grouped.get(block.id) || [], source = entries.filter((entry) => entry.variant === "source"), selected = entries.filter((entry) => entry.variant === variant);
    const translated = new Map(selected.map((entry) => [key(entry), entry]));
    let html = null, unsupportedHtml = false;
    if (block.type === "html" && entries.length) {
      try { html = htmlMetadata(block, variant); }
      catch { unsupportedHtml = true; }
    }
    const structural = structuralMetadata(block);
    const add = (entry, absent = false) => {
      const item = block.items?.find((value) => value.id === entry.itemId);
      result.push({ text: absent ? "" : entry.text, address: address(entry), blockIndex, ...structural,
        status: absent ? "unavailable" : "available", ...(absent ? { reason: "translation_missing" } : {}), language: absent ? variant : entry.language,
        translationState: absent ? "missing" : entry.translationState, origin: entry.origin,
        sourceHash: saved.fingerprints[entry.itemId || block.id],
        ...(typeof item?.num === "string" || typeof item?.num === "number" && Number.isFinite(item.num) ? { num: clipped(item.num, 128), ...(String(item.num).length > 128 ? { metadataTruncated: true } : {}) } : {}),
        ...(block.type === "table" ? { table: { headerRows: block.head?.length || 0, bodyRows: block.rows?.length || 0, columns: block.head?.[0]?.length || block.rows?.[0]?.length || 0 } } : {}),
        ...(html?.has(entry.nodeId) ? { html: html.get(entry.nodeId) } : {}) });
    };
    const seen = new Set();
    for (const entry of source) { const match = translated.get(key(entry)); add(match || entry, !match); seen.add(key(entry)); }
    for (const entry of selected) if (!seen.has(key(entry))) add(entry);
    if (!source.length && !selected.length) result.push({ text: "", address: { blockId: block.id }, blockIndex, ...structural, status: "unsupported", reason: "no_indexed_text" });
    if (unsupportedHtml) result.push({ text: "", address: { blockId: block.id }, blockIndex, kind: "html", status: "unsupported", reason: "html_semantics_unavailable" });
    if (block.type === "figure") result.push({ text: "", address: { blockId: block.id }, blockIndex, kind: "image", path: clipped(block.src, 500), status: "unavailable", reason: "image_bytes_not_read" });
    for (const image of html?.images || []) result.push({ text: "", address: { blockId: block.id }, blockIndex, kind: "image", ...image, status: "unavailable", reason: "image_bytes_not_read" });
  }
  return result;
}

export async function readDocumentProjection(workspace, raw) {
  const input = readContextInput.parse(raw);
  check(input.view === "outline" || input.view === "content", "VALIDATION_FAILED", "此读取需要 outline 或 content 分支。");
  check(!(input.section_id && input.block_id), "VALIDATION_FAILED", "章节与起始内容块只能选择一项。");
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (cursor) check(cursor.d === input.document_id && cursor.v === input.variant && cursor.w === input.view && cursor.s === (input.section_id ?? null) && cursor.b === (input.block_id ?? null) && (input.revision === undefined || cursor.r === input.revision), "CURSOR_MISMATCH", "阅读游标的文档、版本、语言或范围不匹配。");
  const saved = await workspace.revision(input.document_id, cursor?.r ?? input.revision), document = saved.document;
  check(!cursor || cursor.r === document.revision, "CURSOR_MISMATCH", "游标指定的正文版本不可用。");
  const variants = [...new Set(["source", ...saved.index.map((entry) => entry.variant)])];
  const outline = sections(document, input.variant), common = { view: input.view, documentId: document.id, revision: document.revision,
    currentRevision: (await workspace.row(document.id)).current_revision, variant: input.variant, projectionVersion: READING_PROJECTION_VERSION,
    readOnlyProjection: true, contentScope: "blocks", metadataIncluded: false, sectionPolicy: "heading_to_next_heading", variants: variants.slice(0, 32), variantCount: variants.length, variantsTruncated: variants.length > 32, variantAvailable: variants.includes(input.variant),
    offsetUnit: "UTF-16", maxChars: input.max_chars, maxItems: MAX_READING_ITEMS, maxResponseBytes: MAX_READING_RESPONSE_BYTES };
  const continuation = (index, offset) => ({ view: input.view, document_id: document.id, revision: document.revision, variant: input.variant,
    ...(input.section_id ? { section_id: input.section_id } : {}), ...(input.block_id ? { block_id: input.block_id } : {}), max_chars: input.max_chars,
    cursor: encodeCursor({ p: READING_PROJECTION_VERSION, d: document.id, r: document.revision, v: input.variant, w: input.view, s: input.section_id ?? null, b: input.block_id ?? null, i: index, o: offset }) });
  let i = cursor?.i ?? 0, offset = cursor?.o ?? 0;
  if (input.view === "outline") {
    check(i <= outline.length && offset === 0, "INVALID_CURSOR", "目录游标超出范围。");
    const returned = []; let chars = 0;
    while (i < outline.length && returned.length < MAX_READING_ITEMS) {
      const section = outline[i], title = clipped(section.title, Math.min(240, input.max_chars - chars));
      if (section.title && !title) break;
      returned.push({ ...section, title, titleChars: section.title.length, titleTruncated: title.length < section.title.length, blockCount: section.endBlock - section.startBlock });
      chars += title.length; i++;
      if (chars >= input.max_chars) break;
    }
    const next = i < outline.length ? continuation(i, 0) : null;
    const result = { ...common, sections: returned, returnedChars: chars, coverage: { contentScope: "blocks", metadataIncluded: false, start: cursor?.i ?? 0, end: i, total: outline.length, complete: !next }, next, ...(next ? { nextTool: "read_context" } : {}) };
    check(readingResponseBytes(result) <= MAX_READING_RESPONSE_BYTES, "READING_LIMIT", "目录结果超过响应预算。");
    return result;
  }
  let startBlock = 0, endBlock = document.blocks.length;
  if (input.section_id) {
    const section = outline.find((entry) => entry.sectionId === input.section_id);
    check(section, "SECTION_NOT_FOUND", "章节不存在，请读取此版本的目录。");
    ({ startBlock, endBlock } = section);
  } else if (input.block_id) {
    startBlock = document.blocks.findIndex((block) => block.id === input.block_id);
    check(startBlock >= 0, "ANCHOR_UNRESOLVED", "起始内容块不存在，请读取目录。");
  }
  const all = units(saved, input.variant, startBlock, endBlock);
  const unavailableEntries = all.filter((entry) => entry.status === "unavailable").length, unsupportedEntries = all.filter((entry) => entry.status === "unsupported").length,
    incompleteSemanticsEntries = all.filter((entry) => entry.metadataTruncated || entry.html?.linksTruncated || entry.html?.attributesTruncated || entry.html?.imagesTruncated).length;
  check(i <= all.length && (i < all.length ? offset <= all[i].text.length && safe(all[i].text, offset) === offset : offset === 0), "INVALID_CURSOR", "正文游标的顺序或文字偏移无效。");
  const initial = { entry: i, offset }, spans = []; let text = "";
  const finish = () => {
    const next = i < all.length ? continuation(i, offset) : null;
    return { ...common, text, spans, returnedChars: text.length,
      coverage: { scope: input.section_id ? "section" : input.block_id ? "from_block" : "document", contentScope: "blocks", metadataIncluded: false, ...(input.section_id ? { sectionId: input.section_id } : {}), startBlock, endBlock, totalBlocks: document.blocks.length,
        from: initial, to: { entry: i, offset }, totalEntries: all.length, complete: !next,
        documentTraversed: !next && startBlock === 0 && endBlock === document.blocks.length,
        documentComplete: !next && startBlock === 0 && endBlock === document.blocks.length && unavailableEntries === 0 && unsupportedEntries === 0 && incompleteSemanticsEntries === 0,
        contentComplete: !next && unavailableEntries === 0 && unsupportedEntries === 0 && incompleteSemanticsEntries === 0, unavailableEntries, unsupportedEntries, incompleteSemanticsEntries,
        unreadEntries: all.length - i }, next, ...(next ? { nextTool: "read_context" } : {}) };
  };
  while (i < all.length && spans.length < MAX_READING_ITEMS) {
    const entry = all[i], separator = text && entry.text.length ? "\n\n" : "", remaining = input.max_chars - text.length - separator.length;
    if (entry.text.length > offset && remaining <= 0) break;
    const end = safe(entry.text, Math.min(entry.text.length, offset + Math.max(0, remaining)));
    if (end === offset && offset < entry.text.length) break;
    const before = { text, i, offset }, { text: original, ...metadata } = entry;
    const textStart = text.length + separator.length;
    text += separator + original.slice(offset, end);
    spans.push({ ...metadata, textStart, textEnd: text.length, sourceStart: offset, sourceEnd: end, totalChars: original.length, truncated: offset > 0 || end < original.length });
    if (end < original.length) offset = end; else { i++; offset = 0; }
    if (readingResponseBytes(finish()) > MAX_READING_RESPONSE_BYTES) {
      spans.pop(); ({ text, i, offset } = before);
      check(spans.length > 0, "READING_LIMIT", "单个来源映射超过响应预算，请使用精确读取。");
      break;
    }
    if (text.length >= input.max_chars) break;
  }
  return finish();
}
