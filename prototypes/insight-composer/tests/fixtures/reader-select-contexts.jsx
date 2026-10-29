import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReaderSelect } from "../../src/ReaderSelect.jsx";
import { MaterialDetails } from "../../src/workspace/MaterialDetails.jsx";
import { CollectionForm, DocumentForm } from "../../src/workspace/CollectionForms.jsx";
import { WorkspaceDialog as CollectionDialog } from "../../src/workspace/shared.jsx";
import { WorkspaceDialog as ServiceDialog } from "../../src/WorkspaceDialog.jsx";
import { ReadingSettings } from "../../src/ReadingSettings.jsx";
import { RevisionReview } from "../../src/RevisionReview.jsx";
import { ReaderRuntimeProvider } from "../../src/ReaderRuntime.jsx";
import { createPreviewReaderRuntime } from "../../src/reader-runtime.js";
import { ReaderInterfaceScale } from "../../src/InterfaceScale.jsx";
import { ContinuousMotion } from "../../src/Motion.jsx";
import "../../src/styles.css";
import "../../src/workspace/workspace.css";
import "../../src/workspace/flow.css";
import "../../src/reader-integration.css";
import "../../src/workspace-shell.css";
import "../../src/reading-settings.css";

// URL ?context=details|edit|category|flow|settings|import|revision|reference
// and ?scale=80|100|120. All records/callbacks stay in memory. Real components
// cover eight selects. Flow, import and reference use their exact CSS ancestors
// and options without mounting API/legacy-import/pending-import effects.
const params = new URLSearchParams(location.search);
const context = params.get("context") || "details";
const percent = Number(params.get("scale") || 80);
const runtime = createPreviewReaderRuntime("select-contexts", { uiScale: { percent } });
const noop = () => {};
const material = { id: "fixture-webb", title: "WEBB SPACE TELESCOPE", kind: "PDF", status: "reading", summary: "Synthetic document.", collectionIds: [], tags: [], version: 1 };
const other = { ...material, id: "fixture-long", title: "A long article title for testing picker wrapping and its alignment", status: "unread" };
const workspace = { documents: [material, other], collections: [{ id: "science", parentId: null, label: "科学" }, { id: "long", parentId: null, label: "一个较长的资料分类名称，用于核对展开后的文字换行" }], planIds: [] };
window.selectContexts = { context, percent, changes: [] };

function Fixture() {
  const [open, setOpen] = useState(true);
  const [record, setRecord] = useState(material);
  const [documentDraft, setDocumentDraft] = useState({ ...material, tagsText: "" });
  const [categoryDraft, setCategoryDraft] = useState({ id: null, label: "新分类", parentId: "science" });
  const [values, setValues] = useState({ document: "", question: "all", toc: "collapsed", mode: "source", language: "en", reference: "", importLanguage: "en" });
  const change = (key, value) => { window.selectContexts.changes.push({ key, value }); setValues(current => ({ ...current, [key]: value })); };
  const close = () => setOpen(false);
  let content;
  if (context === "details") content = <aside className="workspace-ui workspace-details" style={{ width: 306 * percent / 80, minHeight: 500 }}><MaterialDetails material={record} workspace={workspace} pending={false} onRead={noop} onPlan={noop} onStatus={(item, status) => setRecord({ ...item, status })} /></aside>;
  if (context === "edit") content = <CollectionDialog open={open} title="编辑资料" onClose={close}><DocumentForm workspace={workspace} draft={documentDraft} onChange={patch => setDocumentDraft(current => ({ ...current, ...patch }))} onSubmit={noop} onCancel={close} pending={false} /></CollectionDialog>;
  if (context === "category") content = <CollectionDialog open={open} title="编辑分类" onClose={close}><CollectionForm workspace={workspace} draft={categoryDraft} onChange={patch => setCategoryDraft(current => ({ ...current, ...patch }))} onSubmit={noop} onCancel={close} pending={false} /></CollectionDialog>;
  if (context === "flow") content = <section className="workspace-ui" style={{ maxWidth: 720 }}><div className="flow-filters"><div className="flow-filter-tools"><div className="flow-filter-options">
    <ReaderSelect className="flow-document-filter" aria-label="按文章筛选洞见" value={values.document} onChange={event => change("document", event.target.value)}><option value="">全部文章</option>{workspace.documents.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</ReaderSelect>
    <ReaderSelect className="flow-question-filter" aria-label="问题状态" value={values.question} onChange={event => change("question", event.target.value)}><option value="all">全部问题</option><option value="unresolved">待解决</option><option value="resolved">已解决</option></ReaderSelect>
  </div></div></div></section>;
  if (context === "settings") content = <ReadingSettings open={open} onClose={close} fontSize={18} onFontSizeChange={noop} readingWidthPercent={80} onReadingWidthChange={noop} showMargins onMarginsChange={noop} openMode="sidebar" onOpenModeChange={noop} tocMode={values.toc} onTocModeChange={value => change("toc", value)} mode={values.mode} onModeChange={value => change("mode", value)} targetLanguage={values.language} languages={["en", "zh-CN", "fr"]} onTargetLanguageChange={value => change("language", value)} />;
  if (context === "import") content = <ServiceDialog open={open} onClose={close} title="导入资料"><form className="workspace-form" onSubmit={event => event.preventDefault()}><label>原文语言<ReaderSelect value={values.importLanguage} onChange={event => change("importLanguage", event.target.value)}><option value="">未指定</option><option value="en">English</option><option value="zh-CN">中文</option><option value="ja">日本語</option><option value="fr">Français</option><option value="de">Deutsch</option></ReaderSelect></label><footer><button type="button" onClick={close}>取消</button></footer></form></ServiceDialog>;
  if (context === "revision") content = <RevisionReview open={open} onClose={close} workspace={workspace} command={async () => { throw new Error("Fixture cannot write"); }} refresh={noop} proposals={workspace.documents.map((item, index) => ({ id: `fixture-proposal-${index + 1}`, documentId: item.id, status: "pending", expectedRevision: 1, operations: [] }))} />;
  if (context === "reference") content = <ServiceDialog open={open} onClose={close} title="打开引用"><form className="workspace-form" onSubmit={event => event.preventDefault()}><label>旧编号所属文章<ReaderSelect value={values.reference} onChange={event => change("reference", event.target.value)}><option value="">选择文章</option>{workspace.documents.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</ReaderSelect></label><footer><button type="button" onClick={close}>取消</button></footer></form></ServiceDialog>;
  return <><ReaderInterfaceScale /><main className="workspace-app" style={{ padding: 32 }}><button type="button" data-context-start onClick={() => setOpen(true)}>打开 {context}</button>{content}<button type="button" data-context-end>后续按钮</button></main></>;
}

createRoot(document.getElementById("root")).render(<React.StrictMode><ReaderRuntimeProvider value={runtime}><ContinuousMotion><Fixture /></ContinuousMotion></ReaderRuntimeProvider></React.StrictMode>);
