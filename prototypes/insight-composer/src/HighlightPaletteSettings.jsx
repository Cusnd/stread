import { useState, useSyncExternalStore } from "react";
import { Check } from "./icons";
import { COLOR_PALETTES, togglePaletteColor } from "./highlight-colors";
import { useReaderRuntime } from "./ReaderRuntime";

export function HighlightPaletteSettings() {
  const runtime = useReaderRuntime();
  const settings = useSyncExternalStore(runtime.palette.subscribe, runtime.palette.getSnapshot);
  const palette = COLOR_PALETTES.find((item) => item.id === settings.presetId);
  const enabled = settings.enabledByPreset[palette.id];
  const [previewColor, setPreviewColor] = useState(null);
  const preview = palette.colors.find((color) => color.id === previewColor) || palette.colors.find((color) => enabled.includes(color.id));
  return <section className="palette-settings" aria-labelledby="palette-heading">
    <h3 id="palette-heading">选择色系</h3>
    <fieldset className="palette-presets">
      <legend className="sr-only">预置色系</legend>
      {COLOR_PALETTES.map((item) => <label className="palette-preset" key={item.id}>
        <input type="radio" name="highlight-palette" value={item.id} checked={settings.presetId === item.id} onChange={() => runtime.palette.update({ ...settings, presetId: item.id })} />
        <span className="palette-preset-title">{item.label}<span className="palette-preset-check" aria-hidden="true"><Check size={13} weight="bold" /></span></span>
        <span className="palette-preview" aria-hidden="true">{item.colors.map((color) => <i key={color.id} style={{ background: color.value }} />)}</span>
      </label>)}
    </fieldset>
    <div className="palette-colors-heading">
      <span id="visible-colors-label">显示在色盘中 <small>{enabled.length} / {palette.colors.length}</small></span>
      <button type="button" disabled={enabled.length === palette.colors.length} onClick={() => runtime.palette.update({ ...settings, enabledByPreset: { ...settings.enabledByPreset, [palette.id]: palette.colors.map((color) => color.id) } })}>全部显示</button>
    </div>
    <div key={palette.id} className="palette-colors" role="group" aria-labelledby="visible-colors-label" style={{ "--palette-columns": palette.colors.length, "--palette-mobile-columns": palette.colors.length === 4 ? 2 : 3 }} onMouseLeave={() => setPreviewColor(null)}>
      {palette.colors.map((color, index) => {
        const checked = enabled.includes(color.id);
        const last = checked && enabled.length === 1;
        return <label className="palette-color" data-enabled={checked} key={color.id} title={last ? "至少保留一种颜色" : undefined} style={{ "--color-order": index }} onMouseEnter={() => setPreviewColor(color.id)}>
          <input type="checkbox" checked={checked} disabled={last} onChange={() => runtime.palette.update(togglePaletteColor(settings, color.id))} />
          <span className="palette-color-dot" style={{ background: color.value }} aria-hidden="true"><Check size={13} weight="bold" /></span>
          <span>{color.label}</span>
        </label>;
      })}
    </div>
    <div className="palette-reading-preview" aria-label="高亮预览"><span>预览</span><p>同时让新的策略<mark style={{ backgroundColor: preview.value }}>不过分偏离参考模型</mark>。</p></div>
    <p className="palette-help">{enabled.length === 1 ? "至少保留一种颜色。" : "点击颜色显示或隐藏。"}已有高亮保持原色。</p>
    {settings.sessionOnly && <p className="palette-storage-note" role="status">浏览器暂时无法保存设置，本次更改仅在当前页面生效。</p>}
  </section>;
}
