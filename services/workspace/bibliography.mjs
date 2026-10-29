import { inlineTokens } from "../../prototypes/insight-composer/src/document-content.js";
import { parseHtml } from "../../prototypes/insight-composer/src/html-content.js";

const EXTENSION = "continous-reader.bibliography";
const plain = (value = "") => inlineTokens(String(value)).map((token) => token.text).join("");
const clean = (value) => typeof value === "string" ? value.trim() : "";
const array = (value) => Array.isArray(value) ? value : [];
const unique = (values) => [...new Set(values.filter(Boolean))];
export const normalizeTitle = (value = "") => plain(value).normalize("NFKD").replace(/\p{M}/gu, "").replace(/[Łł]/g, "l").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function normalizeDoi(value) {
  let result = clean(value).replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)/i, "");
  try { result = decodeURIComponent(result); } catch { /* Keep a literal, malformed escape as non-matching data. */ }
  result = result.replace(/[.,;:*]+$/g, "");
  while (result.endsWith(")") && (result.match(/\(/g)?.length || 0) < (result.match(/\)/g)?.length || 0)) result = result.slice(0, -1);
  result = result.replace(/[\]}]+$/g, "");
  return /^10\.\d{4,9}\/[^\s<>"#]+$/i.test(result) ? result.toLowerCase() : undefined;
}

export function normalizeArxiv(value) {
  const result = clean(value).replace(/^(?:https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/|arxiv\s*:\s*|abs\/)/i, "")
    .replace(/\.pdf$/i, "").replace(/[.,;]+$/, "");
  const match = /^((?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7}))(?:v([1-9]\d*))?$/i.exec(result);
  return match ? { arxiv: match[1].toLowerCase(), ...(match[2] ? { arxivVersion: Number(match[2]) } : {}) } : {};
}

