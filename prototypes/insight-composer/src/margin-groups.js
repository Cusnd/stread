import { sourceDescriptor } from "./document-content.js";
import { isHighlightOnly } from "./insight-content.js";

const objectTypes = new Set(["table", "figure", "math"]);
const compareText = (a, b) => String(a || "") < String(b || "") ? -1 : String(a || "") > String(b || "") ? 1 : 0;
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const fieldOf = (source) => source.field || (source.sourceType === "math" ? "tex" : "text");

// Variant and offsets are deliberately absent: they address a stored selection,
// while this key identifies its logical reading unit. The note itself is retained.
function sourceKey(source) {
  return JSON.stringify([source.blockId, fieldOf(source), source.itemId || null, source.nodeId || null, source.row ?? null, source.column ?? null]);
}

function documentContext(paper) {
  const blocks = new Map(), htmlTables = new Map(), sourceOrder = new Map();
  for (const [blockOrder, block] of (paper?.blocks || []).entries()) {
    blocks.set(block.id, { block, order: blockOrder });
    let ordinal = 0;
    const addSource = (source) => sourceOrder.set(sourceKey({ blockId: block.id, ...source }), ordinal++);
    if (block.type === "list") block.items?.forEach((item) => addSource({ field: "text", itemId: item.id }));
    if (block.type === "table") {
      if (block.caption_pos === "above") addSource({ field: "caption" });
      for (const field of ["head", "rows"]) block[field]?.forEach((row, r) => row.forEach((_, column) => addSource({ field, row: r, column })));
      if (block.caption_pos !== "above") addSource({ field: "caption" });
    }
    if (block.type === "html") {
      const walk = (node, path, tablePath = null) => {
        if (node.kind === "text") return;
        const owner = node.tag === "table" ? path : tablePath;
        if (node.nodeId) {
          addSource({ field: "html_text", nodeId: node.nodeId });
          if (owner !== null) htmlTables.set(JSON.stringify([block.id, node.nodeId]), owner);
        }
        node.children?.forEach((child, index) => walk(child, `${path}.${index}`, owner));
      };
      block.compiledHtml?.source?.tree?.forEach((node, index) => walk(node, String(index)));
    }
  }
  return { blocks, htmlTables, sourceOrder };
}

function keyFor(source, context) {
  const type = context.blocks.get(source.blockId)?.block.type;
  if (objectTypes.has(type)) return JSON.stringify([source.blockId, "object", type]);
  const tablePath = context.htmlTables.get(JSON.stringify([source.blockId, source.nodeId]));
  if (tablePath !== undefined) return JSON.stringify([source.blockId, "html-table", tablePath]);
  return sourceKey(source);
}

export function marginGroupKey(source, paper) {
  return source?.blockId ? keyFor(source, documentContext(paper)) : null;
}

function compareNotes(a, b, context) {
  const sourceA = sourceKey(a), sourceB = sourceKey(b);
  return finite(context.sourceOrder.get(sourceA)) - finite(context.sourceOrder.get(sourceB))
    || compareText(sourceA, sourceB)
    || Number((a.variant || "source") !== "source") - Number((b.variant || "source") !== "source")
    || compareText(a.variant || "source", b.variant || "source")
    || finite(a.start) - finite(b.start)
    || finite(a.end) - finite(b.end)
    || compareText(a.createdAt, b.createdAt)
    || compareText(a.id, b.id);
}

export function buildMarginGroups(notes, paper) {
  const context = documentContext(paper), groups = new Map();
  for (const note of notes || []) {
    if (!note?.blockId || note.referenceStatus === "unresolved" || note.archivedAt || note.deletedAt || isHighlightOnly(note)) continue;
    const key = keyFor(note, context);
    if (!groups.has(key)) groups.set(key, { key, source: note, notes: [], order: context.blocks.get(note.blockId)?.order ?? Infinity });
    groups.get(key).notes.push(note);
  }
  return [...groups.values()].map((group) => {
    group.notes.sort((a, b) => compareNotes(a, b, context));
    group.source = group.notes[0];
    return group;
  }).sort((a, b) => a.order - b.order || compareNotes(a.source, b.source, context) || compareText(a.key, b.key));
}

