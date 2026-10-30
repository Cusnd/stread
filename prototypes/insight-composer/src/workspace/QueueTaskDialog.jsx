import { cloneElement, useEffect, useId, useRef, useState } from "react";
import { ReaderSelect } from "../ReaderSelect.jsx";
import { MotionPanelPage } from "../Motion.jsx";
import { useReducedMotionPreference } from "../useReducedMotionPreference.js";
import { requestJson } from "../workspace-api.js";
import { ActionError, WorkspaceDialog } from "./shared.jsx";
import { queueOutputLabel, queueTypes } from "./queue-model.js";

const emptyLookup = { key: "", items: [], hasMore: false, loading: false, error: "" };
const taskTypes = queueTypes.filter((item) => item.id !== "all");

function TaskFields({ active, offset, reduced, children }) {
  const content = useRef(null);
  if (active) content.current = children;
  // Keep the page and its scroll position, while excluding hidden fields from
  // native validation and preserving the outgoing content during the slide.
  return <MotionPanelPage as="fieldset" className="queue-task-form-scroll" active={active} offset={offset} reduced={reduced} disabled={!active}>{content.current}</MotionPanelPage>;
}

function TaskField({ label, children, className = "" }) {
  const labelId = useId();
  return <div className={"workspace-field " + className}><span id={labelId}>{label}</span>{cloneElement(children, { "aria-labelledby": labelId, className: "ui-field" + (children.props.className ? " " + children.props.className : "") })}</div>;
}

function useChoices(draft, sourceQuery, count, refreshKey) {
  const source = draft?.type === "conversion", question = draft?.type === "question";
  const enabled = Boolean(draft && !draft.taskId && (source || (question && draft.documentId)));
  const key = enabled ? JSON.stringify([source, draft.documentId, sourceQuery, count]) : "";
  const [state, setState] = useState(emptyLookup);
  useEffect(() => {
    if (!enabled) { setState(emptyLookup); return; }
    const controller = new AbortController();
    setState((previous) => ({ key, items: previous.key === key ? previous.items : [], loading: true, hasMore: false, error: "" }));
    const read = async () => {
      let result, hasMore = false;
      const rows = [];
      const pageSize = source ? 20 : 100;
      for (let offset = 0; offset < count; offset += pageSize) {
        const query = source
          ? new URLSearchParams({ query: sourceQuery, offset: String(offset), limit: String(Math.min(pageSize, count - offset)) })
          : new URLSearchParams({ type: "question", question: "unresolved", documentId: draft.documentId, offset: String(offset), limit: String(Math.min(pageSize, count - offset)) });
        result = await requestJson((source ? "/api/sources?" : "/api/flow/insights?") + query, { signal: controller.signal });
        const page = source ? result.sources || [] : result.items || [];
        rows.push(...page);
        hasMore = Boolean(result.hasMore || result.page?.hasMore || result.page?.nextOffset != null || result.total > rows.length);
        if (!page.length || !hasMore) break;
      }
      return { rows, hasMore };
    };
    read().then(({ rows, hasMore }) => {
      if (controller.signal.aborted) return;
      setState({ key, items: [...new Map(rows.map((item) => [item.sourceId || item.id, item])).values()], hasMore, loading: false, error: "" });
    }).catch((error) => {
      if (!controller.signal.aborted) setState({ key, items: [], hasMore: false, loading: false, error: error.message || "暂时无法读取。" });
    });
    return () => controller.abort();
  }, [key, enabled, refreshKey]);
  return state.key === key ? state : { ...emptyLookup, loading: enabled };
}