export function bibliographicIdentifiers(value = "", supplied = {}) {
  const input = typeof value === "string" ? value : "";
  const dois = unique([normalizeDoi(supplied.doi), ...[...input.matchAll(/(?:https?:\/\/(?:dx\.)?doi\.org\/|\bdoi\s*:\s*)?(10\.\d{4,9}\/[^\s<>"\u00a0]+)/gi)].map((match) => normalizeDoi(match[1]))]);
  const arxivValues = [normalizeArxiv(supplied.arxiv), ...array(supplied.arxivVersions).filter((version) => Number.isInteger(version) && version > 0).map((version) => ({ ...normalizeArxiv(supplied.arxiv), arxivVersion: version })), ...[...input.matchAll(/(?:https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/|\barxiv\s*:\s*|\babs\/)((?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v[1-9]\d*)?)/gi)].map((match) => normalizeArxiv(match[1]))].filter((item) => item.arxiv);
  const arxivs = unique(arxivValues.map((item) => item.arxiv));
  const result = {};
  if (dois.length === 1) result.doi = dois[0];
  if (arxivs.length === 1) {
    result.arxiv = arxivs[0];
    const versions = unique(arxivValues.map((item) => item.arxivVersion));
    if (versions.length === 1) result.arxivVersion = versions[0];
    else if (versions.length > 1) result.arxivVersions = versions;
    else if (Number.isInteger(supplied.arxivVersion) && supplied.arxivVersion > 0) result.arxivVersion = supplied.arxivVersion;
  }
  return { identifiers: result, conflicts: [...(dois.length > 1 ? [{ field: "doi", values: dois }] : []), ...(arxivs.length > 1 ? [{ field: "arxiv", values: arxivs }] : [])] };
}

function yearFrom(value, last = false) {
  if (Number.isInteger(value) && value >= 1500 && value <= 2199) return value;
  // Identifiers and page spans contain convincing four-digit numbers too.
  // Keep an ISO publication date's year before removing page-like ranges.
  const input = String(value || "").replace(/https?:\/\/\S+|(?:doi\s*:\s*)?10\.\d{4,9}\/\S+/gi, " ")
    .replace(/(?:arxiv\s*:\s*|abs\/)?(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v[1-9]\d*)?/gi, " ")
    .replace(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})-\d{2}-\d{2}\b/g, "$1 ")
    .replace(/\b(?:pages?|pp?)\.?\s*\d+(?:\s*[-–—]\s*\d+)?/gi, " ")
    .replace(/\b\d{1,6}\s*[-–—]\s*\d{1,6}\b/g, " ")
    .replace(/\b\d+\s*\(\d+\)\s*:\s*\d+/g, " ");
  const years = [...input.matchAll(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/g)].map((match) => Number(match[1]));
  return last ? years.at(-1) : years[0];
}
const authorText = (value) => typeof value === "string" ? value : Array.isArray(value) ? value.map((item) => typeof item === "string" ? item : item?.name).filter(Boolean).join(", ") : "";

/** Document identity deliberately never scans body paragraphs or reference lists. */
export function documentIdentity(input) {
  const document = input?.document || input || {};
  const meta = document.meta || {}, extensions = document.extensions || {};
  const declared = extensions[EXTENSION]?.work || {};
  const provenance = extensions["continous-reader.provenance"] || {};
  const presentation = extensions["continous-reader.presentation"] || {};
  const conversion = extensions["continous-reader.conversion"] || {};
  const metadataText = [meta.date, presentation.publication, provenance.arxiv, provenance.doi, provenance.url,
    meta.doi, meta.identifiers?.doi, meta.arxiv ? "arXiv:" + meta.arxiv : "", meta.identifiers?.arxiv ? "arXiv:" + meta.identifiers.arxiv : "",
    // An extraction URL is only useful when it is an actual arXiv paper URL.
    /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|html|pdf)\//i.test(conversion.html_aid || "") ? conversion.html_aid : "",
    document.source?.url,
    ...array(document.blocks).filter((block) => block.role === "publication").map((block) => block.text)].filter((value) => typeof value === "string").join("\n");
  const parsed = bibliographicIdentifiers(metadataText, { doi: meta.doi || meta.identifiers?.doi || provenance.doi,
    arxiv: meta.arxiv || meta.identifiers?.arxiv || provenance.arxiv, ...declared.identifiers });
  return {
    documentId: document.id, title: clean(declared.title) || clean(meta.title), authors: authorText(declared.authors) || authorText(meta.authors),
    year: yearFrom(declared.year) || yearFrom(meta.year) || yearFrom(meta.date) || yearFrom(presentation.publication), identifiers: parsed.identifiers,
    ...(parsed.conflicts.length ? { conflicts: parsed.conflicts } : {}),
    evidence: [{ kind: "metadata", source: declared.title || declared.identifiers ? EXTENSION : "document" }],
  };
}

/** Conservative display extraction. Matching also uses the complete raw citation. */
export function parseBibliographicReference(raw, declared = {}) {
  const text = plain(raw).replace(/^\s*(?:\[[^\]]+\]|\d+[.)])\s*/, "").trim();
  const sentences = text.split(/(?<=[.!?])\s+/u);
  let title = clean(declared.title), authors = authorText(declared.authors);
  if (!title) {
    const index = sentences.findIndex((sentence, at) => {
      if (at === 0) return false;
      const words = sentence.match(/\p{L}+/gu) || [];
      const lowercase = words.filter((word) => /^[\p{Ll}]/u.test(word) && !/^(and|et|al|de|van|von)$/i.test(word));
      return words.length >= 3 && lowercase.length >= Math.max(2, words.length / 2) && !/^(?:In |Proceedings|arXiv|https?:|doi:)/i.test(sentence);
    });
    if (index > 0) { title = sentences[index].replace(/[.!?]+$/, ""); authors ||= sentences.slice(0, index).join(" ").replace(/\.$/, ""); }
  }
  const parsed = bibliographicIdentifiers(raw, declared.identifiers || {});
  const publicationText = text.replace(/https?:\/\/\S+|(?:doi\s*:\s*)?10\.\d{4,9}\/\S+/gi, "");
  return { title, authors, year: yearFrom(declared.year) || yearFrom(publicationText, true), identifiers: parsed.identifiers,
    ...(parsed.conflicts.length ? { conflicts: parsed.conflicts } : {}) };
}

const addressKey = (source) => [source.blockId, source.itemId || "", source.nodeId || ""].map(encodeURIComponent).join(":");
function htmlUnits(block, variant = "source") {
  const html = variant === "source" ? block.html : block.translations?.[variant]?.html;
  if (typeof html !== "string") return [];
  try { return Object.values(parseHtml(html).index).map((unit) => ({ ...unit, source: { blockId: block.id, nodeId: unit.id, variant, field: "html_text" } })); }
  catch { return []; } // Unknown historical HTML remains readable and is not assigned guessed anchors.
}
function textUnits(block) {
  if (block.type === "html") return ["source", ...Object.keys(block.translations || {})].flatMap((variant) => htmlUnits(block, variant));
  const objects = block.type === "list" ? array(block.items) : [block];
  return objects.flatMap((object) => ["source", ...Object.keys(object.translations || {})].flatMap((variant) => {
    const content = variant === "source" ? object : object.translations[variant];
    const source = { blockId: block.id, ...(object !== block ? { itemId: object.id } : {}), variant };
    return ["text", "caption", "alt", "image_text", "tex", "head", "rows"].flatMap((field) => {
      if (typeof content[field] === "string") return [{ text: content[field], source: { ...source, field } }];
      if (["head", "rows"].includes(field) && Array.isArray(content[field])) return content[field].flatMap((row, index) => array(row).map((text, column) => ({ text, source: { ...source, field, row: index, column } })));
      return [];
    });
  }));
}
function htmlLinks(unit) {
  const links = [];
  const offsets = (node) => Number.isInteger(node.start) ? [node.start, node.end] : (node.children || []).flatMap(offsets);
  function visit(node) {
    if (node.tag === "a" && node.attrs?.href?.startsWith("#")) {
      const range = offsets(node);
      links.push({ href: node.attrs.href, ...(range.length ? { start: Math.min(...range), end: Math.max(...range) } : {}) });
    }
    (node.children || []).forEach(visit);
  }
  visit(unit.ast); return links;
}

export function extractBibliography(document) {
  const references = [], targets = new Map();
  let referenceLevel = null;
  function add(block, object, raw, source) {
    if (!clean(raw)) return;
    const declared = object.extensions?.[EXTENSION] || (object === block ? block.extensions?.[EXTENSION] : null) || {};
    const label = clean(declared.label) || /^\s*(\[[^\]]+\]|\d+[.)])/.exec(plain(raw))?.[1] || clean(object.num) || "";
    const reference = { key: addressKey(source), documentId: document.id, source: { ...source, variant: "source", field: source.nodeId ? "html_text" : "text" }, label, raw,
      ...parseBibliographicReference(raw, declared), occurrences: [] };
    references.push(reference);
    targets.set(source.nodeId || source.itemId || source.blockId, reference);
    // A whole-block fragment is unambiguous only when there is one entry in that block.
    if (!targets.has(source.blockId)) targets.set(source.blockId, reference);
    else if (targets.get(source.blockId) !== reference) targets.set(source.blockId, null);
  }
  for (const block of array(document.blocks)) {
    if (block.type === "heading") {
      const heading = normalizeTitle(block.text).replace(/^\d+\s+/, "");
      if (/^(references|bibliography|literature cited|参考文献|参考资料)$/.test(heading)) referenceLevel = block.level || 1;
      else if (referenceLevel !== null && (block.level || 1) <= referenceLevel) referenceLevel = null;
      continue;
    }
    if (block.role === "footnote" || !(block.role === "reference" || referenceLevel !== null || block.extensions?.[EXTENSION])) continue;
    if (block.type === "para") add(block, block, block.text, { blockId: block.id });
    else if (block.type === "list") for (const item of array(block.items)) add(block, item, item.text, { blockId: block.id, itemId: item.id });
    else if (block.type === "html") {
      const units = htmlUnits(block);
      for (const unit of units.filter((unit) => units.length === 1 || ["li", "p", "dd"].includes(unit.tag))) add(block, units.length === 1 ? block : {}, unit.text, { blockId: block.id, nodeId: unit.id });
    }
  }
  const referenceKeys = new Set(references.map((reference) => reference.key));
  for (const block of array(document.blocks)) for (const unit of textUnits(block)) {
    if (referenceKeys.has(addressKey(unit.source))) continue;
    const links = unit.ast ? htmlLinks(unit) : inlineTokens(unit.text).filter((token) => token.kind === "link" && token.href.startsWith("#"));
    for (const link of links) {
      let target; try { target = decodeURIComponent(link.href.slice(1)); } catch { continue; }
      const reference = targets.get(target);
      if (!reference) continue;
      reference.occurrences.push({ ...unit.source, ...(Number.isInteger(link.start) && Number.isInteger(link.end) ? { start: link.start, end: link.end, quote: unit.text.slice(link.start, link.end) } : {}) });
    }
  }
  return references;
}

