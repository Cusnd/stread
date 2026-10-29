'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

const DIRECT_DEPENDENCIES = {
  '@modelcontextprotocol/server': '@modelcontextprotocol/server',
  '@modelcontextprotocol/client': '@modelcontextprotocol/client',
  '@modelcontextprotocol/node': '@modelcontextprotocol/node',
  zod: 'zod', parse5: 'parse5', katex: 'katex', 'css-tree': 'css-tree',
};
const REQUIRED_FILES = [
  'package.json', 'services/workspace/server.mjs', 'services/workspace/service.mjs',
  'services/workspace/mcp.mjs', 'services/workspace/stdio.mjs',
  'services/workspace/pdf.py', 'services/workspace/pdf_regions.py',
  'services/workspace/authoring-guide.md', 'services/workspace/authoring-schema.json',
  'services/workspace/authoring-minimal-example.json', 'services/workspace/authoring-format-reference.md', 'services/workspace/conversion-workflow.md',
  'services/workspace/authoring-examples/index.md',
  'services/workspace/file-access.md', 'services/workspace/authoring-example.json',
  ...['manifest.json', 'image-text.json', 'multi-figure.json', 'steps-notes.json', 'definition-explanation.json', 'grouped-table.json', 'layout-examples.zip', 'images/scattered.png', 'images/paired.png', 'images/grouped.png'].map((file) => 'services/workspace/authoring-examples/' + file),
  'client/index.html', 'client/articles/attention-is-all-you-need/source.pdf',
  'client/articles/attention-is-all-you-need/document.json',
  'prototypes/insight-composer/scripts/compile-authoring.mjs',
  'prototypes/insight-composer/scripts/authoring-validation.mjs',
  'prototypes/insight-composer/scripts/authoring-compiler.mjs',
  'prototypes/insight-composer/src/html-content.js',
  ...['reading-language.js', 'document-content.js', 'attention-example.js', 'conversion-request.js', 'reader-navigation.js'].map((file) => 'prototypes/insight-composer/src/' + file),
  'spec/Agent转换约定.md', 'spec/文档格式.md',
  'spec/转换质量反馈.md', 'spec/辅助阅读导航.md',
  ...['自定义HTML内容块.md', '双语对照.md', '统一样式.md', '内容模块与布局.md'].map((file) => 'spec/' + file),
  'python/python.exe', 'python/python3.dll', 'python/LICENSE.txt',
  'python/Lib/site-packages/fitz/__init__.py',
  'python/Lib/site-packages/pymupdf/__init__.py',
  'python/Lib/site-packages/pymupdf/_mupdf.pyd',
  'python/Lib/site-packages/pymupdf/_extra.pyd',
  'python/Lib/site-packages/pymupdf/mupdfcpp64.dll',
  'python/continuous-reader-runtime.json',
];
const REQUIRED_APP_FILES = ['electron/main.cjs', 'electron/preload.cjs', 'electron/backend.cjs', 'electron/mcp.cjs', 'electron/workspace-migration.cjs', 'electron/development.cjs', 'package.json',
  'electron/bootstrap.cjs', 'electron/update-core.cjs', 'electron/update-config.cjs', 'electron/update-public-key.pem'];
