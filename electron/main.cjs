const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, session, shell, screen, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { migrateWorkspace } = require('./workspace-migration.cjs');
const { developmentOptions, isBackendRequest, developmentContentPolicy } = require('./development.cjs');

app.setName('Continuous Reader');
app.setAppUserModelId('com.continuousreader.desktop');
const option = (name) => process.argv.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1);
let development, startupError;
try {
  development = developmentOptions({ packaged: app.isPackaged, args: process.argv, projectRoot: path.resolve(__dirname, '..') });
}
catch (error) { startupError = error; }
const profileDir = option('--reader-user-data') ? path.resolve(option('--reader-user-data')) : path.join(app.getPath('home'), '.continuous-reader');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
protocol.registerSchemesAsPrivileged([{ scheme: 'reader', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const mcpMode = process.argv.includes('--mcp');
if (mcpMode) {
  // Each pipe client gets disposable Chromium state; sharing the running UI's
  // cache causes Windows file-lock errors even though MCP never opens a window.
  const temporaryRoot = path.resolve(require('node:os').tmpdir());
  const temporarySession = fs.mkdtempSync(path.join(temporaryRoot, 'continuous-reader-mcp-'));
  app.setPath('sessionData', temporarySession);
  app.disableHardwareAcceleration();
  app.once('quit', () => {
    if (path.dirname(temporarySession) !== temporaryRoot || !path.basename(temporarySession).startsWith('continuous-reader-mcp-')) return;
    try { fs.rmSync(temporarySession, { recursive: true, force: true }); } catch { /* Chromium may still hold a cache handle at exit. */ }
  });
}
const ownsInstance = !mcpMode && (app.readerOwnsInstance ?? app.requestSingleInstanceLock());
const updater = app.isPackaged && !development ? app.readerUpdater : undefined;
const updateRepository = updater?.status().repository;
const nativeTitleBarOverlay = process.platform === 'win32';
const initialTitlebarHeight = 56;
let titlebarHeight = initialTitlebarHeight;
let mainWindow, backend, baseUrl, closing = false, stopped = false, ready = false, requestedDevAction;
let rendererReady;
const pendingClose = new Map();
const userData = app.getPath('userData');
const runtime = app.readerRuntime || (app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.resolve(__dirname, '../.desktop/runtime'));
const windowIcon = path.join(app.isPackaged ? process.resourcesPath : __dirname, 'assets', process.platform === 'win32' ? 'continuous-reader.ico' : 'continuous-reader.png');
const dataDir = path.join(userData, 'workspace');
const stateFile = path.join(userData, 'desktop-state.json');
const sessionFile = path.join(userData, 'reader-session.json');
const connectionFile = path.join(userData, 'connection.json');
const readJson = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, file);
}
function log(message) { fs.mkdirSync(userData, { recursive: true }); fs.appendFileSync(path.join(userData, 'desktop.log'), new Date().toISOString() + ' ' + message + '\n'); }
const internal = (value) => { try { const url = new URL(value); return url.protocol === 'reader:' && url.host === 'app'; } catch { return false; } };
const trusted = (event) => mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame && internal(event.senderFrame.url);
function sessionValue(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 12 * 1024 * 1024) throw new Error('Invalid session');
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => /^(reader-|continuous-reader|collection-|flow-)/.test(key) && typeof value === 'string'));
}
function installIpc() {
  ipcMain.on('reader:ready', (event) => { if (trusted(event) && !closing) rendererReady?.(); });
  ipcMain.handle('reader:update', async (event, action) => {
    if (!trusted(event) || !updater) throw new Error('更新操作不可用。');
    if (!['status', 'check', 'download', 'restart', 'open-release'].includes(action)) throw new Error('未知的更新操作。');
    if (action === 'status') return updater.status();
    if (closing) throw new Error('程序正在退出，请稍后重试。');
    if (action === 'restart') {
      if (!['downloaded', 'restart-required'].includes(updater.status().state)) throw new Error('请先完成更新下载。');
      await closeWindow('update');
    } else if (action === 'open-release') {
      if (typeof updateRepository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(updateRepository)) throw new Error('更新页面地址无效。');
      const releasePath = '/' + updateRepository + '/releases';
      const target = new URL(updater.status().releaseUrl || 'https://github.com' + releasePath);
      const allowedPath = target.pathname === releasePath || target.pathname === releasePath + '/' ||
        (target.pathname.startsWith(releasePath) && /^\/tag\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\/?$/.test(target.pathname.slice(releasePath.length)));
      if (target.origin !== 'https://github.com' || target.username || target.password || target.search || target.hash || !allowedPath) throw new Error('更新页面地址无效。');
      await shell.openExternal(target.href);
    } else await updater[action]();
    return updater.status();
  });
  ipcMain.on('reader:titlebar-height', (event, value) => {
    if (!nativeTitleBarOverlay || !trusted(event) || mainWindow.isDestroyed() || !Number.isFinite(value)) return;
    const height = Math.max(32, Math.min(120, Math.round(value)));
    if (height === titlebarHeight) return;
    try { mainWindow.setTitleBarOverlay({ height }); titlebarHeight = height; }
    catch (error) { log('Titlebar geometry: ' + error.message); }
  });
  ipcMain.on('reader:session-read', (event) => { event.returnValue = trusted(event) ? readJson(sessionFile) : {}; });
  ipcMain.on('reader:session-write', (event, value) => { if (trusted(event)) try { writeJson(sessionFile, sessionValue(value)); } catch (error) { log('Session persistence: ' + error.message); } });
  ipcMain.on('reader:session-write-sync', (event, value) => {
    try { if (!trusted(event)) throw new Error('Untrusted sender'); writeJson(sessionFile, sessionValue(value)); event.returnValue = { ok: true }; }
    catch (error) { log('Session persistence: ' + error.message); event.returnValue = { error: error.message }; }
  });
  ipcMain.on('reader:close-ready', (event, value) => {
    if (trusted(event) && pendingClose.has(value?.id)) { pendingClose.get(value.id)(value.error); pendingClose.delete(value.id); }
  });
}
async function startBackend() {
  const token = randomBytes(32).toString('base64url');
  backend = utilityProcess.fork(path.join(__dirname, 'backend.cjs'), [], { cwd: runtime, stdio: 'pipe', serviceName: 'Continuous Reader Workspace' });
  backend.stdout.on('data', (chunk) => log(chunk.toString().trim()));
  backend.stderr.on('data', (chunk) => log(chunk.toString().trim()));
  backend.on('exit', (code) => {
    log('Backend exit ' + code); stopped = true;
    if (ready && !closing) dialog.showMessageBox(mainWindow, { type: 'error', title: 'Continuous Reader', message: '本地资料服务已停止。', detail: '草稿会保留在本机。请关闭程序后重新打开。', buttons: ['知道了'] });
  });
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('本地资料服务启动超时。')), 60000);
    backend.once('exit', (code) => { clearTimeout(timer); reject(new Error('本地资料服务启动失败：' + code)); });
    backend.on('message', (message) => {
      if (message.type === 'ready') { clearTimeout(timer); resolve(message); }
      if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.message)); }
    });
    backend.postMessage({ type: 'start', runtime, dataDir, token, ...(development ? { sourceRoot: development.root } : {}) });
  });
  baseUrl = 'http://127.0.0.1:' + info.port;
  if (!(await fetch(baseUrl + '/health')).ok) throw new Error('本地资料服务检查失败。');
  writeJson(connectionFile, { url: baseUrl, mcpUrl: baseUrl + '/mcp', token, pid: process.pid, version: updater?.status().version || app.getVersion(), backend: 'local', ...(development ? { development: true } : {}) });
  log('Ready; Electron ' + process.versions.electron + '; Node ' + info.node + '; backend local; workspace ' + dataDir);
  if (development) log('Development preview; source ' + development.root + '; frontend ' + development.origin);
  protocol.handle('reader', async (request) => {
    if (!internal(request.url)) return new Response('Not found', { status: 404 });
    const url = new URL(request.url), headers = new Headers(request.headers);
    headers.delete('host'); headers.delete('origin'); headers.delete('referer'); headers.delete('cookie');
    const fromDevelopmentServer = development && !isBackendRequest(url.pathname);
    if (fromDevelopmentServer) headers.delete('authorization');
    else headers.set('Authorization', 'Bearer ' + token);
    const init = { method: request.method, headers, redirect: 'error' };
    if (!['GET', 'HEAD'].includes(request.method)) init.body = Buffer.from(await request.arrayBuffer());
    try {
      const response = await fetch((fromDevelopmentServer ? development.origin : baseUrl) + url.pathname + url.search, init);
      const resultHeaders = new Headers(response.headers);
      resultHeaders.delete('content-encoding'); resultHeaders.delete('transfer-encoding');
      if (fromDevelopmentServer) {
        resultHeaders.set('Cache-Control', 'no-store');
        if ((resultHeaders.get('content-type') || '').startsWith('text/html')) resultHeaders.set('Content-Security-Policy', developmentContentPolicy(development));
      }
      if ((resultHeaders.get('content-type') || '').startsWith('text/html') && !resultHeaders.has('Content-Security-Policy')) resultHeaders.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      return new Response(response.body, { status: response.status, headers: resultHeaders });
    } catch (error) { log('Request failed: ' + error.message); return new Response(JSON.stringify({ error: '本地资料服务暂不可用。', code: 'SERVICE_UNAVAILABLE' }), { status: 503, headers: { 'Content-Type': 'application/json' } }); }
  });
}
function external(url) { try { if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url); } catch {} }
async function closeWindow(devAction) {
  if (closing || !mainWindow) return;
  closing = true;
  const id = randomUUID();
  let failure;
  failure = await new Promise((resolve) => {
    const timer = setTimeout(() => { pendingClose.delete(id); resolve('保存确认超时。'); }, 20000);
    pendingClose.set(id, (error) => { clearTimeout(timer); resolve(error); });
    mainWindow.webContents.send('reader:prepare-close', id);
  });
  if (failure) {
    const result = await dialog.showMessageBox(mainWindow, { type: 'warning', title: '保存尚未完成', message: failure, detail: '未保存的草稿保留在本机；阅读位置的服务器保存可能尚未完成。', buttons: ['继续使用', ['restart', 'update'].includes(devAction) ? '仍然重启' : '仍然退出'], defaultId: 0, cancelId: 0 });
    if (result.response === 0) {
      closing = false;
      if (development && devAction) { requestedDevAction = undefined; process.send?.({ type: 'reader-dev:' + devAction + '-cancelled', reason: failure }); }
      return;
    }
  }
  const bounds = mainWindow.getNormalBounds();
  try { writeJson(stateFile, { bounds, maximized: mainWindow.isMaximized(), ...(development && internal(mainWindow.webContents.getURL()) ? { devLastUrl: mainWindow.webContents.getURL() } : {}) }); } catch (error) { log('Window state: ' + error.message); }
  try { session.defaultSession.flushStorageData(); } catch (error) { log('Browser storage flush: ' + error.message); }
  mainWindow.destroy(); mainWindow = null;
  await stopBackend();
  if (devAction === 'update') {
    try {
      await updater.activate();
      const portable = process.env.PORTABLE_EXECUTABLE_FILE;
      app.relaunch({ args: process.argv.slice(1), ...(portable && path.isAbsolute(portable) ? { execPath: portable } : {}) });
    } catch (error) {
      log('Update restart failed: ' + error.message);
      dialog.showErrorBox('更新未能重启', error.message + '\n\n请重新打开 Continuous Reader。');
    }
    app.quit();
  } else if (development && devAction === 'restart') app.exit(75);
  else app.quit();
}
async function stopBackend() {
  if (backend && !stopped) await new Promise((resolve) => {
    const timer = setTimeout(() => { backend.kill(); resolve(); }, 5000);
    backend.once('exit', () => { clearTimeout(timer); resolve(); }); backend.postMessage({ type: 'stop' });
  });
  try { fs.unlinkSync(connectionFile); } catch {}
}
async function createWindow() {
  const saved = readJson(stateFile), area = screen.getPrimaryDisplay().workArea;
  const bounds = saved.bounds && screen.getAllDisplays().some((display) => {
    const a = display.workArea, b = saved.bounds; return b.x + 100 < a.x + a.width && b.y + 100 < a.y + a.height && b.x + b.width > a.x + 100 && b.y + b.height > a.y + 100;
  }) ? saved.bounds : { width: Math.min(1440, area.width), height: Math.min(960, area.height) };
  mainWindow = new BrowserWindow({ ...bounds, minWidth: 900, minHeight: 600, show: false, backgroundColor: '#ffffff', title: 'Continuous Reader', icon: windowIcon, autoHideMenuBar: true,
    ...(nativeTitleBarOverlay ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#ffffff', symbolColor: '#292b2c', height: initialTitlebarHeight } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false,
      ...(development || updater ? { additionalArguments: [...(development ? ['--reader-development'] : []), ...(updater ? ['--reader-updates'] : [])] } : {}) } });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (internal(url)) {
      const child = new BrowserWindow({ width: 1100, height: 800, icon: windowIcon, autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
      child.webContents.setWindowOpenHandler(({ url: target }) => { external(target); return { action: 'deny' }; });
      child.webContents.on('will-navigate', (event, target) => { if (!internal(target)) { event.preventDefault(); external(target); } });
      void child.loadURL(url);
    } else external(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!internal(url)) { event.preventDefault(); external(url); } });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', (_event, detail) => { log('Renderer exit ' + detail.reason); });
  mainWindow.webContents.on('did-fail-load', (_event, code, message) => log('Page load failed ' + code + ': ' + message));
  mainWindow.webContents.on('preload-error', (_event, _path, error) => log('Preload failed: ' + error.message));
  mainWindow.webContents.on('did-finish-load', () => log('Page loaded'));
  mainWindow.on('close', (event) => { event.preventDefault(); if (!closing) void closeWindow(); });
  mainWindow.once('ready-to-show', () => { if (saved.maximized) mainWindow.maximize(); mainWindow.show(); });
  const openingUrl = development && internal(saved.devLastUrl) ? saved.devLastUrl : 'reader://app/?view=collection';
  let readinessTimer;
  const readiness = updater?.status().trial ? new Promise((resolve, reject) => {
    rendererReady = resolve;
    readinessTimer = setTimeout(() => reject(new Error('程序界面未能完成启动。')), 30000);
  }) : Promise.resolve();
  try { await Promise.all([mainWindow.loadURL(openingUrl), readiness]); }
  finally { clearTimeout(readinessTimer); rendererReady = undefined; }
  ready = true; mainWindow.show();
  if (development) {
    process.send?.({ type: 'reader-dev:ready' });
    if (requestedDevAction) void closeWindow(requestedDevAction);
  }
}
if (mcpMode) app.whenReady().then(() => require('./mcp.cjs').startMcp({ runtime, userData, app })).catch(() => {
  process.stderr.write('Continuous Reader MCP could not start. Reopen the desktop app and reconnect.\n');
  app.exit(1);
});
else if (!ownsInstance) {
  if (development) process.stderr.write('Continuous Reader 已在运行。请先正常关闭当前窗口，再执行 npm run desktop:dev。\n');
  app.quit();
}
else {
  if (development && typeof process.on === 'function') process.on('message', (message) => {
    if (!['reader-dev:restart', 'reader-dev:stop'].includes(message?.type) || closing) return;
    requestedDevAction = message.type === 'reader-dev:restart' ? 'restart' : 'stop';
    if (ready && mainWindow) void closeWindow(requestedDevAction);
  });
  app.on('second-instance', () => { if (mainWindow?.isMinimized()) mainWindow.restore(); mainWindow?.focus(); });
  app.on('before-quit', (event) => { if (mainWindow) { event.preventDefault(); if (!closing) void closeWindow(); } });
  app.on('window-all-closed', () => { if (!closing) { closing = true; void stopBackend().then(() => app.quit()); } });
  app.whenReady().then(async () => {
    if (startupError) throw startupError;
    installIpc();
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(contents === mainWindow?.webContents && internal(contents.getURL()) && permission === 'clipboard-sanitized-write'));
    session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === mainWindow?.webContents && internal(contents.getURL()) && permission === 'clipboard-sanitized-write');
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '文件', submenu: [{ label: '打开数据目录', click: () => shell.openPath(dataDir) }, { type: 'separator' }, { label: '退出', accelerator: 'Alt+F4', click: () => void closeWindow() }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'togglefullscreen' }] },
    ]));
    const source = option('--import-workspace');
    if (source) log('Migration ' + JSON.stringify(await migrateWorkspace(path.resolve(source), dataDir)));
    await startBackend(); await createWindow(); await updater?.markHealthy();
  }).catch(async (error) => {
    try { await updater?.markFailed(); } catch (failure) { log('Update recovery: ' + failure.message); }
    log(error.stack || String(error)); dialog.showErrorBox('Continuous Reader 无法启动', error.message + '\n\n日志：' + path.join(userData, 'desktop.log')); closing = true; mainWindow?.destroy(); mainWindow = null; await stopBackend(); app.quit();
  });
}
