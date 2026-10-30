import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Stread requires Node.js 24 or newer.");
for (const directory of ["prototypes/insight-composer", "services/workspace", "services/glossary"]) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["ci"], { cwd: resolve(root, directory), stdio: "inherit", shell: process.platform === "win32", windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
