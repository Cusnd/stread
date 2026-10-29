export const SHORTCUTS_KEY = "continuous-reader.shortcuts.v1";
export const SHORTCUT_ACTIONS = [
  { id: "settings", label: "阅读设置", hint: "打开或收起设置", default: "Mod+," },
  { id: "addInsight", label: "添加洞见", hint: "为选中的文字或公式添加洞见", default: "A" },
  { id: "requestChange", label: "AI 请求", hint: "针对整篇文章提出请求", default: "R" },
  { id: "insightSidebar", label: "洞见边栏", hint: "打开或收起侧栏", default: "I" },
  { id: "insightModal", label: "洞见面板", hint: "打开或收起居中面板", default: "Shift+I" },
  { id: "margins", label: "显示 / 隐藏边注", hint: "保留洞见，只切换正文边注", default: "B" },
  { id: "save", label: "保存当前输入", hint: "保存洞见或 AI 请求", default: "Mod+Enter" },
  { id: "close", label: "关闭当前面板", hint: "退出当前菜单、输入框或面板", default: "Escape" },
];
export const DEFAULT_SHORTCUTS = Object.fromEntries(SHORTCUT_ACTIONS.map((action) => [action.id, action.default]));
const modifierOrder = ["Mod", "Alt", "Shift"];
const namedKeys = new Set(["Escape", "Enter", "Home", "End", "PageUp", "PageDown", ...Array.from({ length: 12 }, (_, i) => "F" + (i + 1))]);
export function normalizeChord(chord) {
  if (chord === null) return null;
  if (typeof chord !== "string") return undefined;
  const parts = chord.split("+");
  const key = parts.pop();
  if (!key || parts.some((part) => !modifierOrder.includes(part)) || new Set(parts).size !== parts.length) return undefined;
  const normalized = key.length === 1 && /^[a-z0-9,.;/\[\]'`=\-]$/i.test(key) ? key.toUpperCase() : namedKeys.has(key) ? key : undefined;
  return normalized ? [...modifierOrder.filter((part) => parts.includes(part)), normalized].join("+") : undefined;
}
export function chordFromEvent(event) {
  if (event.isComposing || event.keyCode === 229 || event.key === "Process" || event.key === "Dead" || event.getModifierState?.("AltGraph")) return undefined;
  if (event.ctrlKey && event.metaKey) return undefined;
  const shifted = { "<": ",", ">": ".", "?": "/", ":": ";", '"': "'", "~": "`", "_": "-", "+": "=", "{": "[", "}": "]" };
  const key = event.shiftKey && /^Digit\d$/.test(event.code || "") ? event.code.slice(-1) : event.shiftKey && shifted[event.key] || event.key;
  return normalizeChord([...(event.ctrlKey || event.metaKey ? ["Mod"] : []), ...(event.altKey ? ["Alt"] : []), ...(event.shiftKey ? ["Shift"] : []), key?.length === 1 ? key.toUpperCase() : key].join("+"));
}
export function shortcutProblem(actionId, chord, bindings) {
  if (chord === null) return "";
  if (!normalizeChord(chord)) return "请选择字母、数字或带 Ctrl / ⌘ 的组合键。";
  const key = chord.split("+").at(-1);
  const modified = chord.includes("Mod+") || chord.includes("Alt+");
  if (["F1", "F3", "F5", "F6", "F7", "F10", "F11", "F12"].includes(key) || ["Alt+F4", "Alt+Home", "Mod+Alt+Delete", "Mod+Shift+I", "Mod+Shift+C", "Mod+Shift+J"].includes(chord) ||
      (chord.includes("Mod+") && ["L", "T", "W", "N", "R", "Q", "F", "P", "S", "O", "U", "J", "K", "H", "D", "E", "A", "C", "V", "X", "Z", "Y", "=", "-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].includes(key))) return "此组合常用于浏览器或文字编辑，请换一个键位。";
  if (!modified && key === "Enter") return "Enter 用于确认和换行，请加上 Ctrl / ⌘ 等修饰键。";
  if (key === "Escape" && actionId !== "close") return "Esc 保留给关闭操作。";
  if (["save", "settings"].includes(actionId) && !modified) return "此操作可在输入时使用，请加上 Ctrl / ⌘ 或 Alt。";
  if (actionId === "close" && key !== "Escape" && !modified) return "关闭操作请使用 Esc 或带修饰键的组合，避免打字时误触。";
  const conflict = SHORTCUT_ACTIONS.find((action) => action.id !== actionId && bindings[action.id] === chord);
  return conflict ? `已用于「${conflict.label}」，请先修改该动作，或选择其他键位。` : "";
}
export function normalizeShortcuts(value) {
  const next = {};
  // Reserve explicit custom bindings before filling missing defaults.
  for (const action of SHORTCUT_ACTIONS) if (value && Object.hasOwn(value, action.id)) {
    const chord = normalizeChord(value[action.id]);
    if (chord !== undefined && !shortcutProblem(action.id, chord, next)) next[action.id] = chord;
  }
  for (const action of SHORTCUT_ACTIONS) if (!Object.hasOwn(next, action.id)) next[action.id] = Object.values(next).includes(action.default) ? null : action.default;
  return next;
}
const read = () => { try { return normalizeShortcuts(JSON.parse(window.localStorage.getItem(SHORTCUTS_KEY))); } catch { return normalizeShortcuts(); } };
let snapshot = read();
const listeners = new Set();
export const getReadingShortcuts = () => snapshot;
export function subscribeReadingShortcuts(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function updateReadingShortcut(actionId, chord) {
  const problem = shortcutProblem(actionId, chord, snapshot);
  if (problem) return problem;
  publish({ ...snapshot, [actionId]: chord });
  return "";
}
function publish(next) {
  snapshot = next;
  try { window.localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(snapshot)); } catch { /* Keep the current session usable. */ }
  listeners.forEach((listener) => listener());
}
export const resetReadingShortcuts = () => publish({ ...DEFAULT_SHORTCUTS });
export function matchesShortcut(event, action, bindings = snapshot) {
  return !event.isComposing && !event.repeat && Boolean(bindings[action]) && chordFromEvent(event) === bindings[action];
}
export function formatShortcut(chord, mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)) {
  return chord ? chord.split("+").map((part) => ({ Mod: mac ? "⌘" : "Ctrl", Alt: mac ? "⌥" : "Alt", Escape: "Esc" })[part] || part).join(" + ") : "未设置";
}
const changed = (event) => { if (event.key === SHORTCUTS_KEY || event.key === null) { snapshot = read(); listeners.forEach((listener) => listener()); } };
if (typeof window !== "undefined") window.addEventListener("storage", changed);
if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener("storage", changed));
