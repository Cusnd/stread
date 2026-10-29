import { useRef } from "react";
import { ArrowLeft, SlidersHorizontal } from "../icons";
import { useDesktopHeader } from "../DesktopChrome.jsx";
import { NavigationLoadingLine } from "../NavigationLoadingLine.jsx";
import "../workspace/workspace.css";
import "./article-notes.css";

export function ArticleNotesHeader({ title, onBack, onSettings }) {
  const headerRef = useRef(null);
  useDesktopHeader(headerRef);
  return <header ref={headerRef} className="workspace-ui workspace-header article-notes-header">
    <div className="article-notes-back"><button type="button" className="workspace-icon-button" aria-label="返回文章" title="返回文章" disabled={!onBack} onClick={onBack}><ArrowLeft size={18} /></button><span title={title}>{title}</span></div>
    <span className="article-notes-page-label">笔记</span>
    <div className="workspace-header-actions">{onSettings && <button type="button" className="workspace-icon-button" aria-label="设置" title="设置" aria-haspopup="dialog" onClick={onSettings}><SlidersHorizontal size={17} /></button>}</div>
    <NavigationLoadingLine />
  </header>;
}
