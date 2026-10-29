import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compileAuthoring } from "./authoring-compiler.mjs";
export { compileAuthoring };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, key, detail) => { throw new Error(`${code} [${key}]: ${detail}`); };

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error("Usage: node scripts/compile-authoring.mjs authoring.json output-directory");
  const output = resolve(outputPath), input = JSON.parse(await readFile(resolve(inputPath), "utf8"));
  let previous = null;
  try { previous = JSON.parse(await readFile(resolve(output, "identity.json"), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const result = await compileAuthoring(input, previous);
  for (const asset of result.report.assets) {
    const target = resolve(output, asset);
    if (relative(output, target).startsWith("..")) fail("E_AUTHOR_RESOURCE", input.key, asset);
    const info = await stat(target);
    if (!info.isFile() || !info.size) fail("E_AUTHOR_RESOURCE", input.key, asset);
  }
  if (input.source?.sha256) {
    const actual = digest(await readFile(resolve(output, input.source.path)));
    if (actual !== input.source.sha256) fail("E_AUTHOR_SOURCE_HASH", input.key, "source bytes differ");
  }
  await mkdir(output, { recursive: true });
  // Validate the complete result before writing anything. Production transactional publication is separate.
  for (const [name, value] of [["document.json", result.document], ["identity.json", result.registry], ["text-index.json", result.index], ["compile-report.json", result.report]]) await writeFile(resolve(output, name), JSON.stringify(value, null, 2) + "\n");
  console.log(JSON.stringify(result.report));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
