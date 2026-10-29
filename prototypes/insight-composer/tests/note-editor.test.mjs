import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { markdownEdit, externalNoteChange } from "../src/notes/note-editor-commands.js";
import { renderNoteMarkdown, safeNoteHref } from "../src/notes/note-markdown.js";

function apply(text, selection, command) {
  const change = markdownEdit(text, selection, command);
  return { text: text.slice(0, change.changes.from) + change.changes.insert + text.slice(change.changes.to), selection: change.selection };
}

test("formatting selected Chinese prose preserves its content and can toggle back", () => {
  const original = "前文，一段笔记，后文。";
  const formatted = apply(original, { anchor: 7, head: 3 }, "bold");
  assert.equal(formatted.text, "前文，**一段笔记**，后文。");
  assert.deepEqual(apply(formatted.text, formatted.selection, "bold"), { text: original, selection: { anchor: 3, head: 7 } });
  const empty = apply("文字", { anchor: 2, head: 2 }, "italic");
  assert.equal(empty.text, "文字__");
  assert.deepEqual(empty.selection, { anchor: 3, head: 3 });
});

test("line formatting handles a leading empty line and excludes the line after a selected newline", () => {
  const emptyLine = apply("\n正文", { anchor: 0, head: 0 }, "heading");
  assert.equal(emptyLine.text, "## \n正文");
  const list = apply("第一行\n第二行\n第三行", { anchor: 0, head: 8 }, "list");
  assert.equal(list.text, "- 第一行\n- 第二行\n第三行");
  assert.equal(apply(list.text, list.selection, "list").text, "第一行\n第二行\n第三行");
});

test("code blocks use a longer fence than their content and handle a long note", () => {
  const sample = "```js\nx()\n```";
  const result = apply(sample, { anchor: 0, head: sample.length }, "code");
  assert.equal(result.text, "````\n" + sample + "\n````");
  const long = "` ".repeat(100000);
  const wrapped = apply(long, { anchor: 0, head: long.length }, "code");
  assert.equal(wrapped.text.slice(wrapped.selection.anchor, wrapped.selection.head), long);
});

test("a formatting action is undone as a single editor history event", () => {
  let state = EditorState.create({ doc: "保留撤销历史", selection: { anchor: 0, head: 6 }, extensions: [history()] });
  state = state.update({ ...markdownEdit(state.doc.toString(), state.selection.main, "bold"), userEvent: "input.format" }).state;
  assert.equal(state.doc.toString(), "**保留撤销历史**");
  assert.equal(undo({ state, dispatch: (transaction) => { state = transaction.state; } }), true);
  assert.equal(state.doc.toString(), "保留撤销历史");
});

test("controlled value echoes need no edit, while external changes replace only their changed span", () => {
  assert.equal(externalNoteChange("相同内容", "相同内容"), null);
  assert.deepEqual(externalNoteChange("第一段\n原文本\n第三段", "第一段\n新文本\n第三段"), { from: 4, to: 5, insert: "新" });
  assert.deepEqual(externalNoteChange("", "新笔记"), { from: 0, to: 0, insert: "新笔记" });
});

test("preview renders Markdown without changing source or executing HTML", () => {
  const source = "# 标题\n\n**重点**\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>";
  const html = renderNoteMarkdown(source);
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(source.includes("<script>"), true);
});

test("preview blocks executable and network-relative links and never loads Markdown images", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,test", "vbscript:x", "file:///C:/private", "//example.com", "https:\\example.com", "https://example.com/\nx", "reader://other/test"]) assert.equal(safeNoteHref(href), null, href);
  for (const href of ["https://example.com/paper", "http://127.0.0.1/doc", "mailto:a@example.com", "reader://app/?document=one", "?document=one", "/?document=one", "#N00001"]) assert.equal(safeNoteHref(href), href);
  const html = renderNoteMarkdown('[安全](https://example.com)\n\n[危险](javascript:alert%281%29)\n\n![图片](https://example.com/remote.svg)\n\n![内联](data:image/svg+xml,test)');
  assert.doesNotMatch(html, /<img|<iframe|<script|src=/);
  assert.doesNotMatch(html, /href="(?:javascript|data):/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /class="note-markdown-image"/);
});

test("preview preserves all content of a 200000-character note", () => {
  const source = "笔记内容".repeat(50000);
  assert.equal(renderNoteMarkdown(source), "<p>" + source + "</p>\n");
});
