import { useId, useRef, useState } from "react";
import { ArrowsInSimple, ArrowsOutSimple, SlidersHorizontal } from "./icons";
import { useObjectControls } from "./ObjectFrame";
import { ObjectSizePanel } from "./ObjectSizePanel";

export function objectLabel(block, mode) {
  const labels = { table: ["Table", "表"], figure: ["Figure", "图"], algorithm: ["Algorithm", "算法"], code: ["Code", "代码"] };
  const pair = labels[block.role || block.type] || ["Object", "内容"];
  return pair[mode === "source" ? 0 : 1] + (block.num ? " " + block.num : "");
}

export function ObjectToolbar({ block, mode }) {
  const label = objectLabel(block, mode);
  const controls = useObjectControls();
  const [open, setOpen] = useState(false);
  const panelOpen = controls?.sizePanelOpen ?? open;
  const setPanelOpen = controls?.setSizePanelOpen || setOpen;
  const trigger = useRef(null), anchor = useRef(null);
  const panelId = useId();
  function close(restoreFocus = true) { setPanelOpen(false); if (restoreFocus) trigger.current?.focus({ preventScroll: true }); }
  return <div ref={anchor} className="object-toolbar">
    <span className="figure-number">{label}</span>
    {controls && <div className="object-actions">
      <button ref={trigger} className="object-size-trigger" data-custom={controls.custom || undefined} aria-label={label + "，调整大小"} aria-expanded={panelOpen} aria-haspopup="dialog" aria-controls={panelOpen ? panelId : undefined} onClick={() => panelOpen ? close() : setPanelOpen(true)}><SlidersHorizontal size={14} /><span>大小</span></button>
      <button className="object-expand" data-expand-block={block.id} aria-label={label + (controls.expanded ? "，收起" : "，展开查看")} aria-expanded={controls.expanded} disabled={!controls.canExpand} onClick={controls.toggle}>
        {controls.expanded ? <ArrowsInSimple size={14} /> : <ArrowsOutSimple size={14} />}<span>{controls.expanded ? "收起" : "展开查看"}</span>
      </button>
    </div>}
    {controls && <ObjectSizePanel open={panelOpen} onClose={close} triggerRef={trigger} anchorRef={anchor} controls={controls} label={label} isImage={(block.role || block.type) === "figure"} id={panelId} />}
  </div>;
}
