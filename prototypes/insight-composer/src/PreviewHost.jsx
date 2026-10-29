import { useEffect, useMemo, useRef, useState } from "react";
import { Reader } from "./App.jsx";
import { prepareReaderDocument } from "./html-content.js";
import { createPreviewReaderRuntime } from "./reader-runtime.js";
import { waitForInitialPreviewRender } from "./reader-preview-ready.js";
import { requestJson } from "./workspace-api.js";
import { previewAccessUrl } from "./preview-access-url.js";
import { createVisiblePoller } from "./visible-poller.js";
import "./reader-preview.css";

const EMPTY = Object.freeze([]);
const validId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
function PreviewProblems({ error }) {
  const diagnostics = Array.isArray(error.details?.diagnostics) ? error.details.diagnostics : EMPTY;
  return <details className="reader-preview-problems"><summary>查看问题</summary><div>
    <p>{error.message || error.error || "请根据校验诊断修复作者输入。"}</p>
    {diagnostics.length > 0 && <ul>{diagnostics.map((problem, index) => <li key={index}>
      <div className="reader-preview-problem-location">{problem.code && <code>{problem.code}</code>}{problem.key && <code>{problem.key}</code>}{problem.path && <code>{problem.path}</code>}</div>
      {problem.message && <p>{problem.message}</p>}{problem.hint && <p>{problem.hint}</p>}
    </li>)}</ul>}
  </div></details>;
}
export function PreviewHost({ previewId, draftId }) {
  const identity = draftId || previewId;
  const access = useMemo(() => new URLSearchParams(window.location.search).get("access"), [identity]);
  const runtime = useMemo(() => createPreviewReaderRuntime(identity || "invalid-preview"), [identity]);
  const [record, setRecord] = useState(null);
  const [error, setError] = useState("");
  const [renderError, setRenderError] = useState("");
  const [draftError, setDraftError] = useState(null);
  const [draftVersion, setDraftVersion] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState({ state: "loading", hash: null, imageCount: 0 });
  const host = useRef(null), current = useRef(null);
  const checkpoint = useRef(null);

  useEffect(() => {
    if (!validId(identity)) { setError("预览地址无效。"); return; }
    const controller = new AbortController(); let lastEnvelope;
    const base = `/api/authoring/${draftId ? "drafts" : "previews"}/${encodeURIComponent(identity)}`;
    async function load(signal) {
        const envelope = await requestJson(previewAccessUrl(base, access), { signal, conditional: true });
        if (signal.aborted) return false;
        const changed = envelope !== lastEnvelope; lastEnvelope = envelope;
        const lastError = envelope.draft?.lastError || null;
        setDraftError((previous) => JSON.stringify(previous) === JSON.stringify(lastError) ? previous : lastError);
        setDraftVersion(envelope.draft?.version ?? null);
        if (!envelope.preview || !envelope.document) {
          if (!current.current) setError("草稿尚无通过检查的版本。");
          return changed;
        }
        const preview = envelope.preview;
        if (envelope.readOnly !== true || !validId(preview.id) || typeof preview.hash !== "string" || (!draftId && preview.id !== previewId)) throw new Error("预览响应与请求的候选版本不一致。");
        if (current.current?.preview.id === preview.id && current.current.preview.hash === preview.hash) { setError(""); return changed; }
        setReady({ state: "preparing", hash: preview.hash, imageCount: 0 }); setRenderError("");
        const document = await prepareReaderDocument(envelope.document);
        if (signal.aborted) return false;
        const resourceBase = `/api/authoring/previews/${encodeURIComponent(preview.id)}`;
        const next = { preview, sourceApiBase: resourceBase,
          paper: { ...document, assetBase: envelope.assetBase || resourceBase + "/assets/", previewAccess: access, sessionKey: "preview:" + identity, sampleNotes: EMPTY } };
        current.current = next; setRecord(next); setError(""); return true;
    }
    const showFailure = (failure) => { if (failure.name !== "AbortError") setError(failure.message || "预览暂时无法加载。"); };
    if (!draftId) { void load(controller.signal).catch(showFailure); return () => controller.abort(); }
    const poller = createVisiblePoller({ run: load, isVisible: () => document.visibilityState !== "hidden", intervalMs: 1000, maxIntervalMs: 15000, onError: showFailure });
    poller.start();
    document.addEventListener("visibilitychange", poller.wake); window.addEventListener("focus", poller.wake);
    return () => { controller.abort(); poller.dispose(); document.removeEventListener("visibilitychange", poller.wake); window.removeEventListener("focus", poller.wake); };
  }, [identity, previewId, draftId, access, attempt]);

  useEffect(() => {
    if (!record || !host.current) return;
    const controller = new AbortController();
    const hash = record.preview.hash;
    setReady({ state: "waiting-assets", hash, imageCount: 0 }); setRenderError("");
    waitForInitialPreviewRender(host.current, controller.signal).then((result) => {
      if (!controller.signal.aborted) setReady({ state: "ready", hash, imageCount: result.imageCount });
    }).catch((failure) => {
      if (failure.name !== "AbortError") { setReady({ state: "asset-error", hash, imageCount: 0 }); setRenderError(failure.message); }
    });
    return () => controller.abort();
  }, [record, attempt]);

  if (!record) return <main className="paper-loading" data-preview-ready="false" data-preview-state="loading" data-draft-error={draftError ? "true" : undefined} aria-live="polite"><p>{error || "正在打开草稿预览…"}</p>{draftError && <PreviewProblems error={draftError} />}{error && <button onClick={() => setAttempt((value) => value + 1)}>重新加载</button>}</main>;
  return <div ref={host} className="reader-preview-host" data-preview-id={record.preview.id} data-preview-hash={record.preview.hash} data-draft-id={draftId || undefined} data-draft-version={draftVersion} data-draft-error={draftError ? "true" : undefined}
    data-preview-ready={ready.state === "ready" && ready.hash === record.preview.hash ? "true" : "false"} data-preview-state={ready.state} data-preview-ready-scope="initial-viewport" data-preview-image-count={ready.imageCount}>
    <Reader key={identity} paper={record.paper} runtime={runtime} insightItems={EMPTY} changeRequestItems={EMPTY} readOnly sourceApiBase={record.sourceApiBase}
      initialReadingState={checkpoint.current} onReadingStateChange={(value) => { checkpoint.current = value; }} onBack={() => window.location.assign("/")} />
    {(error || renderError || draftError) && <div className="reader-preview-error" role="alert"><span>{error || renderError || "新版本未通过检查，保留上次预览。"}</span>
      {draftError && <PreviewProblems error={draftError} />}
      {(error || renderError) && <button onClick={() => setAttempt((value) => value + 1)}>重试</button>}</div>}
  </div>;
}
