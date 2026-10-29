'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Console } = require('node:console');
const { Writable } = require('node:stream');

const MESSAGES = {
  CONNECTION_UNAVAILABLE: 'Open Continuous Reader before starting its MCP connection.',
  CONNECTION_INVALID: 'Continuous Reader connection information is invalid. Reopen the desktop app.',
  APP_NOT_RUNNING: 'Continuous Reader is not running. Open the desktop app and reconnect.',
  SERVICE_UNAVAILABLE: 'The running Continuous Reader workspace is unavailable. Reopen the app and reconnect.',
  AUTHENTICATION_FAILED: 'The Continuous Reader connection has expired. Reconnect to the running desktop app.',
  RUNTIME_UNAVAILABLE: 'The bundled Continuous Reader MCP runtime is unavailable. Repair the desktop installation.',
  START_FAILED: 'Continuous Reader MCP could not start. Reopen the desktop app and reconnect.',
};

function failure(code) {
  return Object.assign(new Error(MESSAGES[code] || MESSAGES.START_FAILED), { code });
}

function validateConnection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.url !== 'string' || value.url.length > 2048
    || typeof value.token !== 'string' || !/^[A-Za-z0-9._~-]{16,512}$/.test(value.token)
    || !Number.isSafeInteger(value.pid) || value.pid < 1) throw failure('CONNECTION_INVALID');
  let url;
  try { url = new URL(value.url); } catch { throw failure('CONNECTION_INVALID'); }
  // The desktop host binds a literal loopback address. Do not send its bearer
  // token through DNS, redirects, credentials, or a URL supplied by a client.
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) throw failure('CONNECTION_INVALID');
  return { url: url.origin, token: value.token, pid: value.pid };
}

async function readConnection(userData) {
  try {
    const file = path.join(userData, 'connection.json');
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > 16 * 1024) throw failure('CONNECTION_INVALID');
    return validateConnection(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'CONNECTION_INVALID') throw error;
    if (error instanceof SyntaxError) throw failure('CONNECTION_INVALID');
    throw failure('CONNECTION_UNAVAILABLE');
  }
}

function assertRunning(pid) {
  if (pid === process.pid) throw failure('APP_NOT_RUNNING');
  try { process.kill(pid, 0); }
  catch { throw failure('APP_NOT_RUNNING'); }
}

async function verifyService(connection) {
  try {
    const health = await fetch(connection.url + '/health', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw failure('SERVICE_UNAVAILABLE');
    const status = await health.json();
    if (status?.ok !== true || status.service !== 'continuous-reader-workspace' || status.authentication !== true) throw failure('SERVICE_UNAVAILABLE');
    // Verify the token against a read-only endpoint before importing a long-lived
    // transport. The file must refer to this authenticated workspace instance.
    const access = await fetch(connection.url + '/api/workspace', {
      headers: { Authorization: 'Bearer ' + connection.token }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    // Drain instead of cancelling the HTTP body immediately before process exit.
    // This also lets the loopback service finish its response cleanly on Windows.
    if (access.body) for await (const _chunk of access.body) { /* discard metadata */ }
    if ([401, 403].includes(access.status)) throw failure('AUTHENTICATION_FAILED');
    if (!access.ok) throw failure('SERVICE_UNAVAILABLE');
  } catch (error) {
    if (MESSAGES[error.code]) throw error;
    throw failure('SERVICE_UNAVAILABLE');
  }
}

/**
 * Called by the dedicated --mcp branch after app.whenReady(). This process never
 * starts a backend or opens a window; it only forwards to the running desktop.
 * All console diagnostics use stderr. stdout belongs exclusively to MCP JSON.
 */
async function startMcp({ runtime, userData, app }) {
  if (!app || typeof app.exit !== 'function') throw new TypeError('An Electron app instance is required');
  // Electron's Windows main process replaces process.stdin with an EOF-only
  // stream. Read the inherited descriptor directly; stdout remains the actual
  // MCP output pipe. Do not modify Electron's non-configurable stdin property.
  const input = process.platform === 'win32' && process.type === 'browser'
    ? createReadStream(null, { fd: 0, autoClose: false }) : process.stdin;
  let connection, stopped = false, monitor, startupDeadline, forwarder;
  const bindings = [];
  const redact = (value) => connection?.token ? value.split(connection.token).join('[redacted]') : value;
  const diagnostic = (message) => { try { process.stderr.write(redact(String(message)) + '\n'); } catch {} };
  const diagnostics = new Writable({ write(chunk, _encoding, done) {
    try { process.stderr.write(redact(chunk.toString()), done); } catch { done(); }
  } });
  diagnostics.on('error', () => {});
  global.console = new Console({ stdout: diagnostics, stderr: diagnostics, ignoreErrors: true });
  function bind(target, event, handler) {
    target.on(event, handler);
    bindings.push(() => target.removeListener(event, handler));
  }
  function stop(code = 0) {
    if (stopped) return;
    stopped = true;
    clearInterval(monitor);
    clearTimeout(startupDeadline);
    for (const unbind of bindings) unbind();
    // Let the forwarder drain its HTTP close request, with a bounded fallback
    // when the desktop disappeared. Leave an I/O turn before Electron teardown.
    const deadline = setTimeout(() => app.exit(code), 1000);
    Promise.resolve().then(() => forwarder?.close()).catch(() => {}).finally(() => {
      clearTimeout(deadline);
      setTimeout(() => app.exit(code), 50);
    });
  }
  bind(input, 'end', () => stop());
  bind(input, 'error', () => stop(1));
  bind(process.stdout, 'error', (error) => stop(error.code === 'EPIPE' ? 0 : 1));
  bind(process, 'SIGINT', () => stop(130));
  bind(process, 'SIGTERM', () => stop(143));
  try {
    connection = await readConnection(userData);
    assertRunning(connection.pid);
    await verifyService(connection);
    assertRunning(connection.pid);
    const entry = path.join(runtime, 'services', 'workspace', 'stdio.mjs');
    try { if (!(await fs.stat(entry)).isFile()) throw failure('RUNTIME_UNAVAILABLE'); }
    catch { throw failure('RUNTIME_UNAVAILABLE'); }
    if (stopped || input.readableEnded || input.destroyed) { stop(); return { stop }; }
    process.env.WORKSPACE_URL = connection.url;
    process.env.CONTINUOUS_READER_AUTH_TOKEN = connection.token;
    await Promise.race([
      import(pathToFileURL(entry).href).then(async ({ startStdio }) => {
        if (typeof startStdio !== 'function') throw failure('RUNTIME_UNAVAILABLE');
        forwarder = await startStdio({ stdin: input, stdout: process.stdout });
      }),
      new Promise((_done, reject) => { startupDeadline = setTimeout(() => reject(failure('START_FAILED')), 10000); }),
    ]);
    clearTimeout(startupDeadline);
    if (stopped) return { stop };
    monitor = setInterval(async () => {
      if (stopped) return;
      try {
        assertRunning(connection.pid);
        const current = await readConnection(userData);
        if (current.pid !== connection.pid || current.url !== connection.url || current.token !== connection.token) throw failure('APP_NOT_RUNNING');
      } catch {
        diagnostic('Continuous Reader closed or restarted. Reconnect after opening the desktop app.');
        stop(1);
      }
    }, 2000);
    monitor.unref();
    return { stop };
  } catch (error) {
    diagnostic(MESSAGES[error.code] || MESSAGES.START_FAILED);
    stop(1);
    return { stop };
  }
}

module.exports = { startMcp, validateConnection, readConnection };
