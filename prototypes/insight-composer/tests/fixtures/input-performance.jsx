import React, { Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { Reader } from "../../src/App.jsx";
import { createPreviewReaderRuntime } from "../../src/reader-runtime.js";
import { ContinuousMotion } from "../../src/Motion.jsx";
import { IconStyleProvider } from "../../src/icons.jsx";
import { prepareReaderDocument } from "../../src/html-content.js";
import { attentionNotes } from "../../src/attention-example.js";
import "../../src/styles.css";

// A real bundled article, isolated memory preferences/drafts, and no API base.
const runtime = createPreviewReaderRuntime("input-performance", { view: { tocMode: "pinned", showMargins: true } });
runtime.mode = "fixture";
runtime.capabilities.insightWrites = true;
const paper = await prepareReaderDocument(await (await fetch("/articles/attention-is-all-you-need/document.json")).json());
paper.assetBase = "/articles/attention-is-all-you-need/";
const source = paper.blocks.find((block) => block.type === "para" && block.text?.length > 80);
const draft = { blockId: source.id, field: "text", variant: "source", start: 0, end: 40, quote: source.text.slice(0, 40), body: "", type: "annotation", color: "amber", revision: paper.revision };
runtime.sessionStorage.setItem("reader-draft:" + paper.id, JSON.stringify(draft));
window.performanceFixture = { runtime, paper, writes: [], renders: [], initialDraft: draft };
function Fixture() {
  const [notes, setNotes] = useState(attentionNotes(paper));
  const save = async (input, options) => {
    const saved = { ...input, id: input.id || "bench-note", reference: input.reference || "#N00999", version: (input.version || 0) + 1 };
    window.performanceFixture.writes.push(structuredClone({ input, options }));
    setNotes((current) => [...current.filter((note) => note.id !== saved.id), saved]);
    return saved;
  };
  return <Profiler id="reader" onRender={(id, phase, actualDuration, baseDuration) => window.performanceFixture.renders.push({ phase, actualDuration, baseDuration })}><Reader paper={paper} runtime={runtime} insightItems={notes} onSaveInsight={save} initialReadingState={{ mode: "bilingual" }} /></Profiler>;
}
createRoot(document.getElementById("root")).render(<React.StrictMode><ContinuousMotion><IconStyleProvider persist={false}><Fixture /></IconStyleProvider></ContinuousMotion></React.StrictMode>);
