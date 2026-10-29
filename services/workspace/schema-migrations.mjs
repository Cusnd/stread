import { canonical, check, hash } from "./errors.mjs";

// This ledger is local implementation state. Business import receipts remain in
// `migrations`; neither schema versions nor derived-index backfills replicate.
export const schemaMigrationLedgerSQL = `CREATE TABLE IF NOT EXISTS schema_versions (
  scope TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL,
  checksum TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(scope,version));`;

export function schemaMigrationDefinitions(scope, migrations) {
  check(/^[a-z][a-z0-9-]{0,79}$/.test(scope) && Array.isArray(migrations), "SCHEMA_MIGRATION_INVALID", "数据库迁移定义无效。", 500);
  return migrations.map((migration, index) => {
    check(migration.version === index + 1 && typeof migration.name === "string" && migration.name.length > 0 && typeof migration.sql === "string" && migration.sql.trim(),
      "SCHEMA_MIGRATION_INVALID", "数据库迁移必须有连续版本、名称和 SQL。", 500, { scope, version: migration.version });
    const sql = migration.sql.replaceAll("\r\n", "\n").trim();
    return { ...migration, sql, checksum: hash(canonical({ version: migration.version, name: migration.name, sql })) };
  });
}

export function schemaMigrationPlan(db, scope, migrations) {
  const available = schemaMigrationDefinitions(scope, migrations);
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'").get();
  const applied = exists ? db.prepare("SELECT version,name,checksum,applied_at FROM schema_versions WHERE scope=? ORDER BY version").all(scope) : [];
  for (let index = 0; index < applied.length; index++) {
    const current = applied[index], expected = available[index];
    check(current.version === index + 1, "SCHEMA_MIGRATION_HISTORY", "数据库迁移历史不连续；保留数据并停止初始化。", 409, { scope, version: current.version });
    check(expected, "SCHEMA_VERSION_NEWER", "数据库由更新版本创建；请使用相同或更新的程序。", 409, { scope, version: current.version });
    check(current.name === expected.name && current.checksum === expected.checksum, "SCHEMA_MIGRATION_CHANGED", "已执行的数据库迁移定义发生改变。", 409, { scope, version: current.version });
  }
  return { scope, currentVersion: applied.length, targetVersion: available.length, applied, pending: available.slice(applied.length) };
}

export function applySchemaMigrations(db, scope, migrations) {
  // Validate the entire known history before creating or changing any schema.
  const plan = schemaMigrationPlan(db, scope, migrations);
  if (!plan.pending.length) return plan;
  for (const migration of plan.pending) db.transaction(() => {
    db.exec(schemaMigrationLedgerSQL);
    // A second local process may have finished while this writer waited.
    const current = schemaMigrationPlan(db, scope, migrations);
    if (current.currentVersion >= migration.version) return;
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_versions(scope,version,name,checksum,applied_at) VALUES(?,?,?,?,?)")
      .run(scope, migration.version, migration.name, migration.checksum, new Date().toISOString());
  });
  return schemaMigrationPlan(db, scope, migrations);
}
