'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { validateConnection, readConnection } = require('../mcp.cjs');

const repository = path.resolve(__dirname, '../..');
const entry = path.join(repository, 'electron/mcp.cjs');
const token = () => randomBytes(32).toString('base64url');
const cleanups = new WeakMap();
function cleanup(t, action) {
  if (!cleanups.has(t)) {
    const actions = [];
    cleanups.set(t, actions);
    t.after(async () => {
      const errors = [];
      for (const dispose of actions.reverse()) {
        try { await dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'MCP fixture cleanup failed');
    });
  }
  cleanups.get(t).push(action);
}

async function directory(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'reader-mcp-test-'));
  cleanup(t, async () => {
    assert.ok(root.startsWith(path.join(tmpdir(), 'reader-mcp-test-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function setup(t) {
  const root = await directory(t), userData = path.join(root, 'profile'), authToken = token();
  await fs.mkdir(userData);
  const { createWorkspaceServer } = await import(pathToFileURL(path.join(repository, 'services/workspace/server.mjs')).href);
  const server = await createWorkspaceServer({ dataDir: path.join(root, 'workspace'), bootstrap: false, glossaryPath: false, staticRoot: false, authToken });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  cleanup(t, async () => { await server.shutdown(); });
  const connection = { url: 'http://127.0.0.1:' + server.address().port, token: authToken, pid: process.pid };
  const writeConnection = (value = connection) => fs.writeFile(path.join(userData, 'connection.json'), JSON.stringify(value));
  await writeConnection();
  return { root, userData, server, connection, writeConnection };
}

function bridge(t, userData, runtime = repository, launch) {
  const script = 'require(' + JSON.stringify(entry) + ').startMcp({ runtime: process.argv[1], userData: process.argv[2], app: { exit: (code) => process.exit(code) } });';
  const child = spawn(launch?.command || process.execPath, launch?.args || ['-e', script, runtime, userData], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, WORKSPACE_URL: 'http://invalid.test:9999', CONTINUOUS_READER_AUTH_TOKEN: 'expired-environment-token' },
  });
  let stdout = '', stderr = '', buffer = '', serial = 0;
  const pending = new Map(), messages = [], parseErrors = [];
  child.stdout.on('data', (chunk) => {
    stdout += chunk; buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line); messages.push(message);
        const request = pending.get(message.id);
        if (request) { clearTimeout(request.timer); pending.delete(message.id); request.resolve(message); }
      } catch { parseErrors.push(line); }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
  cleanup(t, async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP request timed out: ' + method)); }, 10000);
    pending.set(id, { resolve, timer }); send({ id, method, ...(params ? { params } : {}) });
  });
  const initialize = async () => {
    const result = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'desktop-mcp-test', version: '1' } });
    assert.ok(result.result?.serverInfo);
    send({ method: 'notifications/initialized' });
    return result;
  };
  return { child, request, initialize, closed, messages, parseErrors, output: () => ({ stdout, stderr }) };
}

test('connection files accept only authenticated literal-loopback HTTP origins', () => {
  const valid = { url: 'http://127.0.0.1:12345/', pid: 42, token: token() };
  assert.deepEqual(validateConnection(valid), { ...valid, url: 'http://127.0.0.1:12345' });
  assert.equal(validateConnection({ ...valid, url: 'http://[::1]:12345' }).url, 'http://[::1]:12345');
  for (const url of ['https://127.0.0.1:12345', 'http://localhost:12345', 'http://192.168.1.1:12345', 'http://127.0.0.1',
    'http://127.0.0.1:12345/mcp', 'http://127.0.0.1:12345/?token=secret', 'http://127.0.0.1:12345/#fragment', 'http://name:secret@127.0.0.1:12345']) {
    assert.throws(() => validateConnection({ ...valid, url }), { code: 'CONNECTION_INVALID' });
  }
  for (const value of [{ ...valid, pid: 0 }, { ...valid, pid: '42' }, { ...valid, token: '' }, { ...valid, token: 'secret\r\nheader' }]) {
    assert.throws(() => validateConnection(value), { code: 'CONNECTION_INVALID' });
  }
});

test('missing, malformed and oversized connection files produce safe errors', async (t) => {
  const root = await directory(t), file = path.join(root, 'connection.json');
  await assert.rejects(readConnection(root), { code: 'CONNECTION_UNAVAILABLE' });
  await fs.writeFile(file, '{broken');
  await assert.rejects(readConnection(root), { code: 'CONNECTION_INVALID' });
  await fs.writeFile(file, ' '.repeat(17000));
  await assert.rejects(readConnection(root), { code: 'CONNECTION_INVALID' });
});

test('the stdio bridge initializes, lists tools and calls the real isolated workspace without protocol pollution', async (t) => {
  const h = await setup(t), mcp = bridge(t, h.userData);
  const initialization = await mcp.initialize();
  assert.equal(initialization.result.serverInfo.name, 'stread-workspace');
  const list = await mcp.request('tools/list');
  assert.ok(list.result.tools.some((tool) => tool.name === 'query_documents'));
  assert.ok(list.result.tools.some((tool) => tool.name === 'read_context'));
  const call = await mcp.request('tools/call', { name: 'query_documents', arguments: { action: 'list' } });
  assert.ok(!call.error && !call.result.isError);
  assert.ok(call.result.structuredContent);
  assert.deepEqual(JSON.parse(call.result.content[0].text), call.result.structuredContent);
  mcp.child.stdin.end();
  assert.equal((await mcp.closed).code, 0);
  assert.deepEqual(mcp.parseErrors, []);
  assert.ok(!mcp.output().stdout.includes(h.connection.token));
  assert.ok(!mcp.output().stderr.includes(h.connection.token));
  assert.ok(mcp.messages.every((message) => message.jsonrpc === '2.0'));
});

