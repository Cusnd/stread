import { isAbsolute, relative, resolve } from 'node:path';

export const RESTART_EXIT_CODE = 75;

export function parseDevArguments(args, root) {
  let profile;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--reader-user-data') profile = args[++index];
    else if (argument.startsWith('--reader-user-data=')) profile = argument.slice('--reader-user-data='.length);
    else throw new Error('Usage: node electron/dev.mjs [--reader-user-data=<directory>]');
    if (!profile || profile.startsWith('--')) throw new Error('--reader-user-data requires a directory');
  }
  return profile ? ['--reader-user-data=' + resolve(root, profile)] : [];
}

export function isRestartSource(root, file) {
  const path = relative(root, file);
  if (!path || isAbsolute(path) || path === '..' || path.startsWith('..\\') || path.startsWith('../')) return false;
  const normalized = path.replaceAll('\\', '/');
  if (/^electron\/[^/]+\.cjs$/i.test(normalized)) return true;
  if (/^prototypes\/insight-composer\/scripts\/[^/]+\.mjs$/i.test(normalized)) return true;
  // These frontend modules are also imported by the workspace compiler. Their
  // renderer HMR alone would otherwise leave the backend's ESM cache stale.
  if (/^prototypes\/insight-composer\/src\/(?:html-content|document-content|reading-language|attention-example|conversion-request|reader-navigation)\.js$/i.test(normalized)) return true;
  if (!/^services\/workspace\//.test(normalized)) return false;
  if (normalized.split('/').some((part) => ['node_modules', '.data', 'data', '__pycache__', '.git', 'tests'].includes(part))) return false;
  return /\.(?:mjs|py|json|md)$/i.test(normalized);
}

// The launcher never terminates Electron. Only an acknowledged application exit
// can release its workspace and authorize a replacement process.
export function createDevController({ spawnElectron, createWatchers = () => [], closeServer, log = console.log, timers = globalThis, debounceMs = 300 }) {
  let child;
  let watchers = [];
  let pending;
  let debounce;
  let stopping = false;
  let finished = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const clearDebounce = () => { if (debounce !== undefined) timers.clearTimeout(debounce); debounce = undefined; };

  async function finish(code) {
    if (finished) return;
    finished = true;
    clearDebounce();
    for (const watcher of watchers) {
      try { watcher.close(); }
      catch (error) { log('文件监听清理失败：' + error.message); code ||= 1; }
    }
    try { await closeServer(); }
    catch (error) { log('开发服务清理失败：' + error.message); code ||= 1; }
    resolveDone(code);
  }

  function send(type) {
    const current = child;
    if (!current || finished) return false;
    if (!current.connected) {
      log('开发窗口的控制连接已断开；请从窗口正常关闭，启动器不会强制退出程序。');
      return false;
    }
    pending = type;
    try {
      current.send({ type: 'reader-dev:' + type }, (error) => {
        if (!error || child !== current || finished || pending !== type) return;
        pending = undefined;
        if (type === 'stop') stopping = false;
        log('无法请求安全' + (type === 'stop' ? '关闭' : '重启') + '：' + error.message + '。请从窗口正常关闭。');
      });
      return true;
    } catch (error) {
      pending = undefined;
      if (type === 'stop') stopping = false;
      log('无法请求安全关闭或重启：' + error.message + '。请从窗口正常关闭。');
      return false;
    }
  }

  function sourceChanged(file) {
    if (finished || stopping || pending) return;
    if (file) log('检测到源码内容变化：' + file);
    clearDebounce();
    debounce = timers.setTimeout(() => {
      debounce = undefined;
      if (!finished && !stopping && !pending && send('restart')) log('主进程或服务代码已更新，等待保存并安全重启…');
    }, debounceMs);
  }

  function requestStop() {
    if (finished || stopping) return;
    clearDebounce();
    stopping = true;
    if (!child) { void finish(0); return; }
    if (send('stop')) log('等待开发窗口保存并关闭…');
    else stopping = false;
  }

  function launch() {
    if (finished) return;
    clearDebounce();
    pending = undefined;
    let current;
    try { current = spawnElectron(); }
    catch (error) { log('开发窗口启动失败：' + error.message); void finish(1); return; }
    child = current;
    current.on('message', (message) => {
      if (child !== current || finished) return;
      const cancelled = message?.type === 'reader-dev:restart-cancelled' ? 'restart' : message?.type === 'reader-dev:stop-cancelled' ? 'stop' : undefined;
      // Main ignores a second request while its first save dialog is open.
      // If stop arrived during restart and that original request is cancelled,
      // retry the outstanding stop now that main has released its close lock.
      if (cancelled === 'restart' && pending === 'stop' && stopping) {
        pending = undefined;
        if (!send('stop')) stopping = false;
        return;
      }
      if (!cancelled || pending !== cancelled) return;
      pending = undefined;
      if (cancelled === 'stop') stopping = false;
      clearDebounce();
      log('已取消' + (cancelled === 'stop' ? '关闭' : '重启') + '，继续保留当前窗口。' + (message.reason ? ' ' + message.reason : ''));
    });
    current.on('error', (error) => {
      if (child !== current || finished) return;
      log('开发窗口进程错误：' + error.message);
      // Spawn failure has no process to save. Runtime/IPC errors must not kill
      // a process that already owns the workspace.
      if (!current.pid) { child = undefined; void finish(1); }
    });
    current.once('exit', (code, signal) => {
      if (child !== current || finished) return;
      child = undefined;
      const restart = code === RESTART_EXIT_CODE && pending === 'restart' && !stopping;
      pending = undefined;
      if (restart) { log('已保存，正在重启开发窗口…'); launch(); }
      else {
        if (signal) log('开发窗口已退出：' + signal);
        void finish(code === RESTART_EXIT_CODE && stopping ? 0 : code ?? 1);
      }
    });
  }

  function start() {
    try {
      watchers = createWatchers(sourceChanged, (error) => { log('开发文件监听失败：' + error.message); requestStop(); });
    } catch (error) { log('无法监听开发文件：' + error.message); void finish(1); return done; }
    launch();
    return done;
  }
  return { start, requestStop, sourceChanged, done };
}
