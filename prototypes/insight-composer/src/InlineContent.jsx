import { memo, useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { colorFor } from "./highlight-colors";
import { inlineTokens, safeLink } from "./document-content";

const InlineFormula = memo(function InlineFormula({ tex }) {
  const html = useMemo(() => ({ __html: katex.renderToString(tex, { throwOnError: false, trust: false, output: "html" }) }), [tex]);
  return <span className="inline-equation" role="math" aria-label={tex} dangerouslySetInnerHTML={html} />;
});

// Titles and navigation labels share the author's inline notation, without
// source-offset wrappers or nested links inside an existing navigation anchor.
export function InlineLabel({ text = "" }) {
  const tokens = useMemo(() => inlineTokens(text), [text]);
  return tokens.map((token) => token.kind === "math" ? <InlineFormula key={token.start} tex={token.text} />
    : token.kind === "strong" ? <strong key={token.start}>{token.text}</strong>
    : token.kind === "em" ? <em key={token.start}>{token.text}</em>
    : ["code", "fenced-code"].includes(token.kind) ? <code key={token.start}>{token.text}</code>
    : <span key={token.start}>{token.text}</span>);
}

export function InlineContent({ text = "", items = [], draft }) {
  const tokens = useMemo(() => inlineTokens(text), [text]);
  const ranges = [...items, ...(draft ? [draft] : [])];
  function piece(token, start, end, child, atomic = false) {
    const match = ranges.findLast((range) => range.start < end && range.end > start);
    return <span key={start} data-source-start={start} data-source-end={end} data-source-atomic={atomic || undefined}>
      {match ? <mark data-insight-id={match === draft ? undefined : match.id} title={match === draft ? undefined : "查看洞见 " + match.reference} data-color={match.color} style={{ background: colorFor(match.color).value }} className={draft === match ? "draft-highlight" : ""}>{child}</mark> : child}
    </span>;
  }
  return tokens.map((token) => {
    if (token.kind === "fenced-code") {
      const cuts = [...new Set([token.contentStart, token.contentEnd, ...ranges.flatMap((range) => [range.start, range.end]).filter((offset) => offset > token.contentStart && offset < token.contentEnd)])].sort((a, b) => a - b);
      return <span key={token.start} className="source-fenced-code" data-code-language={token.language || undefined}><code>{cuts.slice(0, -1).map((start, index) => piece(token, start, cuts[index + 1], text.slice(start, cuts[index + 1])))}</code></span>;
    }
    if (token.kind === "text") {
      const cuts = [...new Set([token.start, token.end, ...ranges.flatMap((range) => [range.start, range.end]).filter((offset) => offset > token.start && offset < token.end)])].sort((a, b) => a - b);
      return cuts.slice(0, -1).map((start, index) => piece(token, start, cuts[index + 1], text.slice(start, cuts[index + 1])));
    }
    const child = token.kind === "math" ? <InlineFormula tex={token.text} />
      : token.kind === "link" ? <a href={safeLink(token.href)} target={token.href.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{token.text}</a>
      : token.kind === "strong" ? <strong>{token.text}</strong>
      : token.kind === "em" ? <em>{token.text}</em>
      : <code>{token.text}</code>;
    return piece(token, token.start, token.end, child, true);
  });
}