test('the real Windows Electron main process reads inherited MCP stdin and exits cleanly at EOF', { skip: process.platform !== 'win32' }, async (t) => {
  const h = await setup(t), bootstrap = path.join(h.root, 'electron-mcp.cjs');
  await fs.writeFile(bootstrap, [
    "const { app } = require('electron');",
    "app.setPath('userData', process.argv[3]);",
    "app.setPath('sessionData', require('node:path').join(process.argv[3], 'chromium'));",
    "app.disableHardwareAcceleration();",
    'app.whenReady().then(() => require(' + JSON.stringify(entry) + ').startMcp({ runtime: process.argv[2], userData: process.argv[3], app }));',
  ].join('\n'));
  const mcp = bridge(t, h.userData, repository, { command: require('electron'), args: [bootstrap, repository, h.userData] });
  await mcp.initialize();
  const list = await mcp.request('tools/list');
  assert.ok(list.result.tools.some((tool) => tool.name === 'read_context'));
  const call = await mcp.request('tools/call', { name: 'query_documents', arguments: { action: 'list' } });
  assert.ok(!call.error && !call.result.isError);
  assert.deepEqual(call.result.structuredContent.documents, []);
  mcp.child.stdin.end();
  assert.equal((await mcp.closed).code, 0, mcp.output().stderr);
  assert.deepEqual(mcp.parseErrors, []);
  assert.equal(mcp.output().stderr, '');
});

test('a missing desktop profile exits without stdout, stack traces or a backend', async (t) => {
  const root = await directory(t), mcp = bridge(t, root);
  assert.equal((await mcp.closed).code, 1);
  assert.equal(mcp.output().stdout, '');
  assert.match(mcp.output().stderr, /Open Stread/);
  assert.ok(!mcp.output().stderr.includes(root));
  assert.deepEqual(await fs.readdir(root), []);
});

test('a dead UI PID prevents use even if the workspace endpoint still responds', async (t) => {
  const h = await setup(t);
  await h.writeConnection({ ...h.connection, pid: 2147483647 });
  const mcp = bridge(t, h.userData);
  assert.equal((await mcp.closed).code, 1);
  assert.equal(mcp.output().stdout, '');
  assert.match(mcp.output().stderr, /not running/);
  assert.ok(!mcp.output().stderr.includes(h.connection.token));
});

test('an expired token fails before serving MCP and never appears in diagnostics', async (t) => {
  const h = await setup(t), expired = token();
  await h.writeConnection({ ...h.connection, token: expired });
  const mcp = bridge(t, h.userData);
  assert.equal((await mcp.closed).code, 1, mcp.output().stderr);
  assert.equal(mcp.output().stdout, '');
  assert.match(mcp.output().stderr, /expired/);
  assert.ok(!mcp.output().stderr.includes(expired));
});

test('health checks never follow redirects or contact the redirected endpoint', async (t) => {
  const root = await directory(t), seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(302, { Location: '/redirected' }); response.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  cleanup(t, () => new Promise((done) => server.close(done)));
  await fs.writeFile(path.join(root, 'connection.json'), JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port, pid: process.pid, token: token() }));
  const mcp = bridge(t, root);
  assert.equal((await mcp.closed).code, 1);
  assert.equal(mcp.output().stdout, '');
  assert.deepEqual(seen, [{ url: '/health', authorization: undefined }]);
});

test('closing the desktop connection file also closes an established MCP bridge', async (t) => {
  const h = await setup(t), mcp = bridge(t, h.userData);
  await mcp.initialize();
  await fs.unlink(path.join(h.userData, 'connection.json'));
  assert.equal((await mcp.closed).code, 1);
  assert.match(mcp.output().stderr, /closed or restarted/);
  assert.deepEqual(mcp.parseErrors, []);
});

test('bundled runtime console output is redirected and redacted; signals exit the MCP process', async (t) => {
  const h = await setup(t), runtime = path.join(h.root, 'runtime');
  await fs.mkdir(path.join(runtime, 'services/workspace'), { recursive: true });
  await fs.writeFile(path.join(runtime, 'services/workspace/stdio.mjs'), [
    "console.log('runtime diagnostic', process.env.CONTINUOUS_READER_AUTH_TOKEN);",
    "console.table({ token: process.env.CONTINUOUS_READER_AUTH_TOKEN });",
    "setTimeout(() => process.emit('SIGTERM'), 25);",
    "export async function startStdio() { return { close: async () => {} }; }",
  ].join('\n'));
  const mcp = bridge(t, h.userData, runtime);
  assert.equal((await mcp.closed).code, 143);
  assert.equal(mcp.output().stdout, '');
  assert.match(mcp.output().stderr, /runtime diagnostic/);
  assert.match(mcp.output().stderr, /redacted/);
  assert.ok(!mcp.output().stderr.includes(h.connection.token));
});
