import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspace } from "./service.mjs";
import { createWorkspaceSync } from "./sync-engine.mjs";

export function parseSyncArguments(args) {
  const options = {}, actions = [];
  for (const argument of args) {
    if (!argument.startsWith("--")) { actions.push(argument); continue; }
    const match = argument.match(/^--(data-dir|conflict|choice|expected-version)=(.+)$/);
    if (!match || Object.hasOwn(options, match[1])) throw new Error("参数无效或重复。");
    options[match[1]] = match[2];
  }
  const action = actions[0];
  if (["once", "watch"].includes(action)) throw new Error("云端同步已停用；此命令仅用于本机历史状态和冲突处理。");
  if (actions.length !== 1 || !["status", "conflicts", "resolve"].includes(action) || !options["data-dir"]) throw new Error("用法：node services/workspace/sync-cli.mjs <status|conflicts|resolve> --data-dir=<资料库目录>");
  if (action === "resolve" && (!/^[A-Za-z0-9_.:-]{1,160}$/.test(options.conflict || "") || !["local", "remote"].includes(options.choice) || !/^[0-9]+$/.test(options["expected-version"] || "") || !Number.isSafeInteger(Number(options["expected-version"])))) throw new Error("解决冲突需要 --conflict=<ID> --choice=local|remote --expected-version=<当前冲突版本>。");
  if (action !== "resolve" && ["conflict", "choice", "expected-version"].some((name) => Object.hasOwn(options, name))) throw new Error("冲突参数只适用于 resolve。");
  return { action, dataDir: resolve(options["data-dir"]), ...(action === "resolve" ? { resolution: { id: options.conflict, choice: options.choice, expectedVersion: Number(options["expected-version"]) } } : {}) };
}

async function assertClosedProfile(dataDir) {
  await access(join(dataDir, "workspace.sqlite"));
  let connection;
  try { connection = JSON.parse(await readFile(join(dirname(dataDir), "connection.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return; throw error; }
  if (!Number.isSafeInteger(connection?.pid) || connection.pid < 1) return;
  try { process.kill(connection.pid, 0); }
  catch (error) { if (error.code === "ESRCH") return; throw new Error("无法确认桌面资料库是否已关闭。"); }
  throw new Error("此资料库的桌面窗口仍在运行，请使用窗口内历史冲突设置，或正常关闭窗口后再运行维护命令。");
}

export async function runSyncCli({ args = process.argv.slice(2), output = (value) => process.stdout.write(JSON.stringify(value, null, 2) + "\n"), verifyProfile = assertClosedProfile, openWorkspace = createWorkspace, openEngine = createWorkspaceSync } = {}) {
  const options = parseSyncArguments(args); await verifyProfile(options.dataDir);
  const workspace = await openWorkspace({ dataDir: options.dataDir, bootstrap: false, glossaryPath: false });
  workspace.localOnly = true;
  try {
    if (workspace.db && !workspace.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_state'").get()) {
      if (options.action === "status") return output({ mode: "local", configured: false, pending: 0, conflicts: 0 });
      if (options.action === "conflicts") return output({ conflicts: [] });
      throw new Error("没有可处理的历史冲突。");
    }
    const engine = await openEngine(workspace, { mode: "client" });
    if (options.action === "status") return output(engine.status());
    if (options.action === "conflicts") return output(engine.conflicts());
    if (options.action === "resolve") return output(await engine.resolveConflict(options.resolution));
  } finally { await workspace.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSyncCli().catch((error) => {
    const message = error.code === "ENOENT" ? "资料库不存在；请先在桌面中创建或导入资料库。" : error.message?.startsWith("用法：") || /参数|冲突需要|桌面|云端同步已停用/.test(error.message || "") ? error.message : "维护命令未完成，资料和历史内容已保留。";
    process.stderr.write(message + "\n"); process.exitCode = 1;
  });
}
