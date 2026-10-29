import test from "node:test";
import assert from "node:assert/strict";
import { COLOR_PALETTES, colorFor, getEnabledColors, normalizePaletteSettings, togglePaletteColor } from "../src/highlight-colors.js";

test("palette preferences do not reinterpret saved color IDs", () => {
  const original = ["amber", "green", "blue", "rose"].map((id) => colorFor(id).value);
  for (const palette of COLOR_PALETTES) {
    const settings = normalizePaletteSettings({ presetId: palette.id });
    assert.ok(getEnabledColors(settings).length);
    assert.deepEqual(["amber", "green", "blue", "rose"].map((id) => colorFor(id).value), original);
  }
  assert.equal(colorFor("macaron-lilac").value, "#e7def3");
});

test("invalid or obsolete stored settings always recover a usable palette", () => {
  for (const value of [null, [], { presetId: "gone" }, { presetId: "macaron", enabledByPreset: { macaron: [] } }, { presetId: "macaron", enabledByPreset: { macaron: ["obsolete", "amber"] } }]) {
    const settings = normalizePaletteSettings(value);
    assert.ok(getEnabledColors(settings).length);
    assert.ok(getEnabledColors(settings).every((color) => COLOR_PALETTES.find((p) => p.id === settings.presetId).colors.includes(color)));
  }
});

test("per-palette selections survive switching and JSON persistence", () => {
  const customized = togglePaletteColor(normalizePaletteSettings({ presetId: "macaron" }), "macaron-pink");
  const earth = normalizePaletteSettings({ ...customized, presetId: "earth" });
  const restored = normalizePaletteSettings({ ...JSON.parse(JSON.stringify(earth)), presetId: "macaron" });
  assert.equal(getEnabledColors(restored).length, 5);
  assert.equal(getEnabledColors(restored).some((color) => color.id === "macaron-pink"), false);
});

test("the last enabled color cannot be removed", () => {
  let settings = normalizePaletteSettings({ presetId: "macaron" });
  for (const color of COLOR_PALETTES[1].colors.slice(1)) settings = togglePaletteColor(settings, color.id);
  assert.deepEqual(getEnabledColors(settings).map((color) => color.id), ["macaron-yellow"]);
  assert.equal(togglePaletteColor(settings, "macaron-yellow"), settings);
  assert.equal(togglePaletteColor(settings, "unknown"), settings);
});
