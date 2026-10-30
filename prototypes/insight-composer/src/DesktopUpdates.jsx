import { useEffect, useRef, useState } from "react";
import "./desktop-updates.css";

export function desktopUpdatesAvailable() {
  return typeof window !== "undefined" && Boolean(window.continuousReaderDesktop?.updates);
}

function description(status, checked) {
  switch (status.state) {
    case "checking": return "正在检查更新…";
    case "available": return `发现新版本 ${status.availableVersion}`;
    case "downloading": return "正在下载更新…";
    case "downloaded": case "restart-required": return `版本 ${status.availableVersion} 已准备好`;
    case "full-update-required": return status.availableVersion ? `版本 ${status.availableVersion} 需要更新安装包` : "需要完整安装包";
    case "error": return "更新未完成";
    default: return status.checkedAt || checked ? "已是最新版本" : "";
  }
}

export function DesktopUpdates({ active }) {
  const bridge = typeof window !== "undefined" ? window.continuousReaderDesktop?.updates : undefined;
  const [status, setStatus] = useState({ state: "idle", version: "" });
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [checked, setChecked] = useState(false);
  const mounted = useRef(false), operation = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active || !bridge) return;
    let stopped = false, reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try { const value = await bridge.status(); if (!stopped) setStatus(value); }
      catch (failure) { if (!stopped) setError(failure.message); }
      finally { reading = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 750);
    return () => { stopped = true; clearInterval(timer); };
  }, [active, bridge]);

  async function action(name) {
    if (operation.current || !bridge) return;
    operation.current = true; setPending(name); setError("");
    try {
      const value = await bridge[name]();
      if (mounted.current && value) { setStatus(value); if (name === "check" && value.state === "idle") setChecked(true); }
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { operation.current = false; if (mounted.current) setPending(""); }
  }

  if (!bridge) return null;
  const busy = Boolean(pending) || ["checking", "downloading"].includes(status.state);
  const downloaded = ["downloaded", "restart-required"].includes(status.state);
  const message = pending === "restart" ? "正在保存并重启…" : description(status, checked);
  return <section className="desktop-updates" aria-label="程序更新" aria-busy={busy}>
    <div className="desktop-updates-version"><span>Stread</span><span>{status.version ? `版本 ${status.version}` : ""}</span></div>
    <div className="desktop-updates-status" role="status" aria-live="polite">{message}</div>
    {status.state === "downloading" && <progress aria-label="更新下载进度" max={status.bytes || 1} value={Math.min(status.receivedBytes || 0, status.bytes || 1)} />}
    {(error || status.error) && <p className="desktop-updates-error" role="alert">{error || status.error}</p>}
    <div className="desktop-updates-actions">
      {downloaded ? <button type="button" className="ui-button" data-ui-button="submit" disabled={busy} onClick={() => action("restart")}>重启并更新</button>
        : status.state === "available" ? <button type="button" className="ui-button" data-ui-button="submit" disabled={busy} onClick={() => action("download")}>下载更新{status.bytes > 0 ? ` · ${(status.bytes / 1024 / 1024).toFixed(1)} MB` : ""}</button>
          : status.state === "full-update-required" ? <button type="button" className="ui-button" data-ui-button="entry" disabled={busy} onClick={() => action("openRelease")}>下载安装包</button>
            : <button type="button" className="ui-button" data-ui-button="entry" disabled={busy} onClick={() => action("check")}>{pending === "check" || status.state === "checking" ? "正在检查…" : "检查更新"}</button>}
      {status.releaseUrl && status.state !== "full-update-required" && <button type="button" className="ui-button" data-ui-button="text" disabled={busy} onClick={() => action("openRelease")}>版本说明</button>}
    </div>
  </section>;
}
