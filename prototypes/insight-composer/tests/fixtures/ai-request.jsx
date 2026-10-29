import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Reader } from "../../src/App.jsx";
import { createPreviewReaderRuntime } from "../../src/reader-runtime.js";
import { ContinuousMotion } from "../../src/Motion.jsx";
import { IconStyleProvider } from "../../src/icons.jsx";
import { prepareReaderDocument } from "../../src/html-content.js";
import "../../src/styles.css";

// All commands and preferences remain in memory; this fixture has no API base.
const runtime = createPreviewReaderRuntime("ai-request-scope", { view: { tocMode: "hidden", showMargins: false } });
runtime.mode = "fixture";
runtime.capabilities.insightWrites = true;
const paper = await prepareReaderDocument({
  format: "continous-reader", schema: 1, id: "ai-request-fixture", revision: 3,
  meta: { title: "AI request scope fixture", language: "en" },
  assetBase: "/articles/attention-is-all-you-need/",
  blocks: [
    { id: "intro", type: "para", text: "Alpha beta gamma delta. Download the related article for context.", translations: { "zh-CN": { text: "甲乙丙丁。这篇文章讨论整体研究思路。" } } },
    { id: "second", type: "para", text: "Another paragraph for independent request targeting.", translations: { "zh-CN": { text: "另一个段落用于验证请求范围。" } } },
    { id: "items", type: "list", ordered: false, items: [{ id: "item-one", text: "First stable list source", translations: { "zh-CN": { text: "第一条稳定的列表来源" } } }] },
    { id: "table-one", type: "table", caption: "Table caption", head: [["Method", "Score"]], rows: [["Stable cell alpha", "42"]], translations: { "zh-CN": { caption: "表格标题", head: [["方法", "得分"]], rows: [["稳定单元格甲", "42"]] } } },
    { id: "figure-one", type: "figure", src: "figures/figure-1.png", alt: "Architecture diagram", caption: "Architecture figure caption", translations: { "zh-CN": { caption: "架构图题注", alt: "架构图" } } },
    { id: "figure-no-caption", type: "figure", src: "figures/figure-4.png", alt: "Attention visualization without caption" },
  ],
});
const empty = Object.freeze([]);
window.aiRequestFixture = { writes: [], runtime, paper };
function Fixture() {
  const [requests, setRequests] = useState([]);
  const saveRequest = async (input, expectedVersion, options) => {
    window.aiRequestFixture.writes.push(structuredClone({ input, expectedVersion, options }));
    const saved = { ...input, id: input.id || "request-" + (requests.length + 1), reference: "#R" + String(requests.length + 1).padStart(5, "0"), status: "pending", version: (expectedVersion || 0) + 1 };
    setRequests((current) => [...current.filter((item) => item.id !== saved.id), saved]);
    return saved;
  };
  return <><Reader paper={paper} runtime={runtime} insightItems={empty} changeRequestItems={requests} onSaveChangeRequest={saveRequest} readOnly={new URLSearchParams(location.search).has("readonly")} /><input aria-label="快捷键隔离输入" style={{ position: "fixed", bottom: 8, left: 8, width: 120, zIndex: 20 }} /></>;
}
createRoot(document.getElementById("root")).render(<React.StrictMode><ContinuousMotion><IconStyleProvider persist={false}><Fixture /></IconStyleProvider></ContinuousMotion></React.StrictMode>);
