import { useEffect, useId, useRef, useState } from "react";

export function DesktopAutoStart({ active }) {
  const bridge = typeof window !== "undefined" ? window.continuousReaderDesktop?.autoStart : undefined;
  const [enabled, setEnabled] = useState(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const request = useRef(0), writing = useRef(null), refresh = useRef(null);
  const feedbackId = useId();

  useEffect(() => {
    if (!active || !bridge) return;
    let stopped = false, reading = false;
    const read = async () => {
      if (stopped || reading || writing.current) return;
      reading = true;
      const current = ++request.current;
      setPending("read"); setError("");
      try {
        const status = await bridge.get();
        if (!stopped && request.current === current) setEnabled(status.enabled);
      } catch (failure) {
        if (!stopped && request.current === current) { setEnabled(null); setError(failure.message || "无法读取开机自启设置。"); }
      } finally {
        reading = false;
        if (!stopped && request.current === current) setPending("");
      }
    };
    refresh.current = read;
    // A reopened panel reads after an earlier save has finished.
    if (writing.current) writing.current.then(read, read);
    else void read();
    window.addEventListener("focus", read);
    return () => { stopped = true; request.current++; refresh.current = null; window.removeEventListener("focus", read); };
  }, [active, bridge]);

  async function toggle() {
    if (!active || !bridge || pending || writing.current || enabled === null) return;
    const current = ++request.current;
    setPending("write"); setError("");
    const operation = Promise.resolve().then(() => bridge.set(!enabled));
    writing.current = operation;
    try {
      const status = await operation;
      if (request.current === current) setEnabled(status.enabled);
    } catch (failure) {
      if (request.current === current) { setEnabled(null); setError(failure.message || "未能更改开机自启设置。"); }
    } finally {
      if (writing.current === operation) writing.current = null;
      if (request.current === current) setPending("");
    }
  }

  if (!bridge) return null;
  const message = pending === "write" ? "正在保存…" : pending && enabled === null ? "正在读取…" : "";
  return <div className="desktop-auto-start">
    <div className="reading-control-row"><span>开机自启</span><button className="settings-switch" role="switch" aria-label="开机自启" aria-checked={enabled === true} aria-busy={Boolean(pending)} aria-describedby={message || error ? feedbackId : undefined} disabled={Boolean(pending) || enabled === null} onClick={toggle}><span /></button></div>
    {message && <p id={feedbackId} className="desktop-auto-start-feedback" role="status">{message}</p>}
    {error && <div id={feedbackId} className="desktop-auto-start-feedback is-error" role="alert"><span>{error}</span><button onClick={() => refresh.current?.()}>重试</button></div>}
  </div>;
}
