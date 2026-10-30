'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, createPublicKey, verify, randomUUID } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const config = require('./update-config.cjs');

const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const APP_FILES = new Set(['main', 'preload', 'backend', 'mcp', 'workspace-migration', 'development'].map((name) => 'app/electron/' + name + '.cjs').concat('app/package.json'));
const HOSTS = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const RELEASES = 'https://github.com/' + config.repository + '/releases';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
function fail(message) { throw new Error(message); }
function version(value) {
  if (typeof value !== 'string' || !VERSION.test(value) || value.split('.').some((part) => !Number.isSafeInteger(Number(part)))) fail('更新版本号无效。');
  return value;
}
function compareVersion(a, b) {
  const left = version(a).split('.').map(Number), right = version(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
function validatePath(name) {
  if (typeof name !== 'string' || name.length > 512 || !name || /[\\\x00-\x1f\x7f:<>"|?*]/.test(name)) fail('更新文件路径无效。');
  const parts = name.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('更新文件路径无效。');
  if (parts.some((part) => /^(?:node_modules|python|\.git|\.data|user-data|userdata|__pycache__|\.bin)$/i.test(part))
    || /(?:\.sqlite(?:3)?|\.db)(?:-wal|-shm)?$/i.test(name) || /\.pyc$/i.test(name)
    || parts.some((part) => /^(?:connection\.json|reader-session\.json|desktop-state\.json|desktop\.log|\.env(?:\..*)?)$/i.test(part))
    || /^runtime\/services\/agent-host(?:\/|$)/i.test(name)) fail('更新不能包含资料库、凭据、已退休 Agent 或底层运行时。');
  if (!APP_FILES.has(name) && !/^runtime\/(?:client\/|services\/|prototypes\/|spec\/|package(?:-lock)?\.json$)/.test(name)) fail('更新文件超出程序目录。');
  return name;
}
function validateFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > config.limits.files) fail('更新文件清单无效。');
  const seen = new Set(); let previous = '', total = 0;
  for (const file of files) {
    if (!plainObject(file) || !HASH.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > config.limits.file) fail('更新文件校验信息无效。');
    validatePath(file.path);
    const folded = file.path.toLowerCase();
    if (seen.has(folded) || file.path <= previous) fail('更新文件清单存在重复或顺序错误。');
    seen.add(folded); previous = file.path; total += file.bytes;
  }
  if (total > config.limits.expanded) fail('更新展开后超过大小限制。');
  for (const file of APP_FILES) if (!seen.has(file.toLowerCase())) fail('更新缺少必要桌面文件：' + file);
  for (const file of ['runtime/client/index.html', 'runtime/services/workspace/server.mjs', 'runtime/services/workspace/stdio.mjs', 'runtime/package.json']) if (!seen.has(file)) fail('更新缺少必要运行文件：' + file);
  return files;
}
function payloadDescriptor(value) {
  if (!plainObject(value) || typeof value.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.name)
    || !HASH.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > config.limits.compressed) fail('更新下载信息无效。');
}
function validateManifest(manifest) {
  if (!plainObject(manifest) || manifest.schema !== config.schema || manifest.platform !== config.platform || manifest.arch !== config.arch || !HASH.test(manifest.foundation)) fail('更新清单与当前平台不兼容。');
  version(manifest.version); version(manifest.installerVersion);
  if (compareVersion(manifest.installerVersion, manifest.version) > 0) fail('完整安装包版本不能高于更新版本。');
  validateFiles(manifest.files);
  if (manifest.id !== sha(JSON.stringify(manifest.files))) fail('更新文件清单摘要不匹配。');
  payloadDescriptor(manifest.payload);
  if (manifest.delta !== undefined) { payloadDescriptor(manifest.delta); if (!HASH.test(manifest.delta.from)) fail('差分更新基线无效。'); }
  return manifest;
}
function verifyEnvelope(envelope, key) {
  if (!plainObject(envelope) || !plainObject(envelope.manifest) || typeof envelope.signature !== 'string'
    || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) fail('更新签名格式无效。');
  const publicKey = createPublicKey(key);
  if (publicKey.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(JSON.stringify(envelope.manifest)), publicKey, Buffer.from(envelope.signature, 'base64'))) fail('更新签名校验失败。');
  return validateManifest(envelope.manifest);
}
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function readJson(file, limit) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) fail('更新状态文件无效。');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function below(root, target) {
  const relative = path.relative(root, target);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function checkedPath(root, name, allowMissing = false) {
  const target = path.resolve(root, name);
  if (!below(root, target)) fail('更新路径越界。');
  for (let current = target; current !== root; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) fail('更新路径不能包含符号链接。'); }
    catch (error) { if (!allowMissing || error.code !== 'ENOENT') throw error; }
  }
  if (fs.lstatSync(root).isSymbolicLink()) fail('更新目录不能是符号链接。');
  return target;
}
function atomicJson(root, name, value) {
  const file = checkedPath(root, name, true), temporary = checkedPath(root, name + '.tmp-' + randomUUID(), true);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    const handle = fs.openSync(temporary, 'r+'); try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, file);
  } finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}