export function QueueTaskDialog({ draft, workspace, busy, error, onChange, onSave, onClose, onImport, onReload }) {
  const fieldId = useId();
  const reduced = useReducedMotionPreference();
  const [sourceQuery, setSourceQuery] = useState("");
  const [count, setCount] = useState(20);
  const [refreshKey, setRefreshKey] = useState(0);
  const choices = useChoices(draft, sourceQuery, count, refreshKey);
  const edit = Boolean(draft?.taskId), conversion = draft?.type === "conversion", question = draft?.type === "question";
  const returnFocus = useRef("queue-add-task");
  if (draft) returnFocus.current = edit ? "queue-expand-" + draft.taskId : "queue-add-task";
  const frozen = busy || Boolean(draft?.pendingCommand);
  useEffect(() => { setSourceQuery(""); setCount(20); }, [draft?.type, draft?.taskId]);
  const documents = (workspace?.documents || []).filter((item) => !item.archivedAt || item.id === draft?.documentId);
  const languages = draft?.outputLanguages || (draft?.sourceLanguage === "zh-CN" ? ["source"] : ["source", "zh-CN"]);
  const outputMode = languages.length === 1 ? "source" : languages.length === 2 && languages[1] === "zh-CN" ? "bilingual" : "custom";
  const type = draft?.type || "conversion";
  const typeIndex = taskTypes.findIndex((item) => item.id === type);
  const kindControl = <ReaderSelect className="queue-task-kind" aria-label="任务类型" value={type} disabled={edit || frozen} onChange={(event) => onChange({ type: event.target.value, documentId: "", sourceId: "", sourceFilename: "", insightId: "", expectedInsightVersion: undefined, questionConflict: false })}>{taskTypes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</ReaderSelect>;
  return <WorkspaceDialog open={Boolean(draft)} title={edit ? "编辑任务" : "添加任务"} onClose={onClose} size="composer" className="queue-task-dialog" initialFocusKey={edit ? "queue-task-requirements" : "queue-task-surface"} returnFocusKey={returnFocus.current}>
    {draft && <form className="workspace-edit-form queue-task-form" tabIndex={-1} data-focus-key="queue-task-surface" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <div className="queue-task-type-row"><TaskField label="任务类型">{kindControl}</TaskField></div>
      <div className="queue-task-pages">{taskTypes.map((item, index) => <TaskFields key={item.id} active={item.id === type} offset={index < typeIndex ? -8 : 8} reduced={reduced}>
      {item.id === type && <>
      {draft.reference && <p className="queue-draft-reference">{draft.reference}</p>}
      <ActionError message={error || choices.error} />
      {edit && draft.conflict && <div className="queue-edit-recovery"><p>任务已有更新，你的输入仍保留。</p><button type="button" className="ui-button workspace-quiet-button" data-ui-button="secondary" onClick={onReload} disabled={busy}>读取最新版本并保留输入</button></div>}
      {draft.pendingCommand && !busy && <p className="workspace-dialog-copy" role="status">上次保存结果尚未确认。继续确认会重试同一项操作。</p>}
      <div className="queue-task-context">{conversion ? <>
        {!edit && <div className="queue-source-picker">
          <div className="queue-source-heading"><span>源文件</span></div>
          <div className="queue-source-control">
            <div className="queue-source-selection"><ReaderSelect className="ui-field" id={fieldId + "-source"} value={draft.sourceId || ""} required disabled={frozen} aria-label="选择已保存的源文件" onChange={(event) => {
            const file = choices.items.find((item) => (item.sourceId || item.id) === event.target.value);
            onChange({ sourceId: event.target.value, sourceFilename: file?.filename || "", ...(file && !draft.title ? { title: file.filename.replace(/\.[^.]+$/, "") } : {}) });
          }}><option value="" disabled hidden>选择源文件</option>{draft.sourceId && !choices.items.some((item) => (item.sourceId || item.id) === draft.sourceId) && <option value={draft.sourceId}>{draft.sourceFilename || "已选择的源文件"}</option>}{choices.items.map((item) => <option key={item.sourceId || item.id} value={item.sourceId || item.id}>{item.filename}</option>)}</ReaderSelect></div>
            <div className="queue-source-tools">
              <input className="ui-field queue-source-search" type="search" value={sourceQuery} placeholder="搜索已有文件" disabled={frozen} aria-label="搜索已保存的文件" onChange={(event) => { setSourceQuery(event.target.value); setCount(20); }} />
              {(choices.hasMore || choices.error || onImport) && <div className="queue-source-actions">{choices.hasMore && <button type="button" className="ui-button workspace-text-button" data-ui-button="text" aria-label="显示更多源文件" disabled={choices.loading || frozen} onClick={() => setCount(count + 20)}>更多文件</button>}{choices.error && <button type="button" className="ui-button workspace-text-button" data-ui-button="text" disabled={frozen} onClick={() => setRefreshKey((value) => value + 1)}>重试</button>}{onImport && <button type="button" className="ui-button workspace-text-button queue-source-upload" data-ui-button="text" disabled={frozen} onClick={() => onImport(draft)}>上传新文件</button>}</div>}
            </div>
          </div>
        </div>}
        <TaskField label="文章标题"><input value={draft.title || ""} maxLength={500} placeholder="使用文件名" disabled={frozen} onChange={(event) => onChange({ title: event.target.value })} /></TaskField>
        <div className="queue-language-fields"><TaskField label="原文语言"><ReaderSelect value={draft.sourceLanguage || ""} disabled={frozen} onChange={(event) => onChange({ sourceLanguage: event.target.value })}><option value="">未指定</option><option value="en">English</option><option value="zh-CN">中文</option><option value="ja">日本語</option><option value="fr">Français</option><option value="de">Deutsch</option></ReaderSelect></TaskField><TaskField label="输出语言"><ReaderSelect value={outputMode} disabled={frozen} onChange={(event) => onChange({ outputLanguages: event.target.value === "custom" ? languages : event.target.value === "source" ? ["source"] : ["source", "zh-CN"] })}><option value="bilingual">原文 + 简体中文</option><option value="source">仅原文</option>{outputMode === "custom" && <option value="custom">{queueOutputLabel(draft)}</option>}</ReaderSelect></TaskField></div>
      </> : <>
        <TaskField label="关联文章"><ReaderSelect value={draft.documentId || ""} required disabled={edit || frozen} onChange={(event) => onChange({ documentId: event.target.value, insightId: "", expectedInsightVersion: undefined, questionConflict: false })}><option value="" disabled hidden>选择文章</option>{documents.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</ReaderSelect></TaskField>
        {question && !edit && <><TaskField label="问题"><ReaderSelect value={draft.insightId || ""} required disabled={frozen || choices.loading || !draft.documentId} onChange={(event) => { const selected = choices.items.find((item) => item.id === event.target.value); onChange({ insightId: event.target.value, expectedInsightVersion: selected?.version, questionConflict: false }); }}><option value="" disabled hidden>选择未回答的问题</option>{choices.items.map((item) => <option key={item.id} value={item.id}>{item.reference ? item.reference + " · " : ""}{item.title || item.body || item.quote || "未命名问题"}</option>)}</ReaderSelect></TaskField>{draft.questionConflict && <p className="workspace-dialog-copy">请刷新后重新选择问题，你的补充要求仍保留。</p>}{!choices.loading && draft.documentId && !choices.items.length && !choices.error && <p className="workspace-dialog-copy">这篇文章还没有未回答的问题。</p>}<div className="queue-picker-actions">{draft.documentId && <button type="button" className="ui-button workspace-text-button" data-ui-button="text" disabled={choices.loading || frozen} onClick={() => { onChange({ insightId: "", expectedInsightVersion: undefined, questionConflict: false }); setRefreshKey((value) => value + 1); }}>刷新问题列表</button>}{choices.hasMore && <button type="button" className="ui-button workspace-text-button" data-ui-button="text" disabled={choices.loading || frozen} onClick={() => setCount(count + 100)}>显示更多问题</button>}</div></>}
      </>}</div>
      <TaskField className="queue-task-requirements" label={conversion ? "转换要求" : question && !edit ? "补充要求" : "任务要求"}><textarea data-focus-key="queue-task-requirements" rows={conversion ? 3 : 5} maxLength={20000} value={draft.body || ""} disabled={frozen} required={edit || (!conversion && !question)} placeholder={conversion ? "完整保留正文、公式、图表与参考文献，复审通过后发布。" : question ? "可补充回答范围、解释方式或需要对照的内容。" : "描述希望处理的内容"} onChange={(event) => onChange({ body: event.target.value })} /></TaskField>
      </>}
      </TaskFields>)}</div>
      <div className="workspace-dialog-actions queue-task-form-actions"><button type="button" className="ui-button" data-ui-button="text" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="ui-button" data-ui-button="submit" disabled={busy || (edit && Boolean(draft.conflict))}>{busy ? "正在保存…" : draft.pendingCommand ? "继续确认保存" : edit ? "保存修改" : "加入队列"}</button></div>
    </form>}
  </WorkspaceDialog>;
}
