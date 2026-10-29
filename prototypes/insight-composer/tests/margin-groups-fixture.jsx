import React, { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Reader } from "../src/App.jsx";
import { createPreviewReaderRuntime } from "../src/reader-runtime.js";
import { ContinuousMotion } from "../src/Motion.jsx";
import { IconStyleProvider } from "../src/icons.jsx";
import { prepareReaderDocument } from "../src/html-content.js";
import { standardFingerprintInput } from "../src/reading-language.js";
import { sourceText } from "../src/document-content.js";
import "../src/styles.css";

// This fixture mounts the actual Reader. Every document, insight, preference,
// draft and callback result is synthetic and held only in this page's memory.
// No workspace/API base, executeCommand call, or persisted profile is used.
// Reader's acknowledgeDraftCommand only looks for the fresh local draft intent;
// this fixture never creates its corresponding command record, so cleanup is a no-op.
const params = new URLSearchParams(location.search);
const scenes = [
  ["four", "4 条批注"], ["many", "12 条批注"], ["single", "1 条批注"],
  ["long", "4 条长批注"], ["short", "短段落"], ["mixed", "双语与问题"], ["sources", "列表与表格"],
];
const initialScene = scenes.some(([id]) => id === params.get("scenario")) ? params.get("scenario") : "four";
const sourceParagraph = "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train. Our model achieves strong results on the English-to-German and English-to-French translation tasks, while training on eight GPUs. These observations need to be read alongside the data, evaluation method and resource assumptions before they can be compared with another experiment.";
const translationParagraph = "占主导地位的序列转换模型采用复杂的循环神经网络或卷积神经网络，并包含编码器与解码器。表现最好的模型还通过注意力机制连接编码器与解码器。新的网络架构完全基于注意力机制，去掉了循环和卷积。这里的实验同时涉及质量、并行化与训练时间。比较不同结果时，需要保留数据、评价方法与计算资源等限定条件，不能只看一个数字。";
const noteBodies = [
  "这里先交代了序列转换任务的主流结构：编码器与解码器。后面的创新需要放在这个背景下理解，而不是把新模型看作与既有工作完全无关的模型。",
  "更容易并行化和需要更少训练时间是两个相关但不同的判断。重新阅读实验部分时，需要分别看训练成本、硬件条件和最终效果。",
  "不同翻译任务的结果分开报告。比较其他实验时，要确认数据集、评价方法和模型规模相同，再判断改进幅度。",
  "训练天数与 GPU 数量还不是完整的成本描述。需要一起保留模型规模、每步计算量和硬件代际，后续逐条核对。",
];
const excerptTerms = ["sequence transduction models", "significantly less time to train", "English-to-French translation tasks", "eight GPUs"];
const colors = ["amber", "blue", "blue", "rose"];
const frozenDate = "2026-10-25T12:00:00.000Z";
const emptyRequests = Object.freeze([]);

async function withTranslationHashes(document) {
  const targets = document.blocks.flatMap(block => block.type === "list"
    ? block.items.map(item => ({ object: item, type: "list_item", language: item.language || block.language || document.meta.language }))
    : [{ object: block, type: block.type, language: block.language || document.meta.language }]);
  await Promise.all(targets.map(async ({ object, type, language }) => {
    const input = standardFingerprintInput(object, language, type);
    if (!input || !object.translations) return;
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)));
    const hash = "sha256:" + [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
    Object.values(object.translations).forEach(value => { value.source_hash = hash; });
  }));
  return document;
}

