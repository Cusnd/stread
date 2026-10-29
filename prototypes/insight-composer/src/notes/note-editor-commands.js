// Return one edit and the resulting selection. Keeping formatting in a normal
// CodeMirror transaction makes each action one reversible history event.
export function markdownEdit(text, selection, command) {
  const from = Math.min(selection.anchor, selection.head);
  const to = Math.max(selection.anchor, selection.head);
  const selected = text.slice(from, to);
  const edit = (start, end, insert, anchor, head = anchor) => ({ changes: { from: start, to: end, insert }, selection: { anchor, head } });
  if (command === "bold" || command === "italic") {
    const marker = command === "bold" ? "**" : "_";
    if (selected.length >= marker.length * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
      const content = selected.slice(marker.length, -marker.length);
      return edit(from, to, content, from, from + content.length);
    }
    if (from >= marker.length && text.slice(from - marker.length, from) === marker && text.slice(to, to + marker.length) === marker) {
      return edit(from - marker.length, to + marker.length, selected, from - marker.length, to - marker.length);
    }
    return edit(from, to, marker + selected + marker, from + marker.length, to + marker.length);
  }
  if (command === "code") {
    let longestFence = 2;
    for (const match of selected.matchAll(/`+/g)) longestFence = Math.max(longestFence, match[0].length);
    const fence = "`".repeat(longestFence + 1);
    const before = from > 0 && text[from - 1] !== "\n" ? "\n" : "";
    const after = to < text.length && text[to] !== "\n" ? "\n" : "";
    const prefix = before + fence + "\n";
    return edit(from, to, prefix + selected + "\n" + fence + after, from + prefix.length, from + prefix.length + selected.length);
  }
  const prefix = { heading: "## ", list: "- ", quote: "> " }[command];
  if (!prefix) return null;
  const start = from === 0 ? 0 : text.lastIndexOf("\n", from - 1) + 1;
  const lastSelected = to > from && text[to - 1] === "\n" ? to - 1 : to;
  const nextBreak = text.indexOf("\n", lastSelected);
  const end = nextBreak < 0 ? text.length : nextBreak;
  const lines = text.slice(start, end).split("\n");
  const expression = command === "heading" ? /^#{1,6} / : command === "list" ? /^- / : /^> /;
  const remove = lines.every((line) => expression.test(line));
  const content = lines.map((line) => remove ? line.replace(expression, "") : prefix + (command === "heading" ? line.replace(expression, "") : line)).join("\n");
  return edit(start, end, content, start, start + content.length);
}

// Apply remote/parent replacements without replacing the entire document when
// only a small span changed. Local controlled echoes produce no transaction.
export function externalNoteChange(current, next) {
  if (current === next) return null;
  let from = 0;
  while (from < current.length && from < next.length && current[from] === next[from]) from++;
  let oldEnd = current.length, newEnd = next.length;
  while (oldEnd > from && newEnd > from && current[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
  return { from, to: oldEnd, insert: next.slice(from, newEnd) };
}
