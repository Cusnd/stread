// Windows build-time preparation. The shipped app never downloads Python or uses host Python.
// Override the build interpreter with CONTINUOUS_READER_BUILD_PYTHON; --force rebuilds from verified cache.
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = join(root, ".desktop");
const runtimeRoot = resolve(process.env.CONTINUOUS_READER_BUILD_RUNTIME || join(desktop, "runtime"));
if (dirname(runtimeRoot) !== resolve(desktop) || !/^(?:runtime|\.runtime-stage-[0-9a-f-]+)$/.test(basename(runtimeRoot))) throw new Error("Python build output must be an owned runtime under .desktop");
const destination = join(runtimeRoot, "python");
const downloads = join(desktop, "downloads");
const verification = join(desktop, "verification", "python");
export const buildPython = process.env.CONTINUOUS_READER_BUILD_PYTHON || (process.platform === "win32" ? "python" : "python3");
const manifestName = "continuous-reader-runtime.json";
export const runtimePayload = "runtime-only-v2";
const pythonVersion = "3.13.17";
// Match the existing workspace PDF engine; the cp310 abi3 wheel also supports CPython 3.13.
const pymupdfVersion = "1.27.2.2";
const artifacts = [
  {
    filename: "python-3.13.17-embed-amd64.zip",
    url: "https://www.python.org/ftp/python/3.13.17/python-3.13.17-embed-amd64.zip",
    sha256: "9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38",
  },
  {
    filename: "pymupdf-1.27.2.2-cp310-abi3-win_amd64.whl",
    url: "https://files.pythonhosted.org/packages/a8/b6/2a9a8556000199bbf80a5915dcd15d550d1e5288894316445c54726aaf53/pymupdf-1.27.2.2-cp310-abi3-win_amd64.whl",
    sha256: "09bb53f9486ccb5297030cbc2dbdae845ba1c3c5126e96eb2d16c4f118de0b5b",
  },
];

export function runtimeManifest(files) {
  return { schema: 2, payload: runtimePayload, python: pythonVersion, pymupdf: pymupdfVersion, artifacts, files };
}
export function manifestMatchesRuntime(saved) {
  return saved?.schema === 2 && saved.payload === runtimePayload && saved.python === pythonVersion && saved.pymupdf === pymupdfVersion && JSON.stringify(saved.artifacts) === JSON.stringify(artifacts);
}

async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function run(executable, args, { input = "", timeout = 180000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || timedOut) reject(new Error(`${executable} failed (${timedOut ? "timeout" : code}):\n${(errors || output).slice(-6000)}`));
      else resolveResult(output.trim());
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export async function extractArchive(archive, target, { pythonPath = buildPython } = {}) {
  await run(pythonPath, ["-B", "-c", "import pathlib, stat, sys, zipfile; target=pathlib.Path(sys.argv[2]).resolve(); archive=zipfile.ZipFile(sys.argv[1]); members=archive.infolist(); assert all((target / item.filename).resolve().is_relative_to(target) and not stat.S_ISLNK(item.external_attr >> 16) for item in members), 'Unsafe ZIP path'; archive.extractall(target)", archive, target]);
}

async function cachedArtifact(artifact) {
  const path = join(downloads, artifact.filename);
  if (await exists(path)) {
    if (await sha256(path) === artifact.sha256) { console.log(`Verified cached ${artifact.filename}`); return path; }
    console.log(`Replacing invalid cache entry ${artifact.filename}`);
    await rm(path);
  }
  const temporary = path + "." + randomUUID() + ".partial";
  console.log(`Downloading ${artifact.filename}`);
  try {
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status} (${artifact.url})`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    const actual = await sha256(temporary);
    if (actual !== artifact.sha256) throw new Error(`SHA-256 mismatch for ${artifact.filename}: ${actual}`);
    await rename(temporary, path);
    return path;
  } finally { await rm(temporary, { force: true }); }
}

// Every recursive cleanup and directory move is confined to generated runtime children.
async function ownedRuntimePath(path) {
  const absolute = resolve(path);
  const within = relative(runtimeRoot, absolute);
  if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) throw new Error(`Refusing runtime operation outside ${runtimeRoot}`);
  if ((await lstat(runtimeRoot)).isSymbolicLink()) throw new Error("Runtime root must not be a symbolic link");
  if (await exists(absolute) && (await lstat(absolute)).isSymbolicLink()) throw new Error(`Runtime child must not be a symbolic link: ${absolute}`);
  return absolute;
}
async function removeRuntime(path) { await rm(await ownedRuntimePath(path), { recursive: true, force: true }); }
async function moveRuntime(from, to) { await rename(await ownedRuntimePath(from), await ownedRuntimePath(to)); }

async function inventory(directory, prefix = "") {
  const files = [];
  for (const entry of (await readdir(join(directory, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected runtime symbolic link: ${name}`);
    if (entry.isDirectory()) files.push(...await inventory(directory, name));
    else if (name !== manifestName) {
      const path = join(directory, name);
      files.push({ path: name, bytes: (await stat(path)).size, sha256: await sha256(path) });
    }
  }
  return files;
}
async function currentManifest() {
  try {
    const saved = JSON.parse(await readFile(join(destination, manifestName), "utf8"));
    if (!manifestMatchesRuntime(saved)) return null;
    const actual = await inventory(destination);
    return JSON.stringify(actual) === JSON.stringify(saved.files) ? saved : null;
  } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; return null; }
}

