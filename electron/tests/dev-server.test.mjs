import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createDesktopDevServer, repositoryRoot } from '../dev.mjs';

test('real Vite serves reader-origin modules and an explicit loopback HMR socket without a GUI', { timeout: 30000 }, async (t) => {
  // Vite's Windows raw-file handler serves from the current drive. Keep the
  // existing private fixture on that drive so this checks denial, not SPA fallback.
  const privateDirectory = await mkdtemp(path.join(repositoryRoot, 'electron/tests/.private-dev-'));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  const privateFile = path.join(privateDirectory, 'workspace.sqlite');
  const privateSentinel = 'synthetic private data';
  await writeFile(privateFile, privateSentinel);
  const server = await createDesktopDevServer(repositoryRoot);
  t.after(() => server.close());
  const url = new URL(server.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(Number(url.port) > 0);
  assert.equal(server.vite.config.server.proxy, undefined);
  assert.equal(server.vite.config.server.open, false);
  const [htmlResponse, clientResponse, entryResponse, apiResponse] = await Promise.all([
    fetch(server.url + '/'), fetch(server.url + '/@vite/client'), fetch(server.url + '/src/main.jsx'), fetch(server.url + '/api/documents'),
  ]);
  const html = await htmlResponse.text(), client = await clientResponse.text(), entry = await entryResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(html, /src="\/@vite\/client"/);
  assert.match(html, /from "\/@react-refresh"/);
  assert.match(html, /src="\/src\/main\.jsx"/);
  assert.equal(clientResponse.status, 200);
  assert.ok(client.includes('"127.0.0.1"'));
  assert.ok(client.includes('"ws"'));
  assert.match(client, new RegExp('(?:hmrPort|port)\\s*=\\s*' + url.port));
  assert.equal(entryResponse.status, 200);
  assert.match(entry, /from "\/node_modules\/\.vite\/deps\/react/);
  assert.equal(apiResponse.status, 404, 'the desktop dev server must not proxy an unrelated API workspace');
  const forbidden = '/@fs/' + path.join(repositoryRoot, 'package.json').replaceAll('\\', '/');
  const forbiddenResponse = await fetch(server.url + forbidden);
  assert.equal(forbiddenResponse.status, 403, 'Vite must not expose the repository or workspace database');
  const privateResponse = await fetch(server.url + '/@fs/' + privateFile.replaceAll('\\', '/'));
  assert.equal(privateResponse.status, 403);
  assert.ok(!(await privateResponse.text()).includes(privateSentinel));
  const socket = new WebSocket(server.url.replace('http:', 'ws:'), 'vite-hmr');
  t.after(() => socket.close());
  const message = await new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => resolve(JSON.parse(event.data)), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  assert.equal(message.type, 'connected');
  socket.close();
});