// This function is the only DOM boundary. It measures exact rendered addresses,
// never sourceElement's block fallback. Table/figure/math envelopes are explicit
// authored objects; a HTML block's unrelated natural paragraphs remain separate.
export function measureMarginSources(articleRoot, paper) {
  if (!articleRoot) return [];
  const context = documentContext(paper), result = [];
  for (const [order, element] of [...articleRoot.querySelectorAll("[data-block-id]")].entries()) {
    if (!element.getClientRects().length || element.closest("details:not([open])")) continue;
    const source = sourceDescriptor(element);
    const type = context.blocks.get(source.blockId)?.block.type;
    const htmlTable = context.htmlTables.has(JSON.stringify([source.blockId, source.nodeId]));
    const object = objectTypes.has(type) ? element.closest("[data-article-block]") : htmlTable ? element.closest("table") : null;
    const rect = (object || element).getBoundingClientRect();
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || rect.bottom <= rect.top) continue;
    result.push({ key: keyFor(source, context), source, exactSourceKey: sourceKey(source), top: rect.top, bottom: rect.bottom, order });
  }
  return result;
}

export function layoutMarginGroups(groups, measuredSources, options = {}) {
  const {
    railTop = 0, maxHeight = 380, headerHeight = 28, rowHeight = 96,
    footerHeight = 28, gap = 12, maxPreview = 3, compactHeight = 32,
    topInset = 3, bottomInset = 3, compactThreshold = 160,
  } = options;
  const envelopes = new Map();
  for (const item of measuredSources || []) {
    if (!item?.key || !Number.isFinite(item.top) || !Number.isFinite(item.bottom) || item.bottom <= item.top) continue;
    const exact = item.exactSourceKey || (item.source?.blockId ? sourceKey(item.source) : null);
    const current = envelopes.get(item.key);
    if (current) {
      current.top = Math.min(current.top, item.top); current.bottom = Math.max(current.bottom, item.bottom);
      current.order = Math.min(current.order, finite(item.order, Infinity));
      if (exact) current.exactKeys.add(exact);
    } else envelopes.set(item.key, { top: item.top, bottom: item.bottom, order: finite(item.order, Infinity), exactKeys: new Set(exact ? [exact] : []) });
  }
  const layouts = [];
  for (const group of groups || []) {
    const source = envelopes.get(group.key);
    if (!source) continue;
    const notes = group.notes.filter((note) => source.exactKeys.has(sourceKey(note)));
    if (!notes.length) continue;
    const available = Math.max(0, Math.min(finite(maxHeight, 380), source.bottom - source.top - topInset - bottomInset));
    if (available <= 0) continue;
    const capacity = Math.min(3, Math.max(0, Math.floor((available - headerHeight - footerHeight + gap) / Math.max(1, rowHeight + gap))), Math.max(0, maxPreview), notes.length);
    const compact = available < compactThreshold || capacity === 0;
    const previewCount = compact ? 0 : capacity;
    const naturalHeight = compact ? compactHeight : headerHeight + footerHeight + previewCount * rowHeight + Math.max(0, previewCount - 1) * gap;
    layouts.push({ ...group, notes, source: notes[0], top: source.top - railTop + topInset,
      height: Math.min(available, naturalHeight), previewCount, compact,
      sourceTop: source.top, sourceBottom: source.bottom, order: source.order,
      sourceOverlap: false, overlapCompact: false, laneIndex: 0, laneCount: 1 });
  }
  layouts.sort((a, b) => a.sourceTop - b.sourceTop || a.order - b.order || compareText(a.key, b.key));
  // Parallel authored columns still have independent identities. Only actual
  // margin collisions, not broad bilingual/source envelopes, require compact
  // entries. Detect against the original bounds before shortening any entry.
  const collisions = new Set();
  for (let i = 0; i < layouts.length; i++) {
    for (let j = i + 1; j < layouts.length && layouts[j].sourceTop < layouts[i].sourceBottom; j++) {
      layouts[i].sourceOverlap = true; layouts[j].sourceOverlap = true;
      if (layouts[j].top < layouts[i].top + layouts[i].height) { collisions.add(i); collisions.add(j); }
    }
  }
  for (const index of collisions) {
    const item = layouts[index];
    item.compact = true; item.previewCount = 0; item.overlapCompact = true;
    item.height = Math.min(item.height, compactHeight);
  }

  // Assign horizontal lanes to connected clusters of the remaining real
  // rectangles. Every member of a cluster uses the same denominator, avoiding
  // a partial-width group overlapping a later full-width entry. No top moves.
  let cluster = [], clusterBottom = -Infinity;
  const finishCluster = () => {
    cluster.forEach((item, laneIndex) => { item.laneIndex = laneIndex; item.laneCount = cluster.length; });
  };
  for (const item of layouts) {
    if (item.top >= clusterBottom) { finishCluster(); cluster = []; clusterBottom = -Infinity; }
    cluster.push(item); clusterBottom = Math.max(clusterBottom, item.top + item.height);
  }
  finishCluster();
  return layouts;
}
