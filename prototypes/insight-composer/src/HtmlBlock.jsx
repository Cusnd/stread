import { memo, useMemo, useState } from "react";
import katex from "katex";
import { colorFor } from "./highlight-colors";
import { sameSource } from "./document-content";
import { localHtmlClass, safeHtmlAsset } from "./html-content";
import { ObjectToolbar, objectLabel } from "./ObjectToolbar";
import { ObjectFrame } from "./ObjectFrame";
import { imageKeyboardProps } from "./image-preview.js";
import "./html-block.css";

const MathAtom = memo(function MathAtom({ tex }) {
  const markup = useMemo(() => ({ __html: katex.renderToString(tex, { throwOnError: false, trust: false, output: "html", maxExpand: 1000 }) }), [tex]);
  return <span className="inline-equation" role="math" aria-label={tex} dangerouslySetInnerHTML={markup} />;
});

function HtmlTable({ children, attributes, label }) {
  const [scrolled, setScrolled] = useState(false);
  return <div className="html-table-scroll" role="region" aria-label={label + "，可横向滚动"} tabIndex={0} data-scrolled={scrolled || undefined} onScroll={(event) => setScrolled(event.currentTarget.scrollLeft > 1)}>
    <table {...attributes}>{children}</table>
  </div>;
}

export function HtmlBlock({ block, language, mode, notes, draft, activeNote, assetBase, resourceUrl, targetLanguage = "zh-CN", translationFirst = false }) {
  const asset = resourceUrl || ((path) => (assetBase || "") + path);
  const compiled = block.compiledHtml;
  if (!compiled || compiled.error) return <ObjectFrame as="section" block={block} label={objectLabel(block, mode)} className="reader-html html-diagnostic">
    <ObjectToolbar block={block} mode={mode} />
    <p role="status">此处的 HTML 内容暂时无法显示，原始内容已保留。</p>
    <details><summary>查看原因</summary><code>{compiled?.error || "内容尚未校验"}</code></details>
    {safeHtmlAsset(block.fallback?.image) && <img src={asset(block.fallback.image)} alt={block.fallback.alt || "原始版式"} {...imageKeyboardProps(false, block.fallback.alt || "原始版式")} />}
  </ObjectFrame>;
  const source = compiled.source, translated = compiled.variants[targetLanguage];
  const state = compiled.translationStates[targetLanguage] || "missing";
  const paired = mode === "bilingual" && translated && source.scaffold === translated.scaffold;
  const bilingualOrder = translationFirst ? [targetLanguage, "source"] : ["source", targetLanguage];
  const views = paired ? ["source"] : mode === "source" ? ["source"] : mode === "translation" ? [translated ? targetLanguage : "source"] : translated ? bilingualOrder : ["source"];
  const active = notes.find((note) => note.id === activeNote);
  const label = objectLabel(block, mode);
  const domId = (id, view) => `${compiled.scope}-${view}-${id}`;
  function attributes(ast, view) {
    const result = {};
    for (const [key, value] of Object.entries(ast.attrs)) {
      if (key === "class") result.className = value.split(/\s+/).filter(Boolean).map(localHtmlClass).join(" ");
      else if (key === "data-node-id") result.id = domId(value, view);
      else if (key === "headers") result.headers = value.split(/\s+/).map((id) => domId(id, view)).join(" ");
      else if (key === "rowspan") result.rowSpan = Number(value);
      else if (key === "colspan") result.colSpan = Number(value);
      else if (key === "href") {
        const target = value.slice(1);
        result.href = value.startsWith("#") && compiled.variants[view].index[target] ? "#" + domId(target, view) : value;
        if (!value.startsWith("#")) { result.target = "_blank"; result.rel = "noreferrer noopener"; }
      } else if (key === "src") result.src = asset(value);
      else if (key === "data-same-as") {
        result["data-empty-ref"] = value;
        result.title = (mode === "source" ? "Unlisted value: same as the referenced cell " : "未列出的数值与关联单元格相同：") + compiled.variants[view].index[value].text;
      } else if (key !== "data-tex") result[key] = value;
    }
    return result;
  }
  function matches(note, descriptor, shared) {
    return note?.referenceStatus !== "unresolved" && (sameSource(note, descriptor) || (shared && note?.variant === targetLanguage && sameSource({ ...note, variant: "source" }, descriptor)));
  }
  function decorated(ast, descriptor, shared, key, linked = false) {
    const ranges = [...notes.filter((note) => note.id !== draft?.id && matches(note, descriptor, shared)), ...(matches(draft, descriptor, shared) ? [draft] : [])];
    function fragment(start, end, child, atomic = false, suffix = "") {
      const match = ranges.findLast((note) => note.start < end && note.end > start);
      return <span key={key + ":" + suffix + start} data-source-start={start} data-source-end={end} data-source-atomic={atomic || undefined}>
        {match ? <mark data-insight-id={match === draft ? undefined : match.id} title={match === draft ? undefined : "查看洞见 " + match.reference} data-color={match.color} style={{ background: colorFor(match.color).value }} className={match === draft ? "draft-highlight" : undefined}>{child}</mark> : child}
      </span>;
    }
    if (ast.kind === "text") {
      const cuts = [...new Set([ast.start, ast.end, ...ranges.flatMap((note) => [note.start, note.end]).filter((offset) => offset > ast.start && offset < ast.end)])].sort((a, b) => a - b);
      return cuts.slice(0, -1).map((start, index) => fragment(start, cuts[index + 1], ast.text.slice(start - ast.start, cuts[index + 1] - ast.start)));
    }
    if (ast.attrs["data-tex"]) return fragment(ast.start, ast.end, <MathAtom tex={ast.attrs["data-tex"]} />, true);
    if (ast.tag === "br") return <br key={key} data-source-start={ast.start} data-source-end={ast.end} />;
    const Tag = ast.tag;
    if (Tag === "img") return <img key={key} {...attributes(ast, descriptor.variant)} {...imageKeyboardProps(linked, ast.attrs.alt)} />;
    return <Tag key={key} {...attributes(ast, descriptor.variant)}>{ast.children.map((child, index) => decorated(child, descriptor, shared, key + ":" + index, linked || Tag === "a"))}</Tag>;
  }
  function render(ast, view, key, linked = false) {
    if (ast.kind === "text") return ast.text;
    const Tag = ast.tag;
    const props = attributes(ast, view);
    if (ast.nodeId) {
      const original = source.index[ast.nodeId], translation = translated?.index[ast.nodeId];
      const shared = paired && state === "current" && original.semantic === translation?.semantic;
      const variants = paired && !shared ? bilingualOrder : [view];
      const Wrapper = ["p", "span", "strong", "em", "b", "i", "code", "pre", "sup", "sub", "a"].includes(Tag) ? "span" : "div";
      return <Tag key={key} {...props}>{variants.map((variant) => {
        const item = compiled.variants[variant].index[ast.nodeId];
        const descriptor = { blockId: block.id, variant, field: "html_text", nodeId: ast.nodeId };
        const isActive = matches(active, descriptor, shared);
        return <Wrapper key={variant} className={"html-variant" + (isActive ? " active-paragraph" : "")} lang={variant === "source" ? block.language || language || "und" : variant}
          data-block-id={block.id} data-variant={variant} data-field="html_text" data-node-id={ast.nodeId} data-source-length={item.text.length}
          data-shared-variants={shared ? "source " + targetLanguage : undefined} data-html-text={item.text}>
          {item.ast.children.map((child, index) => decorated(child, descriptor, shared, key + ":" + variant + ":" + index, linked || Tag === "a"))}
        </Wrapper>;
      })}</Tag>;
    }
    const children = ast.children.map((child, index) => render(child, view, key + ":" + index, linked || Tag === "a"));
    if (Tag === "table") return <HtmlTable key={key} attributes={props} label={label}>{children}</HtmlTable>;
    if (Tag === "img") return <img key={key} {...props} {...imageKeyboardProps(linked, ast.attrs.alt)} />;
    if (Tag === "br") return <br key={key} {...props} />;
    return <Tag key={key} {...props}>{children}</Tag>;
  }
  return <ObjectFrame as="section" block={block} label={label} data-html-profile={block.html_profile} data-html-scope={compiled.scope} className="reader-html">
    {compiled.css && <style>{compiled.css}</style>}
    {block.origin === "user" && <span className="user-origin">用户补充</span>}
    <ObjectToolbar block={block} mode={mode} />
    {mode !== "source" && state !== "current" && <p className="html-translation-status" role="status">{state === "missing" ? "此处尚未翻译，显示原文" : state === "unconfirmed" ? "译文来源版本未确认" : "原文已更新，译文待核对"}</p>}
    {views.map((view) => <div key={view} className="html-content" lang={view === "source" ? block.language || language || "und" : view}>{compiled.variants[view].tree.map((ast, index) => render(ast, view, String(index)))}</div>)}
    {safeHtmlAsset(block.fallback?.image) && <details className="original-table"><summary>{mode === "source" ? "Original table layout" : "核对原表版式"}</summary><a href={asset(block.fallback.image)} target="_blank" rel="noreferrer"><img src={asset(block.fallback.image)} alt={block.fallback.alt || "原始版式"} loading="lazy" /></a></details>}
  </ObjectFrame>;
}
