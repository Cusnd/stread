import React, { useState } from "react";
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
  const [workspace, setWorkspace] = useState({ documents: [material], collections: [], planIds: [material.id], planVersion: 1 });
  const [view, setView] = useState({ collectionId: "all", selectedId: material.id, navigationExpanded: true });
  const [busy, setBusy] = useState(false);
  async function command(input) {
    window.planFeedback.commands.push(input);
    setBusy(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, window.planFeedback.delay));
      if (window.planFeedback.failNext) { window.planFeedback.failNext = false; throw new Error("Synthetic save failure"); }
      setWorkspace((current) => ({ ...current, planIds: input.kind === "plan.add" ? [material.id] : [], planVersion: current.planVersion + 1 }));
    } finally { setBusy(false); }
  }
  return <><header style={{ height: 56 * percent / 80 }}>Collection</header><CollectionPage workspace={workspace} view={view} setView={setView} busy={busy} command={command} openDocument={async (...args) => { window.planFeedback.reads.push(args); }} /></>;
}
createRoot(document.getElementById("root")).render(<React.StrictMode><ReaderRuntimeProvider value={runtime}><ContinuousMotion><Fixture /></ContinuousMotion></ReaderRuntimeProvider></React.StrictMode>);