function createDocument(scene) {
  const short = scene === "short";
  const blocks = [
    { id: "abstract-heading", type: "heading", level: 1, text: "Abstract", translations: { "zh-CN": { text: "摘要" } } },
    { id: "abstract", type: "para", text: short ? "One short paragraph has four independent annotations." : sourceParagraph,
      translations: { "zh-CN": { text: short ? "一个短段落拥有四条独立批注。" : translationParagraph } } },
    { id: "next-heading", type: "heading", level: 1, text: "An independent paragraph", translations: { "zh-CN": { text: "另一个段落" } } },
    { id: "next", type: "para", text: "This is the next paragraph. Its annotation belongs here and must not be pushed away by the annotations attached to the previous paragraph. Changing the selected note should leave this text in the same position.",
      translations: { "zh-CN": { text: "这是下一个段落。它的批注属于这里，不应该被上一段的多条批注挤走。切换所选批注时，正文位置应保持不动。" } } },
  ];
  if (scene === "sources") blocks.push(
    { id: "sources-heading", type: "heading", level: 1, text: "Independent source identities" },
    { id: "source-list", type: "list", ordered: false, items: [
      { id: "first-item", text: "First list item has its own stable source identity and must stay distinct from the second item.", translations: { "zh-CN": { text: "第一条列表项拥有独立、稳定的来源身份。" } } },
      { id: "second-item", text: "Second list item remains independent even though it shares the list block with the first item.", translations: { "zh-CN": { text: "第二条列表项和第一条共用列表块，但仍然是独立来源。" } } },
    ] },
    { id: "source-table", type: "table", num: "1", caption: "Two independently addressable cells", caption_pos: "above", head: [["Method", "Result"]], rows: [["Stable cell alpha", "Stable cell beta"], ["Another row gamma", "Another row delta"]], translations: { "zh-CN": { caption: "两个独立寻址的单元格", head: [["方法", "结果"]], rows: [["稳定单元格甲", "稳定单元格乙"], ["另一行丙", "另一行丁"]] } } },
    { id: "source-equation", type: "math", tex: "E = mc^2", tag: "1" },
  );
  return { format: "continous-reader", schema: 1, id: "margin-groups-fixture-" + scene, revision: 3,
    meta: { title: "段落批注 · 聚合预览", language: "en", authors: "独立演示资料" }, blocks };
}

const documents = Object.fromEntries(await Promise.all(scenes.map(async ([scene]) => [scene, await prepareReaderDocument(await withTranslationHashes(createDocument(scene)))])));

function anchored(paper, id, source, term, body, color, extra = {}) {
  const text = sourceText(paper, source), start = text.indexOf(term);
  if (start < 0) throw new Error("Fixture source excerpt is missing: " + term);
  return { id: "fixture-" + id, documentId: paper.id, revision: paper.revision, version: 1,
    type: "annotation", color, body, ...source, start, end: start + term.length, quote: term,
    reference: "#N" + String(id).padStart(5, "0"), createdAt: frozenDate, updatedAt: frozenDate, ...extra };
}

