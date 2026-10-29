import { parseFragment, serialize } from "parse5";
import { canonical, check, clone, hash, identifier, object, version } from "./errors.mjs";
import { compileInput, resolveSource, validateDocument } from "./documents.mjs";

const clean = (value) => JSON.parse(JSON.stringify(value));
const digest = (value) => hash(canonical(clean(value)));
const compilerDigest = (value) => hash(JSON.stringify(value));
const attr = (node, name) => node.attrs?.find((entry) => entry.name === name);
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function authoringRevisionTarget(value) {
  object(value, "修订目标");
  for (const key of Object.keys(value)) check(["documentId", "baseRevision", "baseHash"].includes(key), "VALIDATION_FAILED", "修订目标含未知字段。", 400, { field: `target.${key}` });
  identifier(value.documentId, "修订文档"); version(value.baseRevision, "修订基准版本");
  check(typeof value.baseHash === "string" && /^[a-f0-9]{64}$/.test(value.baseHash), "VALIDATION_FAILED", "修订基准需要当前编辑包的正文摘要。");
  return { documentId: value.documentId, baseRevision: value.baseRevision, baseHash: value.baseHash };
}

function semanticDocument(document) {
  const result = clean(document);
  delete result.revision;
  if (result.extensions) {
    delete result.extensions["continous-reader.authoring"];
    if (!Object.keys(result.extensions).length) delete result.extensions;
  }
  const html = (value) => {
    const root = parseFragment(value);
    const visit = (node) => { node.attrs?.sort((a, b) => a.name.localeCompare(b.name)); node.childNodes?.forEach(visit); };
    visit(root); return serialize(root);
  };
  for (const block of result.blocks) if (block.type === "html") {
    block.html = html(block.html);
    for (const translated of Object.values(block.translations || {})) translated.html = html(translated.html);
  }
  return result;
}

function authorHtml(value, known = new Map()) {
  const root = parseFragment(value), nodes = [];
  const visit = (node) => {
    const identity = attr(node, "data-node-id");
    if (identity) {
      const id = identity.value, key = known.get(id) || (keyPattern.test(id) ? id : "node-" + hash(id).slice(0, 24));
      identity.name = "data-key"; identity.value = key; nodes.push({ id, key });
    }
    node.childNodes?.forEach(visit);
  };
  visit(root); return { html: serialize(root), nodes };
}

function translations(value) {
  const result = clone(value);
  for (const translation of Object.values(result.translations || {})) delete translation.source_hash;
  return result;
}

/** A candidate deletion is not retirement of an already published identity.
 * These merged objects are compiler history only; only submitted authoring is
 * emitted. Candidate entries win, and the immutable base fills deleted keys.
 */
