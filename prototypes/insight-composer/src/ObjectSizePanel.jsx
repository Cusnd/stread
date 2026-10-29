import { matchesShortcut } from "./reading-shortcuts";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowCounterClockwise, Minus, Plus, X } from "./icons";
import { OBJECT_FONT_MIN, OBJECT_FONT_MAX } from "./object-preferences";
import { motion } from "motion/react";
import { useMotionPresence } from "./useMotionPresence.js";
import { useReaderRuntime } from "./ReaderRuntime";

function SizeControl({ label, value, min, max, unit, onChange }) {
  const runtime = useReaderRuntime();
  const [editing, setEditing] = useState(null);
  const clamp = (next) => Math.max(min, Math.min(max, next));
  function commit() {
    if (editing !== null && editing.trim() && Number.isFinite(Number(editing))) onChange(clamp(Number(editing)));
    setEditing(null);
  }
  return <div className="object-size-control">
    <div className="object-size-control-heading"><span>{label}</span><label className="object-size-number"><input type="number" aria-label={label + "数值"} min={min} max={max} step="1" value={editing ?? value}
      onChange={(event) => setEditing(event.target.value)} onBlur={commit} onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        if (matchesShortcut(event.nativeEvent, "close", runtime.shortcuts.getSnapshot()) && editing !== null) { event.preventDefault(); event.stopPropagation(); setEditing(null); }
      }} /><span>{unit}</span></label></div>
    <div className="object-size-range"><button aria-label={"减小" + label} disabled={value <= min} onClick={() => onChange(clamp(value - 1))}><Minus size={13} /></button>
      <input type="range" aria-label={label} min={min} max={max} step="1" value={value} aria-valuetext={value + unit} onChange={(event) => onChange(Number(event.target.value))} />
      <button aria-label={"增大" + label} disabled={value >= max} onClick={() => onChange(clamp(value + 1))}><Plus size={13} /></button></div>
  </div>;
}

export function ObjectSizePanel({ open, onClose, triggerRef, anchorRef, controls, label, isImage, id }) {
  const runtime = useReaderRuntime();
  const panel = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState({ left: 12, top: 70 });
  const { present, entered, motionProps } = useMotionPresence(open, { kind: "surface" });
  useLayoutEffect(() => {
    if (!present) return;
    function measure() {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor || !panel.current) return;
      const viewport = document.documentElement.clientWidth;
      const width = Math.min(292, viewport - 24);
      const height = panel.current.getBoundingClientRect().height;
      const header = document.querySelector(".topbar")?.getBoundingClientRect().bottom || 0;
      const top = Math.max(header + 8, Math.min(anchor.bottom + 8, window.innerHeight - height - 12));
      const next = { left: Math.max(12, Math.min(anchor.left, viewport - width - 12)), top, width };
      setPosition((previous) => Object.keys(next).every((key) => previous[key] === next[key]) ? previous : next);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel.current);
    if (anchorRef.current) observer.observe(anchorRef.current);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [present, anchorRef]);
  useLayoutEffect(() => {
    if (!open || !present) return;
    panel.current?.querySelector('input[type="range"]')?.focus({ preventScroll: true });
    function outside(event) {
      // Browser/window activation can return focus to the body without a user
      // choosing another control. Keep the nonmodal panel open in that case.
      if (event.type === "focusin" && (event.target === document.body || event.target === document.documentElement)) return;
      if (!panel.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) closeRef.current(false);
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); };
  }, [open, present, triggerRef]);
  if (!present) return null;
  return createPortal(<motion.section {...motionProps} data-motion-surface="object-size" ref={panel} id={id} className="object-size-panel" role="dialog" aria-label={label + "大小设置"}
    data-state={open && entered ? "open" : "closed"} inert={!open} aria-hidden={!open || undefined} style={position}
    onKeyDown={(event) => { event.stopPropagation(); if (matchesShortcut(event.nativeEvent, "close", runtime.shortcuts.getSnapshot())) { event.preventDefault(); onClose(); } }}>
    <header><span>{label} · 大小</span><button aria-label="关闭大小设置" onClick={() => onClose()}><X size={15} /></button></header>
    <SizeControl label={isImage ? "图片大小" : "对象宽度"} unit="%" min={controls.minPercent} max={controls.maxPercent} value={controls.widthPercent} onChange={controls.setWidthPercent} />
    <p className="object-size-hint">100% 为默认宽度 · 当前 {Math.round(controls.width || 0)} px{isImage ? " · 等比缩放" : ""}</p>
    <div className="object-font-mode"><span>{isImage ? "图注字号" : "内容字号"}</span><button role="switch" aria-label="跟随正文字号" aria-checked={controls.followsBody}
      onClick={() => controls.setFontSize(controls.followsBody ? controls.fontSize : null)}><span className="object-follow-indicator" />跟随正文</button></div>
    <SizeControl label={isImage ? "图注字号" : "内容字号"} unit="px" min={OBJECT_FONT_MIN} max={OBJECT_FONT_MAX} value={controls.fontSize} onChange={controls.setFontSize} />
    <p className="object-size-hint">{isImage ? "图片内的文字随图片缩放，字号设置作用于图注。" : controls.followsBody ? "调整字号后，仅为此对象单独设置。" : "仅调整此对象的文字与题注。"}</p>
    {controls.syncStatus && <div className="object-save-status" role="status" data-status={controls.syncStatus} title={controls.syncError || undefined}>
      <span>{controls.syncStatus === "error" ? "暂未保存到本机" : controls.syncStatus === "loading" ? "正在读取已保存设置…" : controls.syncStatus === "saved" ? "已保存到本机" : "正在保存…"}</span>
      {controls.syncStatus === "error" && <button onClick={controls.retrySync}>重试保存</button>}
    </div>}
    <footer><button className="object-size-reset" disabled={!controls.custom && !controls.expanded} onClick={() => { controls.reset(); panel.current?.querySelector('input[type="range"]')?.focus({ preventScroll: true }); }}><ArrowCounterClockwise size={13} />恢复默认</button><button className="object-size-done" onClick={() => onClose()}>完成</button></footer>
  </motion.section>, document.body);
}
