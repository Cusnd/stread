import { useMemo } from "react";
import { renderNoteMarkdown } from "./note-markdown.js";

export function NoteMarkdown({ value }) {
  const html = useMemo(() => ({ __html: renderNoteMarkdown(value) }), [value]);
  return <div className="note-markdown" dangerouslySetInnerHTML={html} />;
}