export function authoringRevisionPrevious(editing, baselineDocument, previous, authoring) {
  const baseline = { identity: editing.identity, document: baselineDocument };
  if (!previous) return baseline;
  const identity = clone(previous.identity), document = clone(previous.document);
  identity.blocks = { ...clone(baseline.identity.blocks), ...identity.blocks };
  const inputs = new Map(authoring.blocks.map((block) => [block.key, block]));
  for (const [key, base] of Object.entries(baseline.identity.blocks)) {
    const current = previous.identity.blocks[key];
    if (!current) continue;
    const next = identity.blocks[key];
    if (base.items || current.items) next.items = { ...clone(base.items || {}), ...clone(current.items || {}) };
    if (base.nodes || current.nodes) {
      next.nodes = clone(current.nodes || []);
      const ids = new Set(next.nodes.map((node) => node.id)), keys = new Set(next.nodes.filter((node) => node.key).map((node) => node.key));
      for (const node of base.nodes || []) if (!ids.has(node.id) && (!node.key || !keys.has(node.key))) next.nodes.push(clone(node));
    }
    // Reintroducing an unchanged base translation does not review its source.
    // Prefer an identical newer candidate translation when one exists.
    for (const [language, value] of Object.entries(inputs.get(key)?.translations || {})) {
      const inputHash = compilerDigest(value);
      if (current.translationInputs?.[language] !== inputHash && base.translationInputs?.[language] === inputHash) {
        (next.translationInputs ||= {})[language] = inputHash;
        (next.translationHashes ||= {})[language] = base.translationHashes?.[language];
      }
    }
  }
  const previousBlocks = new Map(document.blocks.map((block) => [block.id, block]));
  for (const block of baseline.document.blocks) {
    const current = previousBlocks.get(block.id);
    if (!current) document.blocks.push(clone(block));
    else if (block.type === "list" && current.type === "list") {
      const ids = new Set(current.items.map((item) => item.id));
      for (const item of block.items) if (!ids.has(item.id)) current.items.push(clone(item));
    }
  }
  const preserveTranslationHistory = (current, base, requested) => {
    if (!current || !base || !requested?.translations) return;
    for (const [language, value] of Object.entries(requested.translations)) {
      const content = (translation) => { if (!translation) return null; const result = clone(translation); delete result.source_hash; delete result.reviewed; return result; };
      if (!value.reviewed && canonical(content(value)) !== canonical(content(current.translations?.[language])) && canonical(content(value)) === canonical(content(base.translations?.[language]))) {
        (current.translations ||= {})[language] = clone(base.translations[language]);
      }
    }
  };
  preserveTranslationHistory(document.meta, baseline.document.meta, authoring.meta);
  const currentById = new Map(document.blocks.map((block) => [block.id, block])), baseById = new Map(baseline.document.blocks.map((block) => [block.id, block]));
  for (const [key, registry] of Object.entries(identity.blocks)) {
    const current = currentById.get(registry.id), base = baseById.get(registry.id), requested = inputs.get(key);
    if (current?.type !== "list" || base?.type !== "list" || requested?.type !== "list") continue;
    const currentItems = new Map(current.items.map((item) => [item.id, item])), baseItems = new Map(base.items.map((item) => [item.id, item]));
    for (const item of requested.items) {
      const id = registry.items[item.key];
      preserveTranslationHistory(currentItems.get(id), baseItems.get(id), item);
    }
  }
  return { identity, document };
}