const slash = (value) => value.replaceAll('\\', '/');
const excluded = (value) => /(^|\/)(?:\.bin|__pycache__)(\/|$)/.test(slash(value)) || /\.pyc$/i.test(value);
const within = (root, target) => { const relative = path.relative(root, target); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
function fail(message) { throw new Error('Desktop package verification failed: ' + message); }
function assertNoPrivateData(relative) {
  const name = slash(relative);
  if (/(^|\/)(?:\.data|user-data|userdata|\.git)(\/|$)/i.test(name)
    || /(?:\.sqlite(?:3)?|\.db)(?:-wal|-shm)?$/i.test(name)
    || /(^|\/)(?:connection\.json|reader-session\.json|desktop-state\.json|desktop\.log|\.env(?:\.[^/]+)?)$/i.test(name)) {
    fail('private workspace/profile data is present: ' + name);
  }
}

async function requiredFile(root, relative, allowEmpty = false) {
  const file = path.resolve(root, relative);
  if (!within(root, file)) fail('path escapes the packaged runtime: ' + relative);
  let info, actual;
  try { info = await fs.stat(file); actual = await fs.realpath(file); }
  catch { fail('required file is missing: ' + slash(relative)); }
  if (!info.isFile() || (!allowEmpty && info.size === 0)) fail('required file is empty or invalid: ' + slash(relative));
  if (!within(root, actual)) fail('required file resolves outside the package: ' + slash(relative));
  return info;
}

async function inventory(root) {
  const files = new Map();
  async function visit(relative = '') {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = relative ? relative + '/' + item.name : item.name;
      assertNoPrivateData(next);
      if (/^(?:services\/agent-host|node_modules\/@agentclientprotocol|node_modules\/@openai\/codex(?:-[^/]+)?)(?:\/|$)/.test(next)) fail('retired Agent runtime must not be shipped: ' + next);
      if (next.startsWith('python/Lib/site-packages/pymupdf/mupdf-devel/')) fail('MuPDF build-only files must not be shipped: ' + next);
      if (/^python\/Lib\/site-packages\/(?:bin|Scripts)(?:\/|$)/i.test(next) || /^python\/Lib\/site-packages\/[^/]+\.dist-info\/direct_url\.json$/i.test(next)) fail('host-specific Python installation metadata must not be shipped: ' + next);
      if (excluded(next)) continue;
      if (item.isSymbolicLink()) fail('unexpected symbolic link in runtime: ' + next);
      if (item.isDirectory()) await visit(next);
      else if (item.isFile()) files.set(next, (await fs.stat(path.join(root, next))).size);
      else fail('unsupported runtime entry: ' + next);
    }
  }
  await visit();
  return files;
}

