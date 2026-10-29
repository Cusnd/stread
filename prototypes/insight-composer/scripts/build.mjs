#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { generateThirdPartyNotices } from "../../../scripts/generate-third-party-notices.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const client = join(dist, "client");
const stage = join(dist, ".build-stage-" + randomUUID());

async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function ownedOutput(path) {
  const absolute = resolve(path);
  const child = relative(dist, absolute);
  if (!child || child === ".." || child.startsWith(".." + sep) || isAbsolute(child)) throw new Error(`Refusing output operation outside ${dist}`);
  if ((await lstat(dist)).isSymbolicLink()) throw new Error("Build output cannot use a symbolic-link dist directory");
  if (await exists(absolute) && (await lstat(absolute)).isSymbolicLink()) throw new Error(`Build output cannot contain a symbolic link: ${absolute}`);
  return absolute;
}
async function walk(directory, prefix = "") {
  const files = [], directories = [];
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Build output cannot contain a symbolic link: ${join(directory, name)}`);
    if (entry.isDirectory()) {
      const nested = await walk(directory, name);
      files.push(...nested.files);
      directories.push(name, ...nested.directories);
    } else files.push(name);
  }
  return { files, directories };
}
async function hash(path) {
  const result = createHash("sha256");
  for await (const chunk of createReadStream(path)) result.update(chunk);
  return result.digest("hex");
}
async function identical(source, target) {
  if (!await exists(target)) return false;
  const [left, right] = await Promise.all([stat(source), stat(target)]);
  return right.isFile() && left.size === right.size && await hash(source) === await hash(target);
}
async function publishFile(name) {
  const source = join(stage, name);
  const target = await ownedOutput(join(client, name));
  // In particular, an open source.pdf is never overwritten or removed if its bytes are unchanged.
  if (await identical(source, target)) return false;
  await mkdir(dirname(target), { recursive: true });
  const temporary = await ownedOutput(target + ".publish-" + randomUUID() + ".tmp");
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
    return true;
  } catch (error) {
    throw new Error(`Build publication incomplete: could not replace ${target} (${error.code || error.message}). The entry page has not been advanced past this failure.`, { cause: error });
  } finally { await rm(temporary, { force: true }); }
}

// An already open app can request an older lazy chunk long after index.html changes.
// Content-addressed Vite assets therefore remain available across builds; other stale files are removed.
function immutableAsset(name) { return name.startsWith("assets/") && (/^assets\/pdfjs-[0-9]+\.[0-9]+\.[0-9]+\//.test(name) || /-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(name)); }

async function main() {
  await generateThirdPartyNotices();
  await mkdir(dist, { recursive: true });
  await ownedOutput(stage);
  await ownedOutput(client);
  try {
    // Vite only empties its unique staging tree, never the directory served by a running app.
    await build({ root, build: { outDir: stage, emptyOutDir: true } });
    const generated = await walk(stage);
    if (!generated.files.includes("index.html")) throw new Error("Vite did not emit index.html; the existing build was left in place");
    await mkdir(client, { recursive: true });
    const previous = await walk(client);
    const current = new Set(generated.files);
    const result = { copied: 0, unchanged: 0, removed: 0, retainedHashedAssets: 0 };
    for (const name of generated.files.filter((name) => name !== "index.html")) {
      if (await publishFile(name)) result.copied += 1;
      else result.unchanged += 1;
    }
    for (const name of previous.files.filter((name) => !current.has(name))) {
      if (immutableAsset(name)) { result.retainedHashedAssets += 1; continue; }
      const target = await ownedOutput(join(client, name));
      try { await rm(target); result.removed += 1; }
      catch (error) { throw new Error(`Build publication incomplete: could not remove stale output ${target} (${error.code || error.message}). The previous entry page is still active.`, { cause: error }); }
    }
    for (const name of previous.directories.sort((left, right) => right.split("/").length - left.split("/").length)) {
      const target = await ownedOutput(join(client, name));
      try { if ((await readdir(target)).length === 0) await rmdir(target); }
      catch (error) { throw new Error(`Build publication incomplete: could not clean stale directory ${target} (${error.code || error.message}). The previous entry page is still active.`, { cause: error }); }
    }
    // Publish the entry only after all of its assets are present and required cleanup succeeded.
    if (await publishFile("index.html")) result.copied += 1;
    else result.unchanged += 1;
    console.log(`Published dist/client: ${JSON.stringify(result)}`);
  } finally {
    if (await exists(stage)) await rm(await ownedOutput(stage), { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
