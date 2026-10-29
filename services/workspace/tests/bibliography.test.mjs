import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { documentIdentity, extractBibliography, matchBibliography, normalizeArxiv, normalizeDoi, parseBibliographicReference } from "../bibliography.mjs";

const document = (id, overrides = {}) => ({ id, revision: 1, meta: { title: "A reliable target paper", authors: "Alice Smith, Bob Jones", date: "2020" }, blocks: [], ...overrides });
const reference = (text, extra = {}) => ({ raw: text, ...parseBibliographicReference(text), ...extra });
const withIdentifier = (id, doi, title = "A reliable target paper") => document(id, {
  meta: { title, authors: "Alice Smith, Bob Jones", date: "2020" }, extensions: { "continous-reader.bibliography": { work: { identifiers: { doi } } } },
});

test("normalizes DOI punctuation and arXiv versions without conflating identifiers", () => {
  assert.equal(normalizeDoi("https://doi.org/10.5555/ABC%2F123."), "10.5555/abc/123");
  assert.equal(normalizeDoi("10.1002/(SICI)123(ABC))"), "10.1002/(sici)123(abc)");
  assert.equal(normalizeDoi("not-a-doi"), undefined);
  assert.deepEqual(normalizeArxiv("https://arxiv.org/pdf/1706.03762v7.pdf"), { arxiv: "1706.03762", arxivVersion: 7 });
  assert.deepEqual(normalizeArxiv("arXiv:cs/9901001v2"), { arxiv: "cs/9901001", arxivVersion: 2 });
});

test("document identity uses declared own metadata and never a cited paper's identifier", () => {
  const source = document("a", { blocks: [{ id: "ref", type: "para", role: "reference", text: "[1] Someone. Other work. 2019. doi:10.5555/other arXiv:1234.5678" }],
    extensions: { "continous-reader.provenance": { arxiv: "https://arxiv.org/abs/1706.03762v7" } } });
  const identity = documentIdentity(source);
  assert.deepEqual(identity.identifiers, { arxiv: "1706.03762", arxivVersion: 7 });
  assert.equal(identity.year, 2020);
  assert.equal(identity.title, "A reliable target paper");
  assert.equal(documentIdentity(document("b", { meta: { title: "Book", year: 2001, doi: "10.5555/own" } })).identifiers.doi, "10.5555/own");
  assert.deepEqual(documentIdentity(document("c", { blocks: [{ id: "body", type: "para", text: "We compare arXiv:1706.03762." }] })).identifiers, {});
  assert.equal(documentIdentity(document("d", { meta: { title: "ResNet", date: "arXiv:1512.03385v1 · 2015" } })).year, 2015);
  assert.equal(documentIdentity(document("e", { meta: { title: "Dated paper", date: "2023-08-02" } })).year, 2023);
  assert.equal(parseBibliographicReference("Alice Smith. A reliable target paper. 2020, pages 1735–1780. doi:10.2024/2050").year, 2020);
  assert.equal(parseBibliographicReference("Alice Smith. A reliable target paper. arXiv:1512.03385, 2015.").year, 2015);
});

test("ordinary reference blocks keep stable addresses and source/translation occurrences", () => {
  const input = document("a", { blocks: [
    { id: "p", type: "para", text: "See [1](#r).", translations: { zh: { text: "参见[1](#r)。" } } },
    { id: "r", type: "para", role: "reference", text: "[1] Alice Smith and Bob Jones. A reliable target paper. Journal of Testing, 2020.", translations: { zh: { text: "[1] 翻译题名，2020。" } } },
  ] });
  const before = structuredClone(input), references = extractBibliography(input);
  assert.equal(references.length, 1);
  assert.equal(references[0].label, "[1]");
  assert.equal(references[0].title, "A reliable target paper");
  assert.equal(references[0].year, 2020);
  assert.deepEqual(references[0].source, { blockId: "r", variant: "source", field: "text" });
  assert.equal(references[0].occurrences.length, 2);
  assert.deepEqual(references[0].occurrences.map((item) => item.variant), ["source", "zh"]);
  assert.equal(references[0].occurrences[0].quote, "[1](#r)");
  input.blocks[1].text += " Corrected venue.";
  assert.equal(extractBibliography(input)[0].key, references[0].key);
  input.blocks[1].text = before.blocks[1].text;
  assert.deepEqual(input, before);
});

test("reference sections include list items, skip footnotes and stop at subsequent sections", () => {
  const refs = extractBibliography(document("a", { blocks: [
    { id: "p", type: "para", text: "[2](#r2) and [1](#r1)." },
    { id: "bibliography", type: "heading", level: 1, text: "References" },
    { id: "refs", type: "list", items: [{ id: "r1", text: "[1] Alice Smith. One useful paper. 2020." }, { id: "r2", text: "[2] Bob Jones. Another useful paper. 2021." }] },
    { id: "note", type: "para", role: "footnote", text: "Not a bibliography entry." },
    { id: "appendix", type: "heading", level: 1, text: "Appendix" },
    { id: "appendix-p", type: "para", text: "Ordinary body text." },
  ] }));
  assert.equal(refs.length, 2);
  assert.equal(refs[1].source.itemId, "r2");
  assert.equal(refs[1].occurrences[0].start, 0);
  assert.equal(refs[0].occurrences[0].start, 13);
});

