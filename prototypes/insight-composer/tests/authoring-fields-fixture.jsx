import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PaperArticle } from "../src/PaperArticle.jsx";
import { ReaderToc } from "../src/ReaderToc.jsx";
import "../src/styles.css";

// Component-only fixture: no workspace profile, API or saved reading state.
const picture = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#ddd"/></svg>');
const paper = { meta: { title: "A bound on $x_i^2$", language: "en", translations: { "zh-CN": { title: "$x_i^2$ 的界", source_hash: "fixture" } } }, blocks: [
  { id: "heading-math", type: "heading", level: 1, text: "Proof for $x_i^2$ and [the table](#table-paired)", translations: { "zh-CN": { text: "$x_i^2$ 的证明与[表格](#table-paired)", source_hash: "fixture" } } },
  { id: "figure-translated", type: "figure", src: picture, alt: "Fixture", translations: { "zh-CN": { caption: "译文图注 $x_i^2$", source_hash: "fixture" } } },
  { id: "table-translated", type: "table", head: [["Value"]], rows: [["1"]], caption_pos: "above", translations: { "zh-CN": { caption: "译文表注 $x_i^2$", source_hash: "fixture" } } },
  { id: "figure-paired", type: "figure", src: picture, alt: "Fixture", caption: "Source figure caption", translations: { "zh-CN": { caption: "双语图注", source_hash: "fixture" } } },
  { id: "table-paired", type: "table", head: [["Value"]], rows: [["1"]], caption: "Source table caption", translations: { "zh-CN": { caption: "双语表注", source_hash: "fixture" } } },
], compiledTranslationStates: Object.fromEntries(["$meta", "heading-math", "figure-translated", "table-translated", "figure-paired", "table-paired"].map(id => [id, { "zh-CN": "current" }])) };

function Fixture() {
  const [mode, setMode] = useState("source"), [translationFirst, setTranslationFirst] = useState(false), [targetLanguage, setTargetLanguage] = useState("zh-CN");
  const [auxiliary, setAuxiliary] = useState(false);
  window.authoringFields = { setMode, setTranslationFirst, setTargetLanguage, setAuxiliary };
  const currentPaper = auxiliary ? { ...paper, blocks: paper.blocks.filter(block => block.type !== "heading"), navigation: { kind: "auxiliary", items: [{ targetId: "table-paired", text: "Plain auxiliary label", level: 1 }] } } : paper;
  return <main className="reader-app paper-reader"><aside><ReaderToc paper={currentPaper} mode={mode} targetLanguage={targetLanguage} /></aside><div className="article" style={{ maxWidth: 760, margin: "40px auto" }}>
    <PaperArticle paper={currentPaper} mode={mode} targetLanguage={targetLanguage} translationFirst={translationFirst} notes={[]} equation={() => null} />
  </div></main>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