function fileBytes(root, name, descriptor) {
  const target = checkedPath(root, name), info = fs.lstatSync(target);
  if (!info.isFile() || info.size !== descriptor.bytes) fail('更新文件大小校验失败：' + name);
  const bytes = fs.readFileSync(target);
  if (sha(bytes) !== descriptor.sha256) fail('更新文件哈希校验失败：' + name);
  return bytes;
}
function listApplicationFiles(root) {
  const result = [];
  function visit(name) {
    const folder = checkedPath(root, name);
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const child = name + '/' + entry.name;
      if (child === 'runtime/node_modules' || child === 'runtime/python') {
        if (!entry.isDirectory() || entry.isSymbolicLink()) fail('底层运行时目录无效。');
        continue;
      }
      if (entry.isSymbolicLink()) fail('更新文件不能包含符号链接。');
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) result.push(child);
      else fail('更新文件类型无效。');
    }
  }
  visit('app'); visit('runtime'); return result.sort();
}

function createUpdater({ app, profile, resourcesPath, appRoot, fetchImpl = globalThis.fetch, publicKey, platform = process.platform, arch = process.arch }) {
  const base = readJson(path.join(resourcesPath, 'update-base.json'), config.limits.manifest);
  if (base.schema !== config.schema || !HASH.test(base.foundation) || base.platform !== platform || base.arch !== arch
    || platform !== config.platform || arch !== config.arch) fail('安装程序缺少当前平台的有效增量更新基线。');
  version(base.version); validateFiles(base.files);
  if (base.id !== sha(JSON.stringify(base.files))) fail('安装程序更新基线摘要无效。');
  if (!Array.isArray(base.foundationFiles) || !base.foundationFiles.length || base.foundationFiles.some((file) => !plainObject(file)
    || typeof file.path !== 'string' || !/^runtime\/(?:node_modules|python)\/.+/.test(file.path) || file.path.includes('\\') || file.path.split('/').some((part) => !part || part === '.' || part === '..')
    || !HASH.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) fail('安装程序底层运行时清单无效。');
  const key = publicKey || fs.readFileSync(path.join(appRoot, 'electron/update-public-key.pem'), 'utf8');
  const root = path.join(profile, 'updates');
  fs.mkdirSync(profile, { recursive: true });
  if (exists(root) && fs.lstatSync(root).isSymbolicLink()) fail('更新目录不能是符号链接。');
  fs.mkdirSync(root, { recursive: true });
  const releases = checkedPath(root, 'releases', true); fs.mkdirSync(releases, { recursive: true });
  const defaultState = () => ({ schema: 1, active: null, previous: null, pending: null, downloaded: null, trial: null });
  function loadState() {
    if (!exists(path.join(root, 'state.json'))) return defaultState();
    const state = readJson(checkedPath(root, 'state.json'), 65536);
    if (plainObject(state) && state.downloaded === undefined) state.downloaded = null;
    if (!plainObject(state) || state.schema !== 1 || ['active', 'previous', 'pending', 'downloaded'].some((name) => state[name] !== null && !HASH.test(state[name]))
      || (state.trial !== null && (!plainObject(state.trial) || !HASH.test(state.trial.id) || !Number.isSafeInteger(state.trial.pid) || state.trial.pid <= 0))) fail('更新启动状态无效。');
    return state;
  }
  const saveState = (state) => atomicJson(root, 'state.json', state);
  const baseline = { appRoot, runtime: path.join(resourcesPath, 'runtime'), version: base.version, id: base.id, files: base.files };
  let selected = baseline, checked, downloaded, busy = false, stateUsable = true;
  let snapshot = { state: 'idle', version: base.version, trial: false, releaseUrl: RELEASES, bytes: 0, receivedBytes: 0, error: '' };
  const status = () => ({ ...snapshot, repository: config.repository });
  const set = (value) => { snapshot = { ...snapshot, ...value }; return status(); };
  function verifyFoundation(directory) {
    const names = [];
    function visit(name) {
      const folder = checkedPath(directory, name);
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const child = name + '/' + entry.name;
        if (entry.isSymbolicLink()) fail('底层运行时不能包含符号链接。');
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile()) names.push(child);
        else fail('底层运行时文件类型无效。');
      }
    }
    for (const name of ['runtime/node_modules', 'runtime/python']) visit(name);
    if (JSON.stringify(names.sort()) !== JSON.stringify(base.foundationFiles.map((file) => file.path))) fail('缓存底层运行时文件清单不匹配。');
    for (const file of base.foundationFiles) fileBytes(directory, file.path, file);
  }
  function candidate(id) {
    if (!HASH.test(id)) fail('更新版本标识无效。');
    const directory = checkedPath(root, 'releases/' + id);
    const envelope = readJson(checkedPath(root, 'releases/' + id + '/update.json'), config.limits.manifest);
    const manifest = verifyEnvelope(envelope, key);
    if (manifest.id !== id || manifest.foundation !== base.foundation || compareVersion(manifest.version, base.version) <= 0) fail('缓存更新与当前安装基线不兼容。');
    if (JSON.stringify(listApplicationFiles(directory)) !== JSON.stringify(manifest.files.map((file) => file.path))) fail('缓存更新文件清单不匹配。');
    for (const file of manifest.files) fileBytes(directory, file.path, file);
    verifyFoundation(directory);
    return { appRoot: path.join(directory, 'app'), runtime: path.join(directory, 'runtime'), version: manifest.version, id, files: manifest.files, envelope };
  }
  function fallback(state) {
    let next = baseline;
    if (state.previous) try { next = candidate(state.previous); } catch {}
    state.active = next === baseline ? null : next.id; state.previous = null; state.pending = null; state.trial = null;
    return next;
  }
  function select({ mcp = false } = {}) {
    let state;
    try { state = loadState(); }
    catch (error) {
      set({ error: '更新状态损坏，已使用安装版本。', trial: false }); selected = baseline;
      if (!mcp) {
        stateUsable = false;
        try {
          const damaged = checkedPath(root, 'state.json');
          fs.renameSync(damaged, checkedPath(root, 'state-corrupt-' + randomUUID() + '.json', true));
          saveState(defaultState()); stateUsable = true;
        } catch { /* An unreadable or linked state must not prevent the installed baseline from starting. */ }
      }
      return selected;
    }
    let changed = false;
    if (!mcp && state.trial) {
      selected = fallback(state); changed = true;
      set({ error: '上次更新未完成启动，已恢复到可用版本。' });
    }
    if (!mcp && state.pending) {
      try {
        const next = candidate(state.pending);
        state.previous = state.active; state.active = next.id; state.pending = null;
        state.trial = { id: next.id, pid: process.pid }; selected = next; changed = true;
      } catch (error) { state.pending = null; changed = true; set({ error: '更新校验失败，保留当前程序：' + error.message }); }
    }
    if (!state.trial || mcp) {
      if (state.active) {
        try { selected = candidate(state.active); }
        catch (error) { selected = fallback(state); changed = !mcp; set({ error: '缓存更新不可用，已恢复到可用版本。' }); }
      } else selected = baseline;
    }
    if (state.downloaded && !mcp) {
      try {
        const staged = candidate(state.downloaded);
        if (compareVersion(staged.version, selected.version) > 0) {
          downloaded = staged.id;
          set({ state: 'downloaded', availableVersion: staged.version, bytes: staged.envelope.manifest.payload.bytes, releaseUrl: RELEASES + '/tag/v' + staged.version });
        } else { state.downloaded = null; changed = true; }
      } catch { state.downloaded = null; changed = true; }
    }
    if (changed) saveState(state);
    set({ version: selected.version, trial: !mcp && state.trial?.id === selected.id && state.trial.pid === process.pid }); return { ...selected };
  }
  async function fetchBytes(url, limit, progress = false) {
    let current = url;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
    try {
      for (let redirects = 0; redirects <= 5; redirects++) {
        const parsed = new URL(current);
        if (parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) fail('更新下载地址不受信任。');
        const response = await fetchImpl(current, { redirect: 'manual', signal: controller.signal, headers: { Accept: parsed.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'Stread-Updater' } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location'); if (!location) fail('更新下载重定向无效。');
          await response.body?.cancel?.(); current = new URL(location, current).href; continue;
        }
        if (!response.ok) { const error = new Error('无法获取 GitHub 更新（HTTP ' + response.status + '）。'); error.status = response.status; throw error; }
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > limit) fail('更新下载超过大小限制。');
        const chunks = []; let bytes = 0;
        if (!response.body) fail('更新下载为空。');
        for await (const chunk of response.body) {
          bytes += chunk.length; if (bytes > limit) { controller.abort(); fail('更新下载超过大小限制。'); }
          chunks.push(Buffer.from(chunk)); if (progress) set({ receivedBytes: bytes });
        }
        return Buffer.concat(chunks);
      }
      fail('更新下载重定向过多。');
    } finally { clearTimeout(timer); }
  }
  async function action(task) {
    if (busy) fail('更新操作正在进行，请稍候。');
    busy = true;
    try { return await task(); }
    catch (error) { set({ state: 'error', error: error.message }); throw error; }
    finally { busy = false; }
  }
  async function check() {
    return action(async () => {
      set({ state: 'checking', error: '', availableVersion: undefined, bytes: 0, receivedBytes: 0 }); checked = undefined;
      if (platform !== config.platform || arch !== config.arch) return set({ state: 'full-update-required', error: '当前平台需要完整安装包。' });
      let release;
      try { release = JSON.parse((await fetchBytes('https://api.github.com/repos/' + config.repository + '/releases/latest', config.limits.manifest)).toString('utf8')); }
      catch (error) { if (error.status === 404) return set({ state: 'idle', checkedAt: Date.now() }); throw error; }
      if (!plainObject(release) || release.draft !== false || release.prerelease !== false || !release.published_at || typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) fail('GitHub 发布信息无效。');
      const releaseVersion = version(release.tag_name.slice(1));
      if (compareVersion(releaseVersion, selected.version) <= 0) return set({ state: 'idle', checkedAt: Date.now() });
      const releaseUrl = RELEASES + '/tag/' + release.tag_name;
      if (!Array.isArray(release.assets) || !release.assets.some((asset) => asset.name === config.manifestName)) return set({ state: 'full-update-required', availableVersion: releaseVersion, releaseUrl, checkedAt: Date.now() });
      const assetRoot = RELEASES + '/download/' + release.tag_name + '/';
      const envelope = JSON.parse((await fetchBytes(assetRoot + config.manifestName, config.limits.manifest)).toString('utf8'));
      const manifest = verifyEnvelope(envelope, key);
      if (manifest.version !== releaseVersion) fail('更新签名版本与 GitHub 发布版本不一致。');
      if (manifest.foundation !== base.foundation) return set({ state: 'full-update-required', availableVersion: releaseVersion, releaseUrl: RELEASES + '/tag/v' + manifest.installerVersion, checkedAt: Date.now() });
      const descriptor = manifest.delta?.from === selected.id ? manifest.delta : manifest.payload;
      checked = { envelope, manifest, assetRoot, descriptor };
      let stateName = 'available';
      const state = loadState();
      if (state.downloaded === manifest.id) {
        try { candidate(manifest.id); downloaded = manifest.id; stateName = 'downloaded'; }
        catch { state.downloaded = null; downloaded = undefined; saveState(state); }
      }
      return set({ state: stateName, availableVersion: manifest.version, bytes: descriptor.bytes, releaseUrl, incremental: descriptor === manifest.delta, checkedAt: Date.now() });
    });
  }
  async function copyFoundation(stage) {
    for (const name of ['node_modules', 'python']) {
      const source = path.join(resourcesPath, 'runtime', name), destination = path.join(stage, 'runtime', name);
      if (fs.lstatSync(source).isSymbolicLink()) fail('底层运行时不能是符号链接。');
      await fsp.cp(source, destination, { recursive: true, errorOnExist: true, force: false, filter(file) {
        const relative = path.relative(source, file);
        if (/(^|[\\/])(?:__pycache__|\.bin)([\\/]|$)/.test(relative) || /\.pyc$/i.test(relative)) return false;
        if (fs.lstatSync(file).isSymbolicLink()) fail('底层运行时不能包含符号链接。');
        return true;
      } });
    }
  }
  async function download() {
    return action(async () => {
      if (!checked) fail('请先检查可用更新。');
      const { manifest, envelope, assetRoot, descriptor } = checked;
      set({ state: 'downloading', error: '', bytes: descriptor.bytes, receivedBytes: 0 });
      const compressed = await fetchBytes(assetRoot + descriptor.name, descriptor.bytes, true);
      if (compressed.length !== descriptor.bytes || sha(compressed) !== descriptor.sha256) fail('更新下载校验失败。');
      const contents = JSON.parse(gunzipSync(compressed, { maxOutputLength: config.limits.expanded }).toString('utf8'));
      if (!plainObject(contents) || contents.schema !== config.schema || !Array.isArray(contents.files) || contents.files.length > config.limits.files) fail('更新包格式无效。');
      const required = new Map(manifest.files.map((file) => [file.path, file])), supplied = new Map();
      for (const entry of contents.files) {
        if (!plainObject(entry)) fail('更新包文件无效。');
        const name = validatePath(entry.path), file = required.get(name);
        if (!file || supplied.has(name) || typeof entry.data !== 'string' || entry.data.length > Math.ceil(config.limits.file / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.data)) fail('更新包含有未知、重复或无效文件。');
        const bytes = Buffer.from(entry.data, 'base64');
        if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) fail('更新包文件校验失败：' + name);
        supplied.set(name, bytes);
      }
      if (descriptor === manifest.payload && supplied.size !== required.size) fail('完整程序更新包缺少文件。');
      const stage = checkedPath(root, '.stage-' + randomUUID(), true); await fsp.mkdir(stage);
      try {
        for (const file of manifest.files) {
          let bytes = supplied.get(file.path);
          if (!bytes) {
            const old = selected.files.find((item) => item.path === file.path);
            if (!old || old.sha256 !== file.sha256 || old.bytes !== file.bytes) fail('差分更新缺少修改文件：' + file.path);
            const sourceRoot = file.path.startsWith('app/') ? selected.appRoot : selected.runtime;
            bytes = fileBytes(sourceRoot, file.path.slice(file.path.indexOf('/') + 1), file);
          }
          const destination = checkedPath(stage, file.path, true); await fsp.mkdir(path.dirname(destination), { recursive: true });
          await fsp.writeFile(destination, bytes, { flag: 'wx' });
        }
        await copyFoundation(stage); verifyFoundation(stage);
        for (const file of manifest.files) fileBytes(stage, file.path, file);
        atomicJson(stage, 'update.json', envelope);
        const destination = checkedPath(root, 'releases/' + manifest.id, true);
        if (exists(destination)) {
          try { candidate(manifest.id); }
          catch (error) {
            const state = loadState();
            if ([state.active, state.previous, state.pending, selected.id].includes(manifest.id)) throw error;
            const quarantine = checkedPath(root, '.corrupt-' + manifest.id + '-' + randomUUID(), true);
            await fsp.rename(destination, quarantine);
            await fsp.rename(stage, destination);
          }
        } else await fsp.rename(stage, destination);
        downloaded = manifest.id;
        const state = loadState(); state.downloaded = downloaded; saveState(state);
        return set({ state: 'downloaded', receivedBytes: descriptor.bytes });
      } finally {
        if (exists(stage)) await fsp.rm(checkedPath(root, path.basename(stage)), { recursive: true, force: true });
      }
    });
  }
  function activate() {
    if (busy || !downloaded) fail('请先完成更新下载。');
    const next = candidate(downloaded), state = loadState();
    if (compareVersion(next.version, selected.version) <= 0) fail('更新版本必须高于当前版本。');
    state.pending = downloaded; state.downloaded = null; saveState(state);
    return set({ state: 'restart-required' });
  }
  function markHealthy() {
    if (!stateUsable) return;
    const state = loadState();
    if (state.trial?.id === selected.id && state.trial.pid === process.pid) {
      state.trial = null; if (state.downloaded === selected.id) state.downloaded = null; saveState(state); set({ trial: false });
      const keep = new Set([state.active, state.previous, state.pending, downloaded].filter(Boolean));
      for (const name of fs.readdirSync(releases)) if (HASH.test(name) && !keep.has(name)) {
        try { const old = checkedPath(root, 'releases/' + name); fs.rmSync(old, { recursive: true, force: true }); } catch { /* A previous MCP process can still hold files; a future healthy start can retry. */ }
      }
    }
  }
  function markFailed() {
    if (!stateUsable) return;
    const state = loadState();
    if (state.trial?.id === selected.id && state.trial.pid === process.pid) { fallback(state); saveState(state); set({ trial: false }); }
  }
  return { status, check, download, activate, markHealthy, markFailed, select };
}

module.exports = { createUpdater, validateManifest, verifyEnvelope, validatePath, validateFiles, compareVersion, config, sha };
