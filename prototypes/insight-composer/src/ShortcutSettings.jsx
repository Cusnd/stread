import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowCounterClockwise } from "./icons";
import { SHORTCUT_ACTIONS, DEFAULT_SHORTCUTS, chordFromEvent, formatShortcut } from "./reading-shortcuts";
import { useReaderRuntime } from "./ReaderRuntime";

export function ShortcutSettings({ active }) {
  const runtime = useReaderRuntime();
  const bindings = useSyncExternalStore(runtime.shortcuts.subscribe, runtime.shortcuts.getSnapshot);
  const [recording, setRecording] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => { if (!active) { setRecording(null); setMessage(""); } }, [active]);
  function setBinding(id, chord) {
    const problem = runtime.shortcuts.update(id, chord);
    setError(Boolean(problem));
    setMessage(problem || `${SHORTCUT_ACTIONS.find((action) => action.id === id).label}：${formatShortcut(chord)}`);
    if (!problem) setRecording(null);
  }
  function record(event, id) {
    if (recording !== id) return;
    if (event.key === "Tab") { setRecording(null); setError(false); setMessage("已取消，原快捷键保留。"); return; }
    event.preventDefault(); event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
    if (event.key === "Escape" && id !== "close") { setRecording(null); setMessage("已取消，原快捷键保留。"); setError(false); return; }
    if (["Backspace", "Delete"].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { setBinding(id, null); return; }
    if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
    const chord = chordFromEvent(event.nativeEvent);
    if (!chord) { setMessage("此按键用于系统导航或输入法，请选择其他组合。"); setError(true); return; }
    setBinding(id, chord);
  }
  return <div className="shortcut-settings">
    <div className="shortcut-intro"><p>点击键位，再按下新的快捷键。</p><button className="shortcut-reset-all" disabled={SHORTCUT_ACTIONS.every((action) => bindings[action.id] === action.default)} onClick={() => { runtime.shortcuts.reset(); setRecording(null); setError(false); setMessage("已恢复所有默认快捷键。"); }}>恢复全部默认</button></div>
    <div className="shortcut-rows">{SHORTCUT_ACTIONS.map((action) => <div className="shortcut-row" key={action.id}>
      <div className="shortcut-label"><span>{action.label}</span><small>{action.hint}</small></div>
      <button className="shortcut-recorder" data-shortcut-recorder aria-label={"修改快捷键：" + action.label} aria-pressed={recording === action.id} aria-describedby="shortcut-feedback" onClick={() => { setRecording(action.id); setError(false); setMessage(action.id === "close" ? "按下新组合；Delete 停用；点击其他位置取消。" : "按下新组合；Esc 取消；Delete 停用。"); }} onKeyDown={(event) => record(event, action.id)} onBlur={() => { if (recording === action.id) { setRecording(null); setError(false); setMessage("已取消，原快捷键保留。"); } }}><kbd>{recording === action.id ? "请按键…" : formatShortcut(bindings[action.id])}</kbd></button>
      <button className="shortcut-reset" aria-label={"恢复默认快捷键：" + action.label} title={"恢复为 " + formatShortcut(action.default)} disabled={bindings[action.id] === DEFAULT_SHORTCUTS[action.id]} onClick={() => setBinding(action.id, action.default)}><ArrowCounterClockwise size={15} /></button>
    </div>)}</div>
    <p id="shortcut-feedback" className={"shortcut-feedback" + (error ? " is-error" : "")} role={error ? "alert" : "status"}>{message || "阅读动作在输入框与中文组字时暂停。Ctrl 在 Mac 上对应 ⌘。"}</p>
    <p className="shortcut-footnote">{runtime.mode === "preview" ? "快捷键仅在当前预览中临时生效。" : "快捷键自动保存并同步到同一浏览器的标签页。"}Tab、方向键和 Enter 继续用于界面导航。</p>
  </div>;
}
