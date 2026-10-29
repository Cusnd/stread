import { matchesShortcut } from "./reading-shortcuts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, MagnifyingGlass, NotePencil, Plus, Trash, X } from "./icons";
import { AnimatePresence, motion } from "motion/react";
import { MotionItem } from "./Motion.jsx";
import { useMotionPresence } from "./useMotionPresence.js";
import "./glossary.css";

const API = "http://127.0.0.1:4176/api/glossary";
async function requestAt(apiBase, path = "", method = "GET", value, signal) {
  const response = await fetch(apiBase + path, { method, signal, headers: value ? { "Content-Type": "application/json" } : undefined, body: value ? JSON.stringify(value) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "术语表暂时不可用，请重试。");
  return data;
}

export function GlossaryPanel({ open, onClose, documentId = "direct-preference-optimization", documentTitle = "直接偏好优化", apiBase = API }) {
  const request = (path, method, value, signal) => requestAt(apiBase, path, method, value, signal);
  const blank = () => ({ term: "", definition: "", aliases: "", documentId, documentTitle });
  const [entries, setEntries] = useState([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [removed, setRemoved] = useState(null);
  const rootRef = useRef(null);
  const { present, entered, motionProps } = useMotionPresence(open, { kind: "panel", openState: { opacity: 1, x: 0 }, closedState: { opacity: 0, x: "100%" } });

  async function load(signal) {
    setLoading(true);
    try { const data = await request("", "GET", undefined, signal); setEntries(data.entries); setError(""); }
    catch (failure) { if (failure.name !== "AbortError") setError("术语表暂时无法加载，请重试。"); }
    finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, apiBase]);
  useLayoutEffect(() => {
    if (!open || !present) return;
    const previous = document.activeElement;
    rootRef.current.querySelector(editing ? '[name="term"]' : '[name="glossary-search"]')?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (previous?.isConnected && !previous.closest('[inert], [aria-hidden="true"]') && (rootRef.current?.contains(active) || active === document.body || active === document.documentElement)) previous.focus({ preventScroll: true });
    };
  }, [open, present]);
  useLayoutEffect(() => {
    if (open && editing) rootRef.current?.querySelector('[name="term"]')?.focus({ preventScroll: true });
  }, [Boolean(editing), editing?.id]);

  function edit(entry) {
    setEditing(entry ? { ...entry, aliases: entry.aliases.join("，") } : blank());
    setError(""); setMessage(""); setRemoved(null);
  }
  async function save(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError("");
    try {
      const input = { ...editing, aliases: editing.aliases.split(/[,，\n]/).map((alias) => alias.trim()).filter(Boolean), expectedRevision: editing.revision };
      const { entry } = await request(editing.id ? "/" + editing.id : "", editing.id ? "PATCH" : "POST", input);
      setEntries((current) => [entry, ...current.filter((item) => item.id !== entry.id)]);
      setEditing(null); setQuery(""); setMessage("已保存");
      rootRef.current?.querySelector('[name="glossary-search"]')?.focus({ preventScroll: true });
    } catch (failure) { setError(failure.message === "Failed to fetch" ? "暂时无法保存，输入内容已保留。" : failure.message); }
    finally { setSaving(false); }
  }
  async function removeEntry(entry) {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const result = await request("/" + entry.id, "DELETE", { expectedRevision: entry.revision });
      setEntries((current) => current.filter((item) => item.id !== entry.id));
      setRemoved(result.entry); setEditing(null); setMessage("已移除“" + entry.term + "”");
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }
  async function undo() {
    if (!removed || saving) return;
    setSaving(true); setError("");
    try {
      const { entry } = await request("/" + removed.id + "/restore", "POST", { expectedRevision: removed.revision });
      setEntries((current) => [entry, ...current]); setRemoved(null); setMessage("已恢复");
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }
  function onKeys(event) {
    if (matchesShortcut(event.nativeEvent, "close")) { event.preventDefault(); event.stopPropagation(); onClose(); }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && editing) { event.preventDefault(); void save(event); }
  }
  if (!present) return null;
  const needle = query.trim().normalize("NFKC").toLocaleLowerCase();
  const filtered = entries.filter((entry) => [entry.term, ...entry.aliases, entry.definition].join("\n").normalize("NFKC").toLocaleLowerCase().includes(needle));
  return <div className="glossary-shell" data-state={open && entered ? "open" : "closed"} inert={!open} aria-hidden={!open || undefined}>
    <motion.aside {...motionProps} ref={rootRef} className="glossary-panel" data-motion-surface="glossary" aria-label="术语表" onKeyDown={onKeys}>
      <header className="glossary-heading"><div><BookOpen size={18} /><h2>术语表</h2><span>{entries.length}</span></div><button className="icon-button" aria-label="关闭术语表" onClick={onClose}><X size={18} /></button></header>
      <div className="glossary-toolbar"><label className="glossary-search"><MagnifyingGlass size={15} /><input name="glossary-search" aria-label="检索术语" placeholder="检索术语或解释" value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="glossary-add" disabled={saving} onClick={() => edit()} aria-label="添加术语" title="添加术语"><Plus size={16} /></button></div>
      <div className="glossary-scroll">
        {error && <div className="glossary-error" role="alert"><p>{error}</p>{!editing && <button onClick={() => load()}>重试</button>}</div>}
        <AnimatePresence initial={false} mode="popLayout">{editing && <MotionItem as="form" key={"edit-" + (editing.id || "new")} className="glossary-form" data-motion-surface="glossary-form" onSubmit={save}>
          <div className="glossary-form-heading"><h3>{editing.id ? "编辑术语" : "添加术语"}</h3><button type="button" className="icon-button" aria-label="取消术语编辑" disabled={saving} onClick={() => { setEditing(null); setError(""); }}><X size={15} /></button></div>
          <label>术语<input name="term" required maxLength={120} placeholder="例如：配分函数" value={editing.term} onChange={(event) => setEditing({ ...editing, term: event.target.value })} /></label>
          <label>别名<span>选填，用逗号分隔</span><input name="aliases" maxLength={968} placeholder="例如：partition function，Z(x)" value={editing.aliases} onChange={(event) => setEditing({ ...editing, aliases: event.target.value })} /></label>
          <label>解释<textarea name="definition" required maxLength={5000} rows={4} placeholder="用自己的话记下它的含义…" value={editing.definition} onChange={(event) => setEditing({ ...editing, definition: event.target.value })} /></label>
          <div className="glossary-form-actions"><small>{editing.documentTitle}</small><button className="glossary-save" disabled={saving || !editing.term.trim() || !editing.definition.trim()} type="submit">{saving ? "保存中…" : "保存"}</button></div>
        </MotionItem>}</AnimatePresence>
        {!editing && loading && !entries.length && <p className="glossary-loading">正在加载…</p>}
        {!editing && !loading && !error && !filtered.length && <div className="glossary-empty"><BookOpen size={26} /><p>{needle ? "没有匹配的术语" : "还没有术语"}</p><span>{needle ? "试试其他名称或别名。" : "把阅读时遇到的概念记在这里。"}</span>{!needle && <button onClick={() => edit()}>添加第一条术语</button>}</div>}
        <AnimatePresence initial={false}>{!editing && <MotionItem as="div" key="glossary-list" className="glossary-list" layout={false}><AnimatePresence initial={false} mode="popLayout">{filtered.map((entry) => <MotionItem as="section" className="glossary-entry" key={entry.id} data-term-id={entry.id}>
          <div className="glossary-term-row"><h3>{entry.term}</h3><div><button aria-label={"编辑术语：" + entry.term} title="编辑" onClick={() => edit(entry)}><NotePencil size={14} /></button><button aria-label={"移除术语：" + entry.term} title="移除" disabled={saving} onClick={() => removeEntry(entry)}><Trash size={14} /></button></div></div>
          {!!entry.aliases.length && <p className="glossary-aliases">{entry.aliases.join(" · ")}</p>}
          <p className="glossary-definition">{entry.definition}</p>
          {entry.documentTitle && <small className="glossary-source">{entry.documentTitle}</small>}
        </MotionItem>)}</AnimatePresence></MotionItem>}</AnimatePresence>
      </div>
      <footer className="glossary-footer"><span role="status">{message || "你保存的解释可供 AI 读取"}</span>{removed && <button onClick={undo} disabled={saving}>撤销</button>}</footer>
    </motion.aside>
  </div>;
}
