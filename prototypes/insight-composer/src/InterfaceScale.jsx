import { useLayoutEffect, useSyncExternalStore } from "react";
import { UI_SCALE_BASE, UI_SCALE_DEFAULT, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from "./ui-scale";
import { useReaderRuntime } from "./ReaderRuntime";

export function ReaderInterfaceScale() {
  const runtime = useReaderRuntime();
  const { percent } = useSyncExternalStore(runtime.uiScale.subscribe, runtime.uiScale.getSnapshot);
  useLayoutEffect(() => {
    const previous = document.documentElement.style.getPropertyValue("--ui-scale");
    document.documentElement.style.setProperty("--ui-scale", String(percent / UI_SCALE_BASE));
    window.dispatchEvent(new Event("reader-ui-scale-change"));
    if (runtime.mode !== "preview") return;
    return () => {
      if (previous) document.documentElement.style.setProperty("--ui-scale", previous);
      else document.documentElement.style.removeProperty("--ui-scale");
    };
  }, [percent, runtime.mode]);
  return null;
}

export function InterfaceScaleControl() {
  const runtime = useReaderRuntime();
  const { percent, sessionOnly } = useSyncExternalStore(runtime.uiScale.subscribe, runtime.uiScale.getSnapshot);
  return <section className="interface-scale-control" aria-label="界面大小设置">
    <div className="interface-scale-heading"><label htmlFor="reader-ui-scale">界面大小</label><div><output htmlFor="reader-ui-scale">{percent}<span>%</span></output><button disabled={percent === UI_SCALE_DEFAULT} title="恢复紧凑 80%" onClick={() => runtime.uiScale.update(UI_SCALE_DEFAULT)}>重置</button></div></div>
    <input id="reader-ui-scale" className="reading-size-slider interface-scale-slider" type="range" min={UI_SCALE_MIN} max={UI_SCALE_MAX} step={UI_SCALE_STEP} value={percent} onChange={(event) => runtime.uiScale.update(Number(event.target.value))} aria-label="界面大小" aria-valuetext={percent + "%" + (percent === 80 ? "，紧凑" : percent === 100 ? "，标准" : percent === 120 ? "，较大" : "")} style={{ "--range-progress": `${(percent - UI_SCALE_MIN) / (UI_SCALE_MAX - UI_SCALE_MIN) * 100}%` }} />
    <div className="interface-scale-marks" aria-hidden="true"><span>紧凑 80%</span><span>标准 100%</span><span>较大 120%</span></div>
    <p>{sessionOnly ? "当前窗口生效，浏览器暂时无法记住此设置。" : "调整目录、工具栏和面板，正文与批注保持独立。"}</p>
  </section>;
}