function seedNotes(scene) {
  const paper = documents[scene], short = scene === "short";
  const count = scene === "single" ? 1 : scene === "many" ? 12 : 4;
  const notes = Array.from({ length: count }, (_, i) => {
    const sourceIndex = count === 12 ? Math.floor(i / 3) : i;
    const body = noteBodies[sourceIndex] + (scene === "long" ? ("\n\n后续核对：保留原文的限定条件，把观察和解释分开，比较时保持评价口径一致。".repeat(12)) + (i === 1 ? "\n" + "very_long_unbroken_annotation_".repeat(30) : "") : count === 12 ? "\n补记 " + (i + 1) + "：这一条记录仍然保持独立。" : "");
    return anchored(paper, i + 3, { blockId: "abstract", variant: "source", field: "text" }, short ? ["One", "short paragraph", "four", "independent annotations"][sourceIndex] : excerptTerms[sourceIndex], body, colors[sourceIndex]);
  });
  notes.push(anchored(paper, 90, { blockId: "next", variant: "source", field: "text" }, "next paragraph", "这条批注属于下一个段落。它的位置必须保持独立，不被上面的批注推挤。", "green"));
  if (scene === "mixed") notes.push(
    anchored(paper, 30, { blockId: "abstract", variant: "zh-CN", field: "text" }, "编码器与解码器", "这条批注来自译文，应与同逻辑段落的原文批注聚合，同时保留它的语言和精确偏移。", "green", { title: "已有的独立标题" }),
    anchored(paper, 31, { blockId: "abstract", variant: "source", field: "text" }, "attention mechanism", "这种注意力机制如何连接编码器与解码器？", "amber", { type: "question", reference: "#Q00001", answer: { sourceLabel: "合成回答", blocks: [{ type: "paragraph", text: "这是一段用于验证完整问题与回答入口的合成回答。问题身份和已有回答都应在聚合后保留。" }] } }),
    anchored(paper, 32, { blockId: "abstract", variant: "source", field: "text" }, "new simple network architecture", "", "rose"),
    anchored(paper, 33, { blockId: "abstract", variant: "source", field: "text" }, "strong results", "失效来源的原始摘录仍应在洞见中可查，但不生成精确位置旁注。", "blue", { referenceStatus: "unresolved" }),
    { id: "fixture-34", documentId: paper.id, revision: paper.revision, version: 1, type: "note", color: "amber", body: "这是整篇文章的笔记，不应错误归到某一个段落。", quote: "", reference: "#N00034", createdAt: frozenDate },
  );
  if (scene === "sources") notes.push(
    anchored(paper, 40, { blockId: "source-list", variant: "source", field: "text", itemId: "first-item" }, "First list item", "第一条列表来源的批注。", "amber"),
    anchored(paper, 41, { blockId: "source-list", variant: "zh-CN", field: "text", itemId: "first-item" }, "第一条列表项", "第一条列表的译文批注，允许同项聚合但保留语言。", "blue"),
    anchored(paper, 42, { blockId: "source-list", variant: "source", field: "text", itemId: "second-item" }, "Second list item", "第二条列表来源的批注，不应和第一条错误归组。", "rose"),
    anchored(paper, 43, { blockId: "source-table", variant: "source", field: "rows", row: 0, column: 0 }, "Stable cell alpha", "第一行第一列。任何对象级聚合都必须保留这条精确来源。", "amber"),
    anchored(paper, 44, { blockId: "source-table", variant: "source", field: "rows", row: 0, column: 1 }, "Stable cell beta", "第一行第二列，不能因为与左侧同高而变成相同来源。", "blue"),
    anchored(paper, 45, { blockId: "source-table", variant: "zh-CN", field: "rows", row: 1, column: 1 }, "另一行丁", "译文第二行第二列仍能精确定位。", "rose"),
    anchored(paper, 46, { blockId: "source-equation", variant: "source", field: "tex", sourceType: "math" }, "E = mc^2", "公式批注应保留 TeX、编号与来源身份。", "green", { equationNumber: "1" }),
  );
  return notes;
}

