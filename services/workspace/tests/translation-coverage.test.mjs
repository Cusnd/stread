import test from 'node:test';
import assert from 'node:assert/strict';
import { translationCoverage, storedAuthoringQuality } from '../authoring-quality.mjs';
import { canonical, hash } from '../errors.mjs';
import { authoringReviewPlan } from '../authoring-review-workflow.mjs';

test('default Chinese coverage locates missing title, prose, list, figure, table and HTML fields while sharing pure math', () => {
  const document = { meta: { title: 'Paper', language: 'en' }, blocks: [
    { id: 'p', type: 'para', text: 'Full paragraph.' },
    { id: 'l', type: 'list', items: [{ id: 'i', text: 'Item' }] },
    { id: 'f', type: 'figure', src: 'plot.png', caption: 'Figure', alt: 'Curve', image_text: 'Accuracy' },
    { id: 't', type: 'table', head: [['Method']], rows: [['Baseline']] },
    { id: 'h', type: 'html', html: '<p>Algorithm description.</p>' },
    { id: 'm', type: 'math', tex: 'x^2' },
    { id: 'numeric', type: 'table', head: [['1', '2']], rows: [['0.25', '$\\alpha$']] },
  ] };
  const report = translationCoverage(document);
  assert.equal(report.expectedFields, 9);
  assert.equal(report.missingFieldCount, 9);
  assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.missing.find(target => target.itemId), { blockId: 'l', itemId: 'i', field: 'text' });
  assert.ok(!report.missing.some(target => target.blockId === 'm'));
});

test('present translation fields are observations, with copied prose flagged and bibliography preserved', () => {
  const document = { meta: { title: 'Paper', language: 'en', translations: { 'zh-CN': { title: '论文' } } }, blocks: [
    { id: 'p', type: 'para', text: 'A sentence.', translations: { 'zh-CN': { text: '一句话。' } } },
    { id: 'c', type: 'para', text: 'Copied English.', translations: { 'zh-CN': { text: 'Copied English.' } } },
    { id: 'r', type: 'para', role: 'reference', text: 'Smith, 2001.', translations: { 'zh-CN': { text: 'Smith, 2001.' } } },
  ] };
  const report = translationCoverage(document);
  assert.equal(report.status, 'present');
  assert.equal(report.presentFields, 4);
  assert.equal(report.identicalFieldCount, 1);
  assert.equal(report.identical[0].blockId, 'c');
});

test('Chinese sources need no duplicate Chinese translation, including block overrides and bounded missing targets', () => {
  assert.equal(translationCoverage({ meta: { title: '论文', language: 'zh-CN' }, blocks: [{ id: 'p', type: 'para', text: '正文' }] }).status, 'not_applicable');
  const report = translationCoverage({ meta: { title: '论文', language: 'zh-CN' }, blocks: Array.from({ length: 80 }, (_, n) => ({ id: 'p' + n, type: 'para', text: 'English', language: 'en' })) });
  assert.equal(report.missingFieldCount, 80);
  assert.equal(report.missing.length, 40);
  assert.equal(report.missingTruncated, true);
});

test('mixed-language Chinese documents still require translation of explicit English blocks', () => {
  const document = { meta: { title: '论文', language: 'zh-CN' }, blocks: [{ id: 'english', type: 'para', language: 'en', text: 'A complete English paragraph.' }] };
  const coverage = translationCoverage(document);
  const plan = authoringReviewPlan({ validated: { document }, resourceMap: {} }, { pdfPageCount: null, translation: coverage });
  assert.equal(plan.defaultTargetLanguage, 'zh-CN');
  assert.equal(coverage.missingFieldCount, 1);
});

