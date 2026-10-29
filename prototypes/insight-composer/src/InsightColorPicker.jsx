import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check } from "./icons";
import { colorFor, getEnabledColors, getPaletteSettings, subscribePalette } from "./highlight-colors";
import { motion } from "motion/react";
import { useMotionPresence } from "./useMotionPresence.js";

export function InsightColorPicker({ color, open, disabled = false, onOpenChange, onColorChange, triggerRef, inputRef, onMenuKeys }) {
  const settings = useSyncExternalStore(subscribePalette, getPaletteSettings);
  const colors = getEnabledColors(settings);
  const current = colorFor(color);
  const retained = !colors.some((item) => item.id === color);
  const options = retained ? [...colors, current] : colors;
  const lastOpenOptions = useRef([]);
  if (open) lastOpenOptions.current = options.map((item) => ({ ...item, retained: retained && item.id === color }));
  const menuRef = useRef(null);
  const [side, setSide] = useState("bottom");
  const { present, entered, motionProps } = useMotionPresence(open, { kind: "surface", openState: { opacity: 1, y: 0, scale: 1 }, closedState: { opacity: 0, y: side === "top" ? 3 : -3, scale: .985 } });
  useLayoutEffect(() => {
    if (!open || !present) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const headerBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom || 56;
    const fitsBelow = window.innerHeight - 16 - rect.bottom >= menu.offsetHeight + 6;
    setSide(fitsBelow || rect.top < headerBottom + 12 + menu.offsetHeight + 6 ? "bottom" : "top");
    menu.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  }, [open, present, triggerRef]);
  return <div className="color-picker">
    <button ref={triggerRef} className="color-trigger" disabled={disabled} aria-label={"高亮颜色：" + current.label} title="高亮颜色" aria-haspopup="menu" aria-expanded={open} onClick={() => onOpenChange(!open)}><span style={{ background: current.value }} /></button>
    {present && <motion.div {...motionProps} ref={menuRef} className="color-menu" data-motion-surface="color-menu" role="menu" aria-label="高亮颜色" aria-orientation="horizontal" aria-hidden={!open || undefined} inert={!open} data-side={side} data-state={open && entered ? "open" : "closed"} onKeyDown={onMenuKeys}>
      {lastOpenOptions.current.map((item) => {
        const isRetained = item.retained;
        const label = item.label + (isRetained ? "（当前颜色，未在色盘中）" : "");
        return <button key={item.id} className={isRetained ? "retained-color" : undefined} role="menuitemradio" aria-label={label} aria-checked={color === item.id} tabIndex={color === item.id ? 0 : -1} title={label} style={{ background: item.value }} onClick={() => {
          onColorChange(item.id);
          onOpenChange(false);
          inputRef.current?.focus({ preventScroll: true });
        }}><Check size={12} /></button>;
      })}
    </motion.div>}
  </div>;
}
