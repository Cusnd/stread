import { useId } from "react";
import { ICON_STYLES, IconStyleScope, useIconStyle, FileText, InsightIcon, GlossaryIcon, SlidersHorizontal } from "./icons.jsx";
import "./icon-style.css";

export function IconStyleControl() {
  const { style, setStyle, sessionOnly } = useIconStyle();
  const name = useId();
  return <fieldset className="icon-style-control">
    <legend>图标</legend>
    <div className="icon-style-options">
      {ICON_STYLES.map((item) => <label key={item.id} className="icon-style-option">
        <input type="radio" name={name} value={item.id} checked={style === item.id} onChange={() => setStyle(item.id)} />
        <span className="icon-style-sample">
          <IconStyleScope style={item.id}><span className="icon-style-glyphs" aria-hidden="true"><FileText size={18} /><InsightIcon size={18} /><GlossaryIcon size={18} /><SlidersHorizontal size={18} /></span></IconStyleScope>
          <span>{item.label}</span>
        </span>
      </label>)}
    </div>
    <a className="icon-style-compare" href="?icon-preview=1" target="_blank" rel="noreferrer">并排比较</a>
    {sessionOnly && <p className="icon-style-storage-note">仅在当前窗口生效</p>}
  </fieldset>;
}
