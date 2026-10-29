import { useEffect, useState } from "react";
import { InlineContent, InlineLabel } from "./InlineContent";
import { HtmlBlock } from "./HtmlBlock";
import { ObjectToolbar, objectLabel } from "./ObjectToolbar";
import { ObjectFrame } from "./ObjectFrame";
import { sameSource } from "./document-content";
import { contentVariants, standardTranslationStates } from "./reading-language";
import { documentAssetUrl } from "./document-resource";
import "./paper-article.css";
import "./reader-shared.css";

export { ReaderToc as PaperToc } from "./ReaderToc";

const FRONTMATTER = new Set(["rights", "publication", "author-details"]);

export function PaperArticle({ paper, mode, targetLanguage = "zh-CN", translationFirst = false, notes, draft, activeNote, equation }) {
  const [calculatedStates, setTranslationStates] = useState({});
  const translationStates = paper.compiledTranslationStates || calculatedStates;
  useEffect(() => {
    if (paper.compiledTranslationStates) return;
    let disposed = false;
    setTranslationStates({});
    standardTranslationStates(paper).then((states) => { if (!disposed) setTranslationStates(states); }).catch(() => {});
    return () => { disposed = true; };
  }, [paper]);
  const asset = (path) => documentAssetUrl(paper, path);
  const resolvedNotes = notes.filter((item) => item.referenceStatus !== "unresolved");
  const active = resolvedNotes.find((item) => item.id === activeNote);
  const variants = (object, field) => contentVariants(object, field, mode, targetLanguage, translationFirst);
  const origin = (block) => block.origin === "user" ? <span className="user-origin">用户补充</span> : null;
  function status(object, field = "text", key = object.id) {
    if (mode === "source") return null;
    const translation = object.translations?.[targetLanguage];
    const state = translation?.[field] === undefined ? "missing" : !translation.source_hash ? "unconfirmed" : translationStates[key]?.[targetLanguage];
    if (!state || state === "current") return null;
    return <span className="translation-state" data-state={state}>{state === "missing" ? "此处尚未翻译" : state === "stale" ? "原文已更新，译文待核对" : "译文来源版本未确认"}</span>;
  }
  function textSource(block, variant, field = "text", object = block, extra = {}, Tag = "p") {
    const value = variant === "source" ? object[field] : object.translations?.[variant]?.[field];
    const source = { blockId: block.id, variant, field, ...extra };
    const text = Array.isArray(value) ? value[extra.row]?.[extra.column] || "" : value || "";
    const currentDraft = draft?.referenceStatus !== "unresolved" && sameSource(source, draft) ? draft : null;
    return <Tag key={variant + field + (extra.row ?? "") + (extra.column ?? "")} className={"paper-text paper-variant" + (sameSource(source, active) ? " active-paragraph" : "")} lang={variant === "source" ? object.language || block.language || paper.meta.language || "und" : variant} data-block-id={block.id} data-variant={variant} data-field={field} data-item-id={extra.itemId} data-row={extra.row} data-column={extra.column} data-source-length={text.length}>
      <InlineContent text={text} items={resolvedNotes.filter((item) => sameSource(source, item) && item.id !== draft?.id)} draft={currentDraft} />
    </Tag>;
  }
  function translated(block, field = "text", object = block, extra = {}) {
    const available = variants(object, field).filter((variant) => (variant === "source" ? object[field] : object.translations?.[variant]?.[field]) !== undefined);
    return <>{available.map((variant) => textSource(block, variant, field, object, extra))}{status(object, field)}</>;
  }
  function renderCaption(block) {
    if (block.caption === undefined && (mode === "source" || block.translations?.[targetLanguage]?.caption === undefined)) return null;
    return <figcaption>{translated(block, "caption")}</figcaption>;
  }
  function renderBlock(block) {
    if (block.type === "html") return <HtmlBlock key={block.id} block={block} language={paper.meta.language} mode={mode} targetLanguage={targetLanguage} translationFirst={translationFirst} notes={resolvedNotes} draft={draft} activeNote={activeNote} assetBase={paper.assetBase || ""} resourceUrl={asset} />;
    if (block.type === "heading") {
      const Tag = "h" + Math.min(6, block.level + 1);
      return <Tag key={block.id} id={block.id} className="paper-heading" data-toc-heading data-article-block={block.id} data-level={block.level}>
        {origin(block)}{variants(block, "text").map((variant, index) => {
          const HeadingLine = index === 0 ? "span" : "small";
          return <HeadingLine key={variant}>{index === 0 && block.num && <span className="section-number">{block.num}</span>}{textSource(block, variant, "text", block, {}, "span")}</HeadingLine>;
        })}{status(block)}
      </Tag>;
    }
    if (block.type === "math") return <div key={block.id} id={block.id} data-article-block={block.id} className="paper-math">{origin(block)}{variants(block, "tex").map((variant) => <div key={variant} lang={variant === "source" ? block.language || paper.meta.language : variant}>{equation(block.id, variant)}</div>)}{block.translations?.[targetLanguage] && status(block, "tex")}</div>;
    if (block.type === "para") return <div key={block.id} id={block.id} data-article-block={block.id} data-footnote-marker={block.role === "footnote" && block.num ? "true" : undefined} className={"paper-block" + (block.role ? " paper-" + block.role : "")}>
      {origin(block)}{block.role === "footnote" && block.num && <span className="footnote-marker" aria-hidden="true">{block.num}</span>}{translated(block)}
    </div>;
    if (block.type === "list") {
      const Tag = block.ordered ? "ol" : "ul";
      return <div key={block.id} id={block.id} data-article-block={block.id}>{origin(block)}<Tag className="paper-list">{block.items.map((item) => <li key={item.id} id={item.id} data-source-item={item.id}>{translated(block, "text", item, { itemId: item.id })}</li>)}</Tag></div>;
    }
    if (block.type === "figure") return <ObjectFrame key={block.id} block={block} label={objectLabel(block, mode)} className="paper-figure" data-number={block.num}>
      {origin(block)}<ObjectToolbar block={block} mode={mode} />
      <a className="figure-image-link" style={{ "--figure-natural-width": block.extensions?.["continous-reader.image-size"]?.height > 1.4 * block.extensions?.["continous-reader.image-size"]?.width ? "380px" : "none" }} href={asset(block.src)} target="_blank" rel="noreferrer" aria-haspopup="dialog" aria-label={"打开图" + (block.num ? " " + block.num : "") + "大图"}><img src={asset(block.src)} width={block.extensions?.["continous-reader.image-size"]?.width} height={block.extensions?.["continous-reader.image-size"]?.height} alt={(mode === "source" ? block.alt : block.translations?.[targetLanguage]?.alt || block.alt) || ""} loading="lazy" decoding="async" /></a>
      {renderCaption(block)}
      {(block.image_text || mode !== "source" && block.translations?.[targetLanguage]?.image_text) && <details className="figure-text"><summary>{mode === "source" ? "Text in figure" : "图中文字"}</summary>
        {variants(block, "image_text").filter((variant) => variant !== "source" || block.image_text).map((variant) => textSource(block, variant, "image_text"))}{status(block, "image_text")}
      </details>}
    </ObjectFrame>;
    if (block.type === "table") {
      const caption = renderCaption(block);
      const alignment = (column) => ({ l: "left", c: "center", r: "right" })[block.align?.[column]];
      return <ObjectFrame key={block.id} block={block} label={objectLabel(block, mode)} className="paper-table">
        {origin(block)}<ObjectToolbar block={block} mode={mode} />{block.caption_pos === "above" && caption}
        <div className="paper-table-scroll" role="region" aria-label={"表" + (block.num ? " " + block.num : "") + "，可横向滚动"} tabIndex={0}><table>
          {block.head.length > 0 && <thead>{block.head.map((row, i) => <tr key={i}>{row.map((_, j) => <th key={j} scope="col" style={{ textAlign: alignment(j) }}>{variants(block, "head").map((variant) => textSource(block, variant, "head", block, { row: i, column: j }, "div"))}</th>)}</tr>)}</thead>}
          <tbody>{block.rows.map((row, i) => <tr key={i}>{row.map((_, j) => <td key={j} style={{ textAlign: alignment(j) }}>{variants(block, "rows").filter((variant) => variant === "source" || mode === "translation" || block.rows[i][j] !== block.translations?.[variant]?.rows?.[i][j]).map((variant) => textSource(block, variant, "rows", block, { row: i, column: j }, "div"))}</td>)}</tr>)}</tbody>
        </table></div>
        {block.caption_pos !== "above" && caption}{block.caption === undefined && status(block, "rows")}
        {block.extensions?.["continous-reader.source-table"]?.image && <details className="original-table"><summary>{mode === "source" ? "Original table layout" : "核对原表版式"}</summary><a href={asset(block.extensions["continous-reader.source-table"].image)} target="_blank" rel="noreferrer"><img src={asset(block.extensions["continous-reader.source-table"].image)} alt={"表 " + (block.num || "") + " 的 PDF 原始版式"} loading="lazy" /></a></details>}
      </ObjectFrame>;
    }
    return <section key={block.id} id={block.id} data-article-block={block.id} className="reader-unknown-block"><p>此内容暂不支持显示：{block.type}。原始内容已保留。</p><details><summary>查看保留内容 · {block.id}</summary><pre>{JSON.stringify(block, null, 2)}</pre></details></section>;
  }
  const frontmatter = paper.blocks.filter((block) => block.placement === "frontmatter" || (block.placement !== "body" && FRONTMATTER.has(block.role)));
  const titleVariants = variants(paper.meta, "title");
  return <>
    <header className="paper-header" id="section-main">
      {paper.presentation?.publication && <p className="paper-publication">{paper.presentation.publication}</p>}
      {titleVariants.map((variant, index) => { const Title = index === 0 ? "h1" : "p"; return <Title key={variant} className={index === 0 ? undefined : "paper-title-translation"} lang={variant === "source" ? paper.meta.language : variant}><InlineLabel text={variant === "source" ? paper.meta.title : paper.meta.translations[variant].title} /></Title>; })}
      {status(paper.meta, "title", "$meta")}{paper.meta.authors && <p className="paper-authors">{paper.meta.authors}</p>}
      {(paper.presentation?.source_note || paper.source?.path) && <p className="paper-provenance">{paper.presentation?.source_note}{paper.presentation?.source_note && paper.source?.path && <span>·</span>}{paper.source?.path && <a href={asset(paper.source.path)} target="_blank" rel="noreferrer">所附原文 ↗</a>}</p>}
      {(frontmatter.length > 0 || paper.presentation?.translation_note) && <details className="paper-source-details"><summary>作者说明与版本核对</summary>{frontmatter.map(renderBlock)}{paper.presentation?.translation_note && <p className="translation-note">{paper.presentation.translation_note}</p>}</details>}
    </header>
    {paper.blocks.filter((block) => !frontmatter.includes(block)).map(renderBlock)}
  </>;
}
