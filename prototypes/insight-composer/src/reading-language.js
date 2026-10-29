export function languageLabel(language) {
  if (!language || language === "und") return "原文";
  try { return new Intl.DisplayNames(["zh-CN"], { type: "language" }).of(language) || language; }
  catch { return language; }
}
export function documentLanguages(paper) {
  const values = new Set(Object.keys(paper?.meta?.translations || {}));
  for (const block of paper?.blocks || []) {
    Object.keys(block.translations || {}).forEach((language) => values.add(language));
    for (const item of block.items || []) Object.keys(item.translations || {}).forEach((language) => values.add(language));
  }
  return [...values].filter((language) => language !== "source");
}
export function contentVariants(object, field, mode, targetLanguage, translationFirst = false) {
  const translated = object.translations?.[targetLanguage]?.[field] !== undefined;
  if (mode === "source" || !translated) return ["source"];
  if (mode === "translation") return [targetLanguage];
  return translationFirst ? [targetLanguage, "source"] : ["source", targetLanguage];
}
export function standardFingerprintInput(object, language, type = object.type) {
  const nullable = (field) => object[field] === undefined ? null : object[field];
  if (type === "meta") return [language, type, object.title];
  if (["para", "heading", "list_item"].includes(type)) return [language, type, object.text];
  if (type === "table") return [language, type, object.head, object.rows, nullable("caption")];
  if (type === "figure") return [language, type, object.src, nullable("alt"), nullable("caption"), nullable("image_text")];
  if (type === "math") return [language, type, object.tex];
  return null;
}
export async function standardTranslationStates(paper) {
  const objects = [{ key: "$meta", value: paper.meta, language: paper.meta.language || "und", type: "meta" }];
  for (const block of paper.blocks) {
    const language = block.language || paper.meta.language || "und";
    if (block.type === "list") for (const item of block.items || []) objects.push({ key: item.id, value: item, language: item.language || language, type: "list_item" });
    else if (block.type !== "html") objects.push({ key: block.id, value: block, language, type: block.type });
  }
  const entries = await Promise.all(objects.map(async ({ key, value, language, type }) => {
    const input = standardFingerprintInput(value, language, type);
    if (!input) return [key, {}];
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)));
    const hash = "sha256:" + [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return [key, Object.fromEntries(Object.entries(value.translations || {}).map(([variant, translation]) => [variant,
      !translation.source_hash ? "unconfirmed" : translation.source_hash === hash ? "current" : "stale"]))];
  }));
  return Object.fromEntries(entries);
}
