// Disposable in-memory Reader documents; this fixture never opens a saved library.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Reader } from "../../src/App.jsx";
import { createPreviewReaderRuntime } from "../../src/reader-runtime.js";
import { ContinuousMotion } from "../../src/Motion.jsx";
import { IconStyleProvider } from "../../src/icons.jsx";
import { HTML_PROFILE, prepareReaderDocument } from "../../src/html-content.js";
import "../../src/styles.css";

const text = "A continuous paragraph keeps its original identity. Reading navigation can point here without adding a source heading. ";
const blocks = Array.from({ length: 28 }, (_, index) => ({ id: `para-${index}`, type: "para", text: `${index + 1}. ${text.repeat(4)}` }));
blocks[8] = { id: "equation", type: "math", tex: "E=\\frac{1}{2}\\sum_j(y_j-d_j)^2", num: "1" };
blocks[16] = { id: "html", type: "html", html_profile: HTML_PROFILE, html: '<p data-node-id="meaning">An authored HTML paragraph remains an independent source.</p>' };
const base = { format: "continous-reader", schema: 2, id: "navigation-fixture", revision: 1, meta: { title: "Navigation fixture", language: "en" }, blocks };
const auxiliary = { kind: "auxiliary", items: [
  { targetId: "para-0", text: "Introduction", level: 1, translations: { "zh-CN": { text: "引言" } } },
  { targetId: "equation", text: "Error derivative", level: 1, translations: { "zh-CN": { text: "误差导数" } } },
  { targetId: "html", text: "Representation", level: 2, translations: { "zh-CN": { text: "表示" } } },
  { targetId: "para-24", text: "Discussion", level: 1, translations: { "zh-CN": { text: "讨论" } } },
] };
const papers = await Promise.all([
  prepareReaderDocument(base),
  prepareReaderDocument({ ...base, navigation: auxiliary }),
  prepareReaderDocument({ ...base, navigation: auxiliary, blocks: [{ id: "source-heading", type: "heading", level: 1, text: "Actual source section" }, ...blocks] }),
  prepareReaderDocument({ ...base,
    blocks: [{ id: "author-note", type: "para", placement: "frontmatter", text: "The original authors provide this statement." }, ...blocks],
    navigation: { ...auxiliary, items: [{ targetId: "author-note", text: "Author statement", level: 1 }, ...auxiliary.items] },
  }),
]);
const runtime = createPreviewReaderRuntime("navigation-fixture", { view: { tocMode: "pinned", showMargins: false }, uiScale: { percent: 80 } });
function Fixture() {
  const [index, setIndex] = useState(0);
  window.navigationFixture = { show: setIndex, view: runtime.view.read, scale: runtime.uiScale.update };
  return <Reader paper={papers[index]} runtime={runtime} insightItems={[]} initialReadingState={{ mode: "source" }} />;
}
createRoot(document.getElementById("root")).render(<React.StrictMode><ContinuousMotion><IconStyleProvider persist={false}><Fixture /></IconStyleProvider></ContinuousMotion></React.StrictMode>);
