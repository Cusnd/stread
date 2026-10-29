import { useId, useSyncExternalStore } from "react";
import { INTERFACE_MODES, getInterfaceModeSnapshot, getServerInterfaceModeSnapshot, subscribeInterfaceMode, updateInterfaceMode } from "./interface-mode.js";
import "./interface-mode.css";

export function useInterfaceMode() {
  const snapshot = useSyncExternalStore(subscribeInterfaceMode, getInterfaceModeSnapshot, getServerInterfaceModeSnapshot);
  return { ...snapshot, setMode: updateInterfaceMode };
}

export function InterfaceModeControl() {
  const { mode, setMode, sessionOnly } = useInterfaceMode();
  const name = useId();
  return <fieldset className="interface-mode-control">
    <legend>界面</legend>
    <div className="interface-mode-options">
      {INTERFACE_MODES.map((item) => <label key={item.id} className="interface-mode-option">
        <input type="radio" name={name} value={item.id} checked={mode === item.id} onChange={() => setMode(item.id)} />
        <span>{item.label}</span>
      </label>)}
    </div>
    {sessionOnly && <p className="interface-mode-storage-note" role="status">仅在当前窗口生效</p>}
  </fieldset>;
}

export function DecorativeIcon({ children }) {
  const { mode } = useInterfaceMode();
  return mode === "normal" ? children : null;
}