async function copyPdfHelpers() {
  const helpers = join(runtimeRoot, "services", "workspace");
  await mkdir(helpers, { recursive: true });
  for (const name of ["pdf.py", "pdf_regions.py"]) await copyFile(join(root, "services", "workspace", name), join(helpers, name));
  return join(helpers, "pdf.py");
}

async function verify(directory, helper) {
  const executable = join(directory, "python.exe");
  const versions = JSON.parse(await run(executable, ["-X", "utf8", "-B", "-c", "import sys, struct, json, fitz; print(json.dumps({'python': '.'.join(map(str, sys.version_info[:3])), 'pymupdf': fitz.VersionBind, 'mupdf': fitz.VersionFitz, 'bits': struct.calcsize('P') * 8}))"]));
  if (versions.python !== pythonVersion || versions.pymupdf !== pymupdfVersion || versions.bits !== 64) throw new Error(`Unexpected runtime: ${JSON.stringify(versions)}`);
  const request = async (value) => {
    const output = JSON.parse(await run(executable, ["-X", "utf8", "-B", helper], { input: JSON.stringify(value) }));
    if (!output.ok) throw new Error(output.error || "PDF helper failed");
    return output.result;
  };
  const path = join(root, "prototypes", "insight-composer", "public", "articles", "attention-is-all-you-need", "source.pdf");
  const document = JSON.parse(await readFile(join(dirname(path), "document.json"), "utf8"));
  const blocks = document.blocks.filter((block) => block.type === "para" && block.source?.some((source) => source.page === 1)).slice(0, 8).map((block) => ({ id: block.id, type: block.type, text: block.text, source: [{ page: 1 }] }));
  const manifest = await request({ action: "manifest", path });
  const rendered = await request({ action: "render", path, page: 1, width: 900, outputPath: join(verification, "attention-page-1.png") });
  const regions = await request({ action: "regions", path, blocks });
  const rotated = await request({ action: "coordinate_probe" });
  const derived = regions.regions.filter((region) => region.provenance !== "source" && Array.isArray(region.box) && region.box.length === 4 && region.box.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) && region.box[0] < region.box[2] && region.box[1] < region.box[3]);
  if (!manifest.pages.length || rendered.pixelWidth !== 900 || rendered.pixelHeight <= 0 || !derived.length || rotated.length !== 4) throw new Error("PDF runtime verification did not produce valid pages, pixels and derived source regions");
  if (!(await exists(join(directory, "LICENSE.txt")))) throw new Error("Python's original LICENSE.txt is missing");
  const files = await inventory(directory);
  if (!files.some((file) => /pymupdf-[^/]+\.dist-info\/(?:licenses\/)?(?:COPYING|LICENSE)/i.test(file.path))) throw new Error("PyMuPDF wheel license is missing");
  const result = { ...versions, pdfPages: manifest.pages.length, rendered, sourceRegions: regions.regions.length, derivedSourceRegions: derived.length, rotations: rotated.map((page) => page.rotation), bytes: files.reduce((total, file) => total + file.bytes, 0), fileCount: files.length };
  await writeFile(join(verification, "report.json"), JSON.stringify({ ...result, manifest, regions, rotated }, null, 2) + "\n");
  return result;
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Prepare this runtime on Windows x64");
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--force")) throw new Error("Usage: node electron/prepare-python.mjs [--force]");
  await mkdir(downloads, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(verification, { recursive: true });
  const helper = await copyPdfHelpers();
  if (!args.includes("--force") && await currentManifest()) {
    console.log("Installed runtime file hashes match; reusing existing Python");
    console.log(JSON.stringify({ reused: true, path: destination, ...await verify(destination, helper) }, null, 2));
    return;
  }
  try { await run(buildPython, ["--version"], { timeout: 15000 }); }
  catch (error) { throw new Error("Build Python is unavailable. Install Python on PATH or set CONTINUOUS_READER_BUILD_PYTHON to a Python interpreter.", { cause: error }); }
  const archive = await cachedArtifact(artifacts[0]);
  const wheel = await cachedArtifact(artifacts[1]);
  const stage = join(runtimeRoot, ".python-stage-" + randomUUID());
  const backup = join(runtimeRoot, ".python-backup-" + randomUUID());
  await mkdir(stage);
  let backedUp = false;
  try {
    await extractArchive(archive, stage);
    await writeFile(join(stage, "python313._pth"), "python313.zip\n.\nLib/site-packages\n../services/workspace\n\n# Paths are explicit: do not import site or load user-installed packages.\n");
    // This pinned wheel has only fitz/, pymupdf/ and dist-info, with no .data
    // relocation. Extract original bytes so pip cannot embed build-machine
    // paths in direct_url.json, launcher executables or a rewritten RECORD.
    await extractArchive(wheel, join(stage, "Lib", "site-packages"));
    // Development headers/import libraries are unnecessary for the prebuilt
    // Python extensions. Preserve all runtime .pyd/.dll files and licenses.
    await removeRuntime(join(stage, "Lib", "site-packages", "pymupdf", "mupdf-devel"));
    const result = await verify(stage, helper);
    await writeFile(join(stage, manifestName), JSON.stringify(runtimeManifest(await inventory(stage)), null, 2) + "\n");
    if (await exists(destination)) { await moveRuntime(destination, backup); backedUp = true; }
    try { await moveRuntime(stage, destination); }
    catch (error) { if (backedUp) { await moveRuntime(backup, destination); backedUp = false; } throw error; }
    if (backedUp) { await removeRuntime(backup); backedUp = false; }
    console.log(JSON.stringify({ reused: false, path: destination, ...result }, null, 2));
  } finally { await removeRuntime(stage); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
