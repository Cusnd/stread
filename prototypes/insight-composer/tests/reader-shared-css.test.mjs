import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse, generate, walk } from "css-tree";

const compare = (left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
const add = (left, right) => left.map((value, index) => value + right[index]);
function specificity(node) {
  if (node.type === "IdSelector") return [1, 0, 0];
  if (["ClassSelector", "AttributeSelector"].includes(node.type)) return [0, 1, 0];
  if (node.type === "TypeSelector") return [0, 0, node.name === "*" ? 0 : 1];
  if (node.type === "PseudoElementSelector") return [0, 0, 1];
  if (node.type === "PseudoClassSelector") {
    if (node.name === "where") return [0, 0, 0];
    if (!["is", "not", "has"].includes(node.name)) return [0, 1, 0];
  }
  const children = node.children?.toArray().map(specificity) || [];
  return node.type === "SelectorList" ? children.sort(compare).at(-1) || [0, 0, 0] : children.reduce(add, [0, 0, 0]);
}
const rules = [];
for (const file of ["reader-shared.css", "html-block.css"]) {
  const css = parse(readFileSync(new URL("../src/" + file, import.meta.url), "utf8"));
  walk(css, { visit: "Rule", enter(rule) {
    if (rule.prelude?.type !== "SelectorList") return;
    const declarations = rule.block.children.toArray().filter((item) => item.type === "Declaration");
    for (const selector of rule.prelude.children) rules.push({ selector: generate(selector), specificity: specificity(selector), declarations });
  } });
}

test("CSS selector scoring accounts for the strongest :is branch and row-header attributes", () => {
  assert.deepEqual(specificity(parse('.paper-reader :is(td, .reader-html .html-content th[scope="row"])', { context: "selector" })), [0, 4, 1]);
});

test("shared author modifiers beat reader defaults through the cascade without important declarations", () => {
  for (const [modifier, property, value, resetProperties] of [
    ["text-start", "text-align", "start", ["text-align"]],
    ["text-end", "text-align", "end", ["text-align"]],
    ["scalar", "white-space", "nowrap", ["white-space"]],
    ["group-start", "border-top", "1px solid var(--line)", ["border", "border-top"]],
    ["ruled", "border-top", "1px solid var(--line)", ["border", "border-top"]],
  ]) {
    const authorRule = rules.find((rule) => rule.selector.includes(".html-local-" + modifier) && rule.declarations.some((item) => item.property === property));
    assert.ok(authorRule, modifier + " must have a shared rendering rule");
    const declaration = authorRule.declarations.find((item) => item.property === property);
    assert.equal(generate(declaration.value), value);
    assert.equal(declaration.important, false);
    const defaults = rules.filter((rule) => !rule.selector.includes("html-local-") && rule.declarations.some((item) => resetProperties.includes(item.property)));
    assert.ok(defaults.length > 0);
    for (const baseline of defaults) assert.ok(compare(authorRule.specificity, baseline.specificity) > 0,
      modifier + " must outrank " + baseline.selector + " regardless of stylesheet order");
  }
});
