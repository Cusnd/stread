import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createWorkspaceServer } from '../services/workspace/server.mjs';
import { localActor } from '../services/workspace/service.mjs';
import { flowDayStart } from '../services/workspace/flow.mjs';

// This tool intentionally accepts no destination. It can never seed the user's
// normal profile, the development .data folder, or an arbitrary supplied path.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = join(root, '.audit', 'continuous-motion', 'demo-profile');
const dataDir = join(profile, 'workspace');
const manifestPath = join(profile, 'demo-manifest.json');
const statePath = join(profile, 'seed-progress.json');
const lockPath = join(profile, 'seed.lock');
const schema = 'continuous-reader-motion-demo-1';
const argv = process.argv.slice(2);
assert.ok(argv.length === 0 || argv.length === 1 && argv[0] === '--verify', 'Usage: node scripts/seed-motion-demo.mjs [--verify]. No destination argument is accepted.');
const verifyOnly = argv[0] === '--verify';
const iso = (value) => new Date(value).toISOString();
const day = (value, zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const shiftedDay = (value, offset) => new Date(Date.parse(value) + offset * 86_400_000).toISOString().slice(0, 10);
const stableId = (key) => createHash('sha256').update(schema + ':' + key).digest('hex').slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
const exists = async (path) => access(path).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });

