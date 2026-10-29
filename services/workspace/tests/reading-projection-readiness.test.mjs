import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE, measuredEvent as event, ProjectionFixture } from './reading-projection-fixture.mjs';
import { projectReadingChanges } from '../reading-projection.mjs';

const actor = { subjectId: 'reader' }, range = { from: '2025-01-01', to: '2025-01-01', timezone: 'UTC' };

test('history, summary and grouped statistics reject missing or dirty projections instead of returning zero', async t => {
  const h = new ProjectionFixture(); t.after(() => h.close()); h.session('session');
  const reads = [() => h.flow.history(actor, range), () => h.flow.summaryDefault(actor, range), () => h.flow.statistics(actor, { ...range, groupBy: ['document'] })];
  for (const read of reads) await read();
  h.insertRaw(event('session', 1, 0, 15000));
  for (const read of reads) await assert.rejects(read(), error => error.code === 'READING_PROJECTION_PENDING' && error.status === 503 && error.details.retryable);
  projectReadingChanges(h.db);
  assert.equal((await h.flow.summaryDefault(actor, range)).totals.activeMs, 15000);
  assert.equal((await h.flow.history(actor, range)).items[0].activeMs, 15000);
  h.db.prepare('DELETE FROM reading_projection_state').run();
  for (const read of reads) await assert.rejects(read(), error => error.code === 'READING_PROJECTION_PENDING');
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM reading_activity').get().n, 1);
});

test('projection invalidation or a committed reading revision during aggregation rejects the partial response', async t => {
  const h = new ProjectionFixture(); t.after(() => h.close()); h.session('session'); h.insert(event('session', 1, 0, 15000));
  const query = h.flow.sql.query; let changed = false;
  h.flow.sql.query = async (statement, values) => {
    const result = query(statement, values);
    if (!changed && statement.includes('SUM(MIN(r.end_ms')) { changed = true; h.insertRaw(event('session', 2, 15000, 30000)); }
    return result;
  };
  await assert.rejects(h.flow.summaryDefault(actor, range), error => error.code === 'READING_PROJECTION_PENDING');
  projectReadingChanges(h.db); h.flow.sql.query = query; changed = false;
  h.flow.sql.query = async (statement, values) => {
    const result = query(statement, values);
    if (!changed && statement.includes('SUM(MIN(r.end_ms')) { changed = true; h.insert(event('session', 3, 30000, 45000)); h.db.prepare("UPDATE flow_metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run(); }
    return result;
  };
  await assert.rejects(h.flow.summaryDefault(actor, range), error => error.code === 'READING_PROJECTION_PENDING');
  h.flow.sql.query = query;
  assert.equal((await h.flow.summaryDefault(actor, range)).totals.activeMs, 45000);
  assert.equal(h.flow.now() > BASE, true);
});
