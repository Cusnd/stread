import { ReaderSelect } from "./ReaderSelect.jsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { ArrowClockwise, Clock, Keyboard, Palette, SlidersHorizontal, TextAa, X } from "./icons.jsx";
import { IconStyleControl } from "./IconStyleControl.jsx";
import { InterfaceModeControl } from "./InterfaceMode.jsx";
import { ShortcutSettings } from "./ShortcutSettings";
import { LocalHistoryConflicts } from "./SyncSettings.jsx";
import { DesktopUpdates, desktopUpdatesAvailable } from "./DesktopUpdates.jsx";
import { requestJson } from "./workspace-api.js";
import { matchesShortcut } from "./reading-shortcuts";
import { HighlightPaletteSettings } from "./HighlightPaletteSettings";
import { useMotionPresence } from "./useMotionPresence.js";
import { useImmediateReducedMotion } from "./useImmediateReducedMotion.js";
import { motionTransition } from "./motion-system.js";
import { InterfaceScaleControl } from "./InterfaceScale";
import { UI_SCALE_BASE } from "./ui-scale";
import { useReaderRuntime } from "./ReaderRuntime";
import { FONT_SIZE_MIN, FONT_SIZE_MAX, READING_WIDTH_PERCENT_MIN, READING_WIDTH_PERCENT_MAX, READING_WIDTH_PERCENT_STEP, READING_WIDTH_PERCENT_DEFAULT } from "./reading-preferences";
import { languageLabel } from "./reading-language";
import { acquirePageScrollLock } from "./page-scroll-lock.js";
import "./reading-settings.css";

const TABS = [{ id: "reading", label: "阅读", Icon: TextAa }, { id: "interface", label: "界面", Icon: SlidersHorizontal }, { id: "highlight", label: "高亮", Icon: Palette }, { id: "shortcuts", label: "快捷键", Icon: Keyboard }];
const HISTORY_TAB = { id: "history-conflicts", label: "历史冲突", Icon: Clock };
const UPDATES_TAB = { id: "updates", label: "更新", Icon: ArrowClockwise };

function SettingsPage({ id, active, offset, reduced, children }) {
  const motionRef = useImmediateReducedMotion(reduced);
  return <motion.div ref={motionRef} className="settings-page" id={"reading-settings-panel-" + id} role="tabpanel" aria-labelledby={"reading-settings-tab-" + id} aria-hidden={!active || undefined} inert={!active} data-active={active} tabIndex={active ? 0 : -1}
    initial={false} animate={{ opacity: active ? 1 : 0, x: active || reduced ? 0 : offset }} transition={motionTransition("content", reduced)} style={{ zIndex: active ? 1 : 0 }}>
    {children}
  </motion.div>;
}

