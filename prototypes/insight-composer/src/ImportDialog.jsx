import { ReaderSelect } from "./ReaderSelect.jsx";
import { useEffect, useRef, useState } from "react";
import { FileArrowUp, CheckCircle } from "./icons";
import { WorkspaceDialog } from "./WorkspaceDialog.jsx";
import { executeCommand, requestJson } from "./workspace-api.js";
import { MotionFeedback } from "./Motion.jsx";
import { CONVERSION_REQUIREMENTS } from "./conversion-request.js";
import { definiteImportRejection, importQueueCommand, readPendingImport, savePendingImport } from "./import-queue.js";

const pendingStorage = () => { try { return globalThis.localStorage; } catch { return undefined; } };

export function ImportDialog({ open, onClose, command = executeCommand, onQueued, initialDraft }) {
  const [pending, setPending] = useState(() => readPendingImport(pendingStorage()));
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState(() => pending?.title || "");
  const [language, setLanguage] = useState(() => pending?.language || "");
  const [body, setBody] = useState(() => pending?.body || CONVERSION_REQUIREMENTS);
  const [outputLanguages, setOutputLanguages] = useState(() => pending?.outputLanguages);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);
  const wasOpen = useRef(false);
  const submitting = useRef(false);
  const frozen = Boolean(pending?.queueCommand);

  useEffect(() => {
    if (open && !wasOpen.current && initialDraft && !pending?.queueCommand) {
      if (initialDraft.title) setTitle(initialDraft.title);
      if (initialDraft.language || initialDraft.sourceLanguage) setLanguage(initialDraft.language || initialDraft.sourceLanguage);
      if (initialDraft.body) setBody(initialDraft.body);
      setOutputLanguages(initialDraft.outputLanguages);
    }
    wasOpen.current = open;
  }, [open, initialDraft, pending?.queueCommand]);

  useEffect(() => { savePendingImport(pendingStorage(), pending ? { ...pending, title, language, body, outputLanguages } : null); }, [pending, title, language, body, outputLanguages]);

  function selectFile(next) {
    if (!next || submitting.current || frozen) return;
    if (next.size > 64 * 1024 * 1024) { setError("请选择不超过 64 MB 的文件。"); return; }
    if (!/\.(pdf|html?|md|txt|json)$/i.test(next.name)) { setError("请选择 PDF、HTML、Markdown、文本或结构化 JSON。"); return; }
    if (!next.size) { setError("文件为空，请选择有内容的文件。"); return; }
    setFile(next); setTitle(next.name.replace(/\.[^.]+$/, "")); setError(""); setPending(null);
  }

  async function start(event) {
    event.preventDefault();
    if ((!file && !pending) || submitting.current) return;
    submitting.current = true; setUploading(true); setError("");
    let retained = pending;
    try {
      if (!retained) {
        const source = await requestJson("/api/sources?filename=" + encodeURIComponent(file.name), {
          method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file,
        });
        retained = { source, title, language, body, outputLanguages };
        savePendingImport(pendingStorage(), retained); setPending(retained);
      }
      const queueCommand = importQueueCommand(retained, { title, language, body, outputLanguages, requestId: crypto.randomUUID() });
      retained = { ...retained, title, language, body, outputLanguages, queueCommand };
      savePendingImport(pendingStorage(), retained); setPending(retained);
      const receipt = await command(queueCommand);
      setPending(null); savePendingImport(pendingStorage(), null); setFile(null); setTitle(""); setLanguage(""); setBody(CONVERSION_REQUIREMENTS); setOutputLanguages(undefined);
      if (fileInput.current) fileInput.current.value = "";
      if (onQueued) onQueued(receipt.task);
      else onClose();
    } catch (failure) {
      if (retained && definiteImportRejection(failure)) {
        const { queueCommand: _command, ...saved } = retained;
        setPending(saved); savePendingImport(pendingStorage(), saved);
      }
      setError(failure.message || "暂时无法保存，请重试以确认任务是否已入队。");
    } finally { submitting.current = false; setUploading(false); }
  }

  const selected = file || pending?.source;
  return <WorkspaceDialog open={open} onClose={onClose} title="源文件转换" busy={uploading}>
    <form onSubmit={start} className="workspace-form">
      <input ref={fileInput} type="file" accept=".pdf,.html,.htm,.md,.txt,.json" hidden onChange={(event) => selectFile(event.target.files?.[0])} />
      <button type="button" className={"workspace-dropzone" + (dragging ? " is-dragging" : "")} disabled={uploading || frozen} onClick={() => fileInput.current?.click()} onDragOver={(event) => { event.preventDefault(); if (!uploading && !frozen) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); selectFile(event.dataTransfer.files[0]); }}>
        <FileArrowUp size={26} /><strong>{file?.name || pending?.source.filename || "选择文件，或拖到这里"}</strong><span>{selected ? (selected.size / 1024 / 1024).toFixed(2) + " MB" : "PDF、HTML、Markdown、文本或结构化 JSON · 最大 64 MB"}</span>
      </button>
      <label>资料名称<input value={title} onChange={(event) => setTitle(event.target.value)} disabled={uploading || frozen} placeholder="使用文件名" maxLength={500} /></label>
      <label>原文语言<ReaderSelect value={language} onChange={(event) => setLanguage(event.target.value)} disabled={uploading || frozen}><option value="">未指定</option><option value="en">English</option><option value="zh-CN">中文</option><option value="ja">日本語</option><option value="fr">Français</option><option value="de">Deutsch</option></ReaderSelect></label>
      <label>转换要求<textarea value={body} onChange={(event) => setBody(event.target.value)} disabled={uploading || frozen} maxLength={10000} rows={3} /></label>
      <label>输出语言<ReaderSelect value={(outputLanguages || (language === "zh-CN" ? ["source"] : ["source", "zh-CN"])).includes("zh-CN") ? "bilingual" : "source"} onChange={(event) => setOutputLanguages(event.target.value === "source" ? ["source"] : ["source", "zh-CN"])} disabled={uploading || frozen}><option value="bilingual">原文 + 简体中文</option><option value="source">仅原文</option></ReaderSelect></label>
      <MotionFeedback show={Boolean(pending)}><div className="workspace-import-status" role="status"><CheckCircle size={18} /><div><strong>原文件已保存</strong>{frozen && <p>重试会确认同一项任务，不会重复入队。</p>}</div></div></MotionFeedback>
      <MotionFeedback show={Boolean(error)}><p role="alert" className="workspace-service-error">{error}</p></MotionFeedback>
      <footer><button type="button" onClick={onClose} disabled={uploading}>取消</button><button type="submit" className="workspace-primary" disabled={uploading || (!file && !pending)}>{uploading ? "正在保存…" : frozen ? "重试入队" : "加入队列"}</button></footer>
    </form>
  </WorkspaceDialog>;
}
