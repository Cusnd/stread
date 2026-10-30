import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MaterialDetails } from "../../src/workspace/MaterialDetails.jsx";
import { QueueTaskDialog } from "../../src/workspace/QueueTaskDialog.jsx";
import { queueSaveCommand } from "../../src/workspace/queue-model.js";
import { WorkspaceHeader } from "../../src/workspace/WorkspaceHeader.jsx";
import { ReaderSelect } from "../../src/ReaderSelect.jsx";
import { ReadingSettings } from "../../src/ReadingSettings.jsx";
import { DesktopUpdates } from "../../src/DesktopUpdates.jsx";
import { ReaderRuntimeProvider } from "../../src/ReaderRuntime.jsx";
import { createPreviewReaderRuntime } from "../../src/reader-runtime.js";
import { ReaderInterfaceScale } from "../../src/InterfaceScale.jsx";
import { ContinuousMotion } from "../../src/Motion.jsx";
import { X } from "../../src/icons.jsx";
import "../../src/styles.css";
import "../../src/workspace/workspace.css";
import "../../src/workspace/queue.css";
import "../../src/workspace-shell.css";
import "../../src/reader-integration.css";
import "../../src/reader-navigation.css";
import "../../src/glossary.css";
import "../../src/citation-relations.css";
import "../../src/notes/note-editor.css";
import "../../src/icon-gallery.css";

// Actual controls and dialogs, synthetic in-memory records and desktop bridge.
// This fixture never opens a profile, downloads an update or restarts a process.
const runtime = createPreviewReaderRuntime("ui-control-matrix", { uiScale: { percent: 80 } });
const material = { id: "ui-material", title: "A long reading title / 用于检查控件层级与布局的资料标题", kind: "论文", status: "reading", summary: "Synthetic source for keyboard and layout verification.", collectionIds: [], tags: [], version: 1 };
let desktopStatus = { state: "idle", version: "0.0.0-fixture" };
let updateResolve, updateReject;
const fixture = window.uiFixture = {
  updateCalls: [], queueWrites: [], queueCommands: [], reloads: [], reads: [], plans: [], statuses: [], uploads: [],
  scale: percent => runtime.uiScale.update(percent),
  setUpdate: value => { desktopStatus = { version: "0.0.0-fixture", ...value }; },
  settleUpdate: (value, error) => {
    if (error) updateReject(new Error(error));
    else { desktopStatus = { version: "0.0.0-fixture", ...value }; updateResolve(desktopStatus); }
  },
};
const updateAction = name => {
  fixture.updateCalls.push(name);
  return new Promise((resolve, reject) => { updateResolve = resolve; updateReject = reject; });
};
window.continuousReaderDesktop = { updates: {
  status: async () => desktopStatus,
  check: () => updateAction("check"), download: () => updateAction("download"),
  restart: () => updateAction("restart"), openRelease: () => updateAction("openRelease"),
} };
const noop = () => {};

