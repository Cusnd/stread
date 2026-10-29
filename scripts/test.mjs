import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const [directory, patterns] of [
  ["prototypes/insight-composer", ["tests/*.test.mjs", "src/workspace/*.test.mjs"]],
  ["services/glossary", ["tests/*.test.mjs"]],
  ["services/workspace", ["tests/*.test.mjs"]],
]) {
  const result = spawnSync(process.execPath, ["--test", ...patterns], { cwd: resolve(root, directory), stdio: "inherit", windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