test("semantic HTML references and inline citations retain generated node addresses", () => {
  const refs = extractBibliography(document("a", { blocks: [
    { id: "body", type: "html", html: '<p data-node-id="n1">See <a href="#r2"><strong>[2]</strong></a>.</p>' },
    { id: "refs", type: "html", role: "reference", html: '<ol><li data-node-id="r1">[1] Alice Smith. One useful paper. 2020.</li><li data-node-id="r2">[2] Bob Jones. Another useful paper. 2021.</li></ol>' },
  ] }));
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[1].source, { blockId: "refs", nodeId: "r2", variant: "source", field: "html_text" });
  assert.deepEqual(refs[1].occurrences, [{ blockId: "body", nodeId: "n1", variant: "source", field: "html_text", start: 4, end: 7, quote: "[2]" }]);
  assert.equal(refs[0].occurrences.length, 0);
});

test("exact identifiers match multiple copies while preserving the requested arXiv version", () => {
  const ref = reference("[1] Alice Smith and Bob Jones. A reliable target paper. 2020. arXiv:1706.03762v2");
  const records = [1, 2].map((version) => document("v" + version, { meta: { title: "A reliable target paper", authors: "Alice Smith, Bob Jones", date: "2020", arxiv: "1706.03762v" + version } }));
  const match = matchBibliography(ref, records);
  assert.equal(match.status, "linked");
  assert.equal(match.matches.length, 2);
  assert.ok(match.matches[0].evidence.some((item) => item.field === "arxivVersion"));
  assert.equal(match.matches[1].identifiers.arxivVersion, 2);
});

test("title, author and year jointly permit matching; missing or conflicting metadata stays a candidate", () => {
  const raw = "[1] Alice Smith and Bob Jones. A reliable target paper. Journal of Testing, 2020.";
  assert.equal(matchBibliography(reference(raw), [document("target")]).status, "linked");
  assert.equal(matchBibliography({ ...documentIdentity(document("source")), raw: "A reliable target paper" }, [document("target")]).status, "linked", "explicit metadata also matches when raw is a title only");
  assert.equal(matchBibliography(reference(raw.replace("2020", "2021")), [document("target")]).status, "candidate");
  assert.equal(matchBibliography(reference(raw.replace("Alice Smith and Bob Jones", "Charlie Doe")), [document("target")]).status, "candidate");
  assert.equal(matchBibliography(reference(raw), [document("target", { meta: { title: "A reliable target paper" } })]).status, "candidate");
  assert.equal(matchBibliography(reference("Someone. Completely unrelated subject. 2020."), [document("target")]).status, "unresolved");
});

test("identifier conflicts or distinct DOI registrations never silently merge", () => {
  const raw = "[1] Alice Smith and Bob Jones. A reliable target paper. 2020.";
  const documents = [withIdentifier("x", "10.5555/one"), withIdentifier("y", "10.5555/two")];
  const ambiguous = matchBibliography(reference(raw), documents);
  assert.equal(ambiguous.status, "candidate");
  assert.equal(ambiguous.matches.length, 0);
  assert.equal(ambiguous.candidates.length, 2);
  const exact = matchBibliography(reference(raw + " doi:10.5555/one"), documents);
  assert.deepEqual(exact.matches.map((item) => item.documentId), ["x"]);
  assert.ok(exact.candidates[0].evidence.some((item) => item.kind === "conflict"));
  const wrongTitle = matchBibliography(reference("[1] Somebody. Entirely different economic hypotheses. 2020. doi:10.5555/one"), documents);
  assert.equal(wrongTitle.status, "candidate");
});

test("ambiguous multiple identifiers and archived documents cannot produce an automatic match", () => {
  const ref = reference("[1] Alice Smith and Bob Jones. A reliable target paper. 2020. doi:10.5555/one doi:10.5555/two");
  assert.equal(ref.conflicts.length, 1);
  assert.equal(matchBibliography(ref, [withIdentifier("x", "10.5555/one")]).status, "candidate");
  assert.equal(matchBibliography(reference("[1] A reliable target paper. doi:10.5555/one"), [{ ...documentIdentity(withIdentifier("x", "10.5555/one")), archivedAt: "2026-01-01" }]).status, "unresolved");
});

test("the Attention sample discovers the ResNet citation without erasing the preprint year difference", async () => {
  const base = new URL("../../../prototypes/insight-composer/public/articles/", import.meta.url);
  const attention = JSON.parse(await readFile(new URL("attention-is-all-you-need/document.json", base), "utf8"));
  const resnet = JSON.parse(await readFile(new URL("resnet/document.json", base), "utf8"));
  const refs = extractBibliography(attention), ref = refs.find((item) => item.label === "[11]");
  assert.equal(refs.length, attention.blocks.filter((block) => block.role === "reference").length);
  assert.ok(ref.occurrences.length > 0);
  assert.equal(documentIdentity(resnet).identifiers.arxiv, "1512.03385");
  assert.equal(documentIdentity(resnet).year, 2015);
  const result = matchBibliography(ref, [resnet]);
  assert.equal(result.status, "candidate");
  assert.ok(result.candidates[0].evidence.some((item) => item.kind === "difference" && item.field === "year"));
});
