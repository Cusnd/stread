import { useId, useLayoutEffect, useRef, useState } from "react";
import { BookmarkSimple, Check, Copy, DotsThree, NotePencil, Trash } from "./icons";
import { DecorativeIcon } from "./InterfaceMode.jsx";
import { isHighlightOnly } from "./insight-content";
import { matchesShortcut } from "./reading-shortcuts";
import "./insight-management.css";

// A native popover stays above clipped margin rails, scrolling lists and dialogs.
export function InsightActions({ note, onEdit, onDelete, onCopy, onReview, onCompleteReview, readOnly = false, busy = false, editing = false, deleteUnavailable = false, className = "" }) {
  const id = useId();
  const trigger = useRef(null);
  const menu = useRef(null);
  const [open, setOpen] = useState(false);

  function position() {
    if (!trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const width = menu.current.offsetWidth || 168;
    const height = menu.current.offsetHeight || 118;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const right = left + (viewport?.width || window.innerWidth), bottom = top + (viewport?.height || window.innerHeight);
    Object.assign(menu.current.style, {
      left: Math.max(left + 10, Math.min(rect.right - width, right - width - 10)) + "px",
      top: Math.max(top + 10, Math.min(rect.bottom + height + 6 <= bottom - 10 ? rect.bottom + 6 : rect.top - height - 6, bottom - height - 10)) + "px",
    });
  }
  function close() {
    // Closing popovers remain painted briefly for their exit transition, but
    // must immediately leave both keyboard navigation and the accessibility tree.
    menu.current?.setAttribute("inert", "");
    menu.current?.setAttribute("aria-hidden", "true");
    setOpen(false);
    menu.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  }
  function act(callback) {
    close();
    callback?.(note, trigger.current);
  }
  useLayoutEffect(() => {
    if (!open) return;
    position();
    menu.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open]);

  return <div className={"insight-actions " + className}>
    <button ref={trigger} className="insight-more" aria-label={"洞见操作 " + note.reference} title="洞见操作" aria-haspopup="menu" aria-controls={id} aria-expanded={open} onClick={() => {
      if (menu.current.matches(":popover-open")) close();
      else { position(); menu.current.showPopover(); position(); }
    }} onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); menu.current.showPopover(); position(); }
    }}><DotsThree size={20} weight="bold" /></button>
    <div ref={menu} id={id} className="insight-action-menu" popover="auto" role="menu" aria-label={"洞见操作 " + note.reference} inert={!open} aria-hidden={!open} onBeforeToggle={(event) => {
      const nextOpen = event.newState === "open";
      event.currentTarget.toggleAttribute("inert", !nextOpen);
      event.currentTarget.setAttribute("aria-hidden", String(!nextOpen));
      setOpen(nextOpen);
    }} onToggle={(event) => setOpen(event.newState === "open")} onKeyDown={(event) => {
      if (event.isComposing || event.nativeEvent.isComposing) return;
      if (event.key === "Escape" || matchesShortcut(event.nativeEvent, "close")) { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === "Tab") { event.stopPropagation(); close(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const items = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
    }}>
      <button role="menuitem" disabled={readOnly || busy} title={readOnly ? "当前文档为只读" : undefined} onClick={() => act(onEdit)}><DecorativeIcon><NotePencil size={15} aria-hidden="true" /></DecorativeIcon>{editing ? "继续编辑" : isHighlightOnly(note) ? "补充批注" : "编辑洞见"}</button>
      <button role="menuitem" onClick={() => act(onCopy)}><DecorativeIcon><Copy size={15} aria-hidden="true" /></DecorativeIcon>复制编号</button>
      {onCompleteReview && note.review?.pending && <button role="menuitem" disabled={readOnly || busy} title={readOnly ? "当前文档为只读" : undefined} onClick={() => act(onCompleteReview)}><DecorativeIcon><Check size={15} aria-hidden="true" /></DecorativeIcon>完成回顾</button>}
      {onReview && <button role="menuitem" disabled={readOnly || busy} title={readOnly ? "当前文档为只读" : undefined} onClick={() => act(onReview)}><DecorativeIcon><BookmarkSimple size={15} aria-hidden="true" /></DecorativeIcon>{note.review?.pending ? "移出待回顾" : "加入待回顾"}</button>}
      <div className="insight-action-divider" role="separator" />
      <button role="menuitem" className="insight-delete" disabled={readOnly || busy || editing || deleteUnavailable} title={readOnly ? "当前文档为只读" : editing ? "请先保存或取消当前编辑" : note.answer ? "删除问题及其回答" : "删除洞见及其高亮"} onClick={() => act(onDelete)}><DecorativeIcon><Trash size={15} aria-hidden="true" /></DecorativeIcon>{note.answer ? "删除问题与回答" : "删除洞见"}</button>
    </div>
  </div>;
}
