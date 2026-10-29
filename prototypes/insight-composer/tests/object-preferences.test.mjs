import test from "node:test";
import assert from "node:assert/strict";
import { normalizeObjectPreferences, objectPreferencesKey, objectWidth, readObjectPreferences, saveObjectPreferences } from "../src/object-preferences.js";

function storage() {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) };
}

test("per-document and per-object settings survive reload without leaking into another object", () => {
  const local = storage(), legacy = storage();
  saveObjectPreferences("paper-1", "figure-1", { widthPercent: 150, fontSize: 16 }, local);
  saveObjectPreferences("paper-1", "table-1", { widthPercent: 80, fontSize: null }, local);
  saveObjectPreferences("paper-2", "figure-1", { widthPercent: 60, fontSize: 28 }, local);
  assert.deepEqual(readObjectPreferences("paper-1", "figure-1", local, legacy), { widthPercent: 150, fontSize: 16 });
  assert.deepEqual(readObjectPreferences("paper-1", "table-1", local, legacy), { widthPercent: 80, fontSize: null });
  assert.deepEqual(readObjectPreferences("paper-2", "figure-1", local, legacy), { widthPercent: 60, fontSize: 28 });
  assert.deepEqual(readObjectPreferences("paper-3", "figure-1", local, legacy), { widthPercent: null, fontSize: null });
});

test("reset and font-only settings cannot revive a legacy pixel width", () => {
  const local = storage(), legacy = storage();
  legacy.setItem("reader-object-sizes:paper", JSON.stringify({ table: 1020 }));
  const old = readObjectPreferences("paper", "table", local, legacy);
  assert.equal(objectWidth(old, { base: 680, min: 160, max: 1200 }), 1020);
  saveObjectPreferences("paper", "table", { widthPercent: old.legacyWidth / 680 * 100 }, local);
  assert.deepEqual(readObjectPreferences("paper", "table", local, legacy), { widthPercent: 150, fontSize: null });
  saveObjectPreferences("paper", "table", {}, local);
  assert.deepEqual(readObjectPreferences("paper", "table", local, legacy), { widthPercent: null, fontSize: null });
});

test("responsive bounds and temporary expansion preserve the preferred proportion and font", () => {
  const preference = { widthPercent: 150, fontSize: 16 };
  assert.equal(objectWidth(preference, { base: 600, min: 160, max: 1100 }), 900);
  assert.equal(objectWidth(preference, { base: 335, min: 160, max: 335 }), 335);
  assert.equal(objectWidth(preference, { base: 600, min: 160, max: 1100 }, true), 1100);
  assert.equal(objectWidth(preference, { base: 600, min: 160, max: 1100 }), 900);
  assert.deepEqual(preference, { widthPercent: 150, fontSize: 16 });
  assert.equal(objectWidth({ widthPercent: 20 }, { base: 335, min: 160, max: 335 }), 160);
});

test("invalid or unavailable storage cannot break reading and subsequent valid saves recover", () => {
  const local = storage(), legacy = storage();
  for (const malformed of ["{", "null", "[]", "5"]) {
    local.setItem(objectPreferencesKey("paper"), malformed);
    assert.deepEqual(readObjectPreferences("paper", "table", local, legacy), { widthPercent: null, fontSize: null });
    saveObjectPreferences("paper", "table", { widthPercent: 120, fontSize: 18 }, local);
    assert.deepEqual(readObjectPreferences("paper", "table", local, legacy), { widthPercent: 120, fontSize: 18 });
  }
  const blocked = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } };
  assert.deepEqual(readObjectPreferences("paper", "table", blocked, blocked), { widthPercent: null, fontSize: null });
  assert.doesNotThrow(() => saveObjectPreferences("paper", "table", {}, blocked));
  assert.deepEqual(normalizeObjectPreferences({ widthPercent: Infinity, fontSize: "18" }), { widthPercent: null, fontSize: null });
  assert.deepEqual(normalizeObjectPreferences({ widthPercent: 500, fontSize: 5 }), { widthPercent: 400, fontSize: 12 });
});