/** Export the saved revision itself, never the potentially older authoring file. */
export async function createAuthoringEditPackage(saved) {
  const document = saved.document;
  check(!saved.readOnly && document.schema === 2, "EDITING_EXPORT_UNSUPPORTED", "此版本暂不能无损导出作者输入；原文未改变。", 409, { documentId: document.id, revision: document.revision });
  const oldRegistry = saved.identity || {}, oldBlocks = new Map(Object.entries(oldRegistry.blocks || {}).map(([key, value]) => [value.id, { key, ...value }]));
  const key = oldRegistry.key || document.extensions?.["continous-reader.authoring"]?.key || (keyPattern.test(document.id) ? document.id : "document-" + hash(document.id).slice(0, 24));
  const authoring = { format: "reader-authoring-1", key, meta: translations(document.meta), ...(document.source ? { source: clone(document.source) } : {}), blocks: [], ...(document.extensions ? { extensions: clone(document.extensions) } : {}) };
  if (authoring.extensions) { delete authoring.extensions["continous-reader.authoring"]; if (!Object.keys(authoring.extensions).length) delete authoring.extensions; }
  const identity = { version: 1, key, documentId: document.id, revision: document.revision, blocks: {} }, usedKeys = new Set();
  for (const original of document.blocks) {
    const old = oldBlocks.get(original.id), baseKey = old?.key || (keyPattern.test(original.id) ? original.id : "block-" + hash(original.id).slice(0, 24));
    check(!usedKeys.has(baseKey), "EDITING_EXPORT_UNSUPPORTED", "当前版本的作者身份存在冲突，不能无损导出。", 409, { blockId: original.id }); usedKeys.add(baseKey);
    const block = translations(original); delete block.id; block.key = baseKey;
    const record = { id: original.id, translationInputs: {}, translationHashes: {} };
    if (block.type === "list") {
      const oldItems = new Map(Object.entries(old?.items || {}).map(([itemKey, id]) => [id, itemKey])); record.items = {};
      block.items = original.items.map((item) => {
        const value = translations(item), itemKey = oldItems.get(item.id) || (keyPattern.test(item.id) ? item.id : "item-" + hash(item.id).slice(0, 24));
        delete value.id; value.key = itemKey; record.items[itemKey] = item.id; return value;
      });
    }
    if (block.type === "html") {
      const known = new Map((old?.nodes || []).filter((node) => node.key).map((node) => [node.id, node.key]));
      const source = authorHtml(block.html, known); block.html = source.html; record.nodes = source.nodes;
      const nodeKeys = new Map(source.nodes.map((node) => [node.id, node.key]));
      for (const translated of Object.values(block.translations || {})) translated.html = authorHtml(translated.html, nodeKeys).html;
    }
    for (const [language, translated] of Object.entries(block.translations || {})) {
      record.translationInputs[language] = compilerDigest(translated); record.translationHashes[language] = original.translations[language].source_hash;
    }
    record.inputHash = compilerDigest(block); identity.blocks[baseKey] = record; authoring.blocks.push(block);
  }
  if (Object.hasOwn(document, "navigation")) {
    const blockKeys = new Map(Object.entries(identity.blocks).map(([blockKey, record]) => [record.id, blockKey]));
    check(document.navigation?.kind === "auxiliary" && Array.isArray(document.navigation.items), "EDITING_EXPORT_UNSUPPORTED", "当前导航结构不能无损导出作者输入；原文未改变。", 409);
    authoring.navigation = { ...clone(document.navigation), items: document.navigation.items.map((item) => {
      check(item && typeof item === "object" && blockKeys.has(item.targetId), "EDITING_EXPORT_UNSUPPORTED", "当前导航目标不存在，不能无损导出作者输入；原文未改变。", 409);
      const { targetId, ...fields } = clone(item); return { ...fields, targetKey: blockKeys.get(targetId) };
    }) };
  }
  identity.inputHash = compilerDigest(authoring);
  check(Buffer.byteLength(JSON.stringify(authoring)) <= 16 * 1024 * 1024, "EDITING_EXPORT_UNSUPPORTED", "当前作者输入超出 16 MiB 修订上传上限；请使用有界精确修订。", 409, { documentId: document.id, revision: document.revision });
  let compiled;
  try { compiled = await compileInput(authoring, { identity, document }); }
  catch (error) { check(false, "EDITING_EXPORT_UNSUPPORTED", "当前版本含不能无损转回作者输入的结构；请保留原文并使用精确修订。", 409, { cause: error.code, diagnostics: error.details?.diagnostics || [], message: error.message }); }
  const validated = await validateDocument(compiled.document, { resourceMap: saved.resourceMap, knownDanglingLinks: saved.report?.danglingLinks || [] });
  check(canonical(semanticDocument(validated.document)) === canonical(semanticDocument(document)) && canonical(validated.fingerprints) === canonical(saved.fingerprints),
    "EDITING_EXPORT_UNSUPPORTED", "作者输入往返检查未保留全部当前内容、身份或翻译来源；原文未改变。", 409, { documentId: document.id, revision: document.revision });
  const resources = clone(saved.resourceMap || {}), resourceBindings = Object.fromEntries(Object.entries(resources).map(([path, file]) => [path, file.id]));
  check(Object.values(resourceBindings).every((id) => typeof id === "string" && id.length), "EDITING_EXPORT_UNSUPPORTED", "当前版本的资源缺少可复用的已上传文件身份。", 409);
  return { format: "reader-editing-package-1", complete: true, base: { documentId: document.id, revision: document.revision, documentHash: digest(document), identityHash: digest(saved.identity || null) },
    authoring, identity: compiled.identity, document: clone(document), resources, resourceBindings,
    historicalAuthoring: { available: Boolean(saved.authoring), revision: saved.report?.authoringSubmission?.documentRevision ?? null, matchesDocumentRevision: saved.report?.authoringSubmission?.documentRevision === document.revision },
    verification: { roundTrip: "semantic-and-identity-equivalent", sourceFingerprintsPreserved: true, scope: "Exact current revision; authoring and generated identities are separate." } };
}

