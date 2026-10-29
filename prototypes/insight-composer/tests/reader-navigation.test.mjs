import assert from "node:assert/strict";
import test from "node:test";
import { navigationLabel, readerNavigation } from "../src/reader-navigation.js";

const blocks = [{ id: "intro", type: "para", text: "An introduction." }, { id: "derivation", type: "math", tex: "x=y" }, { id: "conclusion", type: "para", text: "A conclusion." }];
const item = (targetId, text = targetId, level = 1) => ({ targetId, text, level });

test("auxiliary labels keep source blocks intact and target their existing identities", () => {
  const paper = { blocks, navigation: { kind: "auxiliary", items: [item("intro", "Overview"), item("derivation", "Derivation", 2), item("conclusion", "Conclusion")] } };
  const original = JSON.stringify(paper);
  assert.deepEqual(readerNavigation(paper), { kind: "auxiliary", title: "阅读导航", items: [
    { id: "intro", text: "Overview", level: 1, translations: undefined },
    { id: "derivation", text: "Derivation", level: 2, translations: undefined },
    { id: "conclusion", text: "Conclusion", level: 1, translations: undefined },
  ] });
  assert.equal(JSON.stringify(paper), original);
});

test("source section headings take precedence without mixing in auxiliary labels", () => {
  const heading = { id: "section", type: "heading", level: 2, text: "Methods", num: "2" };
  const paper = { blocks: [heading, ...blocks], navigation: { kind: "auxiliary", items: [item("intro")] } };
  assert.deepEqual(readerNavigation(paper), { kind: "headings", title: "目录", items: [heading] });
});

test("old damaged auxiliary metadata cannot produce unreachable or duplicate navigation", () => {
  const paper = { blocks, navigation: { kind: "auxiliary", items: [null, item("absent"), item("intro", " "), item("intro", "x".repeat(121)), item("intro", "bad level", 4), item("conclusion"), item("intro"), item("intro", "Duplicate")] } };
  assert.deepEqual(readerNavigation(paper).items.map((entry) => entry.id), ["intro", "conclusion"]);
  for (const navigation of [undefined, { kind: "unknown", items: [item("intro")] }, { kind: "auxiliary", items: [] }, { kind: "auxiliary", items: [item("absent")] }]) {
    assert.equal(readerNavigation({ blocks, navigation }).items.length, 0);
    assert.equal(readerNavigation({ blocks, navigation }).kind, "none");
  }
});

test("navigation labels honor language mode and safely fall back to their original label", () => {
  const label = { text: "Forward pass", translations: { "zh-CN": { text: "前向计算" }, bad: { text: {} } } };
  assert.equal(navigationLabel(label, "source", "zh-CN"), "Forward pass");
  assert.equal(navigationLabel(label, "bilingual", "zh-CN"), "前向计算");
  assert.equal(navigationLabel(label, "translation", "zh-CN"), "前向计算");
  assert.equal(navigationLabel(label, "translation", "bad"), "Forward pass");
  assert.equal(navigationLabel(label, "translation", "fr"), "Forward pass");
});
