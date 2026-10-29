import { ReaderSelect } from "./ReaderSelect.jsx";
import { useEffect, useRef, useState } from "react";
import { FileArrowUp, CheckCircle, Copy } from "./icons";
import { WorkspaceDialog } from "./WorkspaceDialog.jsx";
import { requestJson } from "./workspace-api.js";
import { MotionFeedback } from "./Motion.jsx";
import { conversionRequest } from "./conversion-request.js";

const PENDING_IMPORT_KEY = "continuous-reader:pending-import";

function readPendingImport() {
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING_IMPORT_KEY));
    if (typeof saved?.source?.sourceId !== "string" || typeof saved.source.filename !== "string" || !Number.isFinite(saved.source.size) || saved.source.size < 0) return null;
    return { source: saved.source, title: typeof saved.title === "string" ? saved.title : "", language: ["", "en", "zh-CN", "ja", "fr", "de"].includes(saved.language) ? saved.language : "" };
  } catch { return null; }
}

export function ImportDialog({ open, onClose }) {
  const [pending, setPending] = useState(readPendingImport);
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState(() => pending?.title || "");
  const [language, setLanguage] = useState(() => pending?.language || "");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef(null);

  useEffect(() => {
    try {
      if (pending) localStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify({ ...pending, title, language }));
      else localStorage.removeItem(PENDING_IMPORT_KEY);
    } catch { /* The uploaded original remains available through the service. */ }
  }, [pending, title, language]);

  function selectFile(next) {
    if (!next || uploading) return;
    if (next.size > 64 * 1024 * 1024) { setError("请选择不超过 64 MB 的文件。"); return; }
    setFile(next); setTitle(next.name.replace(/\.[^.]+$/, "")); setError(""); setPending(null); setCopied(false);
  }

  async function start(event) {
    event.preventDefault();
    if (!file || uploading || pending) return;
    setUploading(true); setError("");
    try {
      const source = await requestJson("/api/sources?filename=" + encodeURIComponent(file.name), {
        method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file,
      });
      setPending({ source, title, language });
    } catch (failure) { setError(failure.message); }
    finally { setUploading(false); }
  }

  async function copyRequest() {
    if (!pending) return;
    const request = conversionRequest(pending.source, { title, language });
    try { await navigator.clipboard.writeText(request); setCopied(true); setError(""); }
    catch { setError("暂时无法复制，请允许剪贴板访问后重试。"); }
  }

  function reset() {
    setFile(null); setTitle(""); setLanguage(""); setPending(null); setCopied(false); setError("");
    if (fileInput.current) fileInput.current.value = "";
  }

  const selected = file || pending?.source;
  return <WorkspaceDialog open={open} onClose={onClose} title="导入资料" busy={uploading}>
    <form onSubmit={start} className="workspace-form">
      <input ref={fileInput} type="file" accept=".pdf,.html,.htm,.md,.txt,.json" hidden onChange={(event) => selectFile(event.target.files?.[0])} />
      <button type="button" className={"workspace-dropzone" + (dragging ? " is-dragging" : "")} disabled={uploading} onClick={() => fileInput.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files[0]); }}>
        <FileArrowUp size={26} /><strong>{file?.name || pending?.source.filename || "选择文件，或拖到这里"}</strong><span>{selected ? (selected.size / 1024 / 1024).toFixed(2) + " MB · 点击更换" : "PDF、HTML、Markdown、文本或结构化 JSON · 最大 64 MB"}</span>
      </button>
      <label>资料名称<input value={title} onChange={(event) => { setTitle(event.target.value); setCopied(false); }} disabled={uploading} placeholder="使用文件名" maxLength={500} /></label>
      <label>原文语言<ReaderSelect value={language} onChange={(event) => { setLanguage(event.target.value); setCopied(false); }} disabled={uploading}><option value="">未指定</option><option value="en">English</option><option value="zh-CN">中文</option><option value="ja">日本語</option><option value="fr">Français</option><option value="de">Deutsch</option></ReaderSelect></label>
      <MotionFeedback show={Boolean(pending)}><div className="workspace-import-status" role="status"><CheckCircle size={18} /><div><strong>原文件已保存</strong><p>将转换请求交给 Agent。整理并核对后，结果会保存到资料库。</p></div></div></MotionFeedback>
      <MotionFeedback show={!pending}><p className="workspace-muted">保存原文件后，由 Agent 按阅读格式整理并核对。</p></MotionFeedback>
      <MotionFeedback show={Boolean(error)}><p role="alert" className="workspace-service-error">{error}</p></MotionFeedback>
      <footer>{uploading ? <span className="workspace-muted">正在保存原文件…</span> : pending ? <><button type="button" onClick={reset}>继续导入</button><button type="button" className="workspace-primary" onClick={copyRequest}><Copy size={15} />{copied ? "已复制转换请求" : "复制转换请求"}</button></> : <><button type="button" onClick={onClose}>取消</button><button type="submit" className="workspace-primary" disabled={!file}>准备转换</button></>}</footer>
    </form>
  </WorkspaceDialog>;
}