test('table coverage detects copied prose and missing individual cells without duplicating numeric cells', () => {
  const table = { id: 'table', type: 'table', head: [['Condition', 'Result', '123']], rows: [['Decrease weight', 'Reduces error', '$\\alpha$']] };
  const document = { meta: { title: 'Paper', language: 'en', translations: { 'zh-CN': { title: '论文' } } }, blocks: [table] };
  table.translations = { 'zh-CN': { head: table.head, rows: table.rows } };
  let report = translationCoverage(document);
  assert.equal(report.expectedFields, 5);
  assert.equal(report.presentFields, 5);
  assert.equal(report.identicalFieldCount, 4);
  assert.deepEqual(report.identical[3], { blockId: 'table', row: 0, column: 1, field: 'rows' });
  table.translations['zh-CN'] = { head: [['条件', '']], rows: [['减小权重', '']] };
  report = translationCoverage(document);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.missingFieldCount, 2);
  assert.deepEqual(report.missing, [
    { blockId: 'table', row: 0, column: 1, field: 'head' },
    { blockId: 'table', row: 0, column: 1, field: 'rows' },
  ]);
});

test('pure numeric and mathematical prose fields are shared while surrounding natural language is checked', () => {
  const document = { meta: { title: 'Paper', language: 'en', translations: { 'zh-CN': { title: '论文' } } }, blocks: [
    { id: 'digits', type: 'para', text: '123 0.2%' },
    { id: 'math', type: 'para', text: '$x+y$ and explanatory words' },
    { id: 'inline', type: 'para', text: '$x+y$' },
    { id: 'display', type: 'para', text: '$$\\alpha + 1$$' },
    { id: 'list', type: 'list', items: [{ id: 'i', text: '$x+y$' }] },
    { id: 'figure', type: 'figure', caption: '$x+y$' },
    { id: 'html', type: 'html', html: '<p data-node-id="formula"><span data-tex="x+y"></span> &nbsp; 123</p>' },
    { id: 'numeric-link', type: 'para', text: '[123](#b-link)' },
  ] };
  const report = translationCoverage(document);
  assert.equal(report.expectedFields, 2);
  assert.equal(report.missingFieldCount, 1);
  assert.deepEqual(report.missing, [{ blockId: 'math', field: 'text' }]);
});

test('literal delimiters, code, emphasis and link labels cannot hide missing prose translation', () => {
  const literalText = [
    '\\(English prose\\)', '\\[English prose\\]', '`$English prose$`',
    '```text\n$English prose$\n```', '**$English prose$**', '*$English prose$*',
    '[$English prose$](https://example.test)', '<English>', '&Alpha;',
  ];
  const document = { meta: { language: 'en' }, blocks: literalText.map((text, n) => ({ id: `literal-${n}`, type: 'para', text })) };
  const report = translationCoverage(document);
  assert.equal(report.expectedFields, literalText.length);
  assert.equal(report.missingFieldCount, literalText.length);
  assert.deepEqual(report.missing, document.blocks.map(block => ({ blockId: block.id, field: 'text' })));
});

test('field coverage follows inline rendering except for plain image alternative text', () => {
  const literal = '`$English prose$`';
  const document = { meta: { language: 'en', title: literal }, blocks: [
    { id: 'heading', type: 'heading', text: literal },
    { id: 'list', type: 'list', items: [{ id: 'item', text: literal }] },
    { id: 'figure', type: 'figure', caption: literal, image_text: literal, alt: '$English prose$' },
    { id: 'table', type: 'table', head: [[literal]], rows: [[literal]], caption: literal },
    { id: 'formula-figure', type: 'figure', caption: '$x+y$', image_text: '$x+y$' },
  ] };
  const report = translationCoverage(document);
  assert.equal(report.expectedFields, 9);
  assert.equal(report.missingFieldCount, 9);
  assert.deepEqual(report.missing.find(target => target.field === 'alt'), { blockId: 'figure', field: 'alt' });
  assert.ok(!report.missing.some(target => target.blockId === 'formula-figure'));
  assert.equal(translationCoverage({ meta: { title: '$x+y$', language: 'en' }, blocks: [] }).status, 'not_applicable');
});