async function assertFixedDestination() {
  const canonicalRoot = await realpath(root);
  for (const component of ['.audit', 'continuous-motion', 'demo-profile', 'workspace']) {
    const previous = component === '.audit' ? root : component === 'continuous-motion' ? join(root, '.audit') : component === 'demo-profile' ? dirname(profile) : profile;
    const candidate = join(previous, component);
    try {
      const stat = await lstat(candidate);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'The demo destination must not contain a file, symlink or junction: ' + candidate);
      assert.equal(relative(canonicalRoot, await realpath(candidate)), relative(root, candidate), 'The demo destination resolves outside the expected repository path.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.equal(relative(root, dataDir), ['.audit', 'continuous-motion', 'demo-profile', 'workspace'].join(sep));
}

async function assertNotRunning() {
  for (const file of [join(profile, 'connection.json'), join(dataDir, 'connection.json')]) {
    if (!await exists(file)) continue;
    let connection;
    try { connection = JSON.parse(await readFile(file, 'utf8')); }
    catch { throw new Error('The demo connection file cannot be read safely. Close its application before seeding.'); }
    if (Number.isInteger(connection.pid) && connection.pid > 0) {
      try { process.kill(connection.pid, 0); throw new Error('The demonstration profile is running. Close that window before seeding or verifying.'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (connection.url) {
      const url = new URL(connection.url);
      assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Unexpected connection URL; refusing to contact it.');
      let live = false;
      try { live = (await fetch(new URL('/health', url), { signal: AbortSignal.timeout(700) })).ok; } catch {}
      assert.ok(!live, 'The demonstration backend is running. Close it before seeding or verifying.');
    }
  }
}

async function atomicJson(path, value) {
  assert.equal(dirname(path), profile, 'Seed metadata must stay in the demo profile.');
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(temporary, path);
}

function verifyDatabase(manifest) {
  assert.equal(manifest.schema, schema);
  assert.equal(manifest.simulated, true);
  assert.equal(manifest.workspaceRelativePath, '.audit/continuous-motion/demo-profile/workspace');
  const db = new DatabaseSync(join(dataDir, 'workspace.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const counts = Object.fromEntries(['documents', 'collections', 'insights', 'glossary', 'change_requests', 'reading_sessions', 'reading_activity', 'insight_reviews'].map((table) => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
    for (const id of manifest.documentIds) assert.ok(db.prepare('SELECT id FROM documents WHERE id=?').get(id), 'A seeded document is missing: ' + id);
    for (const id of manifest.insightIds) {
      const row = db.prepare('SELECT payload FROM insights WHERE id=?').get(id);
      assert.ok(row, 'A seeded insight is missing: ' + id);
      const note = JSON.parse(row.payload);
      assert.ok(db.prepare('SELECT insight_id FROM references_map WHERE reference=? AND insight_id=?').get(note.reference, id), 'Insight reference is unresolved.');
    }
    for (const id of manifest.sessionIds) {
      const session = db.prepare('SELECT actor_id,active_ms,ended_ms FROM reading_sessions WHERE id=?').get(id);
      assert.equal(session?.actor_id, 'local'); assert.ok(session.active_ms > 0 && session.ended_ms);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reading_activity WHERE reported_ms>60000').get().count, 0);
    return { counts, integrity: 'ok', seededReferences: manifest.insightIds.length, simulated: true };
  } finally { db.close(); }
}

const topics = [
  ['source-mapping', '来源映射与可追溯阅读', 'Source mapping and traceable reading', '来源映射', '用稳定地址连接阅读位置与原始材料，才能把一次局部修改解释清楚。', 'A stable source address connects a reading position to its evidence and makes a local correction explainable.'],
  ['conditional-probability', '条件概率：先限定事件，再计算', 'Conditional probability: define the event first', '条件概率', '条件概率先改变可讨论的样本范围，再在这个范围内比较目标事件；必要条件不能直接替代最终事件。', 'Conditioning changes the relevant sample space before the target event is measured; a necessary condition is not the final event.'],
  ['research-notes', '把研究笔记写成可复查的论证', 'Research notes as checkable arguments', '研究笔记', '把观察、解释和下一步问题分开记录，可以在回顾时判断哪些结论仍然有证据支持。', 'Separating observations, interpretations and follow-up questions makes a research note easier to check later.'],
  ['systems', '系统设计中的状态与边界', 'State and boundaries in system design', '状态边界', '稳定的身份与明确的状态所有权，使并发更新不必依赖界面显示顺序来判断谁拥有最新结果。', 'Stable identity and explicit state ownership allow concurrent updates to avoid depending on visual order.'],
  ['economics', '机会成本与边际选择', 'Opportunity cost and marginal choice', '边际选择', '比较一个额外选择的收益与成本之前，需要写清可行替代项，以及这些替代项共同受到的约束。', 'Before comparing a marginal benefit with a marginal cost, specify feasible alternatives and the constraints they share.'],
  ['reading-plan', '长期阅读计划的反馈周期', 'Feedback cycles in a reading plan', '阅读反馈', '阅读计划给出下一步的方向，回顾记录负责检验理解；计划排序与问题是否解决是两个独立状态。', 'A plan chooses what comes next, while a review checks understanding; plan order and question resolution are independent states.'],
  ['evidence', '证据链：从摘录到论点', 'Evidence chains from excerpts to claims', '证据链', '摘录提供可核对的原文，论点说明如何使用这段材料；两者之间的推理需要显式写出。', 'An excerpt preserves checkable wording, while a claim explains its use; the inference connecting them should be explicit.'],
  ['scientific-figures', '读图时先确认比较基准', 'Reading figures with an explicit baseline', '图表阅读', '读图时先确认坐标、单位和比较基准，再讨论差异；图形大小本身不能代替对测量方法的理解。', 'Before interpreting a figure, identify its axes, units and baseline; visual size cannot replace an understanding of the measurement.'],
  ['archived-notebook', '已归档：早期阅读方法草稿', 'Archived: an early reading-method draft', '阅读草稿', '这份演示草稿用于验证归档与恢复，原始内容仍然保留，不会因列表隐藏而删除。', 'This demonstration draft checks archive and restore behavior; hiding the row does not delete its content.'],
  ['archived-experiment', '已归档：实验设计备忘', 'Archived: experiment design memo', '实验备忘', '这份演示备忘保留了早期假设与反例，便于测试恢复资料后的选择和阅读入口。', 'This demonstration memo retains early hypotheses and counterexamples for testing selection and reading after restore.'],
];

function authoringFor(topic) {
  const [key, title, englishTitle, theme, chinese, english] = topic;
  return {
    format: 'reader-authoring-1', key: 'motion-demo-' + key,
    meta: { title: '演示 · ' + title, language: 'en', translations: { 'zh-CN': { title: '演示 · ' + title } } },
    blocks: [
      { key: 'title', type: 'heading', level: 1, text: englishTitle, translations: { 'zh-CN': { text: title } } },
      { key: 'demo-notice', type: 'para', text: 'Synthetic reading material for Continuous Reader interaction testing. It is not a published research source or a record of the user’s actual reading.', translations: { 'zh-CN': { text: '这是用于 Continuous Reader 交互测试的模拟阅读材料，不是已发表的研究来源，也不代表用户的真实阅读记录。' } } },
      { key: 'premise', type: 'heading', level: 2, text: '1. Define the premise', translations: { 'zh-CN': { text: '1. 明确前提' } } },
      { key: 'argument', type: 'para', text: english, translations: { 'zh-CN': { text: chinese } } },
      { key: 'boundary', type: 'para', text: 'A useful explanation states both its assumptions and the point at which those assumptions stop being sufficient. A counterexample is a way to test that boundary, not merely a reason to discard the entire method.', translations: { 'zh-CN': { text: '有用的解释既说明假设，也说明假设在哪一步不再充分。反例可以帮助检验适用边界，而不只是让人直接放弃整个方法。' } } },
      { key: 'worked-example', type: 'heading', level: 2, text: '2. Compare two possible interpretations', translations: { 'zh-CN': { text: '2. 比较两种可能的解释' } } },
      { key: 'example', type: 'para', text: 'Consider two readers using the same excerpt. One records only the final conclusion; the other records the condition, the inference and a remaining question. Their notes may have the same length, but the second note exposes more of the reasoning that can be revisited.', translations: { 'zh-CN': { text: `围绕“${theme}”，两位读者使用同一段摘录。一位只记录结论，另一位同时写下条件、推理和待解决问题。笔记长度可以相同，后者却保留了更多可在回顾时检查的推理。` } } },
      { key: 'comparison', type: 'html', role: 'table', html: '<table class="ruled"><caption data-key="caption">Demonstration comparison, not empirical results</caption><thead><tr><th data-key="dimension" scope="col">Dimension</th><th data-key="a" scope="col">First note</th><th data-key="b" scope="col">Second note</th></tr></thead><tbody><tr><th data-key="conditions" scope="row">Conditions</th><td data-key="a-condition">Implicit</td><td data-key="b-condition">Explicit</td></tr><tr><th data-key="follow-up" scope="row">Follow-up</th><td data-key="a-follow-up">Not recorded</td><td data-key="b-follow-up">One testable question</td></tr></tbody></table>' },
      { key: 'practice', type: 'heading', level: 2, text: '3. Revisit the evidence', translations: { 'zh-CN': { text: '3. 回到证据' } } },
      ...Array.from({ length: 7 }, (_, i) => ({ key: 'practice-' + i, type: 'para', text: `${english} Practice ${i + 1}: return to the source passage, identify one assumption, and state one observation that would make the interpretation less convincing. Preserve the original wording beside your own explanation.`, translations: { 'zh-CN': { text: `${chinese}练习 ${i + 1}：重新定位原文，指出一个假设，再说明什么观察会削弱当前解释。把原文和自己的解释同时保留，以便下一次回顾。` } } })),
      { key: 'conclusion', type: 'heading', level: 2, text: '4. A question to carry forward', translations: { 'zh-CN': { text: '4. 留给下一次的问题' } } },
      { key: 'closing', type: 'para', text: 'What evidence would distinguish the two explanations? Keep this question separate from whether the note belongs in the next review queue.', translations: { 'zh-CN': { text: '什么证据能够区分这两种解释？把这个问题与“是否加入下一次回顾”分开处理。' } } },
    ],
  };
}

const noteTemplates = [
  ['question', '前提怎样影响结论', '这段论证依赖哪些前提？如果拿掉其中一个条件，结论仍然成立吗？先列出必要条件，再区分它们是否已经充分。'],
  ['note', '把机制写清楚', '先记录输入是什么、经过什么关系、最后得到什么结果。这样的笔记在回顾时可以逐步检查，不必只凭结论是否熟悉来判断理解。'],
  ['annotation', '关键边界', '这里值得保留的不是一句口号，而是方法的适用边界：作者明确说了什么，哪些推断仍需要额外证据。'],
  ['question', '反例与适用范围', '能否构造一个表面相似、但不满足本段条件的例子？反例应该指出具体失效环节，而不能只说结果不同。'],
  ['note', '', '把“已经看到的现象”与“对现象的解释”分别写下。下次阅读时，优先检查解释是否仍然受到材料支持。'],
  ['annotation', '', ''],
  ['question', '从局部步骤到整体解释：中间还缺什么', '这一步为什么能够连接到整体结论？我想把中间的依赖顺序完整展开：先说明对象和条件，再检查每一次推导是否仍然使用同一组条件；最后比较改变条件后，哪些结果会保留、哪些结果需要重新判断。'],
  ['note', '与下一次阅读连接', '下一次阅读时把这条笔记和原文一起打开，先复述论证，再寻找一个不同情境中的应用。\n\n需要保留的检查顺序是：概念是否相同，条件是否满足，推理是否跳步，结论能否被独立验证。不要因为两个段落使用相同术语，就默认它们讨论同一个对象。\n\n这条长笔记专门覆盖列表两行预览、完整详情、源摘录以及回顾操作之间的状态连续性。'],
];
const glossary = [
  ['Attention', '注意力', '根据当前查询与候选内容的相关性分配权重，用来组合信息。'], ['Query / Key / Value', '查询、键、值', '查询表达当前需要，键用于匹配，值提供被组合的内容。'],
  ['Residual connection', '残差连接', '把输入沿旁路与变换结果相加，使网络可以学习相对于输入的修正。'], ['Identity mapping', '恒等映射', '将输入保持不变地传递给输出的映射。'],
  ['Map', '映射阶段', '把输入记录转换为中间键值对的处理阶段。'], ['Reduce', '归约阶段', '按键汇总中间结果的处理阶段。'],
  ['Guide RNA', '向导 RNA', '通过序列匹配引导相关分子机器定位目标的 RNA。'], ['PAM', '前间区序列邻近基序', '某些 CRISPR 系统识别目标时所需的邻近短序列。'],
  ['Source mapping', '来源映射', '把阅读对象定位到原始材料中可核对的位置。'], ['Stable identity', '稳定身份', '在内容移动或编辑后仍用于识别同一对象的标识。'],
  ['Conditional probability', '条件概率', '在给定事件已经发生的条件下，重新计算另一个事件的概率。'], ['Necessary condition', '必要条件', '结论成立时必须满足，但单独满足它未必足以得到结论的条件。'],
  ['Inference', '推理', '从前提和证据得到结论的过程。'], ['Counterexample', '反例', '满足假设却不满足结论、用于检验论断的具体例子。'],
  ['State ownership', '状态所有权', '明确由哪个组件或服务保存并更新某项状态。'], ['Idempotency', '幂等性', '同一个操作重复执行仍保持与一次执行相同的实际结果。'],
  ['Opportunity cost', '机会成本', '作出选择时放弃的最佳可行替代项的价值。'], ['Marginal choice', '边际选择', '围绕增加或减少一个单位所带来的变化进行选择。'],
  ['Retrieval practice', '提取练习', '不直接重读答案，而是主动尝试从记忆中重建解释。'], ['Review membership', '回顾成员状态', '是否被明确加入回顾队列，与问题是否解决分别保存。'],
  ['Evidence chain', '证据链', '把原始材料、观察、推理和结论逐步连接起来的记录。'], ['Provenance', '来源记录', '记录内容从哪里来、经过哪些处理以及可以怎样核验。'],
  ['Scroll restoration', '滚动恢复', '返回既有界面时恢复该界面保存的阅读或列表位置。'], ['Reduced motion', '减少动态效果', '遵循系统偏好，减少或取消空间位移，同时保留功能与状态反馈。'],
];

await assertFixedDestination();
await assertNotRunning();
if (await exists(manifestPath)) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  console.log(JSON.stringify({ mode: 'verified-existing', profile, ...verifyDatabase(manifest) }, null, 2));
  process.exit(0);
}
assert.ok(!verifyOnly, 'The demonstration profile has not been seeded yet. Run the script without --verify.');
await mkdir(profile, { recursive: true });
await assertFixedDestination();
let lock;
try { lock = await open(lockPath, 'wx'); }
catch (error) { if (error.code === 'EEXIST') throw new Error('A seed lock already exists. The existing profile is preserved; inspect the recorded PID before retrying.'); throw error; }
await lock.writeFile(JSON.stringify({ schema, pid: process.pid, createdAt: iso(Date.now()) }) + '\n');
let server;
try {
  const alreadyStarted = await exists(statePath);
  assert.ok(alreadyStarted || !await exists(join(dataDir, 'workspace.sqlite')), 'An unrecognized database already exists at the demo destination. It will not be modified.');
  const state = alreadyStarted ? JSON.parse(await readFile(statePath, 'utf8')) : { schema, simulated: true, anchorNow: Date.now() - 1000, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles', steps: {}, sessions: [] };
  assert.equal(state.schema, schema); assert.equal(state.simulated, true);
  const saveState = () => atomicJson(statePath, state);
  await saveState();
  const bundledPython = join(root, '.desktop', 'runtime', 'python', 'python.exe');
  const pythonPath = await exists(bundledPython) ? bundledPython : (process.env.CONTINUOUS_READER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'));
  console.log('Seeding isolated demonstration profile: ' + profile);
  // Formal authoring endpoints run only on this temporary loopback server.
  const token = randomUUID();
  server = await createWorkspaceServer({ dataDir, bootstrap: true, glossaryPath: false, staticRoot: false, authToken: token, flowNow: () => state.anchorNow, pythonPath });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, expected = 200) => {
    const response = await fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, expected, path + ': ' + JSON.stringify(value));
    return value;
  };
  const step = async (key, action) => {
    if (state.steps[key]?.done) return state.steps[key].value;
    const value = await action(); state.steps[key] = { done: true, value }; await saveState(); return value;
  };
  const command = (key, input) => step(key, async () => {
    // Store the exact optimistic version before dispatch. A replay after an
    // interrupted response uses the same command bytes and request identity.
    if (!state.steps[key]?.input) { state.steps[key] = { input: { requestId: stableId(key), ...input } }; await saveState(); }
    return request('/api/commands', state.steps[key].input);
  });
  const rawCommand = (key, input) => request('/api/commands', { requestId: stableId(key), ...input });
  const initial = await request('/api/workspace?includeArchived=1');
  if (!state.bundledIds) { state.bundledIds = initial.documents.map((item) => item.id); await saveState(); }
  assert.ok([4, 5].includes(state.bundledIds.length), 'Expected the four bundled PDF papers, with an optional Attention comparison view.');
  const chosenTopics = [...topics.slice(0, 12 - state.bundledIds.length), ...topics.slice(-2)];
  const synthetic = [];
  for (const topic of chosenTopics) {
    const authoring = authoringFor(topic), key = topic[0];
    const source = await step('source-' + key, () => request('/api/sources?filename=motion-demo-' + key + '.json', authoring, 201));
    const created = await step('preview-' + key, () => request('/api/authoring/previews', { authoringSourceId: source.sourceId, requestId: stableId('preview-' + key) }, 201));
    const preview = created.preview;
    const frozen = await request(preview.documentUrl);
    assert.equal(frozen.document.blocks.length, authoring.blocks.length);
    const published = await step('publish-' + key, () => request('/api/authoring/previews/publish', { previewId: preview.id, expectedHash: preview.hash, requestId: stableId('publish-' + key), review: { sourceReview: 'Explicitly synthetic demonstration fixture. Authored source and frozen block count checked; no real research or reading data is claimed.', layoutReview: 'Structural authoring validation only. Visual behavior is to be inspected in the isolated desktop demonstration profile.', interactionReview: 'Publication and source identity are verified by this script; browser interaction acceptance is not claimed.' } }, 201));
    synthetic.push(published.document.id);
  }
  const allIds = [...state.bundledIds, ...synthetic], activeIds = allIds.slice(0, 12), archivedIds = allIds.slice(12);
  const categories = {};
  for (const [key, label, parent] of [['research', '研究阅读', null], ['ml', '机器学习', 'research'], ['systems', '系统与方法', 'research'], ['foundations', '基础与推理', null], ['probability', '概率方法', 'foundations'], ['economics', '经济学', 'foundations'], ['notes', '阅读与笔记', null], ['archive', '归档演示', null]]) categories[key] = (await command('category-' + key, { kind: 'collection.create', label, parentId: parent ? categories[parent] : null })).collection.id;
  const records = [];
  for (let index = 0; index < allIds.length; index++) {
    const id = allIds[index], envelope = await request('/api/documents/' + encodeURIComponent(id));
    const bundled = index < state.bundledIds.length;
    const record = envelope.record, category = index < 3 ? 'ml' : index < 5 ? 'systems' : index === 6 ? 'probability' : index === 9 ? 'economics' : index >= 12 ? 'archive' : 'notes';
    const tags = ['演示资料库', bundled ? '真实论文样例' : '模拟文章', ...([0, 2, 5, 8].includes(index) ? ['重点回顾'] : []), ...(index % 3 === 0 ? ['方法'] : ['证据'])];
    const updated = await command('metadata-' + index, { kind: 'document.update', documentId: id, expectedVersion: record.version, patch: { collectionIds: [categories[category]], tags, status: ['reading', 'unread', 'done'][index % 3], summary: bundled ? '独立演示库中的真实论文样例。关联洞见、计划和阅读统计均为模拟测试记录。' + (record.summary || '') : '模拟阅读材料，用于检查列表、详情、双语阅读、来源导航和连续状态变化。' + chosenTopics[index - state.bundledIds.length][4] } });
    const content = await server.workspace.query(localActor, { kind: 'read_document', documentId: id, limit: 100 });
    const paraIds = new Set(content.blocks.filter((block) => block.type === 'para').map((block) => block.id));
    const source = content.text.find((entry) => paraIds.has(entry.blockId) && entry.variant === 'source' && entry.field === 'text' && entry.text.length > 35 && !entry.text.startsWith('Synthetic reading')) || content.text.find((entry) => entry.variant === 'source' && entry.field === 'text' && entry.text.length > 35);
    assert.ok(source, 'No stable text source for ' + id);
    records.push({ ...updated.record, revision: envelope.document.revision, source: { blockId: source.blockId, variant: 'source', field: 'text', start: 0, end: Math.min(110, source.text.length), quote: source.text.slice(0, 110) } });
  }
  for (const index of [0, 5, 1, 6, 2, 7, 3, 8]) await command('plan-' + index, { kind: 'plan.add', documentId: records[index].id });
  for (let index = 0; index < 12; index++) if (index % 3 !== 1) await command('checkpoint-' + index, { kind: 'reading.checkpoint', documentId: records[index].id, readingState: { revision: records[index].revision, blockId: records[index].source.blockId, offsetRatio: (index % 7 + 1) / 10, mode: ['source', 'bilingual', 'translation'][index % 3], targetLanguage: 'zh-CN', translationFirst: index % 2 === 0 } });
  if (!state.sessions.length) {
    const today = day(state.anchorNow, state.timezone), emptyOffsets = [27, 21, 14, 8, 3];
    for (let offset = 29; offset >= 0; offset--) {
      if (emptyOffsets.includes(offset)) continue;
      const date = shiftedDay(today, -offset), midnight = flowDayStart(date, state.timezone);
      for (let slot = 0; slot < 2; slot++) {
        let minutes = 5 + (offset * 7 + slot * 11) % 19;
        let start = midnight + (slot === 0 ? 9 : 18) * 3_600_000 + ((offset * 13) % 45) * 60000;
        if ([5, 18].includes(offset) && slot === 1) { start = flowDayStart(shiftedDay(date, 1), state.timezone) - 3 * 60000; minutes = 12; }
        if (offset === 0) start = state.anchorNow - (slot === 0 ? 120 : 35) * 60000;
        if (start < midnight && offset === 0) continue;
        const index = state.sessions.length, documentIndex = index % 12;
        state.sessions.push({ id: 'motion-demo-session-' + String(index + 1).padStart(3, '0'), documentIndex, startedAt: iso(start), durationMs: minutes * 60000, mode: ['source', 'bilingual', 'translation'][index % 3] });
      }
    }
    await saveState();
  }
  assert.ok(state.sessions.length >= 45 && state.sessions.length <= 60);
  for (const [index, session] of state.sessions.entries()) {
    await step('session-' + index, async () => {
      const document = records[session.documentIndex], start = Date.parse(session.startedAt);
      const position = { blockId: document.source.blockId, offsetRatio: .1, mode: session.mode, targetLanguage: 'zh-CN' };
      await rawCommand('session-start-' + index, { kind: 'reading.session.start', sessionId: session.id, documentId: document.id, documentRevision: document.revision, startedAt: session.startedAt, mode: session.mode, position });
      for (let elapsed = 0, sequence = 1; elapsed < session.durationMs; elapsed += 60000, sequence++) {
        const duration = Math.min(60000, session.durationMs - elapsed);
        const receipt = await rawCommand(`activity-${index}-${sequence}`, { kind: 'reading.session.activity', sessionId: session.id, sequence, startedAt: iso(start + elapsed), endedAt: iso(start + elapsed + duration), activeMs: duration });
        assert.equal(receipt.acceptedMs, duration, 'Simulated sessions must not overlap.');
      }
      await rawCommand('session-end-' + index, { kind: 'reading.session.end', sessionId: session.id, endedAt: iso(start + session.durationMs), reason: 'motion-demo-simulated', position: { ...position, offsetRatio: .7 } });
      return { id: session.id, activeMs: session.durationMs };
    });
  }
  const insightIds = [];
  for (let index = 0; index < 12; index++) {
    const document = records[index], sessions = state.sessions.filter((session) => session.documentIndex === index);
    const notes = noteTemplates.map(([type, title, body], n) => {
      const session = sessions[n % sessions.length];
      const id = 'motion-demo-insight-' + String(index * 8 + n + 1).padStart(3, '0'); insightIds.push(id);
      return { id, type, ...(title ? { title: title + (n % 3 === 0 ? ' · ' + document.title.replace(/^演示 · /, '').slice(0, 20) : '') } : {}), body, color: ['sky', 'green', 'amber', 'rose'][n % 4], ...document.source, revision: document.revision, createdAt: iso(Date.parse(session.startedAt) + (n % 2 + 1) * 30000), origin: 'motion-demo' };
    });
    await command('insights-' + index, { kind: 'legacy.import', documentId: document.id, sessionKey: schema + ':' + document.id, notes, rawSession: { simulated: true, purpose: 'Motion demonstration fixture, not user history' } });
    for (let n = 0; n < notes.length; n++) {
      const note = notes[n];
      if (note.type === 'question' && n !== 3) {
        const saved = (await request('/api/flow/insights/' + note.id)).insight;
        await command('answer-' + note.id, { kind: 'insight.answer', documentId: document.id, insightId: note.id, expectedVersion: saved.version, authorized: true, answer: { sourceLabel: '模拟回答 · 交互测试', blocks: [{ type: 'paragraph', text: '先把前提、推理和结论分别列出。若移除某一前提后无法完成中间推导，就找到了当前论证对该条件的依赖。这个回答用于展示已答问题，不声称完成了对原论文结论的独立验证。' }, ...(n === 6 ? [{ type: 'paragraph', text: '下一步可以比较一个满足前提的例子和一个不满足前提的例子，再检查差异究竟发生在哪个步骤。' }] : [])] } });
      }
      if ([0, 1, 3, 6, 7].includes(n)) await command('review-add-' + note.id, { kind: 'insight.review.add', documentId: document.id, insightId: note.id });
      if ([1, 6].includes(n)) await command('review-complete-' + note.id, { kind: 'insight.review.complete', documentId: document.id, insightId: note.id });
    }
  }
  for (const [index, [term, alias, definition]] of glossary.entries()) {
    const document = records[Math.floor(index / 2)];
    await command('glossary-' + index, { kind: 'glossary.create', input: { term, aliases: [alias], definition, documentId: document.id, documentTitle: document.title } });
  }
  for (let index = 0; index < 6; index++) {
    const document = records[5 + index];
    await command('change-request-' + index, { kind: 'change_request.save', documentId: document.id, changeRequest: { category: ['correction', 'translation', 'instruction'][index % 3], revision: document.revision, source: document.source, body: ['检查此处术语的前后指代，并在保留原文含义的前提下使表述一致。', '请比较此段中英文的条件范围，确认译文没有省略限制条件。', '请补充一个能区分必要条件与充分条件的简单例子。'][index % 3] + '（独立演示库中的模拟请求；不会自动运行 Agent。）' } });
  }
  for (const [index, id] of archivedIds.entries()) {
    const envelope = await request('/api/documents/' + id);
    await command('archive-' + index, { kind: 'document.archive', documentId: id, expectedVersion: envelope.record.version });
  }
  const snapshot = await request('/api/workspace?includeArchived=1');
  const summary = await request('/api/flow/summary?days=30&timezone=' + encodeURIComponent(state.timezone));
  const insights = await request('/api/flow/insights?limit=100');
  const history = await request('/api/flow/history?limit=100&timezone=' + encodeURIComponent(state.timezone));
  assert.equal(snapshot.documents.length, 14); assert.equal(snapshot.documents.filter((record) => !record.archivedAt).length, 12);
  assert.equal(snapshot.planIds.length, 8); assert.equal(insights.total, 96); assert.equal(history.total, state.sessions.length);
  assert.ok(summary.daily.some((record) => record.activeMs === 0));
  assert.ok(history.items.some((record) => record.days?.length > 1));
  assert.ok(history.items.some((record) => record.insights?.length > 0));
  assert.equal((await request('/api/glossary')).total, 24);
  const manifest = { schema, simulated: true, generatedAt: iso(Date.now()), anchorNow: iso(state.anchorNow), timezone: state.timezone, workspaceRelativePath: '.audit/continuous-motion/demo-profile/workspace', notice: 'All insights, plans, requests and reading activity in this profile are synthetic demonstration data, not the user’s actual reading. Four bundled real PDF papers are retained as source-rendering fixtures.', documentIds: allIds, activeDocumentIds: activeIds, archivedDocumentIds: archivedIds, insightIds, sessionIds: state.sessions.map((session) => session.id), bundledDocumentIds: state.bundledIds, sourceVerification: 'New articles published via frozen authoring preview/publish. Insight references and reading positions use current stored source identities.', counts: { documents: 14, activeDocuments: 12, archivedDocuments: 2, insights: 96, glossary: 24, changeRequests: 6, plan: 8, sessions: state.sessions.length, pendingReviews: insights.items.filter((note) => note.review.pending).length, resolvedQuestions: insights.items.filter((note) => note.type === 'question' && note.answer).length, unansweredQuestions: insights.items.filter((note) => note.type === 'question' && !note.answer).length }, summary: { days: 30, activeMs: summary.totals.activeMs, emptyDays: summary.daily.filter((item) => item.activeMs === 0).map((item) => item.date), crossMidnightSessions: history.items.filter((item) => item.days?.length > 1).length, historyItemsWithInsights: history.items.filter((item) => item.insights?.length).length } };
  await server.shutdown(); server = null;
  const verification = verifyDatabase(manifest);
  await writeFile(join(profile, 'README.md'), `# Continuous Reader 独立运动演示资料库\n\n此目录专门用于观察界面动画与交互。洞见、问题回答、计划、术语归属、更改请求和阅读会话都是模拟数据，不能当成用户的真实学习记录或论文研究结果。\n\n资料包括四篇自带 PDF 论文的 ${state.bundledIds.length} 个阅读视图，以及 ${synthetic.length} 份明确标记的模拟双语文章；共 12 份可读资料和 2 份已归档资料。96 条洞见覆盖有无标题、长短内容、批注/笔记/问题、已答/未答以及独立的待回顾/已回顾状态。24 条术语、6 条模拟请求、8 条阅读计划与 ${state.sessions.length} 条模拟会话共同覆盖筛选、排序、归档恢复、三处独立滚动、原文导航和 7/30 天图表。\n\n模拟时间以 ${iso(state.anchorNow)} 为锚点，时区为 ${state.timezone}；包含空日期和跨午夜会话。每个活动片段不超过 60 秒，通过正式 reading.session.* 命令记录，actor 为 local。洞见通过支持历史时间戳的 legacy.import 命令导入，并标注 origin=motion-demo；回答与回顾使用各自正式命令。\n\n新文章先创建冻结 authoring preview，再经结构检查提交 publish。脚本并未声称完成浏览器视觉验收。真实 PDF 样例只从仓库复制到本目录，正文与原文件保持原样。\n\n运行：\n\n- 创建或安全续跑：\`node scripts/seed-motion-demo.mjs\`\n- 只读验证：\`node scripts/seed-motion-demo.mjs --verify\`\n- 打开独立开发窗口：\`npm run desktop:dev -- --reader-user-data=.audit/continuous-motion/demo-profile\`\n\n脚本不接受其他目标路径。发现运行中的连接、未知数据库、重入锁、链接路径时会停止。存在完整 manifest 时只读验证，不重复写入，也不重置手动测试期间的编辑。seed-progress.json 保存可恢复步骤；不删除此数据库，不覆盖正式资料库。\n`, 'utf8');
  await atomicJson(manifestPath, manifest);
  console.log(JSON.stringify({ mode: 'seeded', profile, counts: manifest.counts, summary: manifest.summary, verification }, null, 2));
} finally {
  await server?.shutdown();
  await lock.close();
  await unlink(lockPath);
}
