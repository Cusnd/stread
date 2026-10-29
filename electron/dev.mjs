import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, watch } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDevController, isRestartSource, parseDevArguments } from './dev-controller.mjs';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function ensurePythonRuntime(root, { check = access, run = runPreparation, log = console.log } = {}) {
  const files = ['python.exe', 'continuous-reader-runtime.json'].map((name) => join(root, '.desktop/runtime/python', name));
  try { await Promise.all(files.map((file) => check(file))); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  log('正在准备开发窗口所需的本地 PDF 运行时…');
  await run(root);
  await Promise.all(files.map((file) => check(file)));
}

function runPreparation(root) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(root, 'electron/prepare-python.mjs')], { cwd: root, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error('PDF 运行时准备失败。请运行 node electron/prepare-python.mjs 查看错误。')));
  });
}

export async function createDesktopDevServer(root) {
  const frontend = join(root, 'prototypes/insight-composer');
  const { createServer } = await import(pathToFileURL(join(frontend, 'node_modules/vite/dist/node/index.js')).href);
  const { default: projectConfig } = await import(pathToFileURL(join(frontend, 'vite.config.mjs')).href);
  let vite;
  const sockets = new Set();
  const http = createHttpServer((request, response) => {
    // API requests are authenticated and routed by Electron's reader:// handler.
    // Never revive the browser-development proxy to another workspace service.
    if (/^\/(?:api|mcp|health)(?:[/?]|$)/.test(request.url || '')) {
      response.writeHead(404); response.end('Workspace API is available through reader://app.'); return;
    }
    if (!vite) { response.writeHead(503); response.end('Starting development server'); return; }
    vite.middlewares(request, response);
  });
  http.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const closeHttp = () => {
    for (const socket of sockets) socket.destroy();
    return new Promise((done, reject) => http.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : done()));
  };
  try {
    await new Promise((ready, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', ready); });
    const port = http.address().port;
    // Prebind the shared HTTP/WebSocket server so Vite knows the actual HMR
    // port before its buildStart hook injects /@vite/client constants.
    vite = await createServer({
      ...projectConfig,
      configFile: false,
      root: frontend,
      mode: 'development',
      clearScreen: false,
      // Desktop shutdown may happen before the first browser crawl completes.
      // Release optimized imports immediately so close hooks cannot await it.
      optimizeDeps: { ...projectConfig.optimizeDeps, holdUntilCrawlEnd: false },
      server: {
        ...projectConfig.server,
        host: '127.0.0.1', port, strictPort: true, open: false,
        allowedHosts: ['127.0.0.1'], cors: false, proxy: undefined,
        middlewareMode: true,
        hmr: { protocol: 'ws', host: '127.0.0.1', clientPort: port, server: http },
        fs: { strict: true, allow: [frontend] },
      },
    });
    let closed = false;
    return {
      url: `http://127.0.0.1:${port}`,
      vite,
      async close() {
        if (closed) return;
        closed = true;
        // Middleware-mode Vite does not own this HTTP server. Release its
        // upgraded/unfinished sockets before waiting for Vite's close hooks.
        const stoppedHttp = closeHttp();
        try { await vite.close(); }
        finally { await stoppedHttp; }
      },
    };
  } catch (error) {
    const stoppedHttp = closeHttp();
    try { await vite?.close(); }
    finally { await stoppedHttp; }
    throw error;
  }
}

export function watchRestartSources(root, changed, failed, watchDirectory = watch, { timers = globalThis, debounceMs = 100 } = {}) {
  const watchers = [];
  const directories = [['electron', false], ['services/workspace', true], ['prototypes/insight-composer/scripts', false], ['prototypes/insight-composer/src', false]];
  const ignored = new Set(['node_modules', '.data', 'data', '__pycache__', '.git', 'tests']);
  const hashes = new Map(), pending = new Set();
  let timer, closed = false;
  const fingerprint = (file) => {
    try { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
    catch (error) { if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return null; throw error; }
  };
  const snapshot = (directory, recursive) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory() && recursive && !ignored.has(entry.name)) snapshot(file, true);
      else if (entry.isFile() && isRestartSource(root, file)) hashes.set(file, fingerprint(file));
    }
  };
  const checkChanges = () => {
    timer = undefined;
    if (closed) return;
    const files = [...pending]; pending.clear();
    try {
      for (const file of files) {
        const next = fingerprint(file);
        if ((hashes.get(file) ?? null) === next) continue;
        if (next === null) hashes.delete(file); else hashes.set(file, next);
        changed(relative(root, file).replaceAll('\\', '/'));
      }
    } catch (error) { failed(error); }
  };
  try {
    for (const [directory, recursive] of directories) {
      const absolute = join(root, directory);
      const watcher = watchDirectory(absolute, { recursive }, (_event, filename) => {
        if (closed || !filename) return;
        const file = join(absolute, String(filename));
        if (!isRestartSource(root, file)) return;
        // Windows also reports access-time/metadata changes. Reading or hashing
        // a source must never restart the app; compare settled bytes instead.
        pending.add(file);
        if (timer !== undefined) timers.clearTimeout(timer);
        timer = timers.setTimeout(checkChanges, debounceMs);
      });
      watcher.on('error', (error) => { if (!closed) failed(error); });
      let released = false;
      watchers.push({ close() {
        closed = true;
        if (timer !== undefined) timers.clearTimeout(timer);
        timer = undefined; pending.clear();
        if (!released) { released = true; watcher.close(); }
      } });
    }
    // Install listeners before the synchronous baseline so startup reads and
    // duplicate notifications compare against the same loaded source content.
    for (const [directory, recursive] of directories) snapshot(join(root, directory), recursive);
    return watchers;
  } catch (error) { for (const watcher of watchers) watcher.close(); throw error; }
}

async function electronExecutable(root) {
  const directory = join(root, 'node_modules/electron');
  // Reading path.txt avoids Electron's npm entrypoint downloading dependencies
  // as a side effect when a development installation is incomplete.
  const relative = (await readFile(join(directory, 'path.txt'), 'utf8')).trim();
  const executable = resolve(directory, 'dist', relative);
  await access(executable);
  return executable;
}

export async function runDesktopDevelopment({ root = repositoryRoot, args = process.argv.slice(2) } = {}) {
  const profileArgs = parseDevArguments(args, root);
  const executable = await electronExecutable(root);
  await ensurePythonRuntime(root);
  const server = await createDesktopDevServer(root);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const controller = createDevController({
    spawnElectron: () => spawn(executable, ['.', '--reader-dev-url=' + server.url, '--reader-dev-root=' + root, ...profileArgs], {
      cwd: root, env: environment, windowsHide: true,
      // Isolate terminal signals from the GUI. IPC remains referenced, and all
      // restarts/shutdowns still wait for Electron's own save-and-close flow.
      detached: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    }),
    createWatchers: (changed, failed) => watchRestartSources(root, changed, failed),
    closeServer: () => server.close(),
  });
  const stop = () => controller.requestStop();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log('Electron 开发预览使用 reader://app；前端服务：' + server.url);
  console.log('前端变更即时更新；主进程与服务源码内容变化才会先保存再重启，触发文件会记入日志。');
  try { return await controller.start(); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDesktopDevelopment().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error('无法启动 Electron 开发预览：' + error.message);
    process.exitCode = 1;
  });
}
