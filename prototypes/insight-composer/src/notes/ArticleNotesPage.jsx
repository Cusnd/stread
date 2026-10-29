import { useDeferredValue, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence } from "motion/react";
import { ArrowUpRight, Check, MagnifyingGlass, Plus, Trash } from "../icons";
import { MotionItem } from "../Motion.jsx";
import { getEnabledColors } from "../highlight-colors.js";
import { matchesShortcut } from "../reading-shortcuts.js";
import { acknowledgeDraftCommand, requestJson } from "../workspace-api.js";
import { NoteEditor } from "./NoteEditor.jsx";
import { ArticleNotesHeader } from "./ArticleNotesHeader.jsx";
import { createNoteDraftStore, NOTE_BODY_LIMIT } from "./note-drafts.js";
import "../workspace/workspace.css";
import "./article-notes.css";

function localStorageForDrafts() { try { return window.sessionStorage; } catch { return null; } }
const noteDate = (note) => {
  const date = new Date(note.updatedAt || note.createdAt);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
};
const excerpt = (body) => (body || "").replace(/\s+/g, " ").slice(0, 180);
const NO_NOTES = [];
function statusFor(record) {
  if (record.archiving) return "移除结果待确认";
  if (record.saving) return "保存中…";
  if (record.conflict) return "有更新冲突";
  if (record.error) return "保存失败";
  if (record.suspended) return "保留草稿";
  if (record.dirty) return record.draft.body?.trim() ? "待保存" : "本机草稿";
  return "已保存";
}