export function ReadingSettings({ open, onClose, returnFocusRef, title = "设置", fontSize, onFontSizeChange, readingWidthPercent, onReadingWidthChange, showMargins, onMarginsChange, openMode, onOpenModeChange,
  tocMode, onTocModeChange, mode, onModeChange, targetLanguage, languages = [], onTargetLanguageChange,
  translationFirst, onTranslationFirstChange, pdfAvailable, pdfFollow, onPdfFollowChange }) {
  const runtime = useReaderRuntime();
  const [tab, setTab] = useState("reading");
  const [history, setHistory] = useState({ available: false, conflicts: [], error: "" });
  const updatesAvailable = desktopUpdatesAvailable();
  const tabs = [...TABS, ...(history.available ? [HISTORY_TAB] : []), ...(updatesAvailable ? [UPDATES_TAB] : [])];
  const rootRef = useRef(null);
  const previousFocus = useRef(null);
  const releaseScroll = useRef(null);
  const restore = () => {
    releaseScroll.current?.();
    releaseScroll.current = null;
    if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    previousFocus.current = null;
  };
  const { present, entered, reduced, motionProps } = useMotionPresence(open, { onExit: restore });
  const backdropRef = useImmediateReducedMotion(reduced);
  const indicatorRef = useImmediateReducedMotion(reduced);
  const tabIndex = tabs.findIndex((item) => item.id === tab);
  const pageMotion = (id) => ({ active: tab === id, reduced, offset: tabs.findIndex((item) => item.id === id) < tabIndex ? -8 : 8 });

  useEffect(() => {
    if (!open || runtime.mode !== "workspace") return;
    const controller = new AbortController();
    // Historical conflicts are read from this machine only, once per opening.
    requestJson("/api/sync/client/conflicts", { signal: controller.signal }).then(({ conflicts = [] }) => {
      if (controller.signal.aborted) return;
      setHistory({ available: conflicts.length > 0, conflicts, error: "" });
      if (!conflicts.length) setTab((current) => current === HISTORY_TAB.id ? "reading" : current);
    }).catch((error) => {
      if (!controller.signal.aborted) setHistory((current) => ({ ...current, available: true, error: error.message }));
    });
    return () => controller.abort();
  }, [open, runtime.mode]);

  useLayoutEffect(() => {
    if (!open || !present) return;
    // Keep the open settings surface stable while the user drags its slider.
    // The next opening uses the newly saved interface size.
    if (!releaseScroll.current) {
      rootRef.current.parentElement.style.setProperty("--ui-scale", String(runtime.uiScale.getSnapshot().percent / UI_SCALE_BASE));
      previousFocus.current = returnFocusRef?.current || document.activeElement;
      releaseScroll.current = acquirePageScrollLock();
    }
    rootRef.current.querySelector('[data-settings-close]')?.focus({ preventScroll: true });
  }, [open, present, runtime, returnFocusRef]);
  useEffect(() => () => restore(), []);

  function onKeys(event) {
    if (matchesShortcut(event.nativeEvent, "close", runtime.shortcuts.getSnapshot())) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Tab") {
      const items = [...rootRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')].filter((item) => !item.closest("[inert]") && item.tabIndex >= 0 && item.getClientRects().length);
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }

  function onTabKeys(event) {
    const index = tabs.findIndex((item) => item.id === tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : null;
    if (next === null) return;
    event.preventDefault();
    setTab(tabs[next].id);
    rootRef.current.querySelector('#reading-settings-tab-' + tabs[next].id)?.focus();
  }

  if (!present) return null;
  return <motion.div ref={backdropRef} className="settings-overlay" data-state={open && entered ? "open" : "closed"} inert={!open} aria-hidden={!open || undefined} onClick={(event) => { if (open && event.target === event.currentTarget) onClose(); }}
    initial={{ backgroundColor: "#24282d00" }} animate={{ backgroundColor: open ? "#24282d38" : "#24282d00" }} transition={{ duration: reduced ? 0 : 0.14, ease: "linear" }}>
    <motion.section {...motionProps} ref={rootRef} className="settings" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeys}>
      <header className="settings-heading"><h2>{title}</h2><button className="icon-button" data-settings-close aria-label={"关闭" + title} onClick={onClose}><X size={20} /></button></header>
      <div className="settings-tabs" role="tablist" aria-label="设置分类" onKeyDown={onTabKeys} style={{ "--settings-tab-count": tabs.length }}>
        <motion.span ref={indicatorRef} className="settings-tab-indicator" aria-hidden="true" initial={false} animate={{ x: `${tabIndex * 100}%` }} transition={motionTransition("control", reduced)} />
        {tabs.map(({ id, label, Icon }) => <button key={id} id={"reading-settings-tab-" + id} role="tab" aria-selected={tab === id} aria-controls={"reading-settings-panel-" + id} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}><Icon size={17} /><span>{label}</span></button>)}
      </div>
      <div className="settings-pages">
          <SettingsPage id="reading" {...pageMotion("reading")}>
            {onTranslationFirstChange && <fieldset className="reading-control-row reading-order-control"><legend className="sr-only">双语对照顺序</legend><span>双语对照顺序</span><div className="settings-choice-group">
              <label><input type="radio" name="bilingual-order" value="source" checked={!translationFirst} onChange={() => onTranslationFirstChange(false)} /><span>原文在前</span></label>
              <label><input type="radio" name="bilingual-order" value="translation" checked={translationFirst} onChange={() => onTranslationFirstChange(true)} /><span>译文在前</span></label>
            </div></fieldset>}
            <div className="reading-type-control"><label htmlFor="reading-font-size">正文字号</label><output htmlFor="reading-font-size">{fontSize}<span>px</span></output></div>
            <p id="reading-font-size-description" className="reading-type-description">正文与未单独设置字号的图表、代码和题注同步调整</p>
            <input id="reading-font-size" className="reading-size-slider" type="range" min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} value={fontSize} onChange={(event) => onFontSizeChange(Number(event.target.value))} aria-label="正文字号" aria-describedby="reading-font-size-description" style={{ "--range-progress": `${(fontSize - FONT_SIZE_MIN) / (FONT_SIZE_MAX - FONT_SIZE_MIN) * 100}%` }} />
            <div className="reading-type-preview" aria-label="文字预览"><p style={{ fontSize }}>我们的目标是从人类偏好中学习，同时让新的策略不过分偏离参考模型。</p></div>
            <div className="reading-width-control">
              <div className="reading-type-control"><label htmlFor="reading-body-width">正文宽度</label><div className="reading-width-value"><button onClick={() => onReadingWidthChange(READING_WIDTH_PERCENT_DEFAULT)} disabled={readingWidthPercent === READING_WIDTH_PERCENT_DEFAULT}>重置</button><output htmlFor="reading-body-width">{readingWidthPercent}<span>%</span></output></div></div>
              <p id="reading-width-description" className="reading-type-description">按可用页宽调整，保留边注空间</p>
              <input id="reading-body-width" className="reading-size-slider" type="range" min={READING_WIDTH_PERCENT_MIN} max={READING_WIDTH_PERCENT_MAX} step={READING_WIDTH_PERCENT_STEP} value={readingWidthPercent} onChange={(event) => onReadingWidthChange(Number(event.target.value))} aria-label="正文宽度" aria-valuetext={`${readingWidthPercent}%`} aria-describedby="reading-width-description" style={{ "--range-progress": `${(readingWidthPercent - READING_WIDTH_PERCENT_MIN) / (READING_WIDTH_PERCENT_MAX - READING_WIDTH_PERCENT_MIN) * 100}%` }} />
            </div>
            <div className="reading-control-row"><div><span>正文边注</span><small>在段落旁显示洞见</small></div><button className="settings-switch" role="switch" aria-label="显示正文边注" aria-checked={showMargins} onClick={() => onMarginsChange(!showMargins)}><span /></button></div>
            <fieldset className="reading-control-row"><legend className="sr-only">洞见打开方式</legend><div><span>洞见打开方式</span><small>点击顶栏「洞见」时</small></div><div className="settings-choice-group">
              <label><input type="radio" name="insight-open-mode" value="sidebar" checked={openMode === "sidebar"} onChange={() => onOpenModeChange("sidebar")} /><span>侧栏</span></label>
              <label><input type="radio" name="insight-open-mode" value="modal" checked={openMode === "modal"} onChange={() => onOpenModeChange("modal")} /><span>居中</span></label>
            </div></fieldset>
            {onTocModeChange && <label className="reading-control-row"><span>文章目录</span><ReaderSelect aria-label="目录显示方式" value={tocMode} onChange={(event) => onTocModeChange(event.target.value)}><option value="collapsed">悬停预览</option><option value="pinned">固定显示</option></ReaderSelect></label>}
              {onModeChange && <label className="reading-control-row"><span>阅读方式</span><ReaderSelect aria-label="阅读方式" value={mode} onChange={(event) => onModeChange(event.target.value)}><option value="source">原文</option><option value="translation">译文</option><option value="bilingual">双语对照</option></ReaderSelect></label>}
              {onTargetLanguageChange && <label className="reading-control-row"><span>译文语言</span><ReaderSelect aria-label="译文语言" value={targetLanguage} disabled={!languages.length} onChange={(event) => onTargetLanguageChange(event.target.value)}>{!languages.includes(targetLanguage) && <option value={targetLanguage}>{languageLabel(targetLanguage)}（未提供）</option>}{languages.map((language) => <option key={language} value={language}>{languageLabel(language)}</option>)}</ReaderSelect></label>}
              {pdfAvailable && onPdfFollowChange && <div className="reading-control-row"><div><span>正文与原页联动</span><small>关闭后仍可明确定位</small></div><button className="settings-switch" role="switch" aria-label="正文与原页联动" aria-checked={pdfFollow} onClick={() => onPdfFollowChange(!pdfFollow)}><span /></button></div>}
          </SettingsPage>
          <SettingsPage id="interface" {...pageMotion("interface")}><InterfaceScaleControl /><InterfaceModeControl /><IconStyleControl /></SettingsPage>
          <SettingsPage id="highlight" {...pageMotion("highlight")}><HighlightPaletteSettings /></SettingsPage>
          <SettingsPage id="shortcuts" {...pageMotion("shortcuts")}><ShortcutSettings active={open && tab === "shortcuts"} /></SettingsPage>
          {history.available && <SettingsPage id={HISTORY_TAB.id} {...pageMotion(HISTORY_TAB.id)}><LocalHistoryConflicts active={open && tab === HISTORY_TAB.id} conflicts={history.conflicts} initialError={history.error} onChange={(conflicts) => setHistory({ available: true, conflicts, error: "" })} /></SettingsPage>}
          {updatesAvailable && <SettingsPage id={UPDATES_TAB.id} {...pageMotion(UPDATES_TAB.id)}><DesktopUpdates active={open && tab === UPDATES_TAB.id} /></SettingsPage>}
      </div>
      <footer className="settings-footer"><span>{tab === UPDATES_TAB.id ? "" : "更改即时生效"}</span><button onClick={onClose}>完成</button></footer>
    </motion.section>
  </motion.div>;
}
