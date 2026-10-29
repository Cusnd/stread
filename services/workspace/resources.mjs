import { mkdir, open, rename, link, stat, rm, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { check, fail, hash, text, WorkspaceError } from "./errors.mjs";
import { checkedObjectBytes, objectBytes, parseObjectBytes, validateObjectReference } from "./immutable-objects.mjs";

export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
export const defaultPython = process.env.CONTINUOUS_READER_PYTHON || (process.platform === "win32" ? "python" : "python3");
const helper = fileURLToPath(new URL("./pdf.py", import.meta.url));
// Embedded Python deliberately omits the script directory from sys.path. Pin
// sibling imports to this helper's trusted directory, including repo sources
// during desktop development, without enabling site or environment paths.
const pythonBootstrap = "import os, runpy, sys; helper = sys.argv[1]; sys.path.insert(0, os.path.dirname(helper)); sys.argv = sys.argv[1:]; runpy.run_path(helper, run_name='__main__')";
// Bump when derived coordinate matching changes; stale page-only maps must not
// survive a changed algorithm even if the PDF and source revision stay equal.
export const PDF_REGION_ALGORITHM_VERSION = "6-list-item-heading-geometry";
export const mediaTypeFor = (name) => ({ ".pdf": "application/pdf", ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html", ".htm": "text/html", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".zip": "application/zip" }[extname(name).toLowerCase()] || "application/octet-stream");

export function runPdf(request, { pythonPath = defaultPython, signal, timeoutMs = 120000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(pythonPath, ["-X", "utf8", "-B", "-c", pythonBootstrap, helper], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [], errors = [];
    let bytes = 0, completed = false, terminationReason;
    const finish = (error, result) => {
      if (completed) return;
      completed = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolveResult(result);
    };
    const terminate = () => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
        killer.on("exit", (code) => { if (code) child.kill(); });
      } else child.kill();
    };
    const stop = (error) => { if (completed || terminationReason) return; terminationReason = error; terminate(); };
    const abort = () => stop(new WorkspaceError("CANCELLED", "PDF 处理已取消。", 409));
    const timer = setTimeout(() => stop(new WorkspaceError("CONVERSION_TIMEOUT", "PDF 处理超时。", 422)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) stop(new WorkspaceError("CONVERSION_LIMIT", "PDF 处理结果超过限制。", 422));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => { if (errors.reduce((n, item) => n + item.length, 0) < 8192) errors.push(chunk); });
    child.on("error", (error) => finish(new WorkspaceError("PDF_RUNTIME_UNAVAILABLE", "PDF 处理运行时不可用。", 503, { message: error.message })));
    child.on("close", (code) => {
      if (completed) return;
      if (terminationReason) { finish(terminationReason); return; }
      try {
        const output = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (code !== 0 || !output.ok) finish(new WorkspaceError("PDF_PROCESSING_FAILED", output.error || "PDF 处理失败。", 422));
        else finish(null, output.result);
      } catch { finish(new WorkspaceError("PDF_PROCESSING_FAILED", "PDF 处理没有返回有效结果。", 422, { diagnostic: Buffer.concat(errors).toString("utf8").slice(0, 2000) })); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

export class ResourceFiles {
  constructor(dataDir, options = {}) {
    this.root = resolve(dataDir); this.pythonPath = options.pythonPath || defaultPython;
    this.manifests = new Map(); this.regionMaps = new Map(); this.rendering = new Map();
  }
  async initialize() { await mkdir(resolve(this.root, "blobs"), { recursive: true }); await mkdir(resolve(this.root, "pages"), { recursive: true }); await mkdir(resolve(this.root, "objects", "sha256"), { recursive: true }); }
  async verifyStoredFile(path, sha256, expectedSize) {
    let file;
    try { file = await stat(path); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    check(expectedSize === undefined || file.size === expectedSize, "OBJECT_INTEGRITY_FAILED", "本地文件大小不符。", 409);
    const digest = createHash("sha256"); let size = 0;
    for await (const chunk of createReadStream(path)) { size += chunk.length; digest.update(chunk); }
    check(size === file.size && (expectedSize === undefined || size === expectedSize) && digest.digest("hex") === sha256,
      "OBJECT_INTEGRITY_FAILED", "本地文件完整性校验失败。", 409);
    return true;
  }
  async has(sha256) { return this.verifyStoredFile(this.path(sha256), sha256); }
  objectPath(ref) { validateObjectReference(ref); return resolve(this.root, "objects", "sha256", ref.sha256); }
  async hasObject(ref) { return this.verifyStoredFile(this.objectPath(ref), ref.sha256, ref.size); }
  openObject(ref) { return createReadStream(this.objectPath(ref)); }
  async readObject(ref) {
    try { return parseObjectBytes(await checkedObjectBytes(ref, this.openObject(ref))); }
    catch (error) { if (error.code === "ENOENT") throw new WorkspaceError("OBJECT_MISSING", "内容对象尚未下载或不可用。", 404); throw error; }
  }
  async putObject(value) { const { bytes, ref } = objectBytes(value); return this.importObject(ref, bytes); }
  async publishTemporary(temporary, target, sha256, size) {
    // Hard-link publication is atomic and cannot replace an existing immutable
    // key. rename() replaces targets on POSIX and creates a corruption race.
    try { await link(temporary, target); }
    catch (error) {
      if (error.code !== "EEXIST" || !(await this.verifyStoredFile(target, sha256, size))) throw error;
    }
    // Persist the directory entry where the OS/filesystem supports directory
    // fsync. Windows rejects opening directories; the file itself was fsynced.
    if (process.platform !== "win32") {
      const directory = await open(dirname(target), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  async importObject(ref, input) {
    const bytes = await checkedObjectBytes(ref, input), target = this.objectPath(ref);
    if (await this.hasObject(ref)) return ref;
    const temporary = target + "." + randomUUID() + ".tmp";
    const handle = await open(temporary, "wx");
    try {
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await this.publishTemporary(temporary, target, ref.sha256, ref.size);
    } finally { await rm(temporary, { force: true }); }
    return ref;
  }
  path(sha256) { check(/^[a-f0-9]{64}$/.test(sha256), "VALIDATION_FAILED", "资源摘要无效。"); return resolve(this.root, "blobs", sha256); }
  descriptor(file) { return { ...file, path: this.path(file.sha256) }; }
  read(sha256) { return readFile(this.path(sha256)); }
  open(sha256) { return createReadStream(this.path(sha256)); }
  async put(input, { filename, mediaType } = {}) {
    text(filename, "文件名", 240, true); check(filename === basename(filename) && !/[\\/\u0000-\u001f]/.test(filename), "VALIDATION_FAILED", "文件名无效。");
    const blobRoot = resolve(this.root, "blobs"), temporary = resolve(blobRoot, "." + randomUUID() + ".tmp");
    const digest = createHash("sha256"); let size = 0;
    const handle = await open(temporary, "wx");
    try {
      try {
        const chunks = input instanceof Uint8Array ? [input] : input;
        for await (const chunk of chunks) {
          check(chunk instanceof Uint8Array, "VALIDATION_FAILED", "上传内容必须为字节流。");
          size += chunk.byteLength;
          check(size <= MAX_SOURCE_BYTES, "UPLOAD_TOO_LARGE", "文件超过 100 MiB 限制。", 413);
          digest.update(chunk); await handle.writeFile(chunk);
        }
        check(size > 0, "UPLOAD_TOO_LARGE", "文件为空或超过 100 MiB 限制。", 413);
        await handle.sync();
      } finally { await handle.close(); }
      const sha256 = digest.digest("hex"), target = this.path(sha256);
      await this.publishTemporary(temporary, target, sha256, size);
      return { filename, mediaType: mediaType || mediaTypeFor(filename), sha256, size };
    } finally {
      check(dirname(temporary) === blobRoot, "FORBIDDEN", "上传临时路径无效。", 403);
      await rm(temporary, { force: true });
    }
  }
  async putPath(path, filename = basename(path)) { return this.put(createReadStream(path), { filename, mediaType: mediaTypeFor(filename) }); }
  async manifest(file) {
    const key = file.sha256;
    if (!this.manifests.has(key)) this.manifests.set(key, runPdf({ action: "manifest", path: this.path(key) }, this).catch((error) => { this.manifests.delete(key); throw error; }));
    return this.manifests.get(key);
  }
  async page(file, page, width = 1200) {
    check(Number.isInteger(page) && page >= 1, "VALIDATION_FAILED", "页码无效。");
    check(Number.isInteger(width) && width >= 300 && width <= 1800, "VALIDATION_FAILED", "原页图像宽度无效。");
    const manifest = await this.manifest(file);
    check(page <= manifest.pages.length, "NOT_FOUND", "原页不存在。", 404);
    const target = resolve(this.root, "pages", `${file.sha256}-${page}-${width}.png`);
    if (await stat(target).catch(() => null)) return target;
    if (!this.rendering.has(target)) {
      const pageRoot = resolve(this.root, "pages"), temporary = resolve(pageRoot, randomUUID() + ".png");
      this.rendering.set(target, (async () => {
        const handle = await open(temporary, "wx");
        try {
          await handle.close();
          await runPdf({ action: "render", path: this.path(file.sha256), page, width, outputPath: temporary }, this);
          await rename(temporary, target); return target;
        } finally {
          check(dirname(temporary) === pageRoot, "FORBIDDEN", "原页临时路径无效。", 403);
          await rm(temporary, { force: true });
        }
      })().finally(() => this.rendering.delete(target)));
    }
    return this.rendering.get(target);
  }
  async regions(file, document) {
    const blocks = document.blocks.map(({ id, type, text, origin, source, head, rows, html, role, num, items }) => ({ id, type, text, origin, source, head, rows, html, role, num,
      ...(type === "list" ? { items: items?.map(({ id, text, source }) => ({ id, text, source })) } : {}) }));
    const key = PDF_REGION_ALGORITHM_VERSION + ":" + file.sha256 + ":" + hash(JSON.stringify(blocks));
    if (!this.regionMaps.has(key)) {
      // Bound memory across imported documents/revisions; each result is a
      // disposable derivative of a source hash and its exact block content.
      if (this.regionMaps.size >= 32) this.regionMaps.delete(this.regionMaps.keys().next().value);
      this.regionMaps.set(key, runPdf({ action: "regions", path: this.path(file.sha256), blocks }, this).then((result) => result.regions).catch((error) => { this.regionMaps.delete(key); throw error; }));
    }
    return this.regionMaps.get(key);
  }
}