function surnames(value) {
  return unique(authorText(value).split(/[,;·]|\band\b|\bet al\.?/i).map((name) => normalizeTitle(name).split(" ").filter((word) => word.length > 1).at(-1)));
}
const stopwords = new Set("a an the in on of for to and with by from is are using via".split(" "));
function titleWords(value) { return unique(normalizeTitle(value).split(" ").filter((word) => word.length > 1 && !stopwords.has(word))); }
function titleSimilarity(a, b) {
  const x = titleWords(a), y = titleWords(b), common = x.filter((word) => y.includes(word)).length;
  return common / Math.max(1, new Set([...x, ...y]).size);
}
function idConflicts(a, b) { return ["doi", "arxiv"].filter((key) => a?.[key] && b?.[key] && a[key] !== b[key]); }
function normalizedIdentity(value) {
  if (!value || typeof value !== "object") return {};
  const identity = value?.blocks || value?.document ? documentIdentity(value) : value;
  return { ...identity, documentId: identity.documentId || identity.id, identifiers: bibliographicIdentifiers("", identity.identifiers).identifiers };
}

/** Resolve identity, not semantic similarity. Every automatic result has reproducible evidence. */
export function matchBibliography(reference, documents) {
  const normalizedReference = { ...reference, identifiers: bibliographicIdentifiers("", reference.identifiers).identifiers };
  const raw = normalizeTitle(reference.raw || ""), title = normalizeTitle(reference.title || "");
  const evaluated = [];
  for (const input of array(documents)) {
    const document = normalizedIdentity(input);
    if (!document?.documentId || !document.title || input.archivedAt || document.documentId === reference.documentId) continue;
    const targetTitle = normalizeTitle(document.title), evidence = [];
    const exactIds = ["doi", "arxiv"].filter((key) => normalizedReference.identifiers[key] && normalizedReference.identifiers[key] === document.identifiers[key]);
    const conflicts = idConflicts(normalizedReference.identifiers, document.identifiers);
    for (const field of exactIds) evidence.push({ kind: "identifier", field, value: document.identifiers[field] });
    for (const field of conflicts) evidence.push({ kind: "conflict", field, reference: normalizedReference.identifiers[field], document: document.identifiers[field] });
    if (reference.conflicts?.length || document.conflicts?.length) evidence.push({ kind: "conflict", field: "ambiguous-identifiers" });
    const embedded = targetTitle.length >= 12 && targetTitle.includes(" ") && (` ${raw} `).includes(` ${targetTitle} `);
    const titleExact = title === targetTitle || embedded;
    if (titleExact) evidence.push({ kind: "title", match: "exact" });
    const names = surnames(document.authors), referenceAuthors = normalizeTitle(reference.authors || "");
    // Match names against the citation prefix, never against a title or venue.
    const prefix = referenceAuthors || (embedded ? raw.slice(0, raw.indexOf(targetTitle)) : "");
    const matchingNames = names.filter((name) => (` ${prefix} `).includes(` ${name} `));
    const authorMatch = names.length > 0 && matchingNames.includes(names[0]) && matchingNames.length >= Math.min(2, names.length);
    if (authorMatch) evidence.push({ kind: "authors", matched: matchingNames });
    const yearMatch = Boolean(reference.year && document.year && reference.year === document.year);
    if (yearMatch) evidence.push({ kind: "year", value: document.year });
    else if (reference.year && document.year) evidence.push({ kind: "difference", field: "year", reference: reference.year, document: document.year });
    // A clearly inconsistent title should stop an OCR-corrupted identifier from silently linking.
    const titleConflict = exactIds.length && title && titleWords(title).length >= 3 && !titleExact && titleSimilarity(title, targetTitle) < 0.35;
    if (titleConflict) evidence.push({ kind: "conflict", field: "title" });
    const conflict = conflicts.length || reference.conflicts?.length || document.conflicts?.length || titleConflict;
    const automatic = !conflict && (exactIds.length > 0 || (titleExact && authorMatch && yearMatch));
    const similarity = titleSimilarity(title || raw, targetTitle);
    const candidate = exactIds.length || titleExact || (titleWords(targetTitle).length >= 3 && similarity >= 0.55);
    if (!candidate) continue;
    if (!titleExact && similarity >= 0.55) evidence.push({ kind: "title", match: "similar", similarity: Number(similarity.toFixed(3)) });
    if (exactIds.includes("arxiv") && normalizedReference.identifiers.arxivVersion && document.identifiers.arxivVersion && normalizedReference.identifiers.arxivVersion !== document.identifiers.arxivVersion) {
      evidence.push({ kind: "difference", field: "arxivVersion", reference: normalizedReference.identifiers.arxivVersion, document: document.identifiers.arxivVersion });
    }
    evaluated.push({ documentId: document.documentId, id: document.documentId, title: document.title, authors: document.authors, year: document.year,
      identifiers: document.identifiers, evidence, score: exactIds.length ? 100 : titleExact ? 70 + (authorMatch ? 10 : 0) + (yearMatch ? 10 : 0) : Math.round(similarity * 60), automatic });
  }
  evaluated.sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId));
  const eligible = evaluated.filter((item) => item.automatic);
  // Conflicting registered identities with identical bibliographic details stay candidates.
  const ambiguous = eligible.some((a, index) => eligible.slice(index + 1).some((b) => idConflicts(a.identifiers, b.identifiers).length));
  const expose = ({ automatic, ...item }) => item;
  const matches = ambiguous ? [] : eligible.map(expose);
  const candidates = evaluated.filter((item) => !matches.some((match) => match.documentId === item.documentId)).slice(0, 8).map(expose);
  return { status: matches.length ? "linked" : candidates.length ? "candidate" : "unresolved", matches, candidates };
}
