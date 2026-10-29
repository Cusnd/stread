const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { developmentOptions, isBackendRequest, developmentContentPolicy } = require('../development.cjs');

const projectRoot = path.resolve(__dirname, '../..');
const options = (url = 'http://127.0.0.1:52341', root = projectRoot) => ({ packaged: false, projectRoot, args: ['--reader-dev-root=' + root, '--reader-dev-url=' + url] });

test('development requires an explicit matching source checkout and a loopback-only frontend', () => {
  assert.equal(developmentOptions({ packaged: false, projectRoot, args: [] }), null);
  assert.deepEqual(developmentOptions(options()), { root: projectRoot, origin: 'http://127.0.0.1:52341', websocketOrigin: 'ws://127.0.0.1:52341' });
  for (const url of ['https://127.0.0.1:52341', 'http://localhost:52341', 'http://example.com:52341', 'http://127.0.0.1', 'http://user:secret@127.0.0.1:52341', 'http://127.0.0.1:52341/nested', 'http://127.0.0.1:52341/?x=1', 'http://127.0.0.1:52341/#hash', 'file:///client']) assert.throws(() => developmentOptions(options(url)));
  assert.throws(() => developmentOptions(options(undefined, path.dirname(projectRoot))));
  assert.throws(() => developmentOptions({ packaged: false, projectRoot, args: ['--reader-dev-url=http://127.0.0.1:52341'] }));
  assert.equal(developmentOptions({ ...options('https://evil.example'), packaged: true }), null, 'packaged argv cannot enable a development origin');
});

test('only workspace endpoints receive service authority, never Vite assets or lookalike prefixes', () => {
  for (const path of ['/api', '/api/documents', '/api/commands', '/mcp', '/health']) assert.equal(isBackendRequest(path), true);
  for (const path of ['/', '/@vite/client', '/src/main.jsx', '/articles/example.json', '/api-lookalike', '/health.js', '/mcp.js']) assert.equal(isBackendRequest(path), false);
  const csp = developmentContentPolicy(developmentOptions(options()));
  assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:52341;/);
  assert.doesNotMatch(csp, /'unsafe-eval'|\*|https?:/);
  assert.match(csp, /script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'/);
  assert.match(csp, /worker-src 'self'/);
});
