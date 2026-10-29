const numberedReference = /^#([QN])([0-9]{5,})$/;
const seriesFor = (type) => type === "question" ? "Q" : "N";

export function hasCurrentReference(note) {
  return numberedReference.exec(note.reference || "")?.[1] === seriesFor(note.type);
}

export function assignReference(note, items) {
  const series = seriesFor(note.type);
  const references = { ...note.references };
  const existing = numberedReference.exec(note.reference || "");
  if (existing) references[existing[1]] = note.reference;

  if (!references[series]) {
    const highest = items.reduce((max, item) => {
      const values = [item.reference, ...Object.values(item.references || {})];
      return values.reduce((current, value) => {
        const match = numberedReference.exec(value || "");
        return match?.[1] === series ? Math.max(current, Number(match[2])) : current;
      }, max);
    }, 0);
    references[series] = "#" + series + String(highest + 1).padStart(5, "0");
  }

  // Keep both references when changing type, so switching back restores the number.
  return { ...note, reference: references[series], references };
}

export function assignReferences(items) {
  const assigned = [...items];
  return items.map((note, index) => {
    const next = assignReference(note, assigned);
    assigned[index] = next;
    return next;
  });
}
