import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { MotionItem } from "./Motion.jsx";
import { requestJson } from "./workspace-api.js";
import { syncConflictRows, syncRecordPreview, syncRecordReferences } from "./sync-view.js";
import "./sync-settings.css";

function RecordPreview({ entity, value, documents, objects, positions, side }) {
  const preview = syncRecordPreview(entity, value, { documents, objects, positions });
  return <div className="sync-record-preview" tabIndex={0} aria-label={side + preview.label}><strong>{preview.title}</strong>{preview.lines.map((line, index) => <p key={index}>{line}</p>)}</div>;
}

function ConflictDetail({ conflict, documents, onResolve, busy }) {
  const [objects, setObjects] = useState({}), [positions, setPositions] = useState({}), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const rows = syncConflictRows(conflict), requiresEdit = conflict.source?.code === "SYNC_CONSTRAINT", resolved = conflict.status === "resolved";
  useEffect(() => {
    const controller = new AbortController();
    const references = syncRecordReferences(syncConflictRows(conflict));
    const requests = new Map();
    for (const row of syncConflictRows(conflict).filter((item) => item.entity === "reading")) for (const record of [row.value, row.remote]) {
      if (!record?.document_id || !record.payload) continue;
      try { const value = JSON.parse(record.payload); if (Number.isSafeInteger(value.revision)) requests.set(`${record.document_id}:${value.revision}`, `/api/documents/${encodeURIComponent(record.document_id)}?revision=${value.revision}`); } catch { /* The complete record is still retained for explicit resolution. */ }
    }
    setLoading(true); setError("");
    Promise.all([
      Promise.all(references.map(async (ref) => [ref.key, await requestJson(`/api/sync/client/objects/${ref.sha256}?kind=object&size=${ref.size}`, { signal: controller.signal })])),
      Promise.all([...requests].map(async ([key, url]) => [key, (await requestJson(url, { signal: controller.signal })).document])),
    ]).then(([entries, sourceDocuments]) => { if (!controller.signal.aborted) { setObjects(Object.fromEntries(entries)); setPositions(Object.fromEntries(sourceDocuments)); } })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [conflict.id, conflict.version]);
  return <div className="sync-conflict-detail">
    <div className={"sync-conflict-columns" + (requiresEdit ? " sync-conflict-local" : "")}><span>{requiresEdit ? "本机保留的修改" : "本机版本"}</span>{!requiresEdit && <span>保留的另一版本</span>}</div>
    {rows.map((row) => <section className="sync-conflict-pair" key={row.entity + row.key}><h4>{syncRecordPreview(row.entity, row.value).label}</h4><div className={"sync-conflict-columns" + (requiresEdit ? " sync-conflict-local" : "")}><RecordPreview entity={row.entity} value={row.value} documents={documents} objects={objects} positions={positions} side="本机版本" />{!requiresEdit && <RecordPreview entity={row.entity} value={row.remote} documents={documents} objects={objects} positions={positions} side="保留的另一版本" />}</div></section>)}
    {error && <p className="sync-settings-error" role="alert">{error}</p>}
    <p className="sync-conflict-help">{resolved ? `${conflict.resolution === "remote" ? "已采用另一版本" : "已保留本机版本"}${conflict.resolvedAt ? " · " + new Date(conflict.resolvedAt).toLocaleString() : ""}` : requiresEdit ? "历史记录存在约束冲突。本机内容已保留，请先修改重复内容。" : "这组关联修改会一并采用所选版本，另一份内容保留在本机冲突历史中。"}</p>
    {!resolved && !requiresEdit && <div className="sync-conflict-actions"><button disabled={busy || loading || Boolean(error)} onClick={() => onResolve(conflict, "local")}>保留本机版本</button><button disabled={busy || loading || Boolean(error)} onClick={() => onResolve(conflict, "remote")}>采用另一版本</button></div>}
  </div>;
}

export function LocalHistoryConflicts({ active, conflicts, initialError, onChange }) {
  const [documents, setDocuments] = useState({});
  const [selected, setSelected] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const activeRef = useRef(active), refreshButton = useRef(null), actionPending = useRef(false), focusAfterAction = useRef(false);
  activeRef.current = active;
  useEffect(() => {
    if (!active || !conflicts.length) return;
    const controller = new AbortController();
    requestJson("/api/workspace?includeArchived=1", { signal: controller.signal }).then((workspace) => {
      if (!controller.signal.aborted) setDocuments(Object.fromEntries(workspace.documents.map((item) => [item.id, item])));
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [active, conflicts]);
  useEffect(() => {
    if (!active || busy || !focusAfterAction.current) return;
    focusAfterAction.current = false;
    refreshButton.current?.focus({ preventScroll: true });
  }, [active, busy]);
  async function action(body) {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true); setError("");
    try {
      if (body) await requestJson("/api/sync/client/resolve", { method: "POST", body, signal: AbortSignal.timeout(10000) });
      const saved = await requestJson("/api/sync/client/conflicts", { signal: AbortSignal.timeout(10000) });
      onChange(saved.conflicts || []);
    } catch (failure) { if (activeRef.current) setError(failure.message); }
    finally { actionPending.current = false; focusAfterAction.current = activeRef.current; setBusy(false); }
  }
  const pending = conflicts.filter((conflict) => conflict.status !== "resolved").length;
  return <div className="sync-settings">
    <div className="sync-settings-heading"><p role="status" aria-live="polite">{pending ? `${pending} 组历史冲突待处理` : initialError || error ? "历史冲突读取失败" : "历史冲突已处理"}</p><button ref={refreshButton} disabled={busy} onClick={() => action()}>重新读取</button></div>
    {(error || initialError) && <p className="sync-settings-error" role="alert">{error || initialError}</p>}
    {conflicts.length > 0 && <section className="sync-conflicts"><AnimatePresence initial={false} mode="popLayout">{conflicts.map((conflict) => {
      const row = syncConflictRows(conflict)[0], preview = row ? syncRecordPreview(row.entity, row.value, { documents }) : { title: "关联修改" };
      const expanded = selected === conflict.id;
      return <MotionItem as="article" className="sync-conflict" key={conflict.id}><button className="sync-conflict-toggle" aria-expanded={expanded} aria-controls={"sync-conflict-" + conflict.id} onClick={() => setSelected(expanded ? null : conflict.id)}><span>{preview.title}</span><span>{expanded ? "收起" : conflict.status === "resolved" ? "已处理 · 查看" : "比较"}</span></button><AnimatePresence initial={false}>{expanded && <MotionItem as="div" layout={false} key={"detail-" + conflict.id} id={"sync-conflict-" + conflict.id}><ConflictDetail conflict={conflict} documents={documents} busy={busy} onResolve={(value, choice) => action({ id: value.id, choice, expectedVersion: value.version })} /></MotionItem>}</AnimatePresence></MotionItem>;
    })}</AnimatePresence></section>}
  </div>;
}
