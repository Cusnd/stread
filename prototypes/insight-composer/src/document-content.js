// Offsets always address the stored source string, never KaTeX's presentation DOM.
export function inlineTokens(text) {
  const pattern = /\$([^$\n]+)\$|\[([^\[\]\n]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`/g;
  const result = [];
  function inline(fragment, offset) {
    let cursor = 0;
    for (const match of fragment.matchAll(pattern)) {
      // A link destination can contain balanced parentheses (notably DOI URLs).
      // The regular expression finds its start; consume through its actual end
      // before considering any apparent markup inside the destination.
      if (match.index < cursor) continue;
      let end = match.index + match[0].length, href = match[3];
      if (match[2]) {
        const start = match.index + match[2].length + 3;
        let depth = 0, close = -1;
        for (let index = start; index < fragment.length; index++) {
          const character = fragment[index];
          if (/\s/.test(character)) break;
          if (character === "(") depth++;
          else if (character === ")") {
            if (depth === 0) { close = index; break; }
            depth--;
          }
        }
        if (close < 0 || close === start) continue;
        href = fragment.slice(start, close); end = close + 1;
      }
      if (match.index > cursor) result.push({ kind: "text", start: offset + cursor, end: offset + match.index, text: fragment.slice(cursor, match.index) });
      result.push({ kind: match[1] ? "math" : match[2] ? "link" : match[4] ? "strong" : match[5] ? "em" : "code", start: offset + match.index, end: offset + end, text: match[1] || match[2] || match[4] || match[5] || match[6], href });
      cursor = end;
    }
    if (cursor < fragment.length) result.push({ kind: "text", start: offset + cursor, end: offset + fragment.length, text: fragment.slice(cursor) });
  }
  let cursor = 0;
  for (const match of text.matchAll(/(^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g)) {
    const start = match.index + match[1].length;
    inline(text.slice(cursor, start), cursor);
    const contentStart = start + match[2].length + match[3].length + 1;
    cursor = match.index + match[0].length;
    result.push({ kind: "fenced-code", start, end: cursor, contentStart, contentEnd: contentStart + match[4].length, language: match[3].trim(), text: match[4] });
  }
  inline(text.slice(cursor), cursor);
  return result;
}

export function safeLink(href) {
  return /^(https?:\/\/|#[\w.-]+$)/i.test(href || "") ? href : undefined;
}

export function sourceText(document, source) {
  const block = document.blocks.find((item) => item.id === source.blockId);
  if (!block) return "";
  if (block.type === "html") return block.compiledHtml?.variants?.[source.variant || "source"]?.index[source.nodeId]?.text || "";
  const object = source.itemId ? block.items?.find((item) => item.id === source.itemId) : block;
  if (!object) return "";
  const value = source.variant && source.variant !== "source" ? object.translations?.[source.variant] : object;
  if (!value) return "";
  const field = source.field || (block.type === "math" ? "tex" : "text");
  return field === "head" || field === "rows" ? value[field]?.[source.row]?.[source.column] || "" : value[field] || "";
}

export function sameSource(a, b) {
  return a?.blockId === b?.blockId && (a?.variant || "source") === (b?.variant || "source") && (a?.field || "text") === (b?.field || "text") && a?.itemId === b?.itemId && a?.nodeId === b?.nodeId && a?.row === b?.row && a?.column === b?.column;
}

export function sourceElement(root, source, allowFallback = true) {
  if (!root || !source || source.referenceStatus === "unresolved") return null;
  const elements = [...root.querySelectorAll("[data-block-id]")].filter((node) => node.dataset.blockId === source.blockId);
  if (source.nodeId) {
    const candidates = elements.filter((node) => node.dataset.nodeId === source.nodeId && node.dataset.field === source.field);
    return candidates.find((node) => sameSource(source, sourceDescriptor(node)))
      || candidates.find((node) => node.dataset.sharedVariants?.split(" ").includes(source.variant || "source"))
      || (allowFallback ? candidates[0] : null) || null;
  }
  return elements.find((node) => sameSource(source, sourceDescriptor(node))) || (allowFallback ? elements[0] : null);
}

export function sourceDescriptor(element) {
  const data = element.dataset;
  return { blockId: data.blockId, variant: data.variant || "source", field: data.field || (data.blockType === "math" ? "tex" : "text"),
    ...(data.itemId ? { itemId: data.itemId } : {}),
    ...(data.nodeId ? { nodeId: data.nodeId } : {}),
    ...(data.row !== undefined ? { row: Number(data.row), column: Number(data.column) } : {}),
  };
}

export function normalizeHtmlSource(document, source) {
  const block = document?.blocks.find((item) => item.id === source.blockId);
  if (block?.type !== "html" || source.field === "html_text" || source.referenceStatus === "unresolved") return source;
  const key = JSON.stringify([source.revision, source.variant || "source", source.field, source.row ?? null, source.column ?? null]);
  const mapping = block.compiledHtml?.mappings?.get(key);
  const target = mapping && block.compiledHtml.variants[mapping.variant]?.index[mapping.node_id];
  if (!target || !Number.isInteger(source.start) || !Number.isInteger(source.end) || source.start < 0 || source.end <= source.start || source.end > mapping.previous_text.length || mapping.previous_text.slice(source.start, source.end) !== source.quote) return { ...source, referenceStatus: "unresolved" };
  let start = source.start, end = source.end, quote = source.quote;
  if (mapping.previous_text !== target.text) {
    quote = inlineTokens(quote).map((token) => token.kind === "math" ? "$" + token.text + "$" : token.text).join("").replaceAll(" / ", "\n");
    start = target.text.indexOf(quote); end = start + quote.length;
    if (!quote || start < 0 || target.text.indexOf(quote, start + 1) >= 0) return { ...source, referenceStatus: "unresolved" };
  }
  if (target.text.slice(start, end) !== quote) return { ...source, referenceStatus: "unresolved" };
  const { row, column, itemId, ...rest } = source;
  return { ...rest, revision: document.revision, field: "html_text", nodeId: mapping.node_id, start, end, quote, referenceStatus: mapping.kind,
    previousSource: { revision: source.revision, variant: source.variant || "source", field: source.field, ...(row === undefined ? {} : { row, column }), start: source.start, end: source.end, quote: source.quote } };
}

function sourceOffset(node, offset, end, root) {
  const element = node.nodeType === 1 ? node : node.parentElement;
  const token = element.closest("[data-source-start]");
  if (token && root.contains(token)) {
    const start = Number(token.dataset.sourceStart);
    if (token.dataset.sourceAtomic) return end ? Number(token.dataset.sourceEnd) : start;
    const prefix = document.createRange();
    prefix.selectNodeContents(token);
    prefix.setEnd(node, offset);
    return Math.min(Number(token.dataset.sourceEnd), start + prefix.toString().length);
  }
  if (node.nodeType === 1) {
    const child = node.childNodes[offset - (end ? 1 : 0)];
    if (child) return sourceOffset(child, end ? child.nodeType === 3 ? child.length : child.childNodes.length : 0, end, root);
  }
  return end ? Number(root.dataset.sourceLength) : 0;
}

export function readTextRange(range, element, text) {
  const start = Math.max(0, sourceOffset(range.startContainer, range.startOffset, false, element));
  const end = Math.min(text.length, sourceOffset(range.endContainer, range.endOffset, true, element));
  return { start, end, quote: text.slice(start, end) };
}

export function normalizeMathSource(source, equations) {
  const formula = equations[source.blockId];
  if (!formula) return source;
  if (source.sourceType === "math" && source.quote === formula.tex && source.equationNumber === formula.number && source.field === "tex" && source.start === undefined && source.end === undefined) return source;
  const { start, end, ...rest } = source;
  return { ...rest, variant: "source", field: "tex", sourceType: "math", equationNumber: formula.number, quote: formula.tex };
}
