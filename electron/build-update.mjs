import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, sign, verify, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import verification from './verify-package.cjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifestName = 'reader-update-win32-x64.json';
export const appFiles = ['main.cjs', 'preload.cjs', 'backend.cjs', 'mcp.cjs', 'workspace-migration.cjs', 'development.cjs'].map((name) => 'electron/' + name);
export const foundationFiles = ['bootstrap.cjs', 'update-core.cjs', 'update-config.cjs', 'update-public-key.pem', 'runtime-package-lock.json'].map((name) => 'electron/' + name);
const MAX_PAYLOAD = 128 * 1024 * 1024;
const MAX_EXPANDED = 256 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_FILES = 20000;
const omitted = (path) => /(^|\/)(?:\.bin|__pycache__)(\/|$)/.test(path) || /\.pyc$/i.test(path);
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const validVersion = (value) => typeof value === 'string' && versionPattern.test(value) && value.split('.').every((part) => Number.isSafeInteger(Number(part)));
const newer = (a, b) => { const aa = a.split('.').map(Number), bb = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i]; return false; };

export function validateUpdatePath(path) {
  if (typeof path !== 'string' || path.length > 240 || path.includes('\\') || /[\x00-\x1f\x7f<>:"|?*]/.test(path)) throw new Error('Invalid update path: ' + path);
  const segments = path.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe update path: ' + path);
  if (!([...appFiles.map((name) => 'app/' + name), 'app/package.json'].includes(path) || /^runtime\/(?:client|services|prototypes|spec)\//.test(path) || /^runtime\/package(?:-lock)?\.json$/.test(path))) throw new Error('Unexpected update path: ' + path);
  if (/^runtime\/.*(?:^|\/)(?:python|node_modules)(?:\/|$)/i.test(path) || /^runtime\/(?:python|node_modules)(?:\/|$)/i.test(path)) throw new Error('Foundation file cannot be delivered as an app update: ' + path);
  verification.validatePrivatePath(path);
  if (/^runtime\/services\/agent-host(?:\/|$)/i.test(path)) throw new Error('Retired Agent host cannot be delivered: ' + path);
  return path;
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

export async function inventory(directory, prefix = '') {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Inventory root must be a real directory: ' + directory);
  const result = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = prefix ? prefix + '/' + item.name : item.name;
    if (omitted(name)) continue;
    const file = join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Update source contains a symbolic link: ' + name);
    if (item.isDirectory()) result.push(...await inventory(file, name));
    else if (item.isFile()) result.push({ path: name, sha256: await hashFile(file), bytes: (await lstat(file)).size });
    else throw new Error('Unsupported update source: ' + name);
  }
  return result;
}

async function fileEntry(root, path, normalizeNewlines = false) {
  const file = join(root, path), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular update source: ' + path);
  if (normalizeNewlines) {
    const content = Buffer.from((await readFile(file, 'utf8')).replaceAll('\r\n', '\n'));
    return { path, sha256: digest(content), bytes: content.length };
  }
  return { path, sha256: await hashFile(file), bytes: info.size };
}

export async function foundationInventory({ root, runtime, electron, platform = 'win32', arch = 'x64' }) {
  if (!validVersion(electron)) throw new Error('The Electron foundation version must be pinned');
  const files = [];
  for (const path of foundationFiles) files.push(await fileEntry(root, path, true));
  for (const path of ['electron/assets/continuous-reader.ico', 'electron/assets/continuous-reader.png']) files.push(await fileEntry(root, path));
  for (const path of ['services/workspace/workspace-schema.mjs', 'services/workspace/sync-schema.mjs']) {
    const entry = await fileEntry(runtime, path, true);
    files.push({ ...entry, path: 'runtime/' + path });
  }
  const runtimeFiles = [];
  for (const directory of ['node_modules', 'python']) runtimeFiles.push(...await inventory(join(runtime, directory), 'runtime/' + directory));
  runtimeFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  files.push(...runtimeFiles);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { foundation: digest(JSON.stringify({ schema: 1, platform, arch, electron, files })), foundationFiles: runtimeFiles };
}

export async function foundationId(options) { return (await foundationInventory(options)).foundation; }

export function verifyEnvelope(envelope, publicKey) {
  if (!envelope || !envelope.manifest || typeof envelope.signature !== 'string' || !verify(null, Buffer.from(JSON.stringify(envelope.manifest)), publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('The previous update manifest signature is invalid');
  const manifest = envelope.manifest;
  if (manifest.schema !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' || !validVersion(manifest.version) || !validVersion(manifest.installerVersion) || newer(manifest.installerVersion, manifest.version) || !/^[a-f0-9]{64}$/.test(manifest.foundation) || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) throw new Error('Invalid previous update manifest');
  const names = new Set();
  let previous = '';
  for (const entry of manifest.files) {
    validateUpdatePath(entry.path);
    if (entry.path <= previous || names.has(entry.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE) throw new Error('Invalid previous update inventory');
    names.add(entry.path.toLowerCase()); previous = entry.path;
  }
  if (manifest.id !== digest(JSON.stringify(manifest.files))) throw new Error('The previous update inventory digest does not match');
  return manifest;
}

async function writeAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, value);
  await rename(temporary, file);
}

export async function buildUpdate({ root = repository, runtime = join(root, '.desktop/runtime'), out, base, requireCompatibleBase = false, baselineOnly = false, fullFoundation = false, privateKeyPem, verifyRuntime = true } = {}) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!validVersion(pkg.version)) throw new Error('Update version must be a stable x.y.z version');
  if (!baselineOnly && !fullFoundation && !base) throw new Error('An app update requires --base previous-manifest.json. Use --full-foundation only when publishing a matching full installer.');
  if (fullFoundation && requireCompatibleBase) throw new Error('--full-foundation and --require-compatible-base describe different release modes');
  out = resolve(out || join(root, 'release', pkg.version, 'updates'));
  const publicKey = createPublicKey(await readFile(join(root, 'electron/update-public-key.pem'), 'utf8'));
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Update public key must be Ed25519');
  let privateKey;
  if (!baselineOnly) {
    privateKey = createPrivateKey(privateKeyPem || process.env.READER_UPDATE_PRIVATE_KEY_PEM || await readFile(join(root, '.desktop/update-signing-private.pem'), 'utf8'));
    if (privateKey.asymmetricKeyType !== 'ed25519' || !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) throw new Error('Update signing key does not match the embedded Ed25519 public key');
  }
  if (verifyRuntime) await verification.verifyRuntime({ runtime, stagedRuntime: runtime });
  const { foundation, foundationFiles: runtimeFiles } = await foundationInventory({ root, runtime, electron: pkg.devDependencies?.electron });
  const previous = base ? verifyEnvelope(typeof base === 'string' ? JSON.parse(await readFile(base, 'utf8')) : base, publicKey) : null;
  if (previous && !newer(pkg.version, previous.version)) throw new Error('New update version must be greater than the previous release (' + previous.version + ')');
  if ((requireCompatibleBase || (!baselineOnly && !fullFoundation)) && (!previous || previous.foundation !== foundation)) throw new Error('Application-only release requires a compatible published baseline. Create a full desktop release first.');
  const contents = new Map();
  for (const path of appFiles) contents.set('app/' + path, await readFile(join(root, path)));
  const metadata = Object.fromEntries(['name', 'version', 'description', 'author', 'type'].filter((key) => pkg[key] !== undefined).map((key) => [key, pkg[key]]));
  metadata.main = 'electron/main.cjs';
  contents.set('app/package.json', Buffer.from(JSON.stringify(metadata, null, 2) + '\n'));
  for (const entry of await inventory(runtime)) if (!/^node_modules\/|^python\//.test(entry.path)) contents.set('runtime/' + entry.path, await readFile(join(runtime, entry.path)));
  const files = [...contents].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({ path: validateUpdatePath(path), sha256: digest(bytes), bytes: bytes.length }));
  const names = new Set();
  for (const entry of files) {
    if (names.has(entry.path.toLowerCase()) || entry.bytes > MAX_FILE) throw new Error('Duplicate or oversized update file: ' + entry.path);
    names.add(entry.path.toLowerCase());
  }
  if (files.length > MAX_FILES) throw new Error('Too many files in the app update');
  const id = digest(JSON.stringify(files));
  const baseline = JSON.stringify({ schema: 1, platform: 'win32', arch: 'x64', foundation, version: pkg.version, id, files, foundationFiles: runtimeFiles }, null, 2) + '\n';
  if (Buffer.byteLength(baseline) > 8 * 1024 * 1024) throw new Error('Baseline inventory exceeds the client limit');
  await writeAtomic(join(root, '.desktop/update-base.json'), baseline);
  if (baselineOnly) return { baseline: join(root, '.desktop/update-base.json'), version: pkg.version, foundation, id, files: files.length };
  const prefix = 'Continuous-Reader-' + pkg.version + '-win32-x64-' + id.slice(0, 12);
  async function payload(entries, suffix = '') {
    const data = Buffer.from(JSON.stringify({ schema: 1, files: entries.map(({ path }) => ({ path, data: contents.get(path).toString('base64') })) }));
    if (data.length > MAX_EXPANDED) throw new Error('Expanded update payload exceeds the client limit');
    const bytes = gzipSync(data, { level: 9 });
    if (bytes.length > MAX_PAYLOAD) throw new Error('Compressed update payload exceeds the client limit');
    const name = prefix + suffix + '.crupdate';
    await writeAtomic(join(out, name), bytes);
    return { name, sha256: digest(bytes), bytes: bytes.length };
  }
  const installerVersion = fullFoundation ? pkg.version : previous.installerVersion;
  const manifest = { schema: 1, version: pkg.version, installerVersion, platform: 'win32', arch: 'x64', foundation, id, files, payload: await payload(files) };
  let changedFiles = files.length;
  if (previous?.foundation === foundation) {
    const prior = new Map(previous.files.map((entry) => [entry.path, entry]));
    const changed = files.filter((entry) => prior.get(entry.path)?.sha256 !== entry.sha256 || prior.get(entry.path)?.bytes !== entry.bytes);
    changedFiles = changed.length;
    manifest.delta = { ...await payload(changed, '-from-' + previous.id.slice(0, 12)), from: previous.id };
  }
  const envelope = { manifest, signature: sign(null, Buffer.from(JSON.stringify(manifest)), privateKey).toString('base64') };
  const serialized = JSON.stringify(envelope, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new Error('Update manifest exceeds the client limit');
  await writeAtomic(join(out, manifestName), serialized);
  return { out, manifest: join(out, manifestName), version: pkg.version, installerVersion, foundation, id, files: files.length, changedFiles, fullBytes: manifest.payload.bytes, deltaBytes: manifest.delta?.bytes ?? null };
}

export function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--require-compatible-base') result.requireCompatibleBase = true;
    else if (arg === '--baseline-only') result.baselineOnly = true;
    else if (arg === '--full-foundation') result.fullFoundation = true;
    else if (arg === '--base' || arg === '--out') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(arg + ' needs a path');
      result[arg.slice(2)] = resolve(value);
    } else throw new Error('Usage: node electron/build-update.mjs (--base previous-manifest.json | --full-foundation | --baseline-only) [--out directory] [--require-compatible-base]');
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildUpdate(parseArguments(process.argv.slice(2))).then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
