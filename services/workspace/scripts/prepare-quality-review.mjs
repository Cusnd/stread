import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

// This creates an unchecked worksheet. It never infers fidelity from a PASS or
// promotes generator claims to an independent review.
export function prepareQualityReview(inspection, { reviewer = 'conversion-agent', role = 'generator' } = {}) {
  const preview = inspection.preview || inspection;
  if (!/^preview-[a-f0-9]{64}$/.test(preview.id || '') || preview.id !== `preview-${preview.hash}`) throw new Error('Expected an exact preview ID/hash from the preview creation or inspection response.');
  if (!['generator', 'independent', 'human'].includes(role) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(reviewer)) throw new Error('Use a reviewer ID with letters, digits, underscore, dot, colon or hyphen, and role generator, independent or human.');
  const document = inspection.document || inspection.validated?.document;
  if (!document) throw new Error('Expected the full preview inspection response with document, so the original source hash can be retained.');
  const layer = (summary) => ({ status: 'unverified', summary, evidenceSourceIds: [] });
  return {
    format: 'reader-quality-review-1',
    preview: { id: preview.id, hash: preview.hash },
    reviewer: { id: reviewer, role, method: 'Review not yet performed. Replace with the actual source-first comparison and Reader checks.' },
    baseline: { sourceSha256: document.source?.sha256 || null, artifactSourceIds: [] },
    layers: {
      source_fidelity: layer('Establish original article boundaries and a source-first inventory; compare text, equations, numeric strings, figures with expanded page context, tables and references.'),
      reader_visual: layer('Inspect the complete relevant content in the actual Reader at desktop widths, including larger text and object expansion. Record tested conditions.'),
      usability: layer('Check complete default zh-CN translation coverage and actual translation/bilingual modes, original heading count, navigation, exact anchors, links, PDF source navigation and overflow reachability. Zero source headings is valid; source-only needs an explicit user request.'),
    },
    issues: [],
  };
}

async function main() {
  const { values } = parseArgs({ options: { preview: { type: 'string' }, output: { type: 'string' }, reviewer: { type: 'string' }, role: { type: 'string', default: 'generator' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) {
    console.log('node scripts/prepare-quality-review.mjs --preview inspection.json --output quality-review.json [--reviewer reviewer-id --role generator|independent|human]\nInput is GET /api/authoring/previews/:id. Output is an unchecked worksheet; upload completed evidence and bind its source IDs before publication. Existing output files are never overwritten.');
    return;
  }
  if (!values.preview || !values.output) throw new Error('--preview and --output are required; use --help for input and workflow.');
  const inspection = JSON.parse((await readFile(values.preview, 'utf8')).replace(/^\uFEFF/, ''));
  const report = prepareQualityReview(inspection, values);
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: values.output, previewId: report.preview.id, status: 'unverified', next: 'Perform review, upload evidence, record issue keys, repair, and recheck the exact newest preview.' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