export function editingPackageDescriptor(pkg) {
  const bytes = JSON.stringify(pkg), { documentId, revision } = pkg.base;
  return { documentId, revision, mode: "editing", complete: true, base: pkg.base, format: pkg.format, sha256: hash(bytes), size: Buffer.byteLength(bytes), requiresAuthorization: true,
    artifacts: [{ kind: "editing", filename: "editing.json", mediaType: "application/json", url: `/api/documents/${encodeURIComponent(documentId)}/authoring/editing.json?revision=${revision}`, sha256: hash(bytes), size: Buffer.byteLength(bytes) }],
    historicalAuthoring: pkg.historicalAuthoring, verification: pkg.verification };
}

const identities = (saved) => new Set([...saved.document.blocks.flatMap((block) => [block.id, ...(block.items || []).map((item) => item.id)]), ...saved.index.filter((entry) => entry.nodeId).map((entry) => entry.nodeId)]);
const address = (entry) => canonical([entry.blockId, entry.itemId || null, entry.nodeId || null, entry.variant || "source", entry.field || "text", entry.row ?? null, entry.column ?? null]);

export function revisionImpact(saved, candidate) {
  const before = identities(saved), after = identities(candidate), oldText = new Map(saved.index.map((entry) => [address(entry), entry.text]));
  const nextText = new Map(candidate.index.map((entry) => [address(entry), entry.text])), affectedBlocks = new Set();
  if (canonical(saved.document.meta) !== canonical(candidate.document.meta)) affectedBlocks.add("$meta");
  for (const entry of saved.index) if (!nextText.has(address(entry)) || nextText.get(address(entry)) !== entry.text) affectedBlocks.add(entry.blockId);
  for (const entry of candidate.index) if (!oldText.has(address(entry)) || oldText.get(address(entry)) !== entry.text) affectedBlocks.add(entry.blockId);
  const candidates = new Map(candidate.document.blocks.map((block) => [block.id, block]));
  for (const block of saved.document.blocks) if (!candidates.has(block.id) || canonical(block) !== canonical(candidates.get(block.id))) affectedBlocks.add(block.id);
  return { retainedIdentityCount: [...before].filter((id) => after.has(id)).length, added: [...after].filter((id) => !before.has(id)), removed: [...before].filter((id) => !after.has(id)), affectedBlocks: [...affectedBlocks].sort(), referencePolicy: "Keep original historical revision and exact source; never guess a new positional anchor." };
}

/** Only referenced objects affected by this candidate participate in the guard. */
export async function revisionReferenceGuard(reads, documentId, impact, candidateIndex = []) {
  const affected = new Set(impact.affectedBlocks), references = [];
  const sourceObjects = (value, inherited = {}) => {
    if (!value || typeof value !== "object") return [];
    const current = { ...inherited, ...(value.documentId ? { documentId: value.documentId } : {}), ...(value.revision ? { revision: value.revision } : {}) }, found = [];
    if (value.blockId && affected.has(value.blockId) && (!current.documentId || current.documentId === documentId)) found.push({ ...current, ...value });
    for (const [key, child] of Object.entries(value)) if (["source", "sources", "evidence", "position"].includes(key)) for (const item of Array.isArray(child) ? child : [child]) found.push(...sourceObjects(item, current));
    return found;
  };
  for (const table of ["insights", "change_requests", "document_relations"]) {
    for (const row of await reads.all(`SELECT * FROM ${table} WHERE document_id=? ORDER BY id`, documentId)) {
      const value = JSON.parse(row.payload), sources = sourceObjects(value, { documentId });
      if (!sources.length) continue;
      const entries = sources.map((source) => {
        const exact = Object.fromEntries(["documentId", "revision", "blockId", "itemId", "nodeId", "field", "variant", "row", "column", "start", "end", "quote"].filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
        let candidateReferenceStatus = "resolved";
        try { resolveSource(candidateIndex, exact); } catch { candidateReferenceStatus = "unresolved"; }
        return { source: exact, candidateReferenceStatus, historicalReferencePreserved: true };
      });
      references.push({ entity: table, id: row.id, version: row.version, references: entries });
    }
  }
  const guardHash = digest(references.map(({ entity, id, version, references: entries }) => ({ entity, id, version, sources: entries.map((entry) => entry.source) })));
  return { hash: guardHash, references };
}
