import { useMemo } from "react";
import katex from "katex";
import { InlineContent } from "./InlineContent";
import { languageLabel } from "./reading-language";
import { ArrowUpRight } from "./icons";

export function InsightQuote({ note, sourceLanguage, onLocate }) {
  const isMath = note.sourceType === "math" || note.field === "tex";
  const markup = useMemo(() => isMath ? { __html: katex.renderToString(note.quote, { displayMode: true, throwOnError: false, trust: false }) } : null, [isMath, note.quote]);
  if (!note.blockId) return <p className="document-insight-source">关联整篇文档</p>;
  const label = note.equationNumber ? "公式（" + note.equationNumber + "）" : "原文公式（无编号）";
  const language = note.variant && note.variant !== "source" ? languageLabel(note.variant) + "译文" : languageLabel(sourceLanguage) + (sourceLanguage && sourceLanguage !== "und" ? "原文" : "");
  const canLocate = onLocate && note.referenceStatus !== "unresolved";
  const sourceLabel = isMath ? label : language || "原文";
  const caption = canLocate ? <button type="button" className="quote-source-link" title="定位这条洞见的来源" aria-label={`定位${note.reference || "这条洞见"}的来源：${sourceLabel}`} onClick={() => onLocate(note)}>{sourceLabel}<ArrowUpRight size={12} aria-hidden="true" /></button> : sourceLabel;
  if (!isMath) return <blockquote>{(note.documentId || canLocate) && <span className="quote-language">{caption}</span>}{note.referenceStatus === "unresolved" && <span className="reference-unresolved">原文已变更，保留原摘录</span>}<InlineContent text={note.quote || ""} /></blockquote>;
  return <blockquote className="insight-formula-quote">
    <span>{caption}</span>
    {note.referenceStatus === "unresolved" && <span className="reference-unresolved">原文已变更，保留原公式</span>}
    <div className="quote-equation" tabIndex={0} role="group" aria-label={label + "，可横向滚动"} dangerouslySetInnerHTML={markup} />
  </blockquote>;
}
