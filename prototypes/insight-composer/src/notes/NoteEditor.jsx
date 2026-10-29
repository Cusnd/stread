import { useId, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { NoteMarkdown } from "./NoteMarkdown.jsx";
import { externalNoteChange, markdownEdit } from "./note-editor-commands.js";
import { MotionSelection } from "../Motion.jsx";
import { useMotionPresence } from "../useMotionPresence.js";
import { chordFromEvent, matchesShortcut } from "../reading-shortcuts.js";
import "./note-editor.css";

const externalValue = Annotation.define();
const shown = Object.freeze({ opacity: 1 });
const hidden = Object.freeze({ opacity: 0 });
const permissionExtensions = (readOnly) => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), EditorView.contentAttributes.of({ "aria-readonly": String(readOnly) })];
const tools = [
  { command: "heading", label: "标题", glyph: "H" },
  { command: "bold", label: "粗体 (Ctrl+B)", glyph: <strong>B</strong> },
  { command: "italic", label: "斜体 (Ctrl+I)", glyph: <em>I</em> },
  { command: "list", label: "列表", glyph: "≡" },
  { command: "quote", label: "引用", glyph: "❞" },
  { command: "code", label: "代码块", glyph: "</>" },
];

function format(view, command) {
  if (!view || view.state.readOnly || view.composing) return false;
  const change = markdownEdit(view.state.doc.toString(), view.state.selection.main, command);
  if (!change) return false;
  view.dispatch({ ...change, scrollIntoView: true, userEvent: "input.format" });
  return true;
}

