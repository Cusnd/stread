const { contextBridge, ipcRenderer } = require('electron');
const allowed = (key) => /^(reader-|continuous-reader|collection-|flow-)/.test(key);
function snapshot() {
  const value = {};
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i); if (allowed(key)) value[key] = sessionStorage.getItem(key);
  }
  return value;
}
try {
  const saved = ipcRenderer.sendSync('reader:session-read');
  for (const [key, value] of Object.entries(saved || {})) if (allowed(key) && sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
} catch {}
const callbacks = new Set();
let persistenceTimer;
function persistSession() {
  clearTimeout(persistenceTimer);
  persistenceTimer = setTimeout(() => ipcRenderer.send('reader:session-write', snapshot()), 80);
}
function persistSessionNow() {
  clearTimeout(persistenceTimer);
  const result = ipcRenderer.sendSync('reader:session-write-sync', snapshot());
  if (!result?.ok) throw new Error('本机草稿保存失败：' + (result?.error || '未知错误'));
  return { ok: true };
}
contextBridge.exposeInMainWorld('continuousReaderDesktop', {
  platform: process.platform,
  development: process.argv?.includes('--reader-development') === true,
  titleBarOverlay: process.platform === 'win32',
  ...(process.platform === 'win32' && process.argv?.includes('--reader-auto-start') ? { autoStart: {
    get: () => ipcRenderer.invoke('reader:auto-start', 'get'),
    set: (enabled) => ipcRenderer.invoke('reader:auto-start', 'set', enabled),
  } } : {}),
  ...(process.argv?.includes('--reader-updates') ? { ready: () => ipcRenderer.send('reader:ready'), updates: {
    status: () => ipcRenderer.invoke('reader:update', 'status'),
    check: () => ipcRenderer.invoke('reader:update', 'check'),
    download: () => ipcRenderer.invoke('reader:update', 'download'),
    restart: () => ipcRenderer.invoke('reader:update', 'restart'),
    openRelease: () => ipcRenderer.invoke('reader:update', 'open-release'),
  } } : {}),
  setTitlebarHeight(height) {
    if (process.platform === 'win32' && Number.isFinite(height)) ipcRenderer.send('reader:titlebar-height', height);
  },
  setTitlebarDark(dark) {
    if (process.platform === 'win32' && typeof dark === 'boolean') ipcRenderer.send('reader:titlebar-dark', dark);
  },
  persistSession,
  persistSessionNow,
  onBeforeClose(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
});
setInterval(persistSession, 1500);
window.addEventListener('beforeunload', () => ipcRenderer.sendSync('reader:session-write-sync', snapshot()));
ipcRenderer.on('reader:prepare-close', async (_event, id) => {
  let failure;
  const flushSession = persistSessionNow;
  try {
    flushSession();
    for (const callback of callbacks) await callback();
  } catch (error) { failure = error?.message || '保存未完成。'; }
  try { flushSession(); } catch (error) { failure = error.message; }
  ipcRenderer.send('reader:close-ready', { id, ...(failure ? { error: failure } : {}) });
});
