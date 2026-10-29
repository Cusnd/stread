import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { insightWrite, mergeSavedInsights, upsertInsight } from "../src/reader-state.js";
import { canSaveInsight, isHighlightOnly } from "../src/insight-content.js";
import { readInsightHistory, rememberDeleted } from "../src/insight-history.js";

test("title edits are independent of body, source, identity, answer and review membership", () => {
  const original = {
    id: "question-one", version: 3, revision: 2, type: "question", title: "Old title", body: "Why does this work?",
    reference: "#Q00012", references: { Q: "#Q00012" }, blockId: "para-one", variant: "zh-CN", field: "text",
    quote: "原文摘录", start: 4, end: 8, color: "amber", answer: { text: "A saved answer" },
    review: { pending: true, addedAt: "2026-10-22T20:00:00Z" },
  };
  const restoredDraft = JSON.parse(JSON.stringify({ ...original, title: "  New\r\ntitle\u2028continued  " }));
  const outgoing = insightWrite(restoredDraft, "doc-one", 4);
  assert.equal(outgoing.title, "New title continued");
  assert.equal(outgoing.review, undefined);
  for (const field of ["id", "revision", "type", "body", "reference", "references", "blockId", "variant", "field", "quote", "start", "end", "color", "answer"]) {
    assert.deepEqual(outgoing[field], original[field], field);
  }
  const saved = { ...outgoing, version: 4 };
  const updated = upsertInsight([original], saved);
  assert.deepEqual(updated[0].review, original.review);
  assert.equal(updated[0].title, outgoing.title);
  assert.equal(mergeSavedInsights(updated, [original])[0].title, outgoing.title);
  assert.equal(mergeSavedInsights(updated, [{ ...updated[0], version: 5, title: "" }])[0].title, "");
});

test("legacy omission stays omitted and clearing a title is an explicit empty write", () => {
  const old = { type: "note", body: "Body stays independent" };
  assert.equal(Object.hasOwn(insightWrite(old, "doc-one", 1), "title"), false);
  assert.equal(insightWrite({ ...old, title: " \n " }, "doc-one", 1).title, "");
  assert.equal(old.body, "Body stays independent");
  assert.equal(insightWrite({ ...old, title: "研究标题" }, "doc-one", 1).body, old.body);
});

test("titled annotations are visible insights while untitled pure highlights remain valid", () => {
  const anchored = { type: "annotation", blockId: "para-one", quote: "Excerpt", body: "" };
  assert.equal(canSaveInsight(anchored), true);
  assert.equal(isHighlightOnly(anchored), true);
  const titled = { ...anchored, title: "Compare the assumptions" };
  assert.equal(canSaveInsight(titled), true);
  assert.equal(isHighlightOnly(titled), false);
  assert.equal(isHighlightOnly({ ...titled, title: "  " }), true);
  assert.equal(canSaveInsight({ type: "annotation", title: "No source", body: "" }), false);
  for (const type of ["question", "note"]) {
    assert.equal(canSaveInsight({ ...anchored, type, title: "A title still needs content" }), false);
  }
});

test("archive undo receipts retain titles independently from answers and source addresses", () => {
  const archived = { id: "note-one", title: "Remember this", body: "Longer content", version: 5, archivedAt: "2026-10-23T00:00:00Z", reference: "#N00002", answer: { text: "Saved" }, blockId: "p", start: 0, end: 7 };
  const history = rememberDeleted({ deleted: [], references: [] }, archived);
  assert.deepEqual(readInsightHistory({ getItem: () => JSON.stringify(history) }, "doc-one").deleted[0], archived);
});

test("title field and question detail keep title, content and keyboard editing distinct", async () => {
  const [{ createServer }, { createElement }, { renderToStaticMarkup }] = await Promise.all([import("vite"), import("react"), import("react-dom/server")]);
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, watch: null, hmr: false }, appType: "custom" });
  try {
    const [{ ComposerTitleField, composerAnchor, MAX_COMPOSER_HEIGHT, COMPOSER_TITLE_HEIGHT }, { QuestionDetail }] = await Promise.all([
      server.ssrLoadModule("/src/ComposerSurface.jsx"), server.ssrLoadModule("/src/QuestionDetail.jsx"),
    ]);
    const fieldMarkup = renderToStaticMarkup(createElement(ComposerTitleField, { title: "Independent title", onChange() {}, inputRef: { current: null } }));
    assert.match(fieldMarkup, /type="text"/);
    assert.match(fieldMarkup, /maxLength="200"/i);
    assert.match(fieldMarkup, /value="Independent title"/);
    assert.match(fieldMarkup, /aria-label="洞见标题（可选）"/);
    let focused = 0, prevented = 0;
    let field;
    function TitleFieldHarness() {
      // Render under React's dispatcher before inspecting the control's event
      // handler: the field also subscribes to the reduced-motion preference.
      field = ComposerTitleField({ title: "Title", onChange() {}, inputRef: { current: { focus: () => focused++ } } });
      return field;
    }
    renderToStaticMarkup(createElement(TitleFieldHarness));
    const enter = { key: "Enter", nativeEvent: {}, preventDefault: () => prevented++ };
    field.props.onKeyDown({ ...enter, nativeEvent: { isComposing: true } });
    field.props.onKeyDown({ ...enter, ctrlKey: true });
    assert.equal(focused, 0); assert.equal(prevented, 0);
    field.props.onKeyDown(enter);
    assert.equal(focused, 1); assert.equal(prevented, 1);
    const question = { id: "q", type: "question", reference: "#Q00001", title: "Optional heading", body: "The full question\nwith its original wording", answer: { text: "The existing answer" } };
    const render = (value) => renderToStaticMarkup(createElement(QuestionDetail, { question: value, readOnly: true }));
    const titled = render(question);
    assert.match(titled, /aria-labelledby="question-title"/);
    assert.match(titled, /<h2 id="question-title">Optional heading<\/h2>/);
    assert.match(titled, /<p class="question-body">The full question\nwith its original wording<\/p>/);
    assert.match(titled, /The existing answer/);
    for (const title of [undefined, "", "  "]) {
      const old = render({ ...question, title });
      assert.match(old, /aria-labelledby="question-identity-label"/);
      assert.match(old, /id="question-identity-label"/);
      assert.match(old, /<p class="question-body">The full question\nwith its original wording<\/p>/);
      assert.doesNotMatch(old, /<h2/);
    }
    assert.equal(composerAnchor({ top: 560, bottom: 600 }, 56, 800, MAX_COMPOSER_HEIGHT + COMPOSER_TITLE_HEIGHT + 32), "above");
  } finally { await server.close(); }
});
