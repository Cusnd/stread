import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const children = [
  spawn(process.execPath, ["services/workspace/server.mjs"], { cwd: root, stdio: "inherit", windowsHide: true }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], { cwd: resolve(root, "prototypes/insight-composer"), stdio: "inherit", windowsHide: true }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", (error) => { console.error(error.message); stop(1); });
  child.on("exit", (code) => stop(code || 0));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