export function ArticleNotesPage({ documentId, revision, title, notes = NO_NOTES, readOnly = false,
  onSaveInsight, onArchiveInsight, onRestoreInsight, onBack, onLocateSource, onSettings }) {
  const titleRef = useRef(null), noteViews = useRef(new Map());
  const callbacks = useRef({ onSaveInsight }); callbacks.current = { onSaveInsight };
  const [store] = useState(() => createNoteDraftStore({ documentId, revision, notes, storage: localStorageForDrafts(),
    desktop: window.continuousReaderDesktop, color: getEnabledColors()[0]?.id || "amber", writable: !readOnly,
    save: (input, options) => callbacks.current.onSaveInsight(input, options), acknowledge: acknowledgeDraftCommand }));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [selectedKey, setSelectedKey] = useState(() => {
    try {
      const raw = sessionStorage.getItem("reader-notes-selected:" + documentId);
      if (store.get(raw)) return raw;
      const saved = JSON.parse(raw);
      if (store.get(saved?.key)) return saved.key;
      const record = store.getSnapshot().records.find((item) => item.draft.id === saved?.noteId);
      if (record) return record.key;
    } catch {}
    return store.getSnapshot().records[0]?.key || null;
  });
  const [query, setQuery] = useState(""), deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [actionError, setActionError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedKeyRef = useRef(selectedKey); selectedKeyRef.current = selectedKey;
  const archived = snapshot.archived.at(-1);
  useEffect(() => { store.start(); return () => store.stop(); }, [store]);
  useEffect(() => { store.setWritable(!readOnly); }, [store, readOnly]);
  useEffect(() => { store.receive(notes); }, [store, notes]);
  useEffect(() => { document.title = title + " · 笔记 · 连续阅读"; }, [title]);
  useEffect(() => {
    try { if (selectedKey) sessionStorage.setItem("reader-notes-selected:" + documentId, JSON.stringify({ key: selectedKey, noteId: store.get(selectedKey)?.draft.id })); } catch {}
  }, [documentId, selectedKey, snapshot, store]);
  useEffect(() => {
    const flush = (event) => {
      try { store.flush(); }
      catch (error) { if (event.detail?.errors) event.detail.errors.push(error); setActionError(error.message); }
    };
    window.addEventListener("continuous-reader:flush", flush);
    window.addEventListener("pagehide", flush);
    const unregister = window.continuousReaderDesktop?.onBeforeClose?.(() => store.flush());
    return () => { window.removeEventListener("continuous-reader:flush", flush); window.removeEventListener("pagehide", flush); unregister?.(); };
  }, [store]);
  const selected = snapshot.records.find((record) => record.key === selectedKey) || snapshot.records[0] || null;
  if (selected && !noteViews.current.has(selected.key)) noteViews.current.set(selected.key, {});
  const filtered = snapshot.records.filter((record) => !deferredQuery || ((record.draft.title || "") + "\n" + (record.draft.body || "")).toLocaleLowerCase().includes(deferredQuery));
  const choose = (key) => {
    selectedKeyRef.current = key;
    setSelectedKey(key); setActionError(""); setNotice("");
  };
  const create = () => {
    if (readOnly) return;
    choose(store.create({ revision })); setQuery("");
    requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
  };
  const save = () => !busy && selected && store.save(selected.key, { resume: true });
  const leave = (callback) => {
    try { store.flush(); callback?.(); }
    catch (error) { setActionError(error.message); }
  };
  const archive = async () => {
    if (!selected?.draft.id || selected.dirty || selected.saving || busy || readOnly) return;
    setBusy(true); setActionError("");
    const key = selected.key;
    try {
      if (!store.beginArchive(key)) return;
      const saved = await onArchiveInsight(selected.draft);
      if (!saved?.archivedAt) throw new Error("移除结果尚未确认，请重试。");
      store.remove(key, saved);
      if (selectedKeyRef.current === key) setSelectedKey(store.getSnapshot().records[0]?.key || null);
    } catch (error) { store.archiveFailed(key, error); setActionError(error.message || "暂时无法移除笔记，请重试。"); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    if (!archived || busy || readOnly) return;
    setBusy(true); setActionError("");
    try { const saved = await onRestoreInsight(archived); if (!saved?.id || saved.archivedAt) throw new Error("恢复结果尚未确认，请重试。"); choose(store.restore(saved)); }
    catch (error) { setActionError(error.message || "暂时无法恢复笔记，请重试。"); }
    finally { setBusy(false); }
  };
  const loadLatest = async () => {
    if (!selected?.draft.id || busy) return;
    setBusy(true); setActionError("");
    const key = selected.key, id = selected.draft.id;
    try {
      const result = await requestJson("/api/flow/insights/" + encodeURIComponent(id));
      store.useLatest(key, result.insight);
      setNotice("已读取最新内容；原输入已作为保留草稿留在列表中。");
    } catch (error) { setActionError(error.message || "暂时无法读取最新内容，当前草稿仍保留。"); }
    finally { setBusy(false); }
  };
  const copyAsNew = () => {
    if (!selected || busy) return;
    const key = store.copyAsNew(selected.key);
    if (key) { choose(key); setQuery(""); }
  };
  const copyReference = async () => {
    try { await navigator.clipboard.writeText(selected.draft.reference); setNotice("笔记编号已复制。"); }
    catch { setActionError("暂时无法复制编号，请重试。"); }
  };
  const currentError = actionError || snapshot.storageError || selected?.error || selected?.archiveError;

  return <div className="workspace-ui article-notes-page" data-document-id={documentId} onKeyDown={(event) => {
    if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (matchesShortcut(event.nativeEvent, "save") || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
  }}>
    <ArticleNotesHeader title={title} onBack={() => leave(onBack)} onSettings={onSettings} />
    <main className="article-notes-layout">
      <aside className="article-notes-sidebar" aria-label="文章笔记">
        <div className="article-notes-list-heading"><h1>笔记</h1><button type="button" className="workspace-icon-button" aria-label="新建笔记" title="新建笔记" disabled={readOnly} onClick={create}><Plus size={17} /></button></div>
        <label className="article-notes-search"><MagnifyingGlass size={14} aria-hidden="true" /><input type="search" aria-label="搜索文章笔记" placeholder="搜索笔记" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="article-notes-list-scroll">
          <ul className="article-notes-list"><AnimatePresence initial={false}>{filtered.map((record) => <MotionItem key={record.key}>
            <button type="button" className={"article-note-row" + (selected?.key === record.key ? " is-selected" : "")} aria-pressed={selected?.key === record.key} data-note-key={record.key} data-note-id={record.draft.id || undefined} onClick={() => choose(record.key)}>
              <span className="article-note-row-title">{record.draft.title || "未命名笔记"}</span>
              {record.draft.body && <span className="article-note-row-preview">{excerpt(record.draft.body)}</span>}
              <span className="article-note-row-meta">{record.suspended ? "保留草稿" : record.conflict ? "有更新冲突" : record.error ? "保存失败" : !record.draft.id ? "草稿" : noteDate(record.draft)}{record.dirty && record.draft.id && !record.conflict && !record.error && <span aria-label="有未保存内容"> ·</span>}</span>
            </button>
          </MotionItem>)}</AnimatePresence></ul>
          {!filtered.length && <p className="article-notes-list-empty">{deferredQuery ? "没有匹配的笔记" : "暂无笔记"}</p>}
        </div>
        {archived && <div className="article-notes-undo" role="status"><span>笔记已移除</span><button type="button" disabled={busy || readOnly} onClick={restore}>撤销</button></div>}
      </aside>
      <section className="article-notes-content" aria-label="笔记编辑">
        {selected ? <>
          <div className="article-note-toolbar">
            <div className="article-note-save-meta"><span className="article-note-save-state" role="status" aria-live="polite">{statusFor(selected)}</span>{selected.draft.reference && <button type="button" className="article-note-reference" aria-label="复制笔记编号" title="复制笔记编号" onClick={copyReference}>{selected.draft.reference}</button>}</div>
            <div className="article-note-actions">
              {(selected.draft.blockId || selected.draft.sources?.length) && onLocateSource && <button type="button" className="workspace-text-button" onClick={() => leave(() => onLocateSource(selected.draft))}>回到原文<ArrowUpRight size={13} /></button>}
              <button type="button" className="workspace-icon-button" aria-label={selected.suspended ? "保存为新笔记" : "保存笔记"} title={selected.suspended ? "保存为新笔记 · Ctrl+S" : "保存笔记 · Ctrl+S"} disabled={readOnly || busy || selected.saving || selected.conflict || !(selected.dirty || selected.unconfirmed || selected.needsAck) || !selected.unconfirmed && !selected.needsAck && !selected.draft.body?.trim()} onClick={save}><Check size={16} /></button>
              {selected.draft.id && onArchiveInsight && <button type="button" className="workspace-icon-button" aria-label="移除笔记" title={selected.dirty ? "请先保存笔记" : "移除笔记"} disabled={readOnly || busy || selected.saving || selected.dirty} onClick={archive}><Trash size={16} /></button>}
            </div>
          </div>
          {currentError && <div className="article-notes-error" role="alert"><span>{currentError}</span><div>{selected.archiving ? <button type="button" disabled={busy || readOnly} onClick={archive}>重试移除</button> : selected.conflict ? <><button type="button" disabled={busy || readOnly || selected.saving} onClick={copyAsNew}>另存新笔记</button><button type="button" disabled={busy || readOnly || selected.saving} onClick={loadLatest}>读取最新内容</button></> : <button type="button" disabled={readOnly || selected.saving} onClick={save}>重试保存</button>}</div></div>}
          {notice && <p className="article-notes-notice" role="status">{notice}</p>}
          <div className="article-note-editor-scroll">
            <div className="article-note-document">
              <input ref={titleRef} className="article-note-title" aria-label="笔记标题" placeholder="标题" value={selected.draft.title || ""} maxLength={200} readOnly={readOnly || busy || selected.archiving} onChange={(event) => store.edit(selected.key, { title: event.target.value })} />
              <NoteEditor key={selected.key} value={selected.draft.body || ""} readOnly={readOnly || busy || selected.archiving} onChange={(body) => store.edit(selected.key, { body })} onSave={save} viewState={noteViews.current.get(selected.key)} />
              {(selected.draft.body || "").length > NOTE_BODY_LIMIT && <p className="article-note-limit" role="alert">超过 200000 字，输入已保留在本机草稿中。</p>}
            </div>
          </div>
        </> : <div className="article-notes-empty"><button type="button" className="workspace-quiet-button" disabled={readOnly} onClick={create}><Plus size={16} />新建笔记</button>{readOnly && <p>当前文章为只读。</p>}{currentError && <p role="alert">{currentError}</p>}</div>}
      </section>
    </main>
  </div>;
}
