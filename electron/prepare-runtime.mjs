import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { generateThirdPartyNotices } from '../scripts/generate-third-party-notices.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(root, '.desktop');
const output = join(desktop, 'runtime');
// The compiler shares these modules with the Reader. The rendered UI itself is
// already bundled by Vite; its full source tree has no use in the runtime.
export const compilerFiles = [
  'scripts/compile-authoring.mjs', 'scripts/authoring-compiler.mjs', 'scripts/authoring-validation.mjs',
  'src/html-content.js', 'src/document-content.js', 'src/reading-language.js', 'src/attention-example.js',
  'src/conversion-request.js', 'src/reader-navigation.js',
];
export const contractSpecs = ['Agent转换约定.md', '转换质量反馈.md', '辅助阅读导航.md', '文档格式.md', '自定义HTML内容块.md', '双语对照.md', '统一样式.md', '内容模块与布局.md'];
// Keep executable JS (both ESM and CJS), package exports, data and licenses.
export const developmentMetadata = (name) => /(?:\.map|\.d\.(?:ts|mts|cts))$/i.test(name);
export const runtimeServices = ['workspace'];
export const productionServiceFile = (source) => !/[\\/](?:node_modules|tests|\.data|data|__pycache__)(?:[\\/]|$)/.test(source) && !source.endsWith('.pyc');
export function runtimeDependencies(...manifests) {
  const dependencies = {};
  for (const manifest of manifests) for (const [name, version] of Object.entries(manifest.dependencies || {})) {
    if (dependencies[name] && dependencies[name] !== version) throw new Error('Conflicting runtime dependency versions: ' + name);
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Runtime dependency must be pinned: ' + name);
    dependencies[name] = version;
  }
  return dependencies;
}
const run = (command, args, cwd = root, env = process.env) => new Promise((done, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  child.once('error', reject); child.once('exit', (code) => code === 0 ? done() : reject(new Error(command + ' exited ' + code)));
});
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function ownedBuildPath(path) {
  const absolute = resolve(path), child = relative(desktop, absolute);
  if (!child || isAbsolute(child) || child === '..' || child.startsWith('..' + sep)) throw new Error('Build path escapes .desktop: ' + absolute);
  if ((await lstat(desktop)).isSymbolicLink()) throw new Error('Build directory cannot be a symbolic link');
  for (let current = absolute; current !== desktop; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Build path cannot contain a symbolic link: ' + current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return absolute;
}
async function discard(path) { await rm(await ownedBuildPath(path), { recursive: true, force: true }); }
async function pruneMetadata(directory) {
  const removed = { files: 0, bytes: 0 };
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected dependency link: ' + path);
    if (entry.isDirectory()) {
      const nested = await pruneMetadata(path); removed.files += nested.files; removed.bytes += nested.bytes;
    } else if (developmentMetadata(entry.name)) {
      removed.bytes += (await stat(path)).size; removed.files += 1;
      await rm(await ownedBuildPath(path));
    }
  }
  return removed;
}

export function matchingDependencyLock(lock, dependencies) {
  const locked = lock?.packages?.['']?.dependencies;
  return lock?.lockfileVersion === 3 && locked &&
    JSON.stringify(Object.entries(locked).sort()) === JSON.stringify(Object.entries(dependencies).sort());
}

