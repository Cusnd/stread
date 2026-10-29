import { useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUUpLeft, GlossaryIcon, Check, Copy, DotsThree, Eye, FileText, SidebarSimple, SlidersHorizontal } from "./icons";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { languageLabel } from "./reading-language";
import { matchesShortcut } from "./reading-shortcuts";
import { useReaderRuntime } from "./ReaderRuntime";
import { NavigationLoadingLine } from "./NavigationLoadingLine.jsx";
import { useDesktopHeader } from "./DesktopChrome.jsx";
import { AnimatePresence, motion } from "motion/react";
import { MotionItem, MotionSelection } from "./Motion.jsx";
import "./reader-navigation.css";

export function ReaderTopbar({ onHeightChange, title, onBack, backLabel = "返回资料库", onOpenNotes, onPreloadNotes, hasToc = true, tocTitle = "目录", showToc, tocPinned, onToggleToc, onPreviewToc, onLeaveToc, paper, mode, targetLanguage, onModeChange, sourceTrigger, sourceHref, sourceActive, onSource, insightTrigger, insightCount, insightsActive, onInsights, glossaryActive, onGlossary, showMargins, onMargins, onCopySource, onSettings, canReturn, onReturn, returnLabel = "返回跳转前位置", shortcutLabels, preview = false }) {
  const runtime = useReaderRuntime();
  const modeGroup = useId();
  const headerRef = useRef(null);
  useDesktopHeader(headerRef);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef(null);
  const pendingMenuAction = useRef(null);
  useLayoutEffect(() => {
    const header = headerRef.current;
    const root = header.closest(".reader-app[data-reader-runtime]") ? header.ownerDocument.documentElement : null;
    const previousOffset = root?.style.getPropertyValue("--reader-scrollbar-top");
    const measure = () => {
      const height = header.getBoundingClientRect().height;
      onHeightChange(height);
      // The page scrollbar belongs to html, outside the Reader's CSS scope.
      root?.style.setProperty("--reader-scrollbar-top", `${height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => {
      observer.disconnect();
      if (previousOffset) root?.style.setProperty("--reader-scrollbar-top", previousOffset);
      else root?.style.removeProperty("--reader-scrollbar-top");
    };
  }, [onHeightChange]);
  const modes = [
    { value: "source", label: "原文", description: `${languageLabel(paper?.meta.language)}原文` },
    { value: "translation", label: "译文", description: `${languageLabel(targetLanguage)}译文` },
    { value: "bilingual", label: "对照", description: "双语对照" },
  ];
  const source = onSource
    ? <button ref={sourceTrigger} className={"tool-button source-tool" + (sourceActive ? " selected" : "")} aria-label="原页对照" aria-pressed={sourceActive} title="原页对照" onClick={(event) => { sourceTrigger.current = event.currentTarget; onSource(); }}><span>原页</span></button>
    : sourceHref
      ? <a className="tool-button source-tool" href={sourceHref} target="_blank" rel="noreferrer" aria-label="打开所附原文" title="打开所附原文"><span>原页</span></a>
      : <button className="tool-button source-tool" disabled title="这份文章未附原始文件" aria-label="原页不可用"><span>原页</span></button>;

  // Fixed chrome uses viewport coordinates. Exclude article scroll restoration
  // from both the return control and the mode underline's layout projection.
  return <motion.header ref={headerRef} layoutRoot layoutScroll className="topbar reader-topbar">
    {!preview && <NavigationLoadingLine />}
    <div className="topbar-left">
      {onBack && <button className="icon-button reader-back" aria-label={backLabel} title={backLabel} onClick={onBack}><ArrowLeft size={18} /></button>}
      {hasToc && <button className="icon-button toc-toggle" aria-label={(tocPinned ? "取消固定" : "固定") + tocTitle} aria-controls="reader-toc" aria-expanded={showToc} aria-pressed={tocPinned} title={tocPinned ? "点击取消固定" + tocTitle : "悬停预览，点击固定" + tocTitle} onPointerEnter={onPreviewToc} onPointerLeave={onLeaveToc} onClick={onToggleToc}><SidebarSimple size={19} weight={tocPinned ? "fill" : "regular"} /></button>}
      <span className="document-name" title={title}>{title}</span>
      {preview && <span className="reader-preview-label">草稿预览</span>}
      <AnimatePresence initial={false}>{canReturn && <MotionItem as="button" key="reader-return" className="icon-button reader-return" aria-label={returnLabel} title={returnLabel} onClick={onReturn}><ArrowUUpLeft size={16} /></MotionItem>}</AnimatePresence>
    </div>
    {paper && <fieldset className="reader-mode-switch" data-motion-control="mode" aria-label="阅读语言">
      <legend className="sr-only">阅读语言</legend>
      {modes.map((item) => <label key={item.value} className="reader-mode-option" title={item.description}>
        <input type="radio" name={modeGroup} value={item.value} checked={mode === item.value} onChange={() => onModeChange(item.value)} aria-label={item.description} />
        <span>{item.label}</span>
        {mode === item.value && <MotionSelection layoutId={modeGroup + "-mode"} className="reader-mode-indicator" />}
      </label>)}
    </fieldset>}
    <div className="toolbar reader-tools" aria-label="阅读工具">
      {source}
      <span className="topbar-divider" />
      <button ref={insightTrigger} className={"tool-button insight-tool" + (insightsActive ? " selected" : "")} aria-label="洞见" aria-pressed={insightsActive} title={"洞见" + shortcutLabels.insights} onClick={onInsights}><span>洞见</span>{insightCount > 0 && <small>{insightCount}</small>}</button>
      {onOpenNotes && <button className="tool-button notes-tool" aria-label="文章笔记" title="文章笔记" onPointerEnter={onPreloadNotes} onFocus={onPreloadNotes} onClick={onOpenNotes}><span>笔记</span></button>}
      {onGlossary && <button className={"tool-button glossary-trigger" + (glossaryActive ? " selected" : "")} aria-label="术语表" aria-pressed={glossaryActive} title="术语表" onClick={onGlossary}><span>术语</span></button>}
      <button className="icon-button settings-tool" aria-label="阅读设置" aria-haspopup="dialog" title={"阅读设置" + shortcutLabels.settings} onClick={onSettings}><SlidersHorizontal size={18} /></button>
      <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger asChild><button ref={moreRef} className="icon-button reader-more" aria-label="更多阅读操作" title="更多阅读操作"><DotsThree size={21} weight="bold" /></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="reader-navigation-menu" align="end" sideOffset={8} collisionPadding={12} aria-label="更多阅读操作" inert={!menuOpen}
          onCloseAutoFocus={(event) => { const action = pendingMenuAction.current; if (!action) return; event.preventDefault(); pendingMenuAction.current = null; moreRef.current?.focus({ preventScroll: true }); requestAnimationFrame(action); }}
          onKeyDown={(event) => { if (event.key === "Escape" || matchesShortcut(event.nativeEvent, "close", runtime.shortcuts.getSnapshot())) { event.preventDefault(); setMenuOpen(false); } event.stopPropagation(); }}>
          <DropdownMenu.Item className="reader-navigation-menu-item reader-menu-secondary" disabled={!onSource && !sourceHref} onSelect={onSource ? () => { pendingMenuAction.current = () => { sourceTrigger.current = moreRef.current; onSource(); }; } : undefined} asChild={Boolean(!onSource && sourceHref)}>
            {!onSource && sourceHref ? <a href={sourceHref} target="_blank" rel="noreferrer"><FileText size={17} /><span>打开所附原文</span></a> : <><FileText size={17} /><span>原页对照</span></>}
          </DropdownMenu.Item>
          {onGlossary && <DropdownMenu.Item className="reader-navigation-menu-item reader-menu-secondary" onSelect={() => { pendingMenuAction.current = onGlossary; }}><GlossaryIcon size={17} /><span>术语表</span>{glossaryActive && <Check size={15} />}</DropdownMenu.Item>}
          {paper && <DropdownMenu.Item className="reader-navigation-menu-item" onSelect={onCopySource}><Copy size={17} /><span>复制原文引用</span></DropdownMenu.Item>}
          <DropdownMenu.CheckboxItem className="reader-navigation-menu-item" checked={showMargins} onCheckedChange={onMargins}><Eye size={17} /><span>显示边注</span><DropdownMenu.ItemIndicator className="reader-navigation-menu-check"><Check size={15} /></DropdownMenu.ItemIndicator>{shortcutLabels.margins && <kbd>{shortcutLabels.margins}</kbd>}</DropdownMenu.CheckboxItem>
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  </motion.header>;
}
