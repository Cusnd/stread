import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkspaceServer } from '../server.mjs';
import { localActor } from '../actor.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stread-queue-http-'));
  const authToken = 'queue-http-fixture-only';
  const server = await createWorkspaceServer({ dataDir: directory, bootstrap: false, glossaryPath: false, staticRoot: false, authToken });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Authorization: 'Bearer ' + authToken };
  t.after(async () => {
    await server.shutdown();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path, command) => fetch(base + path, { headers: { ...headers, ...(command ? { 'Content-Type': 'application/json' } : {}) },
    ...(command ? { method: 'POST', body: JSON.stringify(command) } : {}) });
  return { directory, server, base, headers, request };
}

test('HTTP queue uses shared guarded commands and preserves exact identity on uncertain retries', async t => {
  const h = await fixture(t);
  const source = await h.server.workspace.upload(localActor, Buffer.from('Original source'), { filename: 'source.txt', mediaType: 'text/plain' });
  const command = { kind: 'queue.create', requestId: randomUUID(), task: { type: 'conversion', sourceId: source.sourceId, title: 'Source', body: 'Keep all content' } };
  const response = await h.request('/api/commands', command);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.match(receipt.task.reference, /^#T\d{5,}$/);
  assert.deepEqual(await (await h.request('/api/commands', command)).json(), receipt);
  const list = await (await h.request('/api/queue?type=conversion&status=pending')).json();
  assert.equal(list.tasks.length, 1);
  for (const key of [receipt.task.id, receipt.task.reference]) {
    const detail = await h.request('/api/queue/' + encodeURIComponent(key));
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).task.id, receipt.task.id);
  }
  assert.equal((await h.request('/api/queue?offset=NaN')).status, 400);
  assert.equal((await h.request('/api/queue?limit=1.5')).status, 400);
  assert.equal((await h.request('/api/queue?type=invalid')).status, 400);
  const cancelled = await h.request('/api/commands', { kind: 'queue.cancel', taskId: receipt.task.id, expectedVersion: receipt.task.version, requestId: randomUUID() });
  assert.equal(cancelled.status, 200);
  const stale = await h.request('/api/commands', { kind: 'queue.update', taskId: receipt.task.id, expectedVersion: receipt.task.version, patch: { body: 'Late edit' }, requestId: randomUUID() });
  assert.equal(stale.status, 409);
  assert.equal((await (await h.request('/api/queue?status=pending')).json()).total, 0);
  assert.equal((await (await h.request('/api/queue?status=cancelled')).json()).tasks[0].reference, receipt.task.reference);
});

test('queue metadata, source downloads and source thumbnails all require HTTP authorization', async t => {
  const h = await fixture(t);
  const source = await h.server.workspace.upload(localActor, Buffer.from('Private source'), { filename: 'private.txt', mediaType: 'text/plain' });
  const { task } = await h.server.workspace.execute(localActor, { kind: 'queue.create', requestId: randomUUID(), task: { type: 'conversion', sourceId: source.sourceId } });
  for (const path of ['/api/queue', '/api/queue/' + task.id, '/api/sources/' + source.sourceId + '/original', '/api/sources/' + source.sourceId + '/pages/1.png']) {
    assert.equal((await fetch(h.base + path)).status, 401, path);
  }
  const original = await h.request('/api/sources/' + source.sourceId + '/original');
  assert.equal(original.status, 200);
  assert.equal(await original.text(), 'Private source');
  const nonPdf = await h.request('/api/sources/' + source.sourceId + '/pages/1.png');
  assert.equal(nonPdf.status, 404);
});

test('uploaded-source thumbnail routes use the shared renderer with validated page and width', async t => {
  const h = await fixture(t);
  const source = await h.server.workspace.upload(localActor, Buffer.from('%PDF-1.4\nfixture'), { filename: 'paper.pdf', mediaType: 'application/pdf' });
  const image = join(h.directory, 'thumbnail.png');
  await writeFile(image, Buffer.from([137,80,78,71,13,10,26,10]));
  const calls = [];
  h.server.workspace.resources.page = async (file, page, width) => {
    calls.push({ sha256: file.sha256, page, width });
    return image;
  };
  const thumbnail = await h.request('/api/sources/' + source.sourceId + '/pages/1.png?width=600');
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers.get('content-type'), 'image/png');
  await thumbnail.arrayBuffer();
  assert.deepEqual(calls, [{ sha256: source.sha256, page: 1, width: 600 }]);
  assert.equal((await h.request('/api/sources/' + source.sourceId + '/pages/1.png?width=no')).status, 400);
  assert.equal((await h.request('/api/sources/' + source.sourceId + '/pages/1.png?width=0')).status, 400);
});
