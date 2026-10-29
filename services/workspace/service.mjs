// Local SQLite and filesystem adapter for the desktop, HTTP and MCP service.
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./workspace-core.mjs";
import { ResourceFiles } from "./resources.mjs";
import { authoringDocumentation } from "./authoring.mjs";
import { canonical, check, hash, identifier, json, normalized, version } from "./errors.mjs";
export { localActor } from "./actor.mjs";
export const defaultDataDir = process.env.CONTINUOUS_READER_DATA || fileURLToPath(new URL("./.data/", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const now = () => new Date().toISOString();
const noteSignature = (note) => canonical(Object.fromEntries(["id", "title", "body", "type", "color", "quote", "blockId", "variant", "field", "answer"].filter((key) => note[key] !== undefined).map((key) => [key, note[key]])));
export async function createWorkspace(options = {}) {
  const dataDir = resolve(options.dataDir || defaultDataDir);
  await mkdir(dataDir, { recursive: true });
  const database = new DatabaseSync(resolve(dataDir, "workspace.sqlite"));
  database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  database.transaction = (operation) => {
    database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); database.exec("COMMIT"); return result; }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  };
  const workspace = new Workspace({ ...options, dataDir, database, resources: new ResourceFiles(dataDir, options), documentation: authoringDocumentation,
    initializeData: async (value) => {
      if (options.bootstrap !== false) await bootstrap.call(value);
      if (options.glossaryPath !== false) await importGlossaryFile.call(value, options.glossaryPath || resolve(root, "services/glossary/.data/glossary.json"));
    } });
  try { await workspace.initialize(); }
  catch (error) { await workspace.close(); throw error; }
  return workspace;
}

async function importGlossaryFile(path) {
    let content; try { content = await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    const key = "glossary:" + resolve(path); if (this.db.prepare("SELECT key FROM migrations WHERE key=?").get(key)) return;
    const data = JSON.parse(content); check(data.schema === 1 && Array.isArray(data.entries) && Number.isSafeInteger(data.revision), "VALIDATION_FAILED", "已有术语表格式无效，原文件未改动。");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of data.entries) { this.glossaryFields(entry); identifier(entry.id); version(entry.revision); this.db.prepare("INSERT OR IGNORE INTO glossary VALUES(?,?,?,?,?)").run(entry.id, entry.revision, normalized(entry.term), json(entry), entry.deletedAt || null); }
      this.setMeta("glossaryRevision", Math.max(data.revision, this.meta("glossaryRevision")));
      this.db.prepare("INSERT INTO migrations VALUES(?,?,?,?,?)").run(key, hash(content), content, json({ imported: data.entries.length }), now()); this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
async function bootstrap() {
    const base = this.options.sampleRoot || resolve(root, "prototypes/insight-composer/public/articles");
    for (const name of ["attention-is-all-you-need", "resnet", "mapreduce", "crispr"]) {
      const directory = resolve(base, name), files = name === "attention-is-all-you-need" ? ["document.json", "document.html-sample.json"] : ["document.json"];
      for (const filename of files) {
        let document; try { document = JSON.parse(await readFile(resolve(directory, filename), "utf8")); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (name === "attention-is-all-you-need" && filename === "document.json") {
          const { attentionNotes } = await import("../../prototypes/insight-composer/src/attention-example.js");
          attentionNotes(document).forEach((note) => this.exampleSignatures.add(noteSignature(note)));
        }
        if (this.db.prepare("SELECT revision FROM revisions WHERE document_id=? AND revision=?").get(document.id, document.revision)) continue;
        const resourceMap = {};
        const walk = async (dir, prefix = "") => {
          for (const item of await readdir(dir, { withFileTypes: true })) {
            if (item.isSymbolicLink()) continue;
            const path = prefix + item.name;
            if (item.isDirectory()) await walk(resolve(dir, item.name), path + "/");
            else if (item.isFile() && !["document.json", "document.html-sample.json", "identity.json", "text-index.json", "compile-report.json"].includes(path)) resourceMap[path] = await this.resources.putPath(resolve(dir, item.name), item.name);
          }
        };
        await walk(directory);
        const validated = await this.validateCandidate(document, { resourceMap }, { allowDanglingLinks: true });
        const metadata = { title: document.meta.title, kind: "论文", summary: document.blocks.find((b) => b.role === "abstract" && b.text)?.text?.slice(0, 800) || "", collectionIds: [], tags: [], status: "unread", diagnostics: validated.report.diagnostics };
        for (const [path, descriptor] of Object.entries(resourceMap)) resourceMap[path] = { id: "file-" + descriptor.sha256, ...descriptor };
        await this.prepareRevision(validated, resourceMap);
        this.db.exec("BEGIN IMMEDIATE");
        try {
          for (const [path, descriptor] of Object.entries(resourceMap)) resourceMap[path] = this.recordFile(descriptor, "file-" + descriptor.sha256);
          this.db.prepare("INSERT OR IGNORE INTO documents VALUES(?,1,?,?,NULL,?,?)").run(document.id, document.revision, json(metadata), now(), now());
          this.saveRevision(validated, resourceMap, { actor: "bundled-import" });
          this.db.prepare("UPDATE documents SET current_revision=MAX(current_revision,?) WHERE id=?").run(document.revision, document.id);
          this.setMeta("revision", this.meta("revision") + 1); this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      }
    }
  }
