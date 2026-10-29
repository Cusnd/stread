import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ContinuousMotion } from "../../src/Motion.jsx";
import { useContextMenu } from "../../src/ContextMenu.jsx";
import { contextMenuPosition, isContextMenuKey } from "../../src/context-menu.js";

// Real React/Motion/native-popover fixture. No workspace API, clipboard writes,
// storage changes or synthetic reading activity. Run through the Vite dev host.
const browserErrors = [];
window.addEventListener("error", (event) => browserErrors.push(event.message));
window.addEventListener("unhandledrejection", (event) => browserErrors.push(String(event.reason)));
const mainMenu = () => document.querySelector(".reader-context-position:not(.reader-context-submenu)");
const childMenu = () => document.querySelector(".reader-context-submenu");
const view = () => ({ left: visualViewport?.offsetLeft || 0, top: visualViewport?.offsetTop || 0, width: visualViewport?.width || innerWidth, height: visualViewport?.height || innerHeight });
const round = (number) => Math.round(number * 1000) / 1000;
const rect = (node) => { const value = node.getBoundingClientRect(); return Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, round(value[key])])); };
function identity(transform) {
  const matrix = new DOMMatrix(transform === "none" ? undefined : transform);
  return [matrix.a - 1, matrix.b, matrix.c, matrix.d - 1, matrix.e, matrix.f].every((value) => Math.abs(value) < 0.01);
}
function readFrame(node, firstNode, started) {
  if (!node) return { ms: round(performance.now() - started), present: false };
  const surface = node.querySelector(".reader-context-surface"), clip = node.querySelector(".reader-context-clip");
  return {
    ms: round(performance.now() - started), present: true, sameNode: node === firstNode,
    ...rect(node), opacity: Number(getComputedStyle(surface).opacity), transform: getComputedStyle(surface).transform,
    positionTransform: getComputedStyle(node).transform, inert: node.inert, ariaHidden: node.getAttribute("aria-hidden"),
    state: node.dataset.contextState, clipHeight: rect(clip).height,
    contentHeight: node.querySelector(".reader-context-content").offsetHeight,
    slots: [...node.querySelectorAll(".reader-context-slot")].map((item) => ({ ...rect(item), transform: getComputedStyle(item).transform })),
    labels: [...node.querySelectorAll(".reader-context-label")].map((item) => ({ text: item.textContent, ...rect(item), transform: getComputedStyle(item).transform })),
  };
}
async function frames(getNode, firstNode, duration = 200) {
  const started = performance.now(), samples = [{ phase: "after-commit", ...readFrame(getNode(), firstNode, started) }];
  do { await new Promise(requestAnimationFrame); samples.push({ phase: "animation-frame", ...readFrame(getNode(), firstNode, started) }); }
  while (performance.now() - started < duration);
  return samples;
}
function expected(point, node, anchor) {
  return contextMenuPosition({ point, menu: { width: node.offsetWidth, height: node.offsetHeight }, viewport: view(), submenu: Boolean(anchor), anchorRect: anchor?.getBoundingClientRect() });
}
function Fixture() {
  const menu = useContextMenu({ contextKey: "isolated-motion-fixture" });
  const paragraph = useRef(null), editor = useRef(null), running = useRef(false);
  const [report, setReport] = useState(null), [busy, setBusy] = useState(false), [action, setAction] = useState(""), [editing, setEditing] = useState(false);
  const mockAction = (label) => () => setAction(label);
  const openEditor = () => { flushSync(() => setEditing(true)); editor.current?.focus(); };
  function items(variant = "a") {
    const result = [
      { id: "copy", label: "复制", onSelect: mockAction("已模拟复制") },
      { id: "insight", label: "添加洞见", onSelect: openEditor },
      { id: "source", label: "来源", separatorBefore: true, children: [
        { id: "locate", label: "在原页定位", onSelect: mockAction("已模拟原页定位") },
        { id: "reference", label: "复制来源", onSelect: mockAction("已模拟复制来源") },
      ] },
      { id: "size", label: "显示大小", children: [
        { id: "normal", label: "标准", checked: true, onSelect: mockAction("标准大小") },
        { id: "large", label: "放大", checked: false, onSelect: mockAction("放大") },
      ] },
    ];
    if (variant === "a") result.splice(2, 0, { id: "location", label: "在原页定位", onSelect: mockAction("已模拟原页定位") });
    return result;
  }
  function openEvent(event, variant = "a") { return menu.open(event, { id: variant, trigger: paragraph.current, items: items(variant), label: "段落操作" }); }
  function openAt(point, variant) {
    flushSync(() => openEvent({ type: "contextmenu", target: paragraph.current, currentTarget: paragraph.current,
      clientX: point.x, clientY: point.y, defaultPrevented: false, preventDefault() {}, stopPropagation() {} }, variant));
  }
  const key = (node, value, extra = {}) => flushSync(() => node.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra })));
  async function verify() {
    if (running.current) return;
    running.current = true; setBusy(true); setReport(null);
    const result = { viewport: view(), reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, checks: {}, samples: {}, errors: [] };
    const check = (name, passed, detail) => { result.checks[name] = Boolean(passed); if (!passed) result.errors.push(detail || name); };
    const stable = (samples, point, name) => {
      // Motion batches style writes before paint. Keep the synchronous commit
      // snapshot as evidence, but judge visible geometry from the first rAF.
      const painted = samples.filter((sample) => sample.phase === "animation-frame");
      check(`${name}: immediately anchored`, painted.every((sample) => sample.present && Math.abs(sample.x - point.left) <= 1 && Math.abs(sample.y - point.top) <= 1), `${name}: menu travelled away from its final point`);
      check(`${name}: no scale or translation on content`, painted.every((sample) => sample.present && identity(sample.transform) && [...sample.slots, ...sample.labels].every((item) => identity(item.transform))), `${name}: surface/text layout projection detected`);
      check(`${name}: content height immediately fitted`, painted.every((sample) => sample.present && Math.abs(sample.clipHeight - sample.contentHeight) <= 1), `${name}: content height unfolded from an old size`);
    };
    try {
      flushSync(() => { menu.close("outside"); setEditing(false); });
      await frames(mainMenu, null, 220);
      const a = { x: 96, y: 170 }, b = { x: Math.max(400, innerWidth - 330), y: Math.min(380, innerHeight - 260) };
      openAt(a, "a");
      const node = mainMenu();
      if (!node) throw new Error("Main menu did not mount");
      const initialExpected = expected(a, node);
      result.samples.initial = await frames(mainMenu, node);
      stable(result.samples.initial, initialExpected, "initial");
      check("entry fades without moving", result.reducedMotion || result.samples.initial.some((sample) => sample.opacity > 0 && sample.opacity < 1), "No intermediate fade frame was observed");
      openAt(b, "b");
      const movedExpected = expected(b, mainMenu());
      result.samples.retarget = await frames(mainMenu, node);
      stable(result.samples.retarget, movedExpected, "retarget");
      check("retarget preserves native node", result.samples.retarget.every((sample) => sample.sameNode));
      flushSync(() => menu.close("escape"));
      // Reopen during the committed exit, before the browser can finish it.
      // A background tab can delay rAF for a second, which would test a fully
      // completed exit instead of the intended interruption.
      result.samples.closing = [{ phase: "after-commit", ...readFrame(mainMenu(), node, performance.now()) }];
      check("exit is inert immediately", result.samples.closing.every((sample) => !sample.present || sample.inert && sample.ariaHidden === "true"));
      await Promise.resolve();
      openAt(a, "a");
      const reopenExpected = expected(a, mainMenu());
      result.samples.reopen = await frames(mainMenu, node, 260);
      stable(result.samples.reopen, reopenExpected, "reopen");
      check("reopen survives stale exit callback", result.samples.reopen.every((sample) => sample.present && sample.state === "open" && !sample.inert));
      check("reopen preserves node during unfinished exit", result.reducedMotion || result.samples.reopen.every((sample) => sample.sameNode));
      const edge = { x: innerWidth - 4, y: innerHeight - 4 };
      openAt(edge, "b");
      result.samples.edge = await frames(mainMenu, node, 180);
      stable(result.samples.edge, expected(edge, mainMenu()), "viewport edge");
      check("edge keeps the entire menu inside the viewport", result.samples.edge.every((sample) => sample.present && sample.x >= 8 && sample.y >= 8 && sample.x + sample.width <= innerWidth - 8 && sample.y + sample.height <= innerHeight - 8));
      // Focus and key events use the same DOM handlers as real keyboard input.
      key(paragraph.current, "F10", { shiftKey: true });
      await frames(mainMenu, node, 180);
      check("keyboard opens at trigger", mainMenu()?.dataset.contextState === "open");
      const parents = [...mainMenu().querySelectorAll('[aria-haspopup="menu"]')];
      for (let index = 0; index < parents.length; index++) {
        flushSync(() => parents[index].focus()); key(parents[index], "ArrowRight");
        const child = childMenu();
        check(`submenu ${index + 1}: keyboard opens`, Boolean(child) && child?.contains(document.activeElement));
        if (!child) continue;
        const childExpected = expected(a, child, parents[index]);
        result.samples[`submenu${index + 1}`] = await frames(childMenu, child, 180);
        stable(result.samples[`submenu${index + 1}`], childExpected, `submenu ${index + 1}`);
        key(document.activeElement, "ArrowLeft");
        check(`submenu ${index + 1}: returns focus`, document.activeElement === parents[index]);
        await frames(childMenu, child, 180);
      }
      const add = [...mainMenu().querySelectorAll("button")].find((button) => button.textContent === "添加洞见");
      flushSync(() => add.click());
      check("action hands focus to editor", document.activeElement === editor.current);
      await frames(mainMenu, node, 220);
      check("exit completion keeps editor focus", document.activeElement === editor.current);
    } catch (error) { result.errors.push(error.stack || String(error)); }
    result.errors.push(...browserErrors);
    result.passed = result.errors.length === 0 && Object.values(result.checks).every(Boolean);
    setReport(result); setBusy(false); running.current = false;
  }
  return <main style={{ font: "15px system-ui", padding: "24px 40px", color: "#292b2e", maxWidth: 1120, margin: "auto" }}>
    <h1 style={{ fontSize: 21, fontWeight: 600 }}>右键菜单动画</h1>
    <button onClick={verify} disabled={busy} data-testid="verify-motion" style={{ padding: "8px 16px" }}>{busy ? "正在验证…" : "验证动画"}</button>
    <p ref={paragraph} tabIndex={0} onContextMenu={(event) => openEvent(event)} onKeyDown={(event) => { if (isContextMenuKey(event)) openEvent(event); }}
      style={{ font: "23px/2 Georgia, serif", margin: "40px 0", padding: "24px 0", minHeight: 180 }}>
      我们使用 WMT 2014 英德数据集进行训练，其中约有 450 万个句子对。你可以在这段文字中选择一部分，然后右键打开菜单，也可以聚焦段落后按 Shift+F10。菜单中的操作只改变此演示页面，不保存任何阅读数据。
    </p>
    {editing && <textarea ref={editor} aria-label="模拟洞见编辑框" defaultValue="保留的本地演示草稿" style={{ width: 480, height: 70 }} />}
    <output aria-live="polite">{action}</output>
    <pre data-testid="motion-report" data-passed={report ? String(report.passed) : undefined} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "12px/1.45 monospace", background: "#f6f6f6", padding: 16 }}>
      {report ? JSON.stringify(report, null, 2) : "等待验证"}
    </pre>
    {menu.element}
  </main>;
}

const root = import.meta.hot?.data.root || createRoot(document.getElementById("root"));
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<React.StrictMode><ContinuousMotion><Fixture /></ContinuousMotion></React.StrictMode>);
