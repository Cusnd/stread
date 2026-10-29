import { useEffect, useRef, useState } from "react";
import { ReaderTopbar } from "./ReaderTopbar.jsx";
import { ICON_STYLES, IconStyleScope, useIconStyle, ArrowLeft, ArrowUpRight, SidebarSimple, FileText, InsightIcon, GlossaryIcon, SlidersHorizontal, DotsThree, Books, MagnifyingGlass, BookmarkSimple, NotePencil, Highlighter, Check } from "./icons.jsx";
import "./icon-gallery.css";

const glyphs = [
  [SidebarSimple, "目录"], [FileText, "原页"], [InsightIcon, "洞见"], [GlossaryIcon, "术语"],
  [SlidersHorizontal, "设置"], [DotsThree, "更多"], [Books, "资料库"], [MagnifyingGlass, "搜索"],
  [BookmarkSimple, "书签"], [NotePencil, "笔记"], [Highlighter, "高亮"], [ArrowUpRight, "跳转"],
];
const noop = () => {};

function ToolbarSample() {
  const sourceTrigger = useRef(null);
  return <div className="icon-gallery-toolbar reader-app paper-reader" inert aria-hidden="true">
    <ReaderTopbar onHeightChange={noop} title="Attention Is All You Need" onBack={noop}
      showToc={false} tocPinned={false} onToggleToc={noop} onPreviewToc={noop} onLeaveToc={noop}
      paper={{ meta: { language: "en" } }} mode="bilingual" targetLanguage="zh-CN" onModeChange={noop}
      sourceTrigger={sourceTrigger} sourceActive={false} onSource={noop} insightCount={0} insightsActive={false}
      onInsights={noop} glossaryActive={false} onGlossary={noop} showMargins={false} onMargins={noop}
      onCopySource={noop} onSettings={noop} canReturn={false} onReturn={noop} shortcutLabels={{}} />
  </div>;
}

export function IconGallery() {
  const { style, setStyle, sessionOnly } = useIconStyle();
  const [size, setSize] = useState("actual");
  useEffect(() => { document.title = "图标方案 · 连续阅读"; }, []);
  return <main className="icon-gallery" data-size={size}>
    <header className="icon-gallery-heading">
      <div><a className="icon-gallery-back" href="?view=collection"><ArrowLeft size={16} />连续阅读</a><h1>图标方案</h1></div>
      <div className="icon-gallery-actions"><fieldset className="icon-gallery-size"><legend className="sr-only">图标样本大小</legend>
        {[['actual', '实际尺寸'], ['detail', '放大细节']].map(([value, label]) => <label key={value}><input type="radio" name="icon-gallery-size" value={value} checked={size === value} onChange={() => setSize(value)} /><span>{label}</span></label>)}
      </fieldset><a className="icon-gallery-enter" href="?view=collection">进入资料库<ArrowUpRight size={16} /></a></div>
    </header>
    <div className="icon-gallery-directions">
      {ICON_STYLES.map((item, index) => <section key={item.id} className="icon-gallery-direction" aria-label={item.label}>
        <div className="icon-gallery-direction-heading"><div className="icon-gallery-name"><span className="icon-gallery-index">0{index + 1}</span><h2>{item.label}</h2><p>{item.description}</p></div>
          <button className="icon-gallery-apply" aria-pressed={style === item.id} onClick={() => setStyle(item.id)} aria-label={"使用" + item.label}>{style === item.id && <Check size={14} />}<span>{style === item.id ? "已应用" : "使用此套"}</span></button>
        </div>
        <IconStyleScope style={item.id}>
          <ToolbarSample />
          <div className="icon-gallery-glyphs" aria-label={item.label + "图标样本"}>{glyphs.map(([Icon, label]) => <div key={label} className="icon-gallery-glyph"><Icon size={20} /><span>{label}</span></div>)}</div>
        </IconStyleScope>
      </section>)}
    </div>
    <footer className="icon-gallery-footer"><span aria-live="polite">{sessionOnly ? "当前窗口" : "当前图标"} · {ICON_STYLES.find((item) => item.id === style)?.label}</span><span>Collection 与阅读器同步切换</span></footer>
  </main>;
}
