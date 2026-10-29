import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerSurface, ComposerTextarea, ComposerTitleField, ComposerActions } from "../src/ComposerSurface.jsx";
import { ContinuousMotion } from "../src/Motion.jsx";
import "../src/styles.css";

// Isolated layout fixture: no Reader profile, workspace API, or persisted data.
function Fixture() {
  const [draft, setDraft] = useState({ type: "annotation", body: "", title: "" });
  const [titleExpanded, setTitleExpanded] = useState(false);
  const [width, setWidth] = useState(640);
  const [closing, setClosing] = useState(false);
  const composerRef = useRef(null), inputRef = useRef(null), titleRef = useRef(null);
  window.composerFixture = { setDraft, setTitleExpanded, setWidth, setClosing, read: () => draft };
  return <ContinuousMotion><main className="reader-app">
    <header className="topbar" style={{ height: 56 }}>Composer layout regression</header>
    <ComposerSurface draft={draft} closing={closing} position={{ left: 100, top: 200, width }} composerRef={composerRef} inputRef={inputRef} titleExpanded={titleExpanded} onSave={() => { window.savedComposerDraft = draft; }}>
      {titleExpanded && <ComposerTitleField title={draft.title} titleRef={titleRef} inputRef={inputRef} onChange={title => setDraft(current => ({ ...current, title }))} />}
      <div className="composer-input">
        <ComposerTextarea ref={inputRef} rows={1} aria-label="洞见内容" value={draft.body} onChange={event => setDraft(current => ({ ...current, body: event.target.value }))} />
        <ComposerActions><button onClick={() => setTitleExpanded(true)}>添加标题</button></ComposerActions>
      </div>
    </ComposerSurface>
  </main></ContinuousMotion>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
