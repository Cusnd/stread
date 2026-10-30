import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CollectionPage } from "../../src/workspace/CollectionPage.jsx";
import { ContinuousMotion } from "../../src/Motion.jsx";
import { ReaderRuntimeProvider } from "../../src/ReaderRuntime.jsx";
import { createPreviewReaderRuntime } from "../../src/reader-runtime.js";
import "../../src/styles.css";
import "../../src/workspace/workspace.css";

// Real Collection components with delayed, in-memory commands; no saved data.
const percent = Number(new URLSearchParams(location.search).get("scale") || 80);
document.documentElement.style.setProperty("--ui-scale", String(percent / 80));
const runtime = createPreviewReaderRuntime("collection-plan-feedback", { uiScale: { percent } });
const material = { id: "plan-feedback", title: "Deep Residual Learning for Image Recognition", kind: "论文", status: "reading", tags: [], collectionIds: [], version: 1 };
window.planFeedback = { delay: 200, failNext: false, commands: [], reads: [] };
function Fixture() {
  const [workspace, setWorkspace] = useState({ documents: [material], collections: [], planIds: [material.id], planVersion: 1, revision: 1 });
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  window.planFeedback.getWorkspace = () => workspaceRef.current;
  const [view, setView] = useState({ collectionId: "all", selectedId: material.id, navigationExpanded: true });
  const [busy, setBusy] = useState(false);
  async function command(input) {
    window.planFeedback.commands.push(input);
    setBusy(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, window.planFeedback.delay));
      if (window.planFeedback.failNext) { window.planFeedback.failNext = false; throw new Error("Synthetic save failure"); }
      const current = workspaceRef.current;
      let next;
      if (input.kind === "document.update") {
        const document = current.documents.find((item) => item.id === input.documentId);
        if (!document || input.expectedVersion !== document.version) throw new Error("Synthetic document version conflict");
        if (!Object.hasOwn(input.patch || {}, "status") || !["unread", "reading", "done"].includes(input.patch.status)) throw new Error("Unsupported fixture document update");
        next = { ...current, documents: current.documents.map((item) => item.id === input.documentId ? { ...item, status: input.patch.status, version: item.version + 1 } : item), revision: current.revision + 1 };
      } else if (input.kind === "plan.add" || input.kind === "plan.remove") {
        next = { ...current, planIds: input.kind === "plan.add" ? [...new Set([...current.planIds, input.documentId])] : current.planIds.filter((id) => id !== input.documentId), planVersion: current.planVersion + 1, revision: current.revision + 1 };
      } else throw new Error("Unsupported fixture command: " + input.kind);
      workspaceRef.current = next;
      setWorkspace(next);
      return { revision: next.revision };
    } finally { setBusy(false); }
  }
  return <><header style={{ height: 56 * percent / 80 }}>Collection</header><CollectionPage workspace={workspace} view={view} setView={setView} busy={busy} command={command} openDocument={async (...args) => { window.planFeedback.reads.push(args); }} /></>;
}
createRoot(document.getElementById("root")).render(<React.StrictMode><ReaderRuntimeProvider value={runtime}><ContinuousMotion><Fixture /></ContinuousMotion></ReaderRuntimeProvider></React.StrictMode>);