function ScenarioReader({ scene, onScene }) {
  const runtime = useMemo(() => {
    const adapter = createPreviewReaderRuntime("margin-groups-" + scene, {
      view: { tocMode: "hidden", showMargins: true },
      reading: { fontSize: Number(params.get("font")) || 20, readingWidthPercent: 100 },
      uiScale: { percent: Number(params.get("scale")) || 80 },
    });
    adapter.mode = "fixture"; adapter.capabilities.insightWrites = true;
    return adapter;
  }, [scene]);
  const [notes, setNotes] = useState(() => seedNotes(scene));
  const notesRef = useRef(notes); notesRef.current = notes;
  const [calls, setCalls] = useState([]);
  const [readOnly, setReadOnly] = useState(params.has("readonly"));
  const [failNext, setFailNext] = useState(false);
  const failNextRef = useRef(false); failNextRef.current = failNext;
  const paper = documents[scene];
  const preferences = useSyncExternalStore(runtime.reading.subscribe, runtime.reading.getSnapshot);
  const ui = useSyncExternalStore(runtime.uiScale.subscribe, runtime.uiScale.getSnapshot);
  function commit(next) { notesRef.current = next; setNotes(next); }
  function record(action, input, output, options) { setCalls(current => [...current, structuredClone({ action, input, output, options })]); }
  function currentVersion(input) {
    const previous = notesRef.current.find(note => note.id === input.id);
    if (previous && previous.version !== input.version) throw new Error("合成版本冲突：修改尚未保存，草稿已保留。");
    if (failNextRef.current) { failNextRef.current = false; setFailNext(false); throw new Error("合成保存失败：请重试，草稿已保留。"); }
    return previous;
  }
  async function save(input, options) {
    const previous = currentVersion(input);
    const saved = { ...previous, ...input, id: previous?.id || "fixture-new-" + crypto.randomUUID(), reference: previous?.reference || (input.type === "question" ? "#Q" : "#N") + String(100 + notesRef.current.length).padStart(5, "0"), version: (previous?.version || 0) + 1, updatedAt: frozenDate };
    commit([...notesRef.current.filter(note => note.id !== saved.id), saved]); record("save", input, saved, options); return saved;
  }
  async function archive(input) {
    const previous = currentVersion(input);
    const saved = { ...previous, archivedAt: frozenDate, version: previous.version + 1 };
    commit(notesRef.current.map(note => note.id === saved.id ? saved : note)); record("archive", input, saved); return saved;
  }
  async function restore(input) {
    const previous = currentVersion(input);
    const saved = { ...previous, archivedAt: null, version: previous.version + 1 };
    commit(notesRef.current.map(note => note.id === saved.id ? saved : note)); record("restore", input, saved); return saved;
  }
  async function review(input) {
    const previous = currentVersion(input);
    const saved = { ...previous, review: { pending: !previous.review?.pending }, version: previous.version + 1 };
    commit(notesRef.current.map(note => note.id === saved.id ? saved : note)); record("review", input, saved); return saved;
  }
  const audit = { scene, documentId: paper.id, preferences, uiScale: ui.percent, readOnly, activeCount: notes.filter(note => !note.archivedAt).length, calls, notes };
  return <>
    <Reader paper={paper} runtime={runtime} insightItems={notes} changeRequestItems={emptyRequests}
      initialReadingState={{ mode: params.get("mode") || "bilingual", targetLanguage: "zh-CN" }}
      onSaveInsight={save} onDeleteInsight={archive} onRestoreInsight={restore} onReviewInsight={review} readOnly={readOnly} />
    <details className="margin-fixture-controls" open={params.has("controls")}>
      <summary>隔离验证 · {scenes.find(([id]) => id === scene)[1]}</summary>
      <div className="margin-fixture-fields">
        <label>场景<select aria-label="验证场景" value={scene} onChange={event => onScene(event.target.value)}>{scenes.map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>正文<select aria-label="验证正文字号" value={preferences.fontSize} onChange={event => runtime.reading.update({ fontSize: Number(event.target.value) })}>{[14,18,20,24].map(size => <option key={size} value={size}>{size}px</option>)}</select></label>
        <label>界面<select aria-label="验证界面比例" value={ui.percent} onChange={event => runtime.uiScale.update(Number(event.target.value))}>{[80,100,120].map(scale => <option key={scale} value={scale}>{scale}%</option>)}</select></label>
        <label><input aria-label="验证只读模式" type="checkbox" checked={readOnly} onChange={event => setReadOnly(event.target.checked)} />只读</label>
        <label><input aria-label="下一次合成写入失败" type="checkbox" checked={failNext} onChange={event => setFailNext(event.target.checked)} />下次失败</label>
      </div>
      <details><summary>内存审计 · {calls.length} 次回调</summary><pre data-testid="margin-fixture-audit">{JSON.stringify(audit, null, 2)}</pre></details>
    </details>
  </>;
}
function Fixture() {
  const [scene, setScene] = useState(initialScene);
  return <ScenarioReader key={scene} scene={scene} onScene={setScene} />;
}
const style = document.createElement("style");
style.textContent = ".margin-fixture-controls{position:fixed;left:12px;bottom:10px;z-index:60;background:#fafafa;border:1px solid #ddd;border-radius:5px;padding:8px 12px;font:11px/1.5 system-ui,sans-serif;color:#555;max-width:620px;max-height:50vh;overflow:auto;box-shadow:0 2px 12px #0001}.margin-fixture-controls summary{cursor:pointer}.margin-fixture-controls label{display:flex;align-items:center;gap:5px;white-space:nowrap}.margin-fixture-fields{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 0}.margin-fixture-controls select{font:inherit;padding:2px;background:white;border:1px solid #ddd}.margin-fixture-controls pre{max-height:30vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;font-size:10px;line-height:1.5;margin:8px 0 0}.margin-fixture-controls input{accent-color:#444}";
document.head.append(style);
const root = createRoot(document.getElementById("root"));
root.render(<React.StrictMode><ContinuousMotion><IconStyleProvider persist={false}><Fixture /></IconStyleProvider></ContinuousMotion></React.StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => { root.unmount(); style.remove(); });