test('HTML coverage shares only actual math atoms and preserves literal dollar text and decoded letters', () => {
  const document = { meta: { language: 'en' }, blocks: [{ id: 'html', type: 'html', html:
    '<p data-node-id="literal">$English prose$</p>' +
    '<pre data-node-id="code"><code>$English code$</code></pre>' +
    '<p data-node-id="entities">&#69;&#110;&#103;&#108;&#105;&#115;&#104;</p>' +
    '<p data-node-id="mixed"><span data-tex="x+y"></span> Explanation</p>' +
    '<p data-node-id="math"><span data-tex="x+y"></span> 123</p>' +
    '<p data-node-id="numeric">123<!-- English comment --></p>',
  }] };
  const report = translationCoverage(document);
  assert.equal(report.expectedFields, 4);
  assert.deepEqual(report.missing.map(target => target.nodeId), ['literal', 'code', 'entities', 'mixed']);
  const legacy = translationCoverage({ meta: { language: 'en' }, blocks: [
    { id: 'legacy', type: 'html', html: '<p>$English prose$</p>' },
    { id: 'numeric', type: 'html', html: '<p>123<!-- English comment --></p>' },
  ] });
  assert.deepEqual(legacy.missing, [{ blockId: 'legacy', field: 'html' }]);
});

test('HTML coverage locates missing and copied stable units despite another translated unit', () => {
  const source = '<p data-node-id="first">First paragraph.</p><p data-node-id="second">Second paragraph.</p><p data-node-id="formula"><span data-tex="x+y"></span> 123</p>';
  const html = { id: 'html', type: 'html', html: source, translations: { 'zh-CN': {
    html: '<p data-node-id="first">第一段。</p><p data-node-id="second"> </p><p data-node-id="formula"><span data-tex="x+y"></span> 123</p>',
  } } };
  const document = { meta: { language: 'en' }, blocks: [html] };
  let report = translationCoverage(document);
  assert.equal(report.expectedFields, 2);
  assert.equal(report.presentFields, 1);
  assert.deepEqual(report.missing, [{ blockId: 'html', nodeId: 'second', field: 'html_text' }]);
  html.translations['zh-CN'].html = html.translations['zh-CN'].html.replace('> </p>', '>Second paragraph.</p>');
  report = translationCoverage(document);
  assert.equal(report.missingFieldCount, 0);
  assert.deepEqual(report.identical, [{ blockId: 'html', nodeId: 'second', field: 'html_text' }]);
  delete html.translations['zh-CN'];
  report = translationCoverage(document);
  assert.equal(report.missingFieldCount, 2);
  assert.deepEqual(report.missing.map(item => item.nodeId), ['first', 'second']);
});

test('HTML table cell units are checked individually with entity decoding', () => {
  const document = { meta: { language: 'en' }, blocks: [{ id: 'html', type: 'html',
    html: '<table><tbody><tr><td data-node-id="name">Method &amp; result</td><td data-node-id="detail">Full comparison</td></tr></tbody></table>',
    translations: { 'zh-CN': { html: '<table><tbody><tr><td data-node-id="name">方法与结果</td><td data-node-id="detail"></td></tr></tbody></table>' } },
  }] };
  const report = translationCoverage(document);
  assert.equal(report.expectedFields, 2);
  assert.deepEqual(report.missing, [{ blockId: 'html', nodeId: 'detail', field: 'html_text' }]);
});

test('current diagnostics add translation coverage to older retained assessments without altering their evidence', () => {
  const document = { id: 'doc-example', revision: 2, meta: { title: 'Paper', language: 'en' }, blocks: [{ id: 'p', type: 'para', text: 'Text' }] };
  const retained = { evaluatorVersion: 1, document: { id: document.id, revision: document.revision, sha256: hash(canonical(document)) }, layers: { usability: { status: 'verified', scope: 'Navigation only' } }, issues: [], evidence: [{ sourceId: 'file-evidence' }] };
  const before = structuredClone(retained);
  const report = storedAuthoringQuality({ document, identity: { blocks: {} }, report: { previewSubmission: { previewId: 'preview-a', previewHash: 'a'.repeat(64), quality: retained } } });
  assert.equal(report.observations.translation.missingFieldCount, 2);
  assert.ok(report.issues.some(issue => issue.key === 'translation-incomplete-zh-CN'));
  assert.deepEqual(report.layers, retained.layers);
  assert.deepEqual(report.evidence, retained.evidence);
  assert.deepEqual(retained, before);
});