function Fixture() {
  const [record, setRecord] = useState(material);
  const [planned, setPlanned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [queueError, setQueueError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [plainText, setPlainText] = useState("");
  const [choice, setChoice] = useState("first");
  const workspace = { documents: [record], collections: [], planIds: planned ? [record.id] : [] };
  fixture.busy = setBusy;
  fixture.getDraft = () => draft;
  fixture.closeQueue = () => setDraft(null);
  fixture.openQueue = value => { setBusy(false); setQueueError(""); setDraft(value); };
  fixture.queueError = setQueueError;
  return <><ReaderInterfaceScale /><WorkspaceHeader page="queue" onNavigate={noop} onToggleNavigation={noop} navigationExpanded
    onSettings={() => setSettingsOpen(true)} onAddTask={() => setDraft({ type: "correction", documentId: record.id, body: "需要修正的内容" })} />
    <main id="workspace-queue-title" className="workspace-ui" style={{ padding: 24, display: "grid", alignItems: "start", gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))", gap: 32 }}>
      <section aria-label="资料详情"><MaterialDetails material={record} workspace={workspace} pending={busy}
        onRead={item => fixture.reads.push(item.id)} onPlan={item => { fixture.plans.push(item.id); setPlanned(!planned); }}
        onStatus={(item, status) => { fixture.statuses.push(status); setRecord({ ...item, status }); }} /></section>
      <section className="workspace-form" aria-label="通用字段">
        <label>普通输入<input value={plainText} onChange={event => setPlainText(event.target.value)} placeholder="填写文本" /></label>
        <label>普通选择<ReaderSelect value={choice} onChange={event => setChoice(event.target.value)}>
          <option value="first">第一个选项</option><option value="long">A deliberately long option / 很长的选项名称，用于检查原生菜单换行和文字对齐</option><option value="last">最后一个选项</option>
        </ReaderSelect></label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <button type="button" className="ui-button" data-ui-button="secondary" data-role-sample="secondary">次要操作</button>
          <button type="button" className="ui-button" data-ui-button="tool" data-role-sample="tool" aria-label="普通工具"><X size={16} /></button>
          <button type="button" className="ui-button" data-ui-button="tool" data-ui-size="compact" data-role-sample="compact" aria-label="紧凑工具"><X size={14} /></button>
        </div>
        <button type="button" className="ui-button" data-ui-button="submit" data-role-sample="long">保存这段很长的操作说明 / Save the complete, deliberately long changes without truncating the action</button>
        <label><input type="checkbox" data-unscaled-checkbox />保留原生复选框</label>
        <div className="glossary-empty"><button data-role-sample="legacy-glossary">术语入口</button></div>
        <div className="reference-candidates"><button data-role-sample="legacy-reference">引用候选</button></div>
        <div className="note-editor"><button className="cm-button" data-role-sample="legacy-editor">查找</button></div>
        <div className="reader-app"><div className="reader-topbar"><button className="tool-button selected" data-role-sample="reader-selected">已选阅读工具</button></div></div>
      </section>
      {!settingsOpen && <section aria-label="更新区域"><DesktopUpdates active /></section>}
    </main>
    <section className="reader-app" style={{ padding: 24, display: "flex", gap: 12, flexWrap: "wrap" }}>
      <button className="save-button" data-role-sample="legacy-save" aria-label="保存洞见">✓</button>
      <button className="glossary-add" data-role-sample="legacy-glossary-add" aria-label="添加术语">+</button>
      <button className="reference-open" data-role-sample="legacy-reference-open" style={{ width: "auto" }}>打开引用</button>
      <button className="icon-gallery-apply" data-role-sample="legacy-gallery">使用图标</button>
    </section>
    <QueueTaskDialog draft={draft} workspace={workspace} busy={busy} error={queueError} onChange={patch => setDraft(value => ({ ...value, ...patch }))}
      onSave={() => { fixture.queueWrites.push(draft); fixture.queueCommands.push(queueSaveCommand(draft, "fixture-new-request")); setBusy(true); }}
      onClose={() => setDraft(null)} onImport={value => fixture.uploads.push(value)}
      onReload={() => { fixture.reloads.push(draft.taskId); setQueueError(""); setDraft(value => ({ ...value, conflict: false, pendingCommand: null, expectedVersion: value.expectedVersion + 1 })); }} />
    <ReadingSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} fontSize={20} onFontSizeChange={noop} readingWidthPercent={80} onReadingWidthChange={noop}
      showMargins onMarginsChange={noop} openMode="sidebar" onOpenModeChange={noop} tocMode="collapsed" onTocModeChange={noop} mode="source" onModeChange={noop}
      targetLanguage="zh-CN" languages={["en", "zh-CN"]} onTargetLanguageChange={noop} />
  </>;
}
createRoot(document.getElementById("root")).render(<React.StrictMode><ReaderRuntimeProvider value={runtime}><ContinuousMotion><Fixture /></ContinuousMotion></ReaderRuntimeProvider></React.StrictMode>);
