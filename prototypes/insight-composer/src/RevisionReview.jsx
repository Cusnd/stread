import { ReaderSelect } from "./ReaderSelect.jsx";
import { useState } from "react";
import { WorkspaceDialog } from "./WorkspaceDialog.jsx";
import { InlineContent } from "./InlineContent.jsx";
import { MotionFeedback } from "./Motion.jsx";

function printable(value) { return value === null || value === undefined ? "（无）" : typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function relationSummary(relation) {
  if (!relation) return "尚未关联";
  if (relation.status === "dismissed") return "已解除关联，暂停自动匹配";
  const targets = relation.targetDocuments?.map((item) => item.title).filter(Boolean);
  if (targets?.length) return targets.join("\n");
  return relation.status === "candidate" ? "有候选文献，尚未确认" : "尚未关联资料库中的文章";
}
function changeValue(proposal, operation, side, index) {
  if (proposal.changes?.[index] && Object.hasOwn(proposal.changes[index], side)) return proposal.changes[index][side];
  const snapshot = proposal[side];
  if (!snapshot) return side === "after" ? operation.value ?? operation.block ?? operation : "";
  const blocks = snapshot.blocks || snapshot.document?.blocks;
  if (!blocks) return snapshot;
  const block = blocks.find((item) => item.id === (operation.blockId || operation.block?.id));
  if (!block) return "（不存在）";
  const item = operation.itemId ? block.items?.find((entry) => entry.id === operation.itemId) : block;
  const variant = operation.variant && operation.variant !== "source" ? item?.translations?.[operation.variant] : item;
  if (operation.nodeId) return variant?.html || block.html || variant;
  const value = operation.field ? variant?.[operation.field] : variant;
  return Number.isInteger(operation.row) ? value?.[operation.row]?.[operation.column] : value;
}

export function RevisionReview({ open, onClose, proposals, workspace, command, refresh }) {
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = proposals.filter((item) => item.status === "pending" || item.status === "proposed");
  const proposal = pending.find((item) => item.id === selected) || pending[0];
  async function decide(kind) {
    setBusy(true); setError("");
    try { await command({ kind, proposalId: proposal.id }); await refresh(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <WorkspaceDialog open={open} onClose={onClose} title="待审阅修订" wide busy={busy}>
    {!proposal ? <p className="workspace-empty">没有等待审阅的修订。</p> : <div className="workspace-review">
      {pending.length > 1 && <label>选择修订<ReaderSelect value={proposal.id} onChange={(event) => { setSelected(event.target.value); setError(""); }}>{pending.map((item) => <option value={item.id} key={item.id}>{workspace.documents.find((doc) => doc.id === item.documentId)?.title || item.documentId} · {item.id.slice(-8)}</option>)}</ReaderSelect></label>}
      <h3>{workspace.documents.find((doc) => doc.id === proposal.documentId)?.title || proposal.documentId}</h3>
      {proposal.kind === "relation" ? <section className="workspace-change">
        <h4>{({ "relation.link": "关联文献", "relation.dismiss": "解除关联", "relation.reset": "恢复自动匹配" })[proposal.operations[0]?.kind] || "调整文献关联"}</h4>
        <p><InlineContent text={proposal.before?.raw || proposal.after?.raw || proposal.before?.title || proposal.after?.title || ""} /></p>
        <div className="workspace-diff"><div><small>修改前</small><p style={{ whiteSpace: "pre-line" }}>{relationSummary(proposal.before)}</p></div><div><small>修改后</small><p style={{ whiteSpace: "pre-line" }}>{relationSummary(proposal.after)}</p></div></div>
      </section> : <><p className="workspace-muted">基于正文版本 {proposal.expectedRevision} · {proposal.operations.length} 处修改</p>
        {proposal.operations.map((operation, index) => <section className="workspace-change" key={index}><h4>{({ replace: "替换内容", insert: "插入补充", remove: "移除内容", move: "调整顺序" })[operation.kind || operation.type || operation.op] || "修改内容"}<code>{operation.blockId || operation.afterBlockId || operation.beforeBlockId}</code>{operation.variant && <span>{operation.variant}</span>}</h4><div className="workspace-diff"><div><small>修改前</small><pre>{printable(changeValue(proposal, operation, "before", index))}</pre></div><div><small>修改后</small><pre>{printable(changeValue(proposal, operation, "after", index))}</pre></div></div></section>)}
      </>}
      <MotionFeedback show={Boolean(error)}><p className="workspace-service-error" role="alert">{error}</p></MotionFeedback><footer><button disabled={busy} onClick={() => decide("proposal.reject")}>拒绝</button><button disabled={busy} className="workspace-primary" onClick={() => decide("proposal.accept")}>接受这份修订</button></footer>
    </div>}
  </WorkspaceDialog>;
}