async function verifyRuntime({ runtime, stagedRuntime }) {
  try { runtime = await fs.realpath(runtime); }
  catch { fail('packaged runtime directory is missing'); }
  for (const file of REQUIRED_FILES) await requiredFile(runtime, file);
  const manifest = JSON.parse(await fs.readFile(path.join(runtime, 'package.json'), 'utf8'));
  const dependencies = Object.keys(DIRECT_DEPENDENCIES);
  if (JSON.stringify(Object.keys(manifest.dependencies || {}).sort()) !== JSON.stringify([...dependencies].sort())) fail('runtime production dependency manifest does not contain the expected ' + dependencies.length + ' dependencies');
  if (Object.values(manifest.dependencies).some((version) => !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))) fail('runtime dependencies must use pinned versions');
  const moduleRoot = path.join(runtime, 'node_modules');
  const requireFromPackage = createRequire(path.join(runtime, 'package.json'));
  const resolvedDependencies = {};
  for (const [name, specifier] of Object.entries(DIRECT_DEPENDENCIES)) {
    await requiredFile(runtime, 'node_modules/' + name + '/package.json');
    let resolved;
    try { resolved = await fs.realpath(requireFromPackage.resolve(specifier)); }
    catch { fail('packaged dependency cannot resolve: ' + name); }
    if (!within(moduleRoot, resolved)) fail('dependency resolved from the host instead of the package: ' + name);
    resolvedDependencies[name] = slash(path.relative(runtime, resolved));
  }

  const html = await fs.readFile(path.join(runtime, 'client/index.html'), 'utf8');
  const assets = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]).filter((value) => !/^(?:https?:|data:|#|\/\/)/i.test(value));
  if (!assets.some((value) => /\.js(?:\?|$)/.test(value))) fail('static client has no bundled JavaScript entry');
  for (const asset of assets) {
    const relative = 'client/' + asset.split(/[?#]/)[0].replace(/^\/+/, '');
    await requiredFile(runtime, relative);
  }
  const pthNames = (await fs.readdir(path.join(runtime, 'python'))).filter((name) => /^python\d+\._pth$/.test(name));
  if (pthNames.length !== 1) fail('exactly one isolated Python _pth file is required');
  const pythonBase = pthNames[0].slice(0, -5);
  await requiredFile(runtime, 'python/' + pythonBase + '.dll');
  await requiredFile(runtime, 'python/' + pythonBase + '.zip');
  const pth = (await fs.readFile(path.join(runtime, 'python', pthNames[0]), 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (!pth.includes('.') || !pth.includes('Lib/site-packages') || pth.some((line) => /^import\s/.test(line))) fail('Python _pth does not isolate the bundled site-packages');
  for (const entry of pth) {
    const resolved = path.resolve(runtime, 'python', entry);
    if (path.isAbsolute(entry) || !within(runtime, resolved)) fail('Python _pth references the host environment');
    try { await fs.stat(resolved); } catch { fail('Python _pth target is missing: ' + entry); }
  }
  const pythonManifest = JSON.parse(await fs.readFile(path.join(runtime, 'python/continuous-reader-runtime.json'), 'utf8'));
  if (pythonManifest.schema !== 2 || pythonManifest.payload !== 'runtime-only-v2' || !Array.isArray(pythonManifest.files) || !pythonManifest.files.length) fail('bundled Python preparation manifest is invalid');
  for (const file of pythonManifest.files) {
    if (typeof file.path !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 0) fail('bundled Python manifest entry is invalid');
    const info = await requiredFile(runtime, 'python/' + file.path, true);
    if (info.size !== file.bytes) fail('bundled Python file size differs from its verified preparation manifest: ' + file.path);
  }

  const packed = await inventory(runtime);
  if (!stagedRuntime) fail('staged production runtime is required for a complete payload comparison');
  const staged = await inventory(await fs.realpath(stagedRuntime));
  const missing = [...staged].filter(([file, bytes]) => packed.get(file) !== bytes);
  const extras = [...packed.keys()].filter((file) => !staged.has(file));
  if (missing.length || extras.length) fail('staged/packaged payload mismatch; missing or changed: ' + missing.slice(0, 8).map(([file]) => file).join(', ') + '; unexpected: ' + extras.slice(0, 8).join(', '));
  return { fileCount: packed.size, bytes: [...packed.values()].reduce((total, size) => total + size, 0), dependencies: resolvedDependencies };
}

async function afterPack(context) {
  const projectDir = context.packager.projectDir;
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const asar = require('@electron/asar');
  const archive = path.join(resources, 'app.asar');
  let appFiles;
  try { appFiles = new Set(asar.listPackage(archive).map((name) => slash(name).replace(/^\//, ''))); }
  catch { fail('application archive is missing or unreadable'); }
  for (const file of REQUIRED_APP_FILES) if (!appFiles.has(file)) fail('desktop entry is missing from app.asar: ' + file);
  await requiredFile(resources, 'update-base.json');
  const updateBase = JSON.parse(await fs.readFile(path.join(resources, 'update-base.json'), 'utf8'));
  if (updateBase.schema !== 1 || !/^[a-f0-9]{64}$/.test(updateBase.foundation) || !/^[a-f0-9]{64}$/.test(updateBase.id) || !Array.isArray(updateBase.files) || !updateBase.files.length) fail('update foundation manifest is invalid');
  const stagedBase = await fs.readFile(path.join(projectDir, '.desktop/update-base.json'));
  if (!stagedBase.equals(await fs.readFile(path.join(resources, 'update-base.json')))) fail('update foundation differs from staged manifest');
  for (const file of ['assets/continuous-reader.ico', 'assets/continuous-reader.png']) await requiredFile(resources, file);
  for (const file of appFiles) assertNoPrivateData(file);
  // Scan all external resources as well, including anything accidentally copied
  // beside runtime. The archive's entries have been checked above.
  await inventory(await fs.realpath(resources));
  const report = await verifyRuntime({ runtime: path.join(resources, 'runtime'), stagedRuntime: path.join(projectDir, '.desktop/runtime') });
  console.log('Verified desktop payload: ' + report.fileCount + ' runtime files; ' + Object.keys(report.dependencies).length + ' packaged production dependencies.');
  return report;
}

module.exports = afterPack;
module.exports.verifyRuntime = verifyRuntime;
module.exports.validatePrivatePath = assertNoPrivateData;
module.exports.requiredFiles = REQUIRED_FILES;
module.exports.directDependencies = DIRECT_DEPENDENCIES;
module.exports.requiredAppFiles = REQUIRED_APP_FILES;
