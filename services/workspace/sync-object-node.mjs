import { createReadStream } from "node:fs";
import { mkdir, stat, open, rename, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { checkedSyncStream, syncObjectKey } from "./sync-object-transfer.mjs";
import { check } from "./errors.mjs";

export function createNodeSyncObjectStore(resources) {
  const root = resolve(resources.root);
  const target = (ref) => resolve(root, ...syncObjectKey(ref).split("/"));
  const partPath = (ref, part, hash) => resolve(root, "sync-staging", `${ref.kind}-${ref.sha256}-${part}-${hash}`);
  const exists = (path) => stat(path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  const verifiedHead = async (ref) => {
    const found = await exists(target(ref));
    if (!found) return null;
    check(found.size === ref.size, "SYNC_OBJECT_INTEGRITY", "已存同步对象大小校验失败。", 409);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(target(ref))) hash.update(chunk);
    check(hash.digest("hex") === ref.sha256, "SYNC_OBJECT_INTEGRITY", "已存同步对象摘要校验失败。", 409);
    return found;
  };
  return {
    head: verifiedHead,
    get: async (ref) => (await exists(target(ref))) ? Readable.toWeb(createReadStream(target(ref))) : null,
    async put(ref, input) {
      const path = target(ref); await mkdir(dirname(path), { recursive: true });
      const temporary = path + "." + randomUUID() + ".tmp", handle = await open(temporary, "wx");
      try {
        try { for await (const chunk of checkedSyncStream(input, ref)) await handle.writeFile(chunk); await handle.sync(); }
        finally { await handle.close(); }
        if (await verifiedHead(ref)) return;
        try { await rename(temporary, path); }
        catch (error) { if (!await verifiedHead(ref)) throw error; }
      } finally { check(dirname(temporary) === dirname(path), "FORBIDDEN", "临时对象路径无效。", 403); await rm(temporary, { force: true }); }
    },
    async stagePart(ref, part, hash, bytes) {
      const path = partPath(ref, part, hash); await mkdir(dirname(path), { recursive: true });
      const temporary = path + "." + randomUUID() + ".tmp", handle = await open(temporary, "wx");
      try {
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        if (!(await exists(path))) await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    },
    openPart: async (ref, part, hash) => (await exists(partPath(ref, part, hash))) ? Readable.toWeb(createReadStream(partPath(ref, part, hash))) : null,
    async cleanParts(ref, hashes) { for (let i = 0; i < hashes.length; i++) await rm(partPath(ref, i + 1, hashes[i]), { force: true }); },
  };
}
