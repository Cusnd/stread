import { canonical, check, clone, hash, json, object, text } from './errors.mjs';
import { createReadSet, replicationChanges, rowStatement } from './sql-commit.mjs';
import { cloudSyncSchema } from './sync-table-definitions.mjs';
import { augmentQueueCommit } from './queue-data.mjs';

const localKeys = {
  counters: ['series'], sync_reference_ranges: ['series'], migrations: ['key'],
  preview_metadata: ['preview_id'], relation_match_state: ['key'], flow_metadata: ['key'],
  queue_tasks: ['id'], queue_task_previews: ['preview_id'],
};

export function commandDigest(command) {
  object(command, '操作'); text(command.requestId, '请求标识', 160, true); text(command.kind, '操作类型', 100, true);
  const { requestId, ...input } = command;
  return hash(canonical(input));
}

export async function findBusinessReceipt(workspace, command) {
  const digest = commandDigest(command), row = (await workspace.sql.query('SELECT hash,payload FROM receipts WHERE request_id=?', [command.requestId]))[0];
  if (!row) return { digest };
  check(row.hash === digest, 'IDEMPOTENCY_CONFLICT', '此请求编号已用于不同的操作。', 409);
  return { digest, receipt: await workspace.storage.unpack(JSON.parse(row.payload)) };
}

export function changeStatements(changes) {
  return changes.map(change => {
    const keys = cloudSyncSchema.get(change.entity)?.keys || localKeys[change.entity];
    check(keys, 'BUSINESS_TABLE_UNKNOWN', '业务提交包含未定义的数据表。', 500, { entity: change.entity });
    return rowStatement(change.entity, keys, change.value, typeof change.key === 'string' ? JSON.parse(change.key) : change.key);
  });
}

// One call owns a concrete operation. It prepares exact final rows; this helper
// adds the shared commit evidence and submits it once. There is no command bus,
// shadow database, table diff, or second synchronization transaction.
export async function commitBusiness(workspace, actor, input, prepare) {
  const command = clone(object(input, '操作'));
  for (let attempt = 0; attempt < 64; attempt++) {
    try {
    const prior = await findBusinessReceipt(workspace, command);
    if (prior.receipt) return prior.receipt;
    const reads = createReadSet(workspace.sql);
    const recorded = await reads.get('SELECT hash,payload FROM receipts WHERE request_id=?', command.requestId);
    if (recorded) {
      check(recorded.hash === prior.digest, 'IDEMPOTENCY_CONFLICT', '此请求编号已用于不同的操作。', 409);
      return workspace.storage.unpack(JSON.parse(recorded.payload));
    }
    const baseRevision = JSON.parse((await reads.get("SELECT value FROM metadata WHERE key='revision'")).value);
    if (command.expectedWorkspaceRevision !== undefined) check(command.expectedWorkspaceRevision === baseRevision,
      'REVISION_CONFLICT', '工作台已改变，请重新读取。', 409, { currentRevision: baseRevision });
    let activityRevision;
    if (command.expectedActivityRevision !== undefined || command.kind.startsWith('reading.session.') || command.kind.startsWith('insight.review.')) {
      activityRevision = Number((await reads.get("SELECT value FROM flow_metadata WHERE key='revision'")).value);
      if (command.expectedActivityRevision !== undefined) check(command.expectedActivityRevision === activityRevision,
        'REVISION_CONFLICT', '阅读活动已改变，请重新读取。', 409, { currentRevision: activityRevision });
    }
    const prepared = await prepare(reads);
    await augmentQueueCommit(workspace, reads, prepared);
    const result = prepared.result;
    const workspaceChange = prepared.workspaceChange !== false, revision = baseRevision + (workspaceChange ? 1 : 0);
    if (Object.hasOwn(result, 'activityRevision')) result.activityRevision = activityRevision + (prepared.touchActivity ? 1 : 0);
    const receipt = { requestId: command.requestId, revision, ...result }, timestamp = new Date().toISOString();
    const changes = [...(prepared.changes || []), { entity: 'receipts', value: { request_id: command.requestId, hash: prior.digest,
      payload: workspace.storage.pack(receipt), actor: actor.subjectId || 'local', created_at: timestamp } }];
    const statements = changeStatements(changes.slice(0, -1));
    const recordedRow = changes.at(-1).value;
    // A request identity is immutable. Even an unforeseen concurrent path must
    // fail its entire transaction instead of replacing an earlier receipt.
    statements.push({sql:'INSERT INTO receipts(request_id,hash,payload,actor,created_at) VALUES(?,?,?,?,?)',
      values:[recordedRow.request_id,recordedRow.hash,recordedRow.payload,recordedRow.actor,recordedRow.created_at]});
    if (workspaceChange) statements.push(
      { sql: "UPDATE metadata SET value=? WHERE key='revision'", values: [json(revision)] },
      { sql: 'INSERT INTO changes VALUES(?,?,?)', values: [revision, json({ kind: command.kind,
        documentId: command.documentId || result.document?.id || result.insight?.documentId,
        insightId: result.insight?.id, collectionId: result.collection?.id }), timestamp] },
    );
    statements.push(...(prepared.statements || []));
    const synchronized = workspace.options.prepareBusinessCommit
      ? await workspace.options.prepareBusinessCommit({ changes: await replicationChanges(workspace.sql, cloudSyncSchema, changes),
        replicaId: 'cloud-business', requestId: command.requestId }) : { before: [], after: [] };
    const executionGuards = await workspace.options.executionGuards?.({ command, changes, reads }) || [];
    try {
      await workspace.sql.batch([...reads.guards, ...executionGuards, ...synchronized.before, ...statements, ...synchronized.after]);
      return receipt;
    } catch (error) {
      // A lost response or racing duplicate must consult durable evidence first.
      const committed = await findBusinessReceipt(workspace, command);
      if (committed.receipt) return committed.receipt;
      const guardFailure = /business_assertions|CHECK constraint failed|UNIQUE constraint failed: receipts.request_id/.test(error.message || '');
      if (!guardFailure) throw error;
      if (attempt === 63) check(false, 'SYNC_BUSINESS_CONFLICT', '业务提交遇到并发修改，请保留原请求重试。', 409);
      // Re-read original expected versions. Never change a user revision/hash.
    }
    } catch (error) {
      if (error.code !== 'BUSINESS_PREPARATION_CHANGED') throw error;
      if (attempt === 63) check(false, 'SYNC_BUSINESS_CONFLICT', '业务提交遇到并发修改，请保留原请求重试。', 409);
    }
  }
}

// Upload metadata and failed-preview diagnostics have established independent
// persistence semantics. They still use the same atomic replication evidence.
export async function commitAuxiliary(workspace, { reads, changes, statements = [], requestId }) {
  const synchronized = workspace.options.prepareBusinessCommit
    ? await workspace.options.prepareBusinessCommit({ changes: await replicationChanges(workspace.sql, cloudSyncSchema, changes), replicaId: 'cloud-business', requestId })
    : { before: [], after: [] };
  const guards = await workspace.options.executionGuards?.({ changes, reads }) || [];
  await workspace.sql.batch([...(reads?.guards || []), ...guards, ...synchronized.before, ...changeStatements(changes), ...statements, ...synchronized.after]);
}
