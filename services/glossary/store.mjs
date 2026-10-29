import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const defaultDataPath = process.env.CONTINUOUS_READER_GLOSSARY_DATA || fileURLToPath(new URL("./.data/glossary.json", import.meta.url));
export class StoreError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const normalized = (value) => value.normalize("NFKC").trim().toLocaleLowerCase();
function text(value, label, maximum, required = false) {
  if (typeof value !== "string" || value.trim().length > maximum || (required && !value.trim())) throw new StoreError(`${label}${required ? "不能为空，且" : ""}最多 ${maximum} 字。`);
  return value.trim();
}
function fields(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new StoreError("术语内容无效。");
  const aliases = input.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.length > 8) throw new StoreError("别名最多 8 个。");
  return {
    term: text(input.term, "术语", 120, true),
    definition: text(input.definition, "解释", 5000, true),
    aliases: [...new Set(aliases.map((item) => text(item, "别名", 120)).filter(Boolean))],
    documentId: text(input.documentId ?? "", "文章标识", 160),
    documentTitle: text(input.documentTitle ?? "", "文章名称", 200),
  };
}

export class GlossaryStore {
  constructor(path = defaultDataPath) { this.path = resolve(path); this.queue = Promise.resolve(); }
  async read() {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8"));
      if (data.schema !== 1 || !Array.isArray(data.entries) || !Number.isSafeInteger(data.revision)) throw new Error("Invalid glossary format");
      return data;
    } catch (error) {
      if (error.code === "ENOENT") return { schema: 1, revision: 0, entries: [] };
      throw error;
    }
  }
  async list({ query = "", offset = 0, limit = 100, documentId = "" } = {}) {
    const data = await this.read();
    const needle = normalized(query);
    const matches = data.entries.filter((entry) => !entry.deletedAt && (!documentId || entry.documentId === documentId)
      && (!needle || normalized([entry.term, ...entry.aliases, entry.definition].join("\n")).includes(needle)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return { revision: data.revision, total: matches.length, entries: matches.slice(offset, offset + limit) };
  }
  async get(id) {
    const data = await this.read();
    const entry = data.entries.find((item) => item.id === id && !item.deletedAt);
    if (!entry) throw new StoreError("没有找到这条术语。", 404);
    return entry;
  }
  mutate(change) {
    const operation = this.queue.then(async () => {
      const data = await this.read();
      const entry = change(data);
      data.revision += 1;
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = this.path + "." + randomUUID() + ".tmp";
      await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.path);
      return { revision: data.revision, entry };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  create(input) {
    const value = fields(input);
    return this.mutate((data) => {
      if (data.entries.some((entry) => !entry.deletedAt && normalized(entry.term) === normalized(value.term))) throw new StoreError("这条术语已存在，可以直接编辑。", 409);
      const now = new Date().toISOString();
      const entry = { id: randomUUID(), ...value, revision: 1, createdAt: now, updatedAt: now, origin: "user" };
      data.entries.push(entry);
      return entry;
    });
  }
  update(id, input) {
    const value = fields(input);
    return this.mutate((data) => {
      const entry = this.current(data, id, input.expectedRevision);
      if (data.entries.some((other) => !other.deletedAt && other.id !== id && normalized(other.term) === normalized(value.term))) throw new StoreError("这条术语已存在，可以直接编辑。", 409);
      Object.assign(entry, value, { revision: entry.revision + 1, updatedAt: new Date().toISOString() });
      return entry;
    });
  }
  current(data, id, revision, deleted = false) {
    const entry = data.entries.find((item) => item.id === id && Boolean(item.deletedAt) === deleted);
    if (!entry) throw new StoreError("没有找到这条术语。", 404);
    if (entry.revision !== revision) throw new StoreError("这条术语已在其他窗口更新，请重新打开后编辑。", 409);
    return entry;
  }
  remove(id, revision) {
    return this.mutate((data) => {
      const entry = this.current(data, id, revision);
      entry.deletedAt = new Date().toISOString();
      entry.updatedAt = entry.deletedAt;
      entry.revision += 1;
      return entry;
    });
  }
  restore(id, revision) {
    return this.mutate((data) => {
      const entry = this.current(data, id, revision, true);
      if (data.entries.some((other) => !other.deletedAt && normalized(other.term) === normalized(entry.term))) throw new StoreError("已存在同名术语，请先处理同名内容。", 409);
      delete entry.deletedAt;
      entry.updatedAt = new Date().toISOString();
      entry.revision += 1;
      return entry;
    });
  }
}
