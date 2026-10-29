import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createWorkspace, localActor } from '../service.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reader-receipt-race-'));
  const workspace = await createWorkspace({ dataDir: directory, bootstrap: false, glossaryPath: false });
  t.after(async () => {
    await workspace.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.match(directory, /reader-receipt-race-/);
    await rm(directory, { recursive: true, force: true });
  });
  return workspace;
}

// Pause after an absent fast receipt lookup has completed, then let another
// request finish before the first request performs its guarded receipt lookup.
function insertConcurrentCommit(workspace, winnerCommand) {
  const query = workspace.sql.query.bind(workspace.sql), events = [];
  let armed = true, concurrent = false, winner, durableReceipt;
  workspace.sql.query = async (statement, values = []) => {
    const rows = await query(statement, values);
    if (statement === 'SELECT hash,payload FROM receipts WHERE request_id=?' && values[0] === winnerCommand.requestId && !concurrent) {
      events.push(rows.length ? 'receipt-present' : 'receipt-absent');
      if (armed) {
        armed = false;
        assert.equal(rows.length, 0);
        concurrent = true;
        try { winner = await workspace.execute(localActor, winnerCommand); }
        finally { concurrent = false; }
        durableReceipt = query('SELECT * FROM receipts WHERE request_id=?', [winnerCommand.requestId])[0];
        events.push('concurrent-committed');
      }
    }
    return rows;
  };
  return { events, query, get winner() { return winner; }, get durableReceipt() { return durableReceipt; } };
}

function assertOnlyWinnerCommitted(workspace, race) {
  assert.deepEqual(race.events.slice(0, 3), ['receipt-absent', 'concurrent-committed', 'receipt-present']);
  const collections = race.query('SELECT id,label FROM collections');
  assert.deepEqual(collections.map(row => ({ ...row })), [{ id: race.winner.collection.id, label: race.winner.collection.label }]);
  assert.equal(race.query('SELECT COUNT(*) AS count FROM receipts')[0].count, 1);
  assert.equal(race.query('SELECT COUNT(*) AS count FROM changes')[0].count, 1);
  assert.equal(race.query("SELECT value FROM metadata WHERE key='revision'")[0].value, '1');
  assert.deepEqual(race.query('SELECT * FROM receipts WHERE request_id=?', [race.winner.requestId])[0], race.durableReceipt);
  assert.equal(race.query('SELECT COUNT(*) AS count FROM business_assertions')[0].count, 0);
}

test('a duplicate committed between the two receipt reads replays the exact original result without another business write', async t => {
  const workspace = await fixture(t);
  const command = { kind: 'collection.create', label: 'Only collection', parentId: null, requestId: 'same-payload-race', expectedWorkspaceRevision: 0 };
  const race = insertConcurrentCommit(workspace, command);
  const result = await workspace.execute(localActor, command);
  assert.deepEqual(result, race.winner);
  assertOnlyWinnerCommitted(workspace, race);
  assert.deepEqual(await workspace.execute(localActor, command), race.winner);
  assertOnlyWinnerCommitted(workspace, race);
});

test('a different payload committed between the two receipt reads rejects the request ID reuse and preserves the original receipt', async t => {
  const workspace = await fixture(t);
  const winnerCommand = { kind: 'collection.create', label: 'Committed first', parentId: null, requestId: 'different-payload-race', expectedWorkspaceRevision: 0 };
  const race = insertConcurrentCommit(workspace, winnerCommand);
  const conflictingCommand = { ...winnerCommand, label: 'Must never be created' };
  await assert.rejects(workspace.execute(localActor, conflictingCommand), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assertOnlyWinnerCommitted(workspace, race);
  assert.deepEqual(await workspace.execute(localActor, winnerCommand), race.winner);
  await assert.rejects(workspace.execute(localActor, conflictingCommand), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assertOnlyWinnerCommitted(workspace, race);
});
