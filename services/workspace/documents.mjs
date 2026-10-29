import { randomUUID } from "node:crypto";
import { parseFragment, serialize } from "parse5";
import katex from "katex";
import { compileAuthoring } from "../../prototypes/insight-composer/scripts/authoring-compiler.mjs";
import { parseHtml, prepareHtmlBlock, safeHtmlAsset, htmlFingerprint } from "../../prototypes/insight-composer/src/html-content.js";
import { inlineTokens } from "../../prototypes/insight-composer/src/document-content.js";
import { check, clone, fail, hash, identifier, object, text, version, WorkspaceError } from "./errors.mjs";

const types = new Set(["heading", "para", "list", "math", "table", "figure", "html"]);
const languagePattern = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const fieldsFor = {
  meta: ["title"], heading: ["text"], para: ["text"], list_item: ["text"],
  table: ["head", "rows", "caption"], figure: ["alt", "caption", "image_text"], math: ["tex"], html: ["html"],
};
const forbiddenTranslationFields = new Set(["id", "type", "source", "origin", "language", "level", "num", "tag", "src", "ordered", "items", "css", "html_profile", "translations", "placement"]);
const stamp = (input) => "sha256:" + hash(JSON.stringify(input));
export function sourceFingerprint(value, kind, language = "und") {
  const values = kind === "table" ? [value.head, value.rows, value.caption ?? null]
    : kind === "figure" ? [value.src, value.alt ?? null, value.caption ?? null, value.image_text ?? null]
      : [value[kind === "math" ? "tex" : kind === "meta" ? "title" : "text"]];
  return stamp([language, kind, ...values]);
}
const translationState = (value, fingerprint) => !value.source_hash ? "unconfirmed" : value.source_hash === fingerprint ? "current" : "stale";
function math(tex, location) {
  text(tex, location, 30000, true);
  try { katex.renderToString(tex, { throwOnError: true, trust: false, strict: "ignore" }); }
  catch (error) { fail("VALIDATION_FAILED", "公式不能正确渲染。", 400, { location, message: error.message }); }
}
export function validateAnswer(raw) {
  const answer = clone(object(raw, "回答"));
  check(Array.isArray(answer.blocks) && answer.blocks.length > 0 && answer.blocks.length <= 500, "VALIDATION_FAILED", "回答需要有效内容块。");
  if (answer.sourceLabel !== undefined) text(answer.sourceLabel, "回答来源", 200);
  for (const block of answer.blocks) {
    object(block, "回答内容块");
    check(["heading", "paragraph", "math"].includes(block.type), "VALIDATION_FAILED", "回答内容块类型无效。");
    if (block.type === "math") math(block.tex, "回答公式"); else text(block.text, "回答文字", 100000, true);
  }
  check(JSON.stringify(answer).length <= 200000, "VALIDATION_FAILED", "回答内容超过限制。");
  return answer;
}
function matrix(value, label, expected) {
  check(Array.isArray(value) && value.length <= 10000, "VALIDATION_FAILED", `${label}必须是表格行数组。`);
  let width;
  value.forEach((row, rowIndex) => {
    check(Array.isArray(row) && row.length > 0 && row.length <= 1000, "VALIDATION_FAILED", `${label}包含无效行。`);
    width ??= row.length;
    check(row.length === width, "VALIDATION_FAILED", `${label}的列数不一致。`);
    row.forEach((cell) => text(cell, label, 100000));
    if (expected) check(row.length === expected[rowIndex]?.length, "VALIDATION_FAILED", `${label}与原表的形状不同。`);
  });
  if (expected) check(value.length === expected.length, "VALIDATION_FAILED", `${label}与原表的行数不同。`);
  return width;
}
function language(value) { check(typeof value === "string" && languagePattern.test(value) && value !== "source", "VALIDATION_FAILED", "语言代码无效。"); }
function sources(block, pageCount) {
  if (block.origin !== undefined) check(["source", "user"].includes(block.origin), "VALIDATION_FAILED", "内容来源标记无效。");
  if (block.origin === "user") check(!block.source?.length, "VALIDATION_FAILED", "用户补充不能填写原文件映射。");
  if (block.source === undefined) return;
  check(Array.isArray(block.source) && block.source.length <= 1000, "VALIDATION_FAILED", "来源位置必须是数组。");
  for (const source of block.source) {
    object(source, "来源位置");
    check(Number.isInteger(source.page) && source.page > 0 && (!pageCount || source.page <= pageCount), "VALIDATION_FAILED", "来源页码超出范围。");
    if (source.box !== undefined) check(Array.isArray(source.box) && source.box.length === 4 && source.box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) && source.box[0] < source.box[2] && source.box[1] < source.box[3], "VALIDATION_FAILED", "来源区域坐标无效。");
  }
}
function inspectText(value, location, internalLinks) {
  text(value, location, 200000);
  for (const token of inlineTokens(value)) {
    if (token.kind === "text") check(!/<\/?(?:script|iframe|style|table|div|img|p|span)(?:\s[^<>]*|\/?)>/i.test(token.text), "VALIDATION_FAILED", "标准文字字段不能包含原始 HTML。", 400, { location });
    if (token.kind === "math") math(token.text, location);
    if (token.kind === "link") {
      check(/^(https?:\/\/[^\s]+|#[A-Za-z0-9][A-Za-z0-9_.:-]*)$/.test(token.href), "VALIDATION_FAILED", "链接格式不受支持。", 400, { location });
      if (token.href.startsWith("#")) internalLinks.push({ location, target: token.href.slice(1) });
    }
  }
}
export async function validateDocument(raw, { resourceMap, pageCount, allowUnsupported = false, allowDanglingLinks = false, knownDanglingLinks = [] } = {}) {
  object(raw, "文档");
  const document = clone(raw);
  check(document.format === "continous-reader", "UNSUPPORTED_FORMAT", "文档格式不受支持。");
  identifier(document.id, "文档 ID"); version(document.revision, "正文版本");
  object(document.meta, "文章信息"); text(document.meta.title, "文章标题", 2000, true);
  if (document.meta.language) language(document.meta.language);
  check(Array.isArray(document.blocks) && document.blocks.length > 0 && document.blocks.length <= 100000, "VALIDATION_FAILED", "文档需要有效正文。");
  const unsupported = ![1, 2].includes(document.schema) || document.blocks.some((b) => !types.has(b?.type));
  check(!unsupported || allowUnsupported, "UNSUPPORTED_FORMAT", "文档含不支持的格式或内容块。");
  const ids = new Set(), assets = new Set(), index = [], internalLinks = [], diagnostics = [];
  const fingerprints = {};
  const addId = (id) => { identifier(id); check(!ids.has(id), "VALIDATION_FAILED", "正文包含重复 ID。", 400, { id }); ids.add(id); };
  const asset = (path) => {
    check(safeHtmlAsset(path), "VALIDATION_FAILED", "资源路径必须位于文档内。", 400, { path }); assets.add(path);
    if (resourceMap) check(Object.hasOwn(resourceMap, path) && resourceMap[path], "RESOURCE_MISSING", "文档引用的资源不存在。", 400, { path });
  };
  if (document.source) {
    object(document.source, "原文件"); asset(document.source.path);
    check(typeof document.source.sha256 === "string" && /^[a-f0-9]{64}$/.test(document.source.sha256), "VALIDATION_FAILED", "原文件缺少有效摘要。");
    if (resourceMap) check(resourceMap[document.source.path].sha256 === document.source.sha256, "SOURCE_HASH_MISMATCH", "原文件与保存的摘要不同。");
  }
  const addText = (block, objectValue, kind, languageValue, field, value, variant = "source", extra = {}, state = "source") => {
    if (field === "tex") math(value, block.id);
    else if (kind === "figure" && field === "alt") text(value, block.id + "." + field, 200000);
    else inspectText(value, block.id + "." + field, internalLinks);
    index.push({ documentId: document.id, revision: document.revision, blockId: block.id, variant, field, ...extra, text: value, language: variant === "source" ? languageValue : variant, translationState: state, origin: block.origin || "source", source: block.source || [] });
  };
  const inspectObject = (block, value, kind, languageValue, extra = {}) => {
    const fingerprint = sourceFingerprint(value, kind, languageValue);
    fingerprints[extra.itemId || block.id] = fingerprint;
    for (const field of fieldsFor[kind]) {
      if (value[field] === undefined) continue;
      if (field === "head" || field === "rows") value[field].forEach((row, rowIndex) => row.forEach((cell, column) => addText(block, value, kind, languageValue, field, cell, "source", { ...extra, row: rowIndex, column })));
      else addText(block, value, kind, languageValue, field, value[field], "source", extra);
    }
    for (const [variant, translated] of Object.entries(value.translations || {})) {
      language(variant); check(variant !== languageValue, "VALIDATION_FAILED", "译文语言不能与原文语言相同。");
      object(translated, "译文");
      for (const key of Object.keys(translated)) check(!forbiddenTranslationFields.has(key), "VALIDATION_FAILED", "译文不能覆盖正文身份、结构或来源。", 400, { key, blockId: block.id });
      if (translated.source_hash !== undefined) check(/^sha256:[a-f0-9]{64}$/.test(translated.source_hash), "VALIDATION_FAILED", "译文来源指纹无效。");
      const state = translationState(translated, fingerprint);
      for (const field of fieldsFor[kind]) {
        if (translated[field] === undefined) continue;
        if (field === "head" || field === "rows") {
          matrix(translated[field], "译文表格", value[field]);
          translated[field].forEach((row, rowIndex) => row.forEach((cell, column) => {
            check(cell.length > 0 || value[field][rowIndex][column] === "", "VALIDATION_FAILED", "译文不能清空非空原表单元格。");
            addText(block, value, kind, languageValue, field, cell, variant, { ...extra, row: rowIndex, column }, state);
          }));
        } else {
          check(typeof translated[field] === "string" && (translated[field].length > 0 || value[field] === ""), "VALIDATION_FAILED", "缺译应省略字段，不能清空原文。");
          addText(block, value, kind, languageValue, field, translated[field], variant, extra, state);
        }
      }
    }
  };
  const metaBlock = { id: "$meta", origin: "source" };
  inspectObject(metaBlock, document.meta, "meta", document.meta.language || "und");
  for (const block of document.blocks) {
    object(block, "内容块"); addId(block.id); sources(block, pageCount);
    if (block.placement !== undefined) check(["frontmatter", "body"].includes(block.placement), "VALIDATION_FAILED", "内容块布局位置只能是 frontmatter 或 body。", 400, { blockId: block.id });
    const sourceLanguage = block.language || document.meta.language || "und";
    if (block.language) language(block.language);
    if (!types.has(block.type) || ![1, 2].includes(document.schema)) continue;
    if (["para", "heading"].includes(block.type)) text(block.text, "正文", 200000);
    if (block.type === "heading") check(Number.isInteger(block.level) && block.level >= 1 && block.level <= 6, "VALIDATION_FAILED", "标题级别必须在 1 到 6 之间。");
    if (block.type === "math") math(block.tex, block.id);
    if (block.type === "table") {
      const headWidth = matrix(block.head, "表头"), bodyWidth = matrix(block.rows, "表格正文");
      const width = bodyWidth || headWidth;
      check(width && (!headWidth || !bodyWidth || headWidth === bodyWidth), "VALIDATION_FAILED", "表格行列不完整。");
      if (block.align !== undefined) check(typeof block.align === "string" && /^[lcr]+$/.test(block.align) && block.align.length === width, "VALIDATION_FAILED", "表格对齐配置无效。");
      if (block.caption_pos !== undefined) check(["above", "below"].includes(block.caption_pos), "VALIDATION_FAILED", "表格题注位置无效。");
    }
    if (block.type === "figure") asset(block.src);
    if (block.fallback?.image) asset(block.fallback.image);
    if (block.extensions?.["continous-reader.source-table"]?.image) asset(block.extensions["continous-reader.source-table"].image);
    if (block.type === "list") {
      check(typeof block.ordered === "boolean" && Array.isArray(block.items) && block.items.length > 0, "VALIDATION_FAILED", "列表结构无效。");
      check(!block.translations, "VALIDATION_FAILED", "列表译文应保存在稳定列表项上。");
      for (const item of block.items) {
        object(item, "列表项"); addId(item.id); text(item.text, "列表项", 200000);
        check(item.origin === undefined || item.origin === (block.origin || "source"), "VALIDATION_FAILED", "列表项必须继承所在块的来源身份。", 400, { blockId: block.id, itemId: item.id });
        sources({ ...item, origin: block.origin || "source" }, pageCount);
        if (item.language) language(item.language);
        inspectObject({ ...block, source: item.source ?? block.source }, item, "list_item", item.language || sourceLanguage, { itemId: item.id });
      }
    } else if (block.type === "html") {
      for (const translated of Object.values(block.translations || {})) {
        object(translated, "译文");
        for (const key of Object.keys(translated)) check(!forbiddenTranslationFields.has(key), "VALIDATION_FAILED", "译文不能覆盖正文身份、结构或来源。", 400, { key, blockId: block.id });
        if (translated.source_hash !== undefined) check(/^sha256:[a-f0-9]{64}$/.test(translated.source_hash), "VALIDATION_FAILED", "译文来源指纹无效。");
      }
      const prepared = await prepareHtmlBlock(block, sourceLanguage, document.schema);
      check(!prepared.compiledHtml.error, "VALIDATION_FAILED", "HTML 内容不符合约定。", 400, { blockId: block.id, message: prepared.compiledHtml.error });
      fingerprints[block.id] = prepared.compiledHtml.fingerprint;
      const variants = prepared.compiledHtml.variants;
      const sourceNodeIds = new Set(Object.keys(variants.source.index));
      for (const nodeId of sourceNodeIds) addId(nodeId);
      for (const [variant, compiled] of Object.entries(variants)) {
        if (variant !== "source") {
          check(variant !== sourceLanguage, "VALIDATION_FAILED", "译文语言不能与原文相同。");
          const translatedIds = Object.keys(compiled.index);
          check(translatedIds.length === sourceNodeIds.size && translatedIds.every((id) => sourceNodeIds.has(id)), "VALIDATION_FAILED", "HTML 原译节点身份不一致。");
        }
        for (const node of Object.values(compiled.index)) index.push({ documentId: document.id, revision: document.revision, blockId: block.id, variant, field: "html_text", nodeId: node.id, text: node.text, language: variant === "source" ? sourceLanguage : variant, translationState: variant === "source" ? "source" : prepared.compiledHtml.translationStates[variant], origin: block.origin || "source", source: block.source || [] });
        const visit = (node) => {
          if (node.kind !== "element") return;
          if (node.tag === "img") asset(node.attrs.src);
          if (node.attrs["data-tex"]) math(node.attrs["data-tex"], block.id);
          if (node.attrs.href?.startsWith("#")) internalLinks.push({ location: block.id, target: node.attrs.href.slice(1) });
          node.children.forEach(visit);
        };
        compiled.tree.forEach(visit);
      }
    } else inspectObject(block, block, block.type, sourceLanguage);
  }
  const danglingLinks = internalLinks.filter((link) => !ids.has(link.target));
  if (!unsupported) for (const link of danglingLinks) check(allowDanglingLinks || knownDanglingLinks.some((known) => known.location === link.location && known.target === link.target), "VALIDATION_FAILED", "正文包含失去目标的内部链接。", 400, link);
  if (danglingLinks.length) diagnostics.push({ code: "LEGACY_LINK_UNRESOLVED", message: `${danglingLinks.length} 个已有内部链接缺少可靠目标，原始内容已保留。` });
  if (unsupported) diagnostics.push({ code: "UNSUPPORTED_FORMAT", message: "内容已保留，当前阅读器按只读方式打开。" });
  return { document, index, fingerprints, assets: [...assets], readOnly: unsupported, report: { status: unsupported ? "read-only" : "valid", diagnostics, danglingLinks, blockCount: document.blocks.length, textEntries: index.length, scope: "Structure, resources, identity and translation provenance. Source fidelity requires independent review." } };
}

export async function compileInput(input, previous = null) {
  let compiled;
  try { compiled = await compileAuthoring(input, previous?.identity || null); }
  catch (error) {
    let diagnostics = error.diagnostics;
    if (!diagnostics) {
      const match = /^(E_[A-Z_]+) \[([^\]]+)\]: (.*)$/s.exec(error.message);
      if (match) {
        const [, code, key, message] = match, index = input?.blocks?.findIndex((block) => block?.key === key);
        const block = index >= 0 ? input.blocks[index] : null;
        const field = code.includes("SOURCE") ? "source" : code.includes("KEY") ? "key" : code.includes("ALIGNMENT") ? "translations" : block?.type === "html" ? "html" : code.includes("MATH") && block?.type === "math" ? "tex" : code.includes("RESOURCE") && block?.type === "figure" ? "src" : undefined;
        diagnostics = [{ code, key, path: index >= 0 ? `$.blocks[${index}]${field ? "." + field : ""}` : "$", ...(field ? { field } : {}), message,
          hint: "Repair the named authoring unit using the field reference, then validate again." }];
      }
    }
    fail("VALIDATION_FAILED", "作者输入不能编译。", 400, { message: error.message, ...(diagnostics ? { diagnostics, diagnosticsTruncated: Boolean(error.diagnosticsTruncated) } : {}) });
  }
  const old = previous?.document;
  const complete = (value, kind, lang, oldValue) => {
    for (const [target, translation] of Object.entries(value.translations || {})) {
      const currentHash = sourceFingerprint(value, kind, lang);
      const oldTranslation = oldValue?.translations?.[target];
      const fields = fieldsFor[kind];
      const same = oldTranslation && fields.every((field) => JSON.stringify(translation[field]) === JSON.stringify(oldTranslation[field]));
      if (same && oldTranslation.source_hash !== currentHash && !translation.reviewed) {
        if (oldTranslation.source_hash) translation.source_hash = oldTranslation.source_hash;
        else delete translation.source_hash;
      } else translation.source_hash = currentHash;
      delete translation.reviewed;
    }
  };
  complete(compiled.document.meta, "meta", compiled.document.meta.language || "und", old?.meta);
  for (const block of compiled.document.blocks) if (block.type === "list") for (const item of block.items) {
    const oldItem = old?.blocks.find((b) => b.id === block.id)?.items?.find((i) => i.id === item.id);
    complete(item, "list_item", item.language || block.language || compiled.document.meta.language || "und", oldItem);
  }
  return { ...compiled, identity: compiled.registry, authoring: clone(input) };
}

function targetObject(document, operation) {
  const block = operation.blockId === "$meta" ? { id: "$meta", type: "meta" } : document.blocks.find((b) => b.id === operation.blockId);
  check(block, "ANCHOR_UNRESOLVED", "没有找到目标内容块。", 409, { blockId: operation.blockId });
  const value = block.type === "meta" ? document.meta : operation.itemId ? block.items?.find((i) => i.id === operation.itemId) : block;
  check(value, "ANCHOR_UNRESOLVED", "没有找到目标列表项。", 409);
  return { block, value, kind: operation.itemId ? "list_item" : block.type, language: value.language || block.language || document.meta.language || "und" };
}
function replaceHtmlNode(html, nodeId, replacement) {
  const fragment = parseFragment(html);
  let match;
  const visit = (node) => {
    if (node.attrs?.some((a) => a.name === "data-node-id" && a.value === nodeId)) { check(!match, "VALIDATION_FAILED", "HTML 节点重复。"); match = node; }
    node.childNodes?.forEach(visit);
  };
  visit(fragment); check(match, "ANCHOR_UNRESOLVED", "HTML 节点不存在。", 409);
  const node = { nodeName: "#text", value: text(replacement, "HTML 节点文字", 120000), parentNode: match };
  match.childNodes = [node];
  return serialize(fragment);
}
function replaceHtmlRange(html, nodeId, start, end, replacement) {
  const indexed = parseHtml(html).index[nodeId];
  check(indexed, "ANCHOR_UNRESOLVED", "HTML 节点不存在。", 409);
  const fragment = parseFragment(html); let owner;
  const find = (node) => { if (node.attrs?.some((a) => a.name === "data-node-id" && a.value === nodeId)) owner = node; node.childNodes?.forEach(find); };
  find(fragment);
  const leaves = [], raw = [];
  const visit = (node) => { if (node.kind === "text") leaves.push(node); node.children?.forEach(visit); }; visit(indexed.ast);
  const visitRaw = (node, pre = false) => { if (node.nodeName === "#text") raw.push({ node, pre }); node.childNodes?.forEach((child) => visitRaw(child, pre || node.tagName === "pre")); }; visitRaw(owner);
  check(leaves.length === raw.length, "VALIDATION_FAILED", "HTML 文字映射不一致。");
  if (!leaves.length && start === 0 && end === 0 && !indexed.text) { owner.childNodes = [{ nodeName: "#text", value: replacement, parentNode: owner }]; return serialize(fragment); }
  const selected = leaves.map((leaf, index) => ({ leaf, index })).filter(({ leaf }) => start === end ? leaf.start <= start && leaf.end >= end : leaf.end > start && leaf.start < end);
  if (start === end && selected.length > 1) selected.splice(1);
  let covered = start;
  for (const { leaf } of selected) { check(leaf.start <= covered, "VALIDATION_FAILED", "范围包含公式或结构分隔，请分别修改两侧文字。"); covered = Math.max(covered, Math.min(end, leaf.end)); }
  check(selected.length && covered === end, "VALIDATION_FAILED", "范围包含公式或结构分隔，请分别修改两侧文字。");
  for (let i = 0; i < selected.length; i++) {
    const { leaf, index } = selected[i], { node, pre } = raw[index], original = node.value, offsets = [0]; let normalized = "";
    for (let at = 0; at < original.length;) {
      if (!pre && /[\t\r\n\f ]/.test(original[at])) { do { at++; } while (at < original.length && /[\t\r\n\f ]/.test(original[at])); normalized += " "; }
      else normalized += original[at++];
      offsets.push(at);
    }
    check(normalized === leaf.text, "VALIDATION_FAILED", "HTML 文字映射不一致。");
    const from = offsets[Math.max(0, start - leaf.start)], to = offsets[Math.min(leaf.text.length, end - leaf.start)];
    node.value = original.slice(0, from) + (i === 0 ? replacement : "") + original.slice(to);
  }
  const updated = serialize(fragment);
  check(parseHtml(updated).index[nodeId].text === indexed.text.slice(0, start) + replacement + indexed.text.slice(end), "VALIDATION_FAILED", "替换文字改变了 HTML 空白语义，请使用显示文字的精确范围。");
  return updated;
}
export async function applyOperations(original, operations) {
  check(Array.isArray(operations) && operations.length > 0 && operations.length <= 100, "VALIDATION_FAILED", "修订需要 1 到 100 项明确操作。");
  const document = clone(original), changes = [];
  for (let [operationIndex, operation] of operations.entries()) {
    const submittedOperation = operation;
    try {
    object(operation, "修订操作");
    const rangeOperation = operation.kind === "replace_range" ? clone(operation) : null;
    const recordReplace = (before) => changes.push(rangeOperation ? { ...rangeOperation, before: rangeOperation.expectedText, after: rangeOperation.value } : { ...clone(operation), before, after: operation.value });
    if (operation.kind === "replace_range") {
      const { value, kind } = targetObject(document, operation), variant = operation.variant || "source";
      const target = variant === "source" ? value : value.translations?.[variant];
      check(target, "ANCHOR_UNRESOLVED", "该语言没有可修订的文字。", 409);
      const before = operation.field === "html_text" && kind === "html" ? parseHtml(target.html || "").index[operation.nodeId]?.text
        : ["head", "rows"].includes(operation.field) ? target[operation.field]?.[operation.row]?.[operation.column] : target[operation.field];
      check(typeof before === "string" && operation.field !== "html", "VALIDATION_FAILED", "范围修订需要精确文字字段或 HTML 文字节点。");
      const { start, end, expectedText } = operation;
      check(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= before.length, "VALIDATION_FAILED", "字符范围无效（使用 UTF-16 偏移）。");
      const boundary = (at) => at === 0 || at === before.length || !(before.charCodeAt(at - 1) >= 0xd800 && before.charCodeAt(at - 1) <= 0xdbff && before.charCodeAt(at) >= 0xdc00 && before.charCodeAt(at) <= 0xdfff);
      check(boundary(start) && boundary(end), "VALIDATION_FAILED", "字符范围不能截断 Unicode 字符。");
      check(typeof expectedText === "string" && before.slice(start, end) === expectedText, "TEXT_CONFLICT", "目标文字与预期不一致，请重新读取局部上下文。", 409);
      text(operation.value, "替换文字", 200000);
      operation = { ...operation, kind: "replace", value: before.slice(0, start) + operation.value + before.slice(end) };
    }
    if (operation.kind === "replace") {
      const { block, value, kind, language: sourceLanguage } = targetObject(document, operation);
      const variant = operation.variant || "source";
      check(fieldsFor[kind]?.includes(operation.field) || (kind === "html" && operation.field === "html_text"), "VALIDATION_FAILED", "此字段不可局部修改。");
      let objectValue = value;
      if (variant !== "source") {
        language(variant);
        const fingerprint = kind === "html" ? await htmlFingerprint(parseHtml(block.html), sourceLanguage, block.html_profile) : sourceFingerprint(value, kind, sourceLanguage);
        check(operation.sourceHash === fingerprint, "SOURCE_HASH_MISMATCH", "译文依据的原文已改变，请重新读取。", 409, { sourceHash: fingerprint });
        objectValue = ((value.translations ||= {})[variant] ||= {});
        objectValue.source_hash = fingerprint;
      }
      if (operation.field === "html_text") {
        identifier(operation.nodeId, "HTML 节点 ID");
        check(typeof objectValue.html === "string", "ANCHOR_UNRESOLVED", "该语言没有可修订的 HTML。", 409);
        const before = parseHtml(objectValue.html).index[operation.nodeId]?.text;
        objectValue.html = rangeOperation ? replaceHtmlRange(objectValue.html, operation.nodeId, rangeOperation.start, rangeOperation.end, rangeOperation.value) : replaceHtmlNode(objectValue.html, operation.nodeId, operation.value);
        recordReplace(before);
      } else if (["head", "rows"].includes(operation.field) && operation.row !== undefined) {
        check(Number.isInteger(operation.row) && Number.isInteger(operation.column) && operation.row >= 0 && operation.column >= 0, "VALIDATION_FAILED", "单元格位置无效。");
        check(typeof objectValue[operation.field]?.[operation.row]?.[operation.column] === "string", "ANCHOR_UNRESOLVED", "单元格不存在。", 409);
        const before = objectValue[operation.field][operation.row][operation.column];
        objectValue[operation.field][operation.row][operation.column] = text(operation.value, "单元格文字", 100000);
        recordReplace(before);
      } else {
        const before = clone(objectValue[operation.field]);
        objectValue[operation.field] = clone(operation.value);
        recordReplace(before);
      }
    } else if (operation.kind === "insert") {
      object(operation.block, "补充内容");
      check((operation.block.source === undefined || Array.isArray(operation.block.source) && operation.block.source.length === 0) && (!operation.block.origin || operation.block.origin === "user"), "VALIDATION_FAILED", "补充内容不能冒充原文。");
      const block = { ...clone(operation.block), id: "b-" + randomUUID(), origin: "user", language: operation.block.language || "und" };
      delete block.source;
      if (block.type === "list") { check(Array.isArray(block.items), "VALIDATION_FAILED", "补充列表需要有效列表项。"); block.items = block.items.map((item) => ({ ...item, id: "i-" + randomUUID() })); }
      const anchor = operation.beforeBlockId || operation.afterBlockId;
      check(Boolean(operation.beforeBlockId) !== Boolean(operation.afterBlockId), "VALIDATION_FAILED", "补充必须指定一个插入位置。");
      const position = document.blocks.findIndex((b) => b.id === anchor);
      check(position >= 0, "ANCHOR_UNRESOLVED", "插入位置不存在。", 409);
      document.blocks.splice(position + (operation.afterBlockId ? 1 : 0), 0, block);
      changes.push({ kind: "insert", blockId: block.id, before: null, after: block });
    } else if (operation.kind === "remove") {
      const position = document.blocks.findIndex((b) => b.id === operation.blockId);
      check(position >= 0, "ANCHOR_UNRESOLVED", "删除目标不存在。", 409);
      const [before] = document.blocks.splice(position, 1); changes.push({ kind: "remove", blockId: before.id, before, after: null });
    } else if (operation.kind === "move") {
      check(Boolean(operation.beforeBlockId) !== Boolean(operation.afterBlockId), "VALIDATION_FAILED", "移动必须指定一个位置。");
      const position = document.blocks.findIndex((b) => b.id === operation.blockId), anchor = operation.beforeBlockId || operation.afterBlockId;
      check(position >= 0 && anchor !== operation.blockId && document.blocks.some((b) => b.id === anchor), "ANCHOR_UNRESOLVED", "移动目标无效。", 409);
      const [block] = document.blocks.splice(position, 1), target = document.blocks.findIndex((b) => b.id === anchor);
      document.blocks.splice(target + (operation.afterBlockId ? 1 : 0), 0, block);
      changes.push({ ...clone(operation), before: position, after: target + (operation.afterBlockId ? 1 : 0) });
    } else fail("VALIDATION_FAILED", "不支持的正文修订操作。");
    } catch (error) {
      if (error instanceof WorkspaceError) {
        const keys = { blockId: "block_id", field: "field", variant: "variant", itemId: "item_id", nodeId: "node_id", row: "row", column: "column" };
        const target = Object.fromEntries(Object.entries(keys).flatMap(([key, wireKey]) => {
          const value = submittedOperation?.[key];
          return typeof value === "string" ? [[wireKey, value.slice(0, 160)]] : Number.isSafeInteger(value) ? [[wireKey, value]] : [];
        }));
        error.details = { ...error.details, operation_index: operationIndex,
          ...(typeof submittedOperation?.kind === "string" ? { operation_kind: submittedOperation.kind.slice(0, 32) } : {}), target };
      }
      throw error;
    }
  }
  // Only maintain the recognized, source-ordered target list. Unknown legacy
  // navigation remains lossless; retained revisions keep their original list.
  const navigation = document.navigation, oldPositions = new Map(original.blocks.map((block, index) => [block.id, index]));
  if (changes.some((change) => change.kind === "remove" || change.kind === "move") && navigation?.kind === "auxiliary" && Array.isArray(navigation.items)
    && Object.keys(navigation).every((key) => ["kind", "items"].includes(key))
    && navigation.items.every((item, index, items) => item && typeof item.targetId === "string" && oldPositions.has(item.targetId)
      && Object.keys(item).every((key) => ["targetId", "text", "level", "translations"].includes(key))
      && (index === 0 || oldPositions.get(items[index - 1].targetId) < oldPositions.get(item.targetId)))) {
    const positions = new Map(document.blocks.map((block, index) => [block.id, index]));
    navigation.items = navigation.items.filter((item) => positions.has(item.targetId)).sort((a, b) => positions.get(a.targetId) - positions.get(b.targetId));
    if (!navigation.items.length) delete document.navigation;
  }
  document.revision = original.revision + 1;
  return { document, changes };
}

export function resolveSource(index, source, { allowUnresolved = false } = {}) {
  if (!source.blockId) return { ...source };
  const field = source.field || "text", variant = source.variant || "source";
  const matches = index.filter((entry) => entry.blockId === source.blockId && entry.variant === variant && entry.field === field && (source.itemId === undefined || entry.itemId === source.itemId) && (source.nodeId === undefined || entry.nodeId === source.nodeId) && (source.row === undefined || (entry.row === source.row && entry.column === source.column)));
  const target = matches.length === 1 ? matches[0] : undefined;
  const invalidRange = source.start !== undefined && (!Number.isInteger(source.start) || !Number.isInteger(source.end) || source.start < 0 || source.end < source.start || source.end > (target?.text.length ?? 0) || (source.quote !== undefined && target?.text.slice(source.start, source.end) !== source.quote));
  const quoteMismatch = source.quote && source.start === undefined && target && !target.text.includes(source.quote);
  if (!target || invalidRange || quoteMismatch) {
    check(allowUnresolved, "ANCHOR_UNRESOLVED", "原文位置或摘录已失效，请重新选择。", 409);
    return { ...source, referenceStatus: "unresolved" };
  }
  return { ...source, variant, field, referenceStatus: "exact" };
}
