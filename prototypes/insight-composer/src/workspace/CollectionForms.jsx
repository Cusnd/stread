import { ReaderSelect } from "../ReaderSelect.jsx";
import { Trash } from "../icons";
import { availableParents, canRemoveCollection, collectionLabel, statusNames } from "./model.js";

function EditRecovery({ recovery, onReload, pending, workspace }) {
  if (!recovery) return null;
  const labels = { title: "资料标题", kind: "类型", summary: "简介", collectionIds: "所属分类", tagsText: "标签", status: "阅读状态", label: "分类名称", parentId: "上级分类" };
  const display = (field, value) => field === "status" ? statusNames[value] : field === "collectionIds" ? value.map((id) => collectionLabel(workspace.collections, id)).join("、") || "无" : field === "parentId" ? value ? collectionLabel(workspace.collections, value) : "无" : value || "空";
  return <div role="status">
    <p className="workspace-dialog-copy">{recovery.ready ? "已读取最新版本，你的修改已保留。请检查后保存。" : "内容已更新，你的输入已保留。"}</p>
    {!recovery.ready && <button type="button" className="workspace-quiet-button" disabled={pending} onClick={onReload}>读取最新版本并保留修改</button>}
    {Boolean(recovery.conflicts?.length) && <details><summary>查看同时修改的字段</summary><dl>{recovery.conflicts.map(({ field, latest, retained }) => <div key={field}><dt>{labels[field]}</dt><dd>最新内容：{display(field, latest)}</dd><dd>保留修改：{display(field, retained)}</dd></div>)}</dl></details>}
  </div>;
}

export function DocumentForm({ draft, onChange, workspace, onSubmit, onCancel, pending, recovery, onReload }) {
  const kinds = [...new Set([draft.kind, "论文", "书籍", "讲义", "文章", "文档"].filter(Boolean))];
  return <form className="workspace-edit-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <EditRecovery recovery={recovery} onReload={onReload} pending={pending} workspace={workspace} />
    <label className="workspace-field"><span>资料标题</span><input data-dialog-initial required value={draft.title} onChange={(event) => onChange({ title: event.target.value })} /></label>
    <div className="workspace-field-row"><label className="workspace-field"><span>类型</span><ReaderSelect value={draft.kind} onChange={(event) => onChange({ kind: event.target.value })}>{kinds.map((kind) => <option key={kind}>{kind}</option>)}</ReaderSelect></label><label className="workspace-field"><span>阅读状态</span><ReaderSelect value={draft.status} onChange={(event) => onChange({ status: event.target.value })}>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</ReaderSelect></label></div>
    <label className="workspace-field"><span>简介</span><textarea rows={3} value={draft.summary} onChange={(event) => onChange({ summary: event.target.value })} /></label>
    <fieldset className="workspace-category-field"><legend>所属分类</legend>{workspace.collections.length ? <div>{workspace.collections.map((collection) => <label key={collection.id}><input type="checkbox" checked={draft.collectionIds.includes(collection.id)} onChange={(event) => onChange({ collectionIds: event.target.checked ? [...draft.collectionIds, collection.id] : draft.collectionIds.filter((id) => id !== collection.id) })} /><span>{collectionLabel(workspace.collections, collection.id)}</span></label>)}</div> : <p className="workspace-dialog-copy">还没有分类，可以稍后添加。</p>}</fieldset>
    <label className="workspace-field"><span>标签</span><input value={draft.tagsText} onChange={(event) => onChange({ tagsText: event.target.value })} placeholder="用逗号分隔多个标签" /><small>例如：综述，值得重读</small></label>
    <div className="workspace-dialog-actions"><button type="button" className="workspace-text-button" disabled={pending} onClick={onCancel}>取消</button><button type="submit" className="workspace-primary-button" disabled={pending || Boolean(recovery && !recovery.ready)}>{pending ? "正在保存…" : "保存修改"}</button></div>
  </form>;
}

export function CollectionForm({ draft, onChange, workspace, onSubmit, onRemove, onCancel, pending, recovery, onReload }) {
  const removable = Boolean(draft.id) && canRemoveCollection(workspace, draft.id);
  const parents = availableParents(workspace.collections, draft.id);
  return <form className="workspace-edit-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <EditRecovery recovery={recovery} onReload={onReload} pending={pending} workspace={workspace} />
    <label className="workspace-field"><span>分类名称</span><input data-dialog-initial value={draft.label} required onChange={(event) => onChange({ label: event.target.value })} /></label>
    <label className="workspace-field"><span>上级分类</span><ReaderSelect value={draft.parentId || ""} onChange={(event) => onChange({ parentId: event.target.value || null })}><option value="">无，作为一级分类</option>{parents.map((collection) => <option value={collection.id} key={collection.id}>{collectionLabel(workspace.collections, collection.id)}</option>)}</ReaderSelect></label>
    {draft.id && <div className="workspace-remove-category"><button type="button" className="workspace-text-button" disabled={pending || !removable} onClick={onRemove}><Trash size={14} />移除空分类</button>{!removable && <p>分类仍有资料或子分类，包括已归档资料。</p>}</div>}
    <div className="workspace-dialog-actions"><button type="button" className="workspace-text-button" disabled={pending} onClick={onCancel}>取消</button><button type="submit" className="workspace-primary-button" disabled={pending || Boolean(recovery && !recovery.ready)}>{pending ? "正在保存…" : draft.id ? "保存分类" : "创建分类"}</button></div>
  </form>;
}
