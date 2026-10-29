import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileAuthoring } from "../scripts/authoring-compiler.mjs";
import { validateDocument } from "../../../services/workspace/documents.mjs";

const input = translations => ({ format: "reader-authoring-1", key: "translated-math", meta: { title: "Formula validation", language: "en" },
  blocks: [{ key: "formula", type: "math", tex: "x^2 + 1", ...(translations ? { translations } : {}) }] });

test("translated display formulas fail compilation with their author key and language", async () => {
  const source = input({ "zh-CN": { tex: "x^2 + 1" }, fr: { tex: "\\notARealCommand{x}" } });
  const original = structuredClone(source);
  await assert.rejects(compileAuthoring(source), error => {
    assert.match(error.message, /E_AUTHOR_MATH \[formula\]/);
    assert.match(error.message, /"variant":"fr"/);
    assert.match(error.message, /notARealCommand/);
    return true;
  });
  assert.deepEqual(source, original, "rejected authoring is not repaired or changed implicitly");
});

test("shared and valid translated display formulas keep the same compiled source content", async () => {
  for (const translations of [undefined, { "zh-CN": { tex: "x^2+1\\quad\\text{其中 }x\\in\\mathbb{R}" }, fr: { tex: "x^2+1" } }]) {
    const source = input(translations), compiled = await compileAuthoring(source);
    assert.equal(compiled.report.result, "PASS");
    assert.equal(compiled.document.blocks[0].tex, source.blocks[0].tex);
    for (const [variant, translation] of Object.entries(translations || {})) assert.equal(compiled.document.blocks[0].translations[variant].tex, translation.tex);
    await validateDocument(compiled.document);
  }
});

test("source and translated title formulas receive the same compiler checks as body formulas", async () => {
  const valid = input();
  valid.meta.title = "A bound on $x_i^2$";
  valid.meta.translations = { "zh-CN": { title: "$x_i^2$ 的界" } };
  const compiled = await compileAuthoring(valid);
  assert.equal(compiled.report.result, "PASS");
  assert.deepEqual(compiled.document.meta, valid.meta);
  for (const variant of ["source", "zh-CN"]) {
    const broken = structuredClone(valid), target = variant === "source" ? broken.meta : broken.meta.translations[variant];
    target.title = "$\\notARealCommand{x}$";
    await assert.rejects(compileAuthoring(broken), error => {
      assert.match(error.message, /E_AUTHOR_MATH \[\$meta\]/);
      assert.ok(error.message.includes(`"variant":"${variant}"`));
      return true;
    });
  }
});

test("CLI refuses invalid translated TeX before replacing existing compiled artifacts", async t => {
  const directory = await mkdtemp(join(tmpdir(), "reader-translated-math-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), "reader-translated-math-")));
    await rm(directory, { recursive: true, force: true });
  });
  const authoringPath = join(directory, "input.json"), documentPath = join(directory, "document.json");
  const retained = '{"retained":"existing document bytes"}\n';
  await writeFile(documentPath, retained);
  await writeFile(authoringPath, JSON.stringify(input({ "zh-CN": { tex: "\\notARealCommand{x}" } })));
  const script = fileURLToPath(new URL("../scripts/compile-authoring.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, authoringPath, directory], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E_AUTHOR_MATH/);
  assert.match(result.stderr, /"variant":"zh-CN"/);
  assert.equal(await readFile(documentPath, "utf8"), retained);
  assert.deepEqual((await readdir(directory)).sort(), ["document.json", "input.json"]);
});
