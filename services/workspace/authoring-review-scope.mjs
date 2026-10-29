import { parseFragment } from "parse5";
import { canonical, check, hash } from "./errors.mjs";

const blockTypes = new Set(["heading", "para", "list", "math", "figure", "table", "html"]);
const same = (left, right) => canonical(left ?? null) === canonical(right ?? null);
const sorted = (values) => [...new Set(values)].sort();
const resourceContent = (value) => value ? {
  sha256: value.sha256 ?? null, size: value.size ?? null, mediaType: value.mediaType ?? value.media_type ?? null,
} : null;

// Ignore only the compiler's authoring identity envelope and revision counter.
// An unfamiliar document-level field may affect several blocks; changes there
// must not be narrowed to a caller's asserted list of affected paragraphs.
function globalPresentation(document) {
  const { id, revision, meta, blocks, source, navigation, extensions, ...rest } = document;
  const otherExtensions = Object.fromEntries(Object.entries(extensions || {}).filter(([key]) => key !== "continous-reader.authoring"));
  return { ...rest, ...(Object.keys(otherExtensions).length ? { extensions: otherExtensions } : {}) };
}

function blockResources(block, resourcePaths) {
  const paths = new Set();
  let unknown = !blockTypes.has(block.type);
  const add = (value) => { if (typeof value === "string") paths.add(value); };
  if (block.type === "figure") add(block.src);
  add(block.fallback?.image);
  add(block.extensions?.["continous-reader.source-table"]?.image);
  if (block.type === "html") {
    if (typeof block.css === "string" && /url\s*\(/i.test(block.css)) unknown = true;
    // parse5 reads escaped attributes correctly and never executes the fragment.
    for (const html of [block.html, ...Object.values(block.translations || {}).map((value) => value.html)]) {
      if (html === undefined) continue;
      if (typeof html !== "string") { unknown = true; continue; }
      const visit = (node) => {
        const attributes = Object.fromEntries((node.attrs || []).map(({ name, value }) => [name, value]));
        if (node.tagName === "img") add(attributes.src);
        // These are outside the current static profile. Retained older content
        // must not silently be treated as having no asset dependencies.
        if (attributes.srcset || attributes.poster || /url\s*\(/i.test(attributes.style || "")) unknown = true;
        if (attributes.src && node.tagName !== "img") unknown = true;
        node.childNodes?.forEach(visit);
        if (node.content) visit(node.content);
      };
      visit(parseFragment(html));
    }
  }
  // Extensions can retain exact local asset references. Include those consumers
  // without guessing that prose or a generated identity is a resource address.
  const extensionReferences = (value) => {
    if (typeof value === "string") { if (resourcePaths.has(value)) add(value); return; }
    if (Array.isArray(value)) { value.forEach(extensionReferences); return; }
    if (value && typeof value === "object") Object.values(value).forEach(extensionReferences);
  };
  extensionReferences(block.extensions);
  return { paths, unknown };
}

/** Compute review scope from stored content and verified resource bindings only.
 * No authoring/report-provided coverage or requested block list is accepted.
 * The returned scope is frozen inside revisionTarget by prepareAuthoring.
 */
export function deriveAuthoringReviewScope({ baseline = null, candidate, baselineResourceMap = {}, candidateResourceMap = {} }) {
  check(candidate && Array.isArray(candidate.blocks), "VALIDATION_FAILED", "检查范围需要完整候选文档。");
  check(!baseline || Array.isArray(baseline.blocks), "VALIDATION_FAILED", "检查范围需要完整基准文档。");
  const before = new Map((baseline?.blocks || []).map((block) => [block.id, block]));
  const after = new Map(candidate.blocks.map((block) => [block.id, block]));
  check(after.size === candidate.blocks.length && candidate.blocks.every((block) => typeof block.id === "string" && block.id.length),
    "VALIDATION_FAILED", "检查范围需要唯一的已编译内容块身份。");
  const resourcePaths = new Set([...Object.keys(baselineResourceMap), ...Object.keys(candidateResourceMap)]);
  const changedResourcePaths = sorted([...resourcePaths].filter((path) => !same(resourceContent(baselineResourceMap[path]), resourceContent(candidateResourceMap[path]))));
  const changed = new Set(changedResourcePaths);
  const sourcePaths = new Set([baseline?.source?.path, candidate.source?.path].filter((path) => typeof path === "string"));
  const sourceChanged = !same(baseline?.source, candidate.source) || [...sourcePaths].some((path) => changed.has(path));
  const required = new Set(candidate.blocks.filter((block) => !before.has(block.id) || !same(before.get(block.id), block)).map((block) => block.id));
  const removedBlockIds = sorted([...before.keys()].filter((id) => !after.has(id)));
  let full = !baseline || sourceChanged || !same(baseline.meta?.language, candidate.meta?.language)
    || !same(globalPresentation(baseline), globalPresentation(candidate));
  const locatedChanges = new Set([...sourcePaths].filter((path) => changed.has(path)));
  for (const block of [...(baseline?.blocks || []), ...candidate.blocks]) {
    const dependency = blockResources(block, resourcePaths);
    if (dependency.unknown && (changed.size || required.has(block.id) || !after.has(block.id))) full = true;
    for (const path of dependency.paths) if (changed.has(path)) {
      locatedChanges.add(path);
      if (after.has(block.id)) required.add(block.id);
    }
  }
  // A changed resource with no proven consumer may belong to preserved legacy
  // layout/extension data. Expand rather than declaring that change unreviewed.
  if (changedResourcePaths.some((path) => !locatedChanges.has(path))) full = true;
  const scope = {
    kind: full ? "full" : "affected",
    requiredBlockIds: sorted(full ? after.keys() : required),
    removedBlockIds,
    metaChanged: !same(baseline?.meta, candidate.meta),
    navigationChanged: !same(baseline?.navigation, candidate.navigation),
    orderChanged: !same((baseline?.blocks || []).map((block) => block.id), candidate.blocks.map((block) => block.id)),
    changedResourcePaths,
    sourceChanged,
  };
  return { ...scope, scopeHash: hash(canonical(scope)) };
}
