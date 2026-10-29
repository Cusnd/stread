import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ContinuousMotion } from "../../src/Motion.jsx";
import { CollectionPage } from "../../src/workspace/CollectionPage.jsx";
import { ReaderRuntimeProvider } from "../../src/ReaderRuntime.jsx";
import { createPreviewReaderRuntime } from "../../src/reader-runtime.js";
import "../../src/styles.css";
import "../../src/workspace/workspace.css";

// In-memory UI fixture: no workspace API, saved documents or activity writes.
const params = new URLSearchParams(location.search);
const count = Number(params.get("count") || 6);
const percent = Number(params.get("scale") || 80);
const runtime = createPreviewReaderRuntime("collection-transitions", { uiScale: { percent } });
document.documentElement.style.setProperty("--ui-scale", String(percent / 80));
const documents = Array.from({ length: count }, (_, index) => ({
  id: `fixture-${index}`, title: index ? `Reading document ${index}` : "WEBB SPACE TELESCOPE", kind: "PDF",
  status: index ? "reading" : "unread", tags: [], collectionIds: index ? ["science"] : [],
  summary: "Synthetic document for layout verification.", version: 1,
}));
const workspace = { documents, collections: [{ id: "science", label: "科学", parentId: null }], planIds: documents.slice(1).map((item) => item.id) };
function Fixture() {
  const [view, setView] = useState({ collectionId: "all", status: "reading", navigationExpanded: true });
  return <><header style={{ height: 56 * percent / 80 }}>Collection</header><CollectionPage workspace={workspace} view={view} setView={setView} command={async () => { throw new Error("Fixture cannot write"); }} openDocument={async () => {}} /></>;
}
createRoot(document.getElementById("root")).render(<React.StrictMode><ReaderRuntimeProvider value={runtime}><ContinuousMotion><Fixture /></ContinuousMotion></ReaderRuntimeProvider></React.StrictMode>);
