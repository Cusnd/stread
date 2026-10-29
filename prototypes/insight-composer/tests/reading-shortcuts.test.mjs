import test from "node:test";
import assert from "node:assert/strict";
import { SHORTCUTS_KEY, DEFAULT_SHORTCUTS, chordFromEvent, formatShortcut, getReadingShortcuts, matchesShortcut, normalizeShortcuts, resetReadingShortcuts, shortcutProblem, subscribeReadingShortcuts, updateReadingShortcut } from "../src/reading-shortcuts.js";
import { canSaveChangeRequest, changeRequestWrite } from "../src/change-requests.js";

test("custom shortcuts match exact modifiers and suppress repeated keys, IME and AltGraph", () => {
  const bindings = { ...DEFAULT_SHORTCUTS, requestChange: "Alt+Shift+R" };
  const event = { key: "R", altKey: true, shiftKey: true };
  assert.ok(matchesShortcut(event, "requestChange", bindings));
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { getModifierState: () => true }]) assert.equal(matchesShortcut({ ...event, ...extra }, "requestChange", bindings), false);
  assert.equal(chordFromEvent({ key: "Enter", ctrlKey: true }), "Mod+Enter");
  assert.equal(chordFromEvent({ key: "Enter", metaKey: true }), "Mod+Enter");
  assert.equal(matchesShortcut({ key: "r" }, "requestChange", { ...bindings, requestChange: null }), false);
  assert.equal(formatShortcut("Mod+Shift+R", true), "⌘ + Shift + R");
});
test("shortcut conflicts and editing/browser reservations leave bindings intact", () => {
  const bindings = { ...DEFAULT_SHORTCUTS };
  assert.match(shortcutProblem("requestChange", "I", bindings), /洞见边栏/);
  assert.match(shortcutProblem("requestChange", "Mod+R", bindings), /浏览器/);
  assert.match(shortcutProblem("save", "S", bindings), /Ctrl/);
  assert.match(shortcutProblem("close", "C", bindings), /误触/);
  assert.equal(shortcutProblem("requestChange", "Alt+R", bindings), "");
  assert.deepEqual(normalizeShortcuts({ requestChange: "Alt+R", margins: null }), { ...bindings, requestChange: "Alt+R", margins: null });
  const recovered = normalizeShortcuts({ requestChange: "I", insightSidebar: "I", settings: "garbage", save: "Mod+R" });
  assert.equal(recovered.requestChange, "I"); assert.equal(recovered.insightSidebar, null); assert.equal(recovered.settings, "Mod+,"); assert.equal(recovered.save, "Mod+Enter");
});
test("shortcut writes notify subscribers, persist and restore all defaults without accepting conflicts", () => {
  const values = new Map(); const previousWindow = globalThis.window;
  globalThis.window = { localStorage: { setItem: (key, value) => values.set(key, value) } };
  let updates = 0; const unsubscribe = subscribeReadingShortcuts(() => updates++);
  try {
    assert.equal(updateReadingShortcut("requestChange", "Alt+R"), "");
    assert.equal(JSON.parse(values.get(SHORTCUTS_KEY)).requestChange, "Alt+R");
    assert.ok(updateReadingShortcut("requestChange", "I"));
    assert.equal(getReadingShortcuts().requestChange, "Alt+R");
    assert.equal(updates, 1);
    updateReadingShortcut("requestChange", null); resetReadingShortcuts();
    assert.deepEqual(getReadingShortcuts(), DEFAULT_SHORTCUTS); assert.equal(updates, 3);
  } finally { unsubscribe(); globalThis.window = previousWindow; }
});
test("change requests keep the original language and exact source range without UI or insight fields", () => {
  const draft = { intent: "change-request", type: "translation", body: "  请修正这个术语。  ", revision: 3, blockId: "p1", field: "text", variant: "zh-CN", start: 4, end: 6, quote: "术语", left: 10, color: "blue" };
  assert.ok(canSaveChangeRequest(draft)); assert.equal(canSaveChangeRequest({ ...draft, body: "  " }), false);
  assert.deepEqual(changeRequestWrite(draft, "doc", 5), { documentId: "doc", revision: 3, category: "translation", body: "请修正这个术语。", source: { blockId: "p1", variant: "zh-CN", field: "text", start: 4, end: 6, quote: "术语" } });
  assert.equal(changeRequestWrite({ intent: "change-request", type: "instruction", body: "全文统一术语" }, "doc", 5).source, undefined);
});
