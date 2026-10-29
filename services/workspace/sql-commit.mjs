import { randomUUID } from 'node:crypto';
import { check, canonical } from './errors.mjs';
import { sqlName, rowHash, allowedRow } from './sync-schema.mjs';

// SQL execution is the only database difference. This does not emulate a
// transaction callback, keep an execution database, or interpret commands.
export function sqliteAccess(database) {
  return {
    query(sql, values = []) { return database.prepare(sql).all(...values); },
    batch(statements) {
      return database.transaction(() => statements.map(({ sql, values = [] }) => {
        const statement = database.prepare(sql);
        return /^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)
          ? { rows: statement.all(...values) } : { rows: [], meta: statement.run(...values) };
      }));
    },
  };
}

export function d1Access(database) {
  return {
    async query(sql, values = []) { return (await database.prepare(sql).bind(...values).all()).results; },
    async batch(statements) {
      const results = await database.batch(statements.map(({ sql, values = [] }) => database.prepare(sql).bind(...values)));
      return results.map(result => ({ rows: result.results || [], meta: result.meta }));
    },
  };
}

export const mapRead = (value, transform) => value && typeof value.then === 'function' ? value.then(transform) : transform(value);

// Existing local replication uses synchronous metadata reads. The business
// callers await both engines; this small read facade preserves those local
// reads without supplying a pretend synchronous cloud transaction.
export function d1ReadDatabase(binding) {
  return {
    binding,
    prepare(sql) {
      return {
        async all(...values) { return (await binding.prepare(sql).bind(...values).all()).results; },
        async get(...values) { return (await binding.prepare(sql).bind(...values).all()).results?.[0]; },
        run() { throw new Error('Cloud business writes require an explicit atomic batch.'); },
      };
    },
  };
}

export const businessAssertionSchema = `CREATE TABLE IF NOT EXISTS business_assertions (
  attempt TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));`;

export function assertSql(condition, values = []) {
  const attempt = randomUUID();
  return [
    { sql: `INSERT INTO business_assertions(attempt,valid) VALUES(?,CASE WHEN (${condition}) THEN 1 ELSE 0 END)`, values: [attempt, ...values] },
    { sql: 'DELETE FROM business_assertions WHERE attempt=?', values: [attempt] },
  ];
}

// A preparation reads data only. The final batch rechecks the actual result,
// including an empty result or new members of a query, before any writes.
// Domain validation stays with the operation that requested these records.
export function createReadSet(sql) {
  const observed = [], seen = new Set();
  const read = async (statement, values) => {
    check(/^\s*(?:SELECT|WITH)\b/i.test(statement) && !/;\s*\S/.test(statement), 'READ_QUERY_REQUIRED', '准备阶段只允许业务读取。', 500);
    const rows = await sql.query(statement, values);
    const identity = canonical([statement, values]);
    if (!seen.has(identity)) { observed.push({ sql: statement, values: structuredClone(values), rows: structuredClone(rows) }); seen.add(identity); }
    else {
      const earlier = observed.find(item => canonical([item.sql, item.values]) === identity);
      check(canonical(earlier.rows) === canonical(rows), 'BUSINESS_PREPARATION_CHANGED', '准备期间依赖数据改变，请保留原请求重试。', 409);
    }
    return rows;
  };
  return {
    all(statement, ...values) { return read(statement, values); },
    async get(statement, ...values) { return (await read(statement, values))[0]; },
    observed,
    get guards() { return observed.flatMap(readGuards); },
  };
}

function readGuards({ sql, values, rows }) {
  if (!rows.length) return assertSql(`NOT EXISTS(SELECT 1 FROM (${sql}) AS observed)`, values);
  const columns = Object.keys(rows[0]);
  const object = 'json_object(' + columns.flatMap(column => ["'" + column.replaceAll("'", "''") + "'", 'observed.' + sqlName(column)]).join(',') + ')';
  const guards = assertSql(`(SELECT COUNT(*) FROM (${sql}) AS observed)=?`, [...values, rows.length]);
  // Bound each comparison parameter; there is no persisted JSON current-row copy.
  let start = 0;
  while (start < rows.length) {
    let end = start + 1;
    while (end < rows.length && Buffer.byteLength(JSON.stringify(rows.slice(start, end + 1))) <= 128 * 1024) end++;
    const expected = JSON.stringify(rows.slice(start, end));
    guards.push(...assertSql(`(SELECT json_group_array(json(item)) FROM (SELECT ${object} AS item FROM (${sql}) AS observed LIMIT ? OFFSET ?))=?`, [...values, end - start, start, expected]));
    start = end;
  }
  return guards;
}

// Concrete final rows are supplied by each business operation. These helpers
// serialize those rows; they do not decide, replay or merge an operation.
export function rowStatement(table, keys, value, key) {
  if (value === null) return { sql: `DELETE FROM ${sqlName(table)} WHERE ${keys.map(name => sqlName(name) + ' IS ?').join(' AND ')}`, values: key };
  const columns = Object.keys(value), updates = columns.filter(name => !keys.includes(name));
  return { sql: `INSERT INTO ${sqlName(table)} (${columns.map(sqlName).join(',')}) VALUES(${columns.map(() => '?').join(',')}) ON CONFLICT(${keys.map(sqlName).join(',')}) ${updates.length ? 'DO UPDATE SET ' + updates.map(name => sqlName(name) + '=excluded.' + sqlName(name)).join(',') : 'DO NOTHING'}`, values: columns.map(name => value[name]) };
}

export async function replicationChanges(sql, schema, changes) {
  const result = [];
  for (const change of changes) {
    const table = schema.get(change.entity);
    if (!table || change.value !== null && !allowedRow(change.entity, change.value)) continue;
    const value = change.value === null ? null : Object.fromEntries(table.columns.map(column => [column, change.value[column] ?? null]));
    const key = change.key || canonical(table.keys.map(column => change.value[column]));
    const previous = (await sql.query('SELECT version,hash FROM cloud_sync_entities WHERE entity=? AND key=?', [change.entity, key]))[0];
    if (previous?.hash === rowHash(value)) continue;
    result.push({ entity: change.entity, key, value, expected: { version: previous?.version || 0, hash: previous?.hash ?? null } });
  }
  return result;
}