async function copyPlainTree(source, target) {
  if ((await lstat(source)).isSymbolicLink()) throw new Error('Runtime cache cannot contain symbolic links: ' + source);
  await cp(source, target, { recursive: true, filter: async (file) => {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Runtime cache cannot contain symbolic links: ' + file);
    return !/[\\/](?:__pycache__)(?:[\\/]|$)/.test(file) && !file.endsWith('.pyc');
  } });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--reuse', '--refresh-lock'].includes(arg))) throw new Error('Usage: prepare-runtime.mjs [--reuse] [--refresh-lock]');
  const reuse = args.includes('--reuse'), refreshLock = args.includes('--refresh-lock');
  await generateThirdPartyNotices();
  await mkdir(desktop, { recursive: true });
  const stage = await ownedBuildPath(join(desktop, '.runtime-stage-' + randomUUID()));
  const backup = await ownedBuildPath(join(desktop, '.runtime-backup-' + randomUUID()));
  await ownedBuildPath(output);
  await mkdir(stage);
  let backedUp = false;
  try {
    await run(process.execPath, [resolve(root, 'prototypes/insight-composer/node_modules/vite/bin/vite.js'), 'build', '--outDir', join(stage, 'client'), '--emptyOutDir'], resolve(root, 'prototypes/insight-composer'));
    for (const service of runtimeServices) await cp(resolve(root, 'services', service), join(stage, 'services', service), { recursive: true, filter: productionServiceFile });
    for (const file of compilerFiles) {
      const target = join(stage, 'prototypes/insight-composer', file);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(root, 'prototypes/insight-composer', file), target);
    }
    await mkdir(join(stage, 'spec'));
    for (const file of contractSpecs) await cp(join(root, 'spec', file), join(stage, 'spec', file));
    const service = JSON.parse(await readFile(resolve(root, 'services/workspace/package.json'), 'utf8'));
    const client = JSON.parse(await readFile(resolve(root, 'prototypes/insight-composer/package.json'), 'utf8'));
    const dependencies = runtimeDependencies(service, { dependencies: { 'css-tree': client.dependencies['css-tree'] } });
    await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'continuous-reader-runtime', private: true, type: 'module', dependencies }, null, 2));
    const lockPath = join(root, 'electron/runtime-package-lock.json');
    const lockBytes = !refreshLock ? await readFile(lockPath) : null;
    if (lockBytes && !matchingDependencyLock(JSON.parse(lockBytes), dependencies)) throw new Error('Runtime dependencies changed. Run npm run desktop:runtime:lock and release a full installer.');
    if (lockBytes) await writeFile(join(stage, 'package-lock.json'), lockBytes);
    let reusedDependencies = false;
    if (reuse && lockBytes && await exists(join(output, 'node_modules')) && await exists(join(output, 'package-lock.json'))) {
      if (lockBytes.equals(await readFile(join(output, 'package-lock.json')))) {
        await copyPlainTree(join(output, 'node_modules'), join(stage, 'node_modules'));
        reusedDependencies = true;
      }
    }
    if (!reusedDependencies) await run(process.execPath, [process.env.npm_execpath || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), refreshLock ? 'install' : 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false'], stage);
    console.log(reusedDependencies ? 'Reused locked production dependencies.' : 'Installed locked production dependencies.');
    const removed = await pruneMetadata(join(stage, 'node_modules'));
    if (reuse && await exists(join(output, 'python'))) await copyPlainTree(join(output, 'python'), join(stage, 'python'));
    await run(process.execPath, [resolve(root, 'electron/prepare-python.mjs')], root, { ...process.env, CONTINUOUS_READER_BUILD_RUNTIME: stage });
    console.log('Omitted dependency development metadata: ' + JSON.stringify(removed));
    // A failed build leaves the previous runtime intact. A fresh tree prevents
    // removed services and older hashed UI chunks from accumulating in releases.
    const { default: verification } = await import('./verify-package.cjs');
    await verification.verifyRuntime({ runtime: stage, stagedRuntime: stage });
    if (refreshLock) await cp(join(stage, 'package-lock.json'), lockPath);
    if (await exists(output)) { await rename(await ownedBuildPath(output), backup); backedUp = true; }
    try { await rename(stage, output); }
    catch (error) { if (backedUp) { await rename(backup, output); backedUp = false; } throw error; }
    if (backedUp) { await discard(backup); backedUp = false; }
    console.log('Desktop runtime ready: ' + output);
  } finally { await discard(stage); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
