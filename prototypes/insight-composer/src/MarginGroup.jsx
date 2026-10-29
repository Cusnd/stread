import { AnimatePresence } from "motion/react";
import { MotionItem } from "./Motion.jsx";
import { CheckCircle, Question } from "./icons";
import { colorFor } from "./highlight-colors";
import "./margin-groups.css";

function groupLabel(notes) {
  const type = notes[0]?.type;
  if (!notes.every((note) => note.type === type)) return "洞见";
  return type === "question" ? "问题" : type === "note" ? "笔记" : "批注";
}

/** A bounded view of independent insights. All mutations continue to use the
 * Reader's original per-note callbacks, identities, and version guards. */
export function MarginGroup({ group, layout, activeNote, occluded, onOpen, onOpenQuestion, onContextMenu, isContextKey, contextTargetId, renderIdentity, renderActions }) {
  if (!layout) return null;
  const included = new Set(layout.noteIds);
  const notes = group.notes.filter((note) => included.has(note.id));
  if (!notes.length) return null;
  const label = groupLabel(notes);
  const compact = layout.compact;
  const parallel = layout.laneCount > 1;
  const previews = notes.slice(0, layout.previewCount);
  const remaining = notes.length - previews.length;
  const openNote = (note, trigger) => note.type === "question" ? onOpenQuestion(note, trigger) : onOpen(group.key, note.id, trigger);
  // Very short segments remain a faithful color collection; the full group
  // entry provides a usable target instead of dozens of microscopic buttons.
  const interactiveLine = !compact && layout.height / notes.length >= 16;
  return <MotionItem as="section" layout={false} initial={{ opacity: 0 }} animate={{ opacity: occluded ? 0 : 1 }} exit={{ opacity: 0 }} className={"margin-group" + (compact ? " is-compact" : "") + (parallel ? " is-parallel" : "")} data-margin-group={group.key} data-source-overlap={layout.sourceOverlap || undefined}
    data-object-occluded={occluded || undefined} tabIndex={-1} inert={Boolean(occluded)} aria-hidden={occluded || undefined}
    aria-label={`${notes.length} 条${label}`} style={{ top: layout.top, maxHeight: layout.height, "--margin-group-budget": `${layout.height}px`, ...(parallel ? { left: `calc(var(--margin-width) * ${layout.laneIndex} / ${layout.laneCount})`, width: `calc(var(--margin-width) / ${layout.laneCount})` } : {}) }}>
    <div className="margin-group-colors" role={interactiveLine ? "group" : undefined} aria-label={interactiveLine ? "本段洞见颜色索引" : undefined} aria-hidden={!interactiveLine || undefined}
      style={{ gap: compact && notes.length > 8 ? ".5px" : undefined }}>
      {notes.map((note) => interactiveLine ? <button key={note.id} type="button" className="margin-group-color" style={{ "--note-color": colorFor(note.color).value }}
        aria-label={`打开${note.reference || "洞见"}`} aria-pressed={activeNote === note.id} title={note.reference}
        onClick={(event) => openNote(note, event.currentTarget)} />
        : <span key={note.id} className="margin-group-color" style={{ "--note-color": colorFor(note.color).value }} data-active={activeNote === note.id || undefined} />)}
    </div>
    <div className="margin-group-content">
      <div className="margin-group-heading">{parallel ? <button type="button" className="margin-group-open" aria-haspopup="dialog" title={notes[0].quote} aria-label={`打开 ${notes.length} 条${label}：${notes[0].quote || ""}`} onClick={(event) => onOpen(group.key, null, event.currentTarget)}>{notes.length} 条</button> : <><span>{notes.length} 条{label}</span>{compact && <button type="button" className="margin-group-open" aria-haspopup="dialog" onClick={(event) => onOpen(group.key, null, event.currentTarget)}>打开</button>}</>}</div>
      {!compact && <>
        <div className="margin-group-previews">
          <AnimatePresence initial={false} mode="popLayout">
            {previews.map((note) => <MotionItem as="section" key={note.id} id={"margin-" + note.id} className={"margin-note margin-preview" + (activeNote === note.id ? " active" : "")}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} layout="position"
              data-context-active={contextTargetId === "insight:" + note.id || undefined} tabIndex={-1}
              onContextMenu={(event) => onContextMenu(event, note)} onKeyDown={(event) => { if (isContextKey(event)) onContextMenu(event, note); }}>
              <div className="margin-note-type">
                {note.type === "question" ? <span className={"question-state-icon" + (note.answer ? " is-resolved" : "")} role="img" aria-label={note.answer ? "已解决" : "待回答"} title={note.answer ? "已解决" : "待回答"}>
                  {note.answer ? <CheckCircle size={15} aria-hidden="true" /> : <Question size={15} aria-hidden="true" />}
                </span> : <span className="margin-preview-dot" style={{ background: colorFor(note.color).value }} aria-hidden="true" />}
                {renderIdentity(note)}{renderActions(note)}
              </div>
              <button type="button" className="margin-preview-open" aria-haspopup="dialog" aria-label={`查看${note.reference || "洞见"}：${note.title || note.body}`} onClick={(event) => openNote(note, event.currentTarget)}>
                <span className="margin-preview-copy">{note.title && <strong>{note.title}</strong>}{note.title && note.body ? " · " : ""}{note.body}</span>
              </button>
            </MotionItem>)}
          </AnimatePresence>
        </div>
        <button type="button" className="margin-group-more" aria-haspopup="dialog" onClick={(event) => onOpen(group.key, null, event.currentTarget)}>{remaining > 0 ? `还有 ${remaining} 条 · 查看全部` : "打开完整内容"}</button>
      </>}
    </div>
  </MotionItem>;
}
