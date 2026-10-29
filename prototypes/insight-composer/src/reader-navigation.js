// Reading labels are separate from source headings and never become article text.
// Filter older stored data defensively without modifying its preserved contents.
export function readerNavigation(paper) {
  const blocks = Array.isArray(paper?.blocks) ? paper.blocks : [];
  const headings = blocks.filter((block) => block.type === "heading" && block.level >= 1 && block.level <= 3 && typeof block.id === "string");
  if (headings.length) return { kind: "headings", title: "目录", items: headings };
  const positions = new Map(blocks.map((block, index) => [block.id, index]));
  const seen = new Set();
  const items = paper?.navigation?.kind === "auxiliary" && Array.isArray(paper.navigation.items)
    ? paper.navigation.items.slice(0, 200).filter((item) => {
      if (!item || !positions.has(item.targetId) || typeof item.targetId !== "string" || seen.has(item.targetId) ||
        typeof item.text !== "string" || !item.text.trim() || item.text.length > 120 || ![1, 2, 3].includes(item.level)) return false;
      seen.add(item.targetId);
      return true;
    }).map((item) => ({ id: item.targetId, text: item.text, level: item.level, translations: item.translations }))
      .sort((a, b) => positions.get(a.id) - positions.get(b.id))
    : [];
  return { kind: items.length ? "auxiliary" : "none", title: items.length ? "阅读导航" : "目录", items };
}

export function navigationLabel(item, mode, targetLanguage) {
  const translated = item.translations?.[targetLanguage]?.text;
  return mode !== "source" && typeof translated === "string" && translated.trim() ? translated : item.text;
}
