import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MaterialDetails } from "../../src/workspace/MaterialDetails.jsx";
import { DocumentForm } from "../../src/workspace/CollectionForms.jsx";
import { WorkspaceDialog } from "../../src/workspace/shared.jsx";
import { ReaderSelect } from "../../src/ReaderSelect.jsx";
import { ContinuousMotion } from "../../src/Motion.jsx";
import "../../src/styles.css";
import "../../src/workspace/workspace.css";
import "../../src/workspace/flow.css";

// Synthetic records and callbacks stay in memory; no profile or API is used.
const initial = { id: "select-fixture", title: "WEBB SPACE TELESCOPE", kind: "PDF", status: "reading", summary: "Synthetic document for picker verification.", collectionIds: [], tags: [], version: 1 };
window.selectFixture = { writes: [], saves: 0 };
function Fixture() {
  const [material, setMaterial] = useState(initial);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ ...initial, tagsText: "" });
  const [filter, setFilter] = useState("");
  const [optionCount, setOptionCount] = useState(40);
  const [showFilter, setShowFilter] = useState(true);
  const workspace = { documents: [material], collections: [], planIds: [] };
  return <ContinuousMotion><main className="workspace-ui" style={{ padding: 32, display: "flex", gap: 64, alignItems: "flex-start" }}>
    <section style={{ width: 306 }}>
      <MaterialDetails material={material} workspace={workspace} pending={pending} onRead={() => {}} onPlan={() => {}} onStatus={(item, status) => { window.selectFixture.writes.push({ id: item.id, version: item.version, status }); setMaterial({ ...item, status }); }} />
      <button type="button" onClick={() => setPending(!pending)}>切换禁用</button>
      <button type="button" onClick={() => setOpen(true)}>编辑资料</button>
    </section>
    <section className="flow-filter-options" style={{ display: "block", width: 240 }}>
      {showFilter && <label>按文章筛选洞见<ReaderSelect ref={element => { window.selectFixture.filterElement = element; }} className="flow-document-filter" value={filter} onChange={event => setFilter(event.target.value)}><option value="">全部文章</option>{Array.from({ length: optionCount }, (_, index) => <option key={index} value={String(index)}>Article {index + 1}: A long document title with enough words to verify wrapping inside the picker.</option>)}</ReaderSelect></label>}
      <button type="button" style={{ display: "block", marginTop: 24 }}>后续按钮</button>
      <button type="button" onClick={() => { setOptionCount(optionCount === 40 ? 2 : 40); setFilter("0"); }}>改变文章选项</button>
      <button type="button" onClick={() => setShowFilter(!showFilter)}>切换文章筛选</button>
      <p data-filter-value>{filter}</p>
    </section>
    <WorkspaceDialog open={open} title="编辑资料" onClose={() => setOpen(false)}>
      <DocumentForm workspace={workspace} draft={draft} onChange={patch => setDraft({ ...draft, ...patch })} onSubmit={() => { window.selectFixture.saves++; }} onCancel={() => setOpen(false)} pending={false} />
    </WorkspaceDialog>
  </main></ContinuousMotion>;
}
createRoot(document.getElementById("root")).render(<React.StrictMode><Fixture /></React.StrictMode>);