export function NoteEditor({ value = "", onChange, readOnly = false, onSave, viewState }) {
  const host = useRef(null);
  const previewHost = useRef(null);
  const view = useRef(null);
  // Freeze the entry viewport before StrictMode's first setup/cleanup. Its
  // temporary zero-height editor must never replace the note's saved scroll.
  const entryViewport = useRef({ ...viewState });
  const editRestored = useRef(false);
  const previewRestored = useRef(false);
  const callbacks = useRef({ onChange, onSave, value, readOnly, viewState });
  callbacks.current = { onChange, onSave, value, readOnly, viewState };
  const permissions = useRef(new Compartment());
  const reconcile = useRef(() => {});
  const [mode, setMode] = useState(() => viewState?.mode === "preview" ? "preview" : "edit");
  const [previewValue, setPreviewValue] = useState(() => viewState?.mode === "preview" ? value : null);
  const editorId = useId();
  const editPresence = useMotionPresence(mode === "edit", { kind: "content", openState: shown, closedState: hidden });
  const previewPresence = useMotionPresence(mode === "preview", { kind: "content", openState: shown, closedState: hidden });

  useLayoutEffect(() => {
    let disposed = false, compositionTimer;
    editRestored.current = false;
    const syncValue = () => {
      if (disposed || !view.current) return;
      if (view.current.composing) {
        clearTimeout(compositionTimer);
        compositionTimer = setTimeout(syncValue, 30);
        return;
      }
      const changes = externalNoteChange(view.current.state.doc.toString(), String(callbacks.current.value || ""));
      if (changes) view.current.dispatch({ changes, annotations: [externalValue.of(true), Transaction.addToHistory.of(false)] });
    };
    reconcile.current = syncValue;
    const editor = new EditorView({
      parent: host.current,
      scrollTo: entryViewport.current.document === callbacks.current.value ? entryViewport.current.scrollSnapshot : undefined,
      state: EditorState.create({
        doc: String(callbacks.current.value || ""),
        extensions: [
          history(), drawSelection(), EditorView.lineWrapping, markdown(), indentOnInput(), bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle), search({ top: true }),
          placeholder("写下笔记…"),
          permissions.current.of(permissionExtensions(callbacks.current.readOnly)),
          EditorView.contentAttributes.of({ "aria-label": "笔记正文", "aria-multiline": "true", tabindex: "0", spellcheck: "false" }),
          EditorState.phrases.of({ "Find": "查找", "Replace": "替换", "next": "下一个", "previous": "上一个", "all": "全部", "match case": "区分大小写", "by word": "全词", "regexp": "正则表达式", "replace": "替换", "replace all": "全部替换", "close": "关闭" }),
          EditorView.domEventHandlers({ keydown: (event, editorView) => {
            if (event.isComposing || event.keyCode === 229 || editorView.composing || !(chordFromEvent(event) === "Mod+S" || matchesShortcut(event, "save"))) return false;
            event.preventDefault();
            event.stopPropagation();
            if (!callbacks.current.readOnly && !event.repeat) callbacks.current.onSave?.();
            return true;
          } }),
          keymap.of([
            { key: "Mod-b", run: (editorView) => format(editorView, "bold") },
            { key: "Mod-i", run: (editorView) => format(editorView, "italic") },
            ...defaultKeymap, ...historyKeymap, ...searchKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalValue))) callbacks.current.onChange?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    const rememberScroll = () => {
      const saved = callbacks.current.viewState;
      if (!saved || !editRestored.current || !editor.scrollDOM.clientHeight) return;
      saved.editScrollTop = editor.scrollDOM.scrollTop;
      saved.document = editor.state.doc.toString();
      saved.scrollSnapshot = editor.scrollSnapshot();
    };
    editor.scrollDOM.addEventListener("scroll", rememberScroll, { passive: true });
    return () => {
      disposed = true;
      clearTimeout(compositionTimer);
      reconcile.current = () => {};
      editor.scrollDOM.removeEventListener("scroll", rememberScroll);
      view.current = null;
      editor.destroy();
    };
  }, []);

  useLayoutEffect(() => { reconcile.current(); }, [value]);
  useLayoutEffect(() => {
    view.current?.dispatch({ effects: permissions.current.reconfigure(permissionExtensions(readOnly)) });
  }, [readOnly]);
  useLayoutEffect(() => {
    if (mode === "preview") setPreviewValue(value);
  }, [mode, value]);
  useLayoutEffect(() => {
    const saved = callbacks.current.viewState;
    if (mode === "edit") {
      view.current?.requestMeasure();
      const top = (editRestored.current ? saved : entryViewport.current)?.editScrollTop || 0;
      const frame = requestAnimationFrame(() => {
        if (!view.current) return;
        if (top) view.current.scrollDOM.scrollTop = top;
        editRestored.current = true;
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [mode, editPresence.present]);
  useLayoutEffect(() => {
    if (mode === "preview" && previewValue !== null && previewHost.current) {
      previewHost.current.scrollTop = (previewRestored.current ? callbacks.current.viewState : entryViewport.current)?.previewScrollTop || 0;
      previewRestored.current = true;
    }
  }, [mode, previewPresence.present, previewValue !== null]);

  const changeMode = (next) => {
    if (view.current?.composing) return;
    if (next === "preview") setPreviewValue(view.current?.state.doc.toString() ?? value);
    if (callbacks.current.viewState) callbacks.current.viewState.mode = next;
    setMode(next);
  };
  const navigateModes = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || view.current?.composing) return;
    event.preventDefault();
    const next = event.key === "Home" ? "edit" : event.key === "End" ? "preview" : mode === "edit" ? "preview" : "edit";
    changeMode(next);
    event.currentTarget.querySelectorAll("button")[next === "edit" ? 0 : 1]?.focus();
  };
  return <div className="note-editor" data-mode={mode} data-readonly={readOnly || undefined}>
    <div className="note-editor-toolbar">
      <div className="note-editor-format" role="toolbar" aria-label="笔记格式">
        {tools.map((tool) => <button key={tool.command} type="button" className={"note-format-" + tool.command} title={tool.label} aria-label={tool.label} disabled={readOnly || mode === "preview"} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (format(view.current, tool.command)) view.current.focus(); }}>{tool.glyph}</button>)}
      </div>
      <div className="note-editor-modes" role="tablist" aria-label="笔记显示方式" onKeyDown={navigateModes}>
        {[{ id: "edit", label: "编辑" }, { id: "preview", label: "预览" }].map((item) => <button key={item.id} type="button" role="tab" id={editorId + "-" + item.id + "-tab"} aria-controls={editorId + "-" + item.id} aria-selected={mode === item.id} tabIndex={mode === item.id ? 0 : -1} onClick={() => changeMode(item.id)}>{item.label}{mode === item.id && <MotionSelection layoutId={editorId + "-mode"} className="note-editor-mode-indicator" />}</button>)}
      </div>
    </div>
    <div className="note-editor-stage">
      <motion.div {...editPresence.motionProps} ref={host} id={editorId + "-edit"} className="note-editor-host" role="tabpanel" aria-labelledby={editorId + "-edit-tab"} aria-hidden={mode !== "edit" || undefined} inert={mode !== "edit"} hidden={!editPresence.present} />
      <motion.div {...previewPresence.motionProps} ref={previewHost} id={editorId + "-preview"} className="note-editor-preview" role="tabpanel" aria-labelledby={editorId + "-preview-tab"} aria-hidden={mode !== "preview" || undefined} inert={mode !== "preview"} tabIndex={0} hidden={!previewPresence.present} onScroll={(event) => { if (callbacks.current.viewState && event.currentTarget.clientHeight) callbacks.current.viewState.previewScrollTop = event.currentTarget.scrollTop; }}>{previewValue !== null && <NoteMarkdown value={previewValue} />}</motion.div>
    </div>
  </div>;
}
