const path = require('node:path');

function developmentOptions({ packaged, args, projectRoot }) {
  // A distributed application never becomes a development host via argv.
  if (packaged) return null;
  const read = (name) => args.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1);
  const sourceRoot = read('--reader-dev-root'), sourceUrl = read('--reader-dev-url');
  if (!sourceRoot && !sourceUrl) return null;
  if (!sourceRoot || !sourceUrl || !path.isAbsolute(sourceRoot)) throw new Error('开发预览必须由 npm run desktop:dev 启动。');
  if (path.relative(path.resolve(projectRoot), path.resolve(sourceRoot))) throw new Error('开发预览的源码目录与程序不一致。');
  let url;
  try { url = new URL(sourceUrl); } catch { throw new Error('开发预览地址无效。'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('开发预览只接受本机动态端口地址。');
  return { root: path.resolve(sourceRoot), origin: url.origin, websocketOrigin: 'ws://' + url.host };
}

function isBackendRequest(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/mcp' || pathname === '/health';
}

function developmentContentPolicy(options) {
  // React Refresh's module preamble is inline. Node remains isolated and the
  // service token is never sent to Vite or exposed in the renderer.
  return "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' " + options.websocketOrigin + "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
}

module.exports = { developmentOptions, isBackendRequest, developmentContentPolicy };
